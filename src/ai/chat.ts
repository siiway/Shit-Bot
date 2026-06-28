import { getConfig } from '../config';
import { buildTools, executeTool, OpenAITool, ToolContext } from './tools';
import { buildProfile, logConversation, getRecentConversation } from './memory';
import { parseReplyJson, salvageReply, ReplyPayload } from './reactions';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

export interface ChatContext {
  username?: string;
  displayName?: string;
  contextMessage?: string;
  platform?: string;
  channelId?: string;
  messageId?: string;
  images?: string[];
  bareMention?: boolean;
  backfillChannel?: (targetTotal: number) => Promise<void>;
}

export function isAiEnabled(): boolean {
  return getConfig().ai.enabled;
}

function buildMemorySystemMessage(
  platform: string,
  username: string,
  displayName: string,
  injectRecent: boolean
): string | null {
  const profile = buildProfile(platform, username);
  const profileBlock = profile || '（暂无已知信息，请在对话中留意并积累。）';
  const historyGuide = injectRecent
    ? `紧接着会附上你们最近几轮对话，近期上下文可直接据此理解，无需查询。` +
      `遇到指向更早内容的线索时——如对方用"那个/上次/之前/继续/还是用…"等指代、追问最近对话里没有的旧事、或问"我们之前聊过什么"——请主动调用 recall_memory 翻更早的历史（query 填话题/人名/事件关键词；没有具体关键词时留空，会返回最近的对话历史）。`
    : `不会自动附上最近对话。区分两种"历史"：① 你和当前对话者本人的一对一私聊——当对方说"你刚才说的/你之前讲的/我们私聊的"时，调用 recall_memory（留空=返回你俩最近的私聊历史，或填关键词）。② 频道里多人之间的群聊——当对方说"刚才的聊天/我们刚聊的/上面的对话/我们的讨论/帮我看看上面"等（这类通常指频道群聊，而非你俩的私聊）时，调用 read_channel_history 读取频道消息再作答。`;
  return (
    `[私密背景 — 当前对话者的永久唯一标识是 @${username}（不可变，所有记忆都以它为准）；其昵称「${displayName}」只是会变的显示名，不要据此判断身份、也不要拿它去检索。请自然运用以下信息，切勿主动复述或说"你之前…"，像早已了解对方一样，润物细无声。]\n` +
    `${profileBlock}\n\n` +
    historyGuide +
    `当你了解到值得长期记住的新信息、或发现旧信息有变化/有误时，请静默调用 save_memory / update_memory / forget_memory，不要在回复里提及这些操作。`
  );
}

async function callApi(
  messages: ChatMessage[],
  tools: OpenAITool[],
  toolChoice: 'auto' | 'none' | false,
  maxTokensOverride?: number
): Promise<ChatCompletionResponse> {
  const cfg = getConfig().ai;

  const body: Record<string, any> = {
    model: cfg.model,
    messages,
    max_tokens: maxTokensOverride ?? cfg.maxTokens,
    temperature: cfg.temperature,
  };
  if (toolChoice !== false && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const maxAttempts = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(`${cfg.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`HTTP ${response.status}: ${errorText}`) as Error & {
          status?: number;
          body?: string;
        };
        err.status = response.status;
        err.body = errorText;
        throw err;
      }

      return (await response.json()) as ChatCompletionResponse;
    } catch (e) {
      const err = e as Error & { status?: number };
      const transient = (!err.status && err.name !== 'AbortError') || [502, 503, 504].includes(err.status || 0);
      if (!transient || attempt >= maxAttempts) throw e;
      lastErr = e;
      console.warn(`[AI] 网络瞬时错误，重试 ${attempt}/${maxAttempts - 1}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 600 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastErr;
}

function stripToolMessages(messages: ChatMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) {
      messages.splice(i, 1);
    }
  }
}

function messagesHaveImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content));
}

function stripImageParts(messages: ChatMessage[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      m.content = m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    }
  }
}

const NON_ANSWER = '抱歉，我这次没能整理出有效回答。可以换个问法，或直接把要我看的链接发给我。';

const DISCORD_FORMAT =
  '输出只用 Discord 支持的 Markdown（**粗** *斜* __下划线__ ~~删除线~~ `代码` ```代码块``` > 引用 # 标题 - 列表 ||剧透|| [文字](链接)）。表格、图片、HTML、LaTeX 等不被渲染，尽量转成等价写法（如表格→列表或代码块），实在无法转换再原样保留。';

const REACTION_INSTRUCTION =
  '你最终面向用户的回复必须是一个 JSON 对象，且只输出这个 JSON（不要套代码块、不要任何额外文字）：' +
  '{"reply": "<给用户看的话，用 Discord Markdown>", "reactions": ["<表情短码>", ...]}。\n' +
  '- reply：必填，正文。\n' +
  '- reactions：表情短码数组（形如 :smile: :tada: :+1:，首尾带冒号）。它只是贴在用户这条消息上的一个轻量"回应信号"，' +
  '就像真人随手点个表情，纯属点缀、完全可有可无。把握这个度，自行体会：\n' +
  '  · 默认就给 []，绝大多数回复都不需要贴；\n' +
  '  · 仅当对方消息确有明显情绪或场合、贴一个能自然呼应时才加（如对方说了好笑的事→😂、道谢→👍/❤️、好消息→🎉、表示赞同→👍）；\n' +
  '  · 宁缺毋滥：不要为了贴而贴、不要堆砌、不要与内容无关的装饰性表情；真要贴通常 1 个就够，最多别超过 2 个。\n' +
  '注意：只有最终回复才是这个 JSON；工具调用阶段照常，不要包成 JSON。';

function bareMentionGuide(defaultCount: number): string {
  return (
    `用户直接 @ 了你，但没有提出具体问题。请这样处理：\n` +
    `1) 先用 read_channel_history 读取本频道最近约 ${defaultCount} 条消息，了解大家正在聊什么；\n` +
    `2) 若读到的内容不足以理解上下文（话题被截断、缺前因后果），再多读一些，每次约再多 ${defaultCount} 条，直到够用为止（别无止境地读）；\n` +
    `3) 消息里若有链接，可用 open_url 打开了解；若有图片，可用 read_image 查看；\n` +
    `4) 然后像一个正常参与者那样自然地接话或回应——给出有价值的看法、补充或顺着话题往下聊；不要反问"你想问什么"，也不要机械复述聊天记录。`
  );
}

function sanitizeInline(s: string, max: number): string {
  return String(s || '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export async function chatWithAI(userMessage: string, ctx?: ChatContext): Promise<ReplyPayload> {
  const cfg = getConfig().ai;

  if (!cfg.enabled || !cfg.apiKey) {
    return { reply: 'AI 聊天功能未启用或未配置 API Key。', reactions: [] };
  }

  const platform = ctx?.platform || 'discord';
  const username = ctx?.username?.trim() || '';
  const displayName = sanitizeInline(ctx?.displayName || username || '用户', 64) || '用户';
  const memoryOn = !!cfg.memory?.enabled && !!username;
  const reactionsOn = platform === 'discord' && cfg.reactions !== false;
  const bareMention = !!ctx?.bareMention;

  const messages: ChatMessage[] = [{ role: 'system', content: cfg.systemPrompt }];

  if (platform === 'discord') {
    messages.push({ role: 'system', content: DISCORD_FORMAT });
  }

  if (reactionsOn) {
    messages.push({ role: 'system', content: REACTION_INSTRUCTION });
  }

  if (bareMention) {
    messages.push({ role: 'system', content: bareMentionGuide(cfg.summary?.defaultCount ?? 100) });
  }

  if (memoryOn) {
    const injectRecent = !cfg.summary?.enabled;
    const memMsg = buildMemorySystemMessage(platform, username, displayName, injectRecent);
    if (memMsg) messages.push({ role: 'system', content: memMsg });

    if (injectRecent) {
      const recentTurns = cfg.memory?.recentTurns ?? 6;
      for (const turn of getRecentConversation(platform, username, recentTurns)) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
  }

  if (ctx?.contextMessage) {
    messages.push({ role: 'user', content: `以下是被引用的消息内容:\n${ctx.contextMessage}` });
  }

  const effMsg = bareMention ? '（我直接 @ 了你，没有具体问题，麻烦你看看情况自然地回应一下。）' : userMessage;
  const userText = `[${displayName}]: ${effMsg}`;
  const images = (ctx?.images || []).filter((u) => /^https?:\/\//.test(u)).slice(0, 6);
  if (images.length > 0) {
    const parts: ContentPart[] = [{ type: 'text', text: userText }];
    for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
    messages.push({ role: 'user', content: parts });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  if (memoryOn) {
    const logText = bareMention
      ? '[直接@机器人]'
      : userMessage || (images.length ? '[发送了图片]' : '');
    logConversation(platform, username, 'user', logText);
  }

  const tools = buildTools();
  const maxIterations = Math.max(
    1,
    images.length ? Math.min(cfg.maxToolIterations ?? 5, 3) : cfg.maxToolIterations ?? 5
  );
  const pendingImages: string[] = [];
  const toolCtx: ToolContext = {
    platform,
    username,
    channelId: ctx?.channelId,
    excludeMessageId: ctx?.messageId,
    backfill: ctx?.backfillChannel,
    addImages: (urls) => {
      pendingImages.push(...urls);
    },
  };
  let useTools = tools.length > 0;

  console.log(
    `[AI] 请求: model=${cfg.model}, tools=${useTools ? tools.length : 0}, memory=${memoryOn}, user=${username || displayName}`
  );

  try {
    let finalText = '';
    let finalFinishReason = '';

    for (let iter = 0; iter < maxIterations; iter++) {
      const lastIter = iter === maxIterations - 1;
      let data: ChatCompletionResponse;
      try {
        data = await callApi(messages, tools, useTools ? (lastIter ? false : 'auto') : false);
      } catch (e) {
        const err = e as Error & { status?: number; body?: string };
        if (
          useTools &&
          err.status === 400 &&
          /tool|function/i.test(err.body || err.message || '')
        ) {
          console.warn('[AI] 模型疑似不支持工具调用，降级为普通对话');
          useTools = false;
          stripToolMessages(messages);
          try {
            data = await callApi(messages, tools, false);
          } catch {
            finalText = '抱歉，当前模型不支持工具调用，请在配置中关闭联网搜索/记忆，或换用支持工具的模型。';
            break;
          }
        } else if (err.status === 400 && messagesHaveImages(messages)) {
          console.warn('[AI] 图片请求被拒(400)，去掉图片重试纯文本');
          stripImageParts(messages);
          try {
            data = await callApi(messages, tools, useTools ? (lastIter ? false : 'auto') : false);
          } catch {
            throw e;
          }
        } else {
          throw e;
        }
      }

      const choice = data.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        if (data.error?.message) {
          throw new Error(`API 返回错误: ${data.error.message}`);
        }
        console.warn(`[AI] 响应无有效 choices (finish_reason=${choice?.finish_reason || 'n/a'}): ${JSON.stringify(data).slice(0, 500)}`);
        break;
      }

      const finishReason = choice?.finish_reason || '';
      if (finishReason === 'length') {
        console.warn(`[AI] 输出达到 max_tokens(${cfg.maxTokens}) 被截断 (finish_reason=length)`);
      }

      const toolCalls = msg.tool_calls || [];
      if (useTools && !lastIter && toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: msg.content ?? '',
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const name = call.function?.name || '';
          const argStr = call.function?.arguments || '';
          console.log(`[AI] 工具调用: ${name} ${argStr.slice(0, 120)}`);
          const result = await executeTool(name, argStr, toolCtx);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: result,
          });
        }

        if (pendingImages.length > 0) {
          const parts: ContentPart[] = [
            { type: 'text', text: '（read_image 工具加载的图片，请查看后回答）' },
          ];
          for (const url of pendingImages.splice(0)) {
            parts.push({ type: 'image_url', image_url: { url } });
          }
          messages.push({ role: 'user', content: parts });
        }
        continue;
      }

      finalText = (msg.content || '').trim();
      finalFinishReason = finishReason;
      if (!finalText) {
        console.warn(`[AI] 本轮返回空文本 (finish_reason=${finishReason || 'n/a'}, tool_calls=${toolCalls.length}, lastIter=${lastIter})`);
      }
      break;
    }

    if (!finalText) {
      messages.push({
        role: 'user',
        content: '请基于以上已获得的信息，用中文直接给出最终回答，直接给结论、不要长篇推理，也不要再调用任何工具。',
      });
      const escalated = Math.min((cfg.maxTokens || 1024) * 2, 32768);
      try {
        const data = await callApi(messages, tools, false, escalated);
        finalText = (data.choices?.[0]?.message?.content || '').trim();
        finalFinishReason = data.choices?.[0]?.finish_reason || '';
        if (!finalText) {
          console.warn(`[AI] 收尾(去掉工具)仍为空 (finish_reason=${data.choices?.[0]?.finish_reason || 'n/a'})`);
        }
      } catch (e) {
        console.warn('[AI] 收尾(去掉工具)请求失败:', (e as Error).message);
      }
      if (!finalText) {
        finalText = NON_ANSWER;
      }
    }

    let reply = finalText;
    let reactions: string[] = [];

    if (reactionsOn && finalText && finalText !== NON_ANSWER) {
      let parsed = parseReplyJson(finalText);
      // 非法 JSON 且不是被截断 -> 要求模型重新生成 (最多 2 次)
      if (!parsed && finalFinishReason !== 'length') {
        for (let r = 0; r < 2 && !parsed; r++) {
          console.warn('[AI] 最终回复不是合法 JSON，要求重新生成');
          messages.push({
            role: 'user',
            content:
              '你刚才的回复不是合法 JSON。请只输出 {"reply":"...","reactions":[":short_code:", ...]} 这个 JSON，不要代码块、不要任何额外文字。重新输出。',
          });
          try {
            const d = await callApi(messages, tools, false);
            const t = (d.choices?.[0]?.message?.content || '').trim();
            messages.push({ role: 'assistant', content: t });
            finalFinishReason = d.choices?.[0]?.finish_reason || '';
            parsed = parseReplyJson(t);
          } catch (e) {
            console.warn('[AI] 重新生成失败:', (e as Error).message);
            break;
          }
        }
      }
      if (parsed) {
        reply = parsed.reply;
        reactions = parsed.reactions;
      } else {
        // 截断或重试仍失败: 尽量从原始内容里抢救出 reply 文本
        reply = salvageReply(finalText);
      }
    }

    if (finalFinishReason === 'length' && reply) {
      reply += '\n\n（回复因长度上限被截断，可回复"继续"获取后续）';
    }

    if (memoryOn && reply && reply !== NON_ANSWER) {
      logConversation(platform, username, 'assistant', reply);
    }

    return { reply, reactions };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      console.error('AI API 请求超时');
      return { reply: 'AI 响应超时，请稍后再试。', reactions: [] };
    }
    const err = error as Error & { status?: number };
    console.error('AI API 请求失败:', err.message);
    if (err.status) {
      return { reply: `AI 服务返回错误 (${err.status})。请检查 API 配置。`, reactions: [] };
    }
    return { reply: 'AI 服务请求失败，请检查 API 配置或稍后再试。', reactions: [] };
  }
}

