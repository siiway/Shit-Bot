import { getConfig } from '../config';
import { buildTools, executeTool, OpenAITool, ToolContext } from './tools';
import { buildProfile, logConversation, getRecentConversation } from './memory';

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

function sanitizeInline(s: string, max: number): string {
  return String(s || '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export async function chatWithAI(userMessage: string, ctx?: ChatContext): Promise<string> {
  const cfg = getConfig().ai;

  if (!cfg.enabled || !cfg.apiKey) {
    return 'AI 聊天功能未启用或未配置 API Key。';
  }

  const platform = ctx?.platform || 'discord';
  const username = ctx?.username?.trim() || '';
  const displayName = sanitizeInline(ctx?.displayName || username || '用户', 64) || '用户';
  const memoryOn = !!cfg.memory?.enabled && !!username;

  const messages: ChatMessage[] = [{ role: 'system', content: cfg.systemPrompt }];

  if (platform === 'discord') {
    messages.push({ role: 'system', content: DISCORD_FORMAT });
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

  const userText = `[${displayName}]: ${userMessage}`;
  const images = (ctx?.images || []).filter((u) => /^https?:\/\//.test(u)).slice(0, 6);
  if (images.length > 0) {
    const parts: ContentPart[] = [{ type: 'text', text: userText }];
    for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
    messages.push({ role: 'user', content: parts });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  if (memoryOn) {
    logConversation(platform, username, 'user', userMessage || (images.length ? '[发送了图片]' : ''));
  }

  const tools = buildTools();
  const maxIterations = Math.max(
    1,
    images.length ? Math.min(cfg.maxToolIterations ?? 5, 3) : cfg.maxToolIterations ?? 5
  );
  const toolCtx: ToolContext = {
    platform,
    username,
    channelId: ctx?.channelId,
    excludeMessageId: ctx?.messageId,
    backfill: ctx?.backfillChannel,
  };
  let useTools = tools.length > 0;

  console.log(
    `[AI] 请求: model=${cfg.model}, tools=${useTools ? tools.length : 0}, memory=${memoryOn}, user=${username || displayName}`
  );

  try {
    let finalText = '';

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
        continue;
      }

      finalText = (msg.content || '').trim();
      if (finalText && finishReason === 'length') {
        finalText += '\n\n（回复因长度上限被截断，可回复"继续"获取后续）';
      }
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

    if (memoryOn && finalText && finalText !== NON_ANSWER) {
      logConversation(platform, username, 'assistant', finalText);
    }

    return finalText;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      console.error('AI API 请求超时');
      return 'AI 响应超时，请稍后再试。';
    }
    const err = error as Error & { status?: number };
    console.error('AI API 请求失败:', err.message);
    if (err.status) {
      return `AI 服务返回错误 (${err.status})。请检查 API 配置。`;
    }
    return 'AI 服务请求失败，请检查 API 配置或稍后再试。';
  }
}

