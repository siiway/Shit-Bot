import { getConfig } from '../config';
import { buildTools, executeTool, OpenAITool, ToolContext } from './tools';
import { buildProfile, logConversation, getRecentConversation } from './memory';
import { parseReplyJson, salvageReply, ReplyPayload } from './reactions';
import { formatUtc8, nowUtc8 } from './time';
import { fetchImageAsDataUri } from './websearch';

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

// 上游网关"拉取/下载图片失败"类错误的特征。图片现已由本机下载后 base64 内联（见 loadImageDataUri），
// 网关无需联网取图，正常情况下不会再出现这类错误；保留它仅作兜底：万一仍命中(如内联失败漏网、
// 或网关对 data URI 另有限制)，按永久性处理——重试无用，正确做法是去掉图片改用纯文本重试。
function isImageFetchError(err: { status?: number; body?: string; message?: string }): boolean {
  const s = `${err.body || ''} ${err.message || ''}`.toLowerCase();
  return /get file data|file data from|download file|failed to download|convert_request_failed/.test(s);
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
          retryAfterMs?: number;
        };
        err.status = response.status;
        err.body = errorText;
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const secs = Number(retryAfter);
          if (Number.isFinite(secs) && secs >= 0) err.retryAfterMs = secs * 1000;
        }
        throw err;
      }

      return (await response.json()) as ChatCompletionResponse;
    } catch (e) {
      const err = e as Error & { status?: number; retryAfterMs?: number; body?: string };
      const status = err.status || 0;
      const isTimeout = err.name === 'AbortError';
      // 可重试：网络层错误(无状态码)、请求超时、429 限流、408/5xx 服务端错误；
      // 不重试：其它 4xx 客户端错误(400/401/403/404…)，以及"上游拉取图片失败"(永久性，要留给上层去图重试)。
      const retryable =
        (!status || isTimeout || status === 408 || status === 429 || status >= 500) &&
        !isImageFetchError(err);
      // 超时每次都要干等满 60s 才中止，重试代价高、收益低(挂死的上游再试也基本不会成)，最多只重试 1 次；
      // 其余瞬时错误代价小，仍按 maxAttempts 最多 3 次。
      const attemptCap = isTimeout ? 2 : maxAttempts;
      if (!retryable || attempt >= attemptCap) throw e;
      lastErr = e;
      const wait = Math.min(err.retryAfterMs ?? 600 * attempt, 10000);
      const reason = isTimeout ? '请求超时' : err.message;
      console.warn(`[AI] 瞬时错误，${wait}ms 后重试 ${attempt}/${attemptCap - 1}: ${reason}`);
      await new Promise((r) => setTimeout(r, wait));
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
      let imgCount = 0;
      const texts: string[] = [];
      for (const p of m.content) {
        if (p.type === 'text') texts.push(p.text);
        else if (p.type === 'image_url') imgCount++;
      }
      let joined = texts.join('\n');
      // 关键：去图后必须留痕，否则模型看不到任何图片线索，会理直气壮地回"你没发图"误导用户
      if (imgCount > 0) {
        joined += `\n（系统提示：此处原有 ${imgCount} 张图片，但无法处理、已移除；请勿声称用户没有发图，可如实说明你这边暂时看不到图片，并请对方换种方式提供。）`;
      }
      m.content = joined;
    }
  }
}

interface ImageBudget {
  remainingBytes: number;
}

// 本机下载单张图片并转成 base64 data URI；受单图上限与本次请求剩余总预算双重约束。失败/超限返回 null。
async function loadImageDataUri(
  url: string,
  budget: ImageBudget,
  perImageMax: number
): Promise<string | null> {
  const cap = Math.min(perImageMax, budget.remainingBytes);
  if (cap <= 0) return null;
  try {
    const { dataUri, bytes } = await fetchImageAsDataUri(url, cap);
    budget.remainingBytes -= bytes;
    return dataUri;
  } catch (e) {
    console.warn(`[AI] 图片内联失败，跳过 (${url.slice(0, 80)}): ${(e as Error).message}`);
    return null;
  }
}

const NON_ANSWER = '抱歉，我这次没能整理出有效回答。可以换个问法，或直接把要我看的链接发给我。';

// 单条工具结果写入对话前的长度上限：防止超大页面/超多历史撑爆上下文、导致整条请求 400 硬失败
const MAX_TOOL_RESULT = 16000;

// 把模型/网关返回的 content 安全转成字符串：可能是 string、内容块数组、或异常类型(对象/null)，
// 直接 .trim() 会抛。统一在这里窄化，避免一条畸形响应让整轮处理崩掉。
function contentToText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

const DISCORD_FORMAT =
  '输出只用 Discord 支持的 Markdown（**粗** *斜* __下划线__ ~~删除线~~ `代码` ```代码块``` > 引用 # 标题 - 列表 ||剧透|| [文字](链接)）。表格、图片、HTML、LaTeX 等不被渲染，尽量转成等价写法（如表格→列表或代码块），实在无法转换再原样保留。';

const REACTION_INSTRUCTION =
  '你最终面向用户的回复必须是一个 JSON 对象，且只输出这个 JSON（不要套代码块、不要任何额外文字）：' +
  '{"reply": "<给用户看的话，用 Discord Markdown>", "reactions": ["<表情短码>", ...]}。\n' +
  '- reply：必填，正文。其中的双引号和换行必须按 JSON 规则转义（写成 \\" 和 \\n），保证整段能被 JSON.parse 解析。\n' +
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

  messages.push({
    role: 'system',
    content:
      `当前时间：${nowUtc8()}（UTC+8，北京时间）。` +
      `除非用户明确指明其它时区，默认所有时间都按 UTC+8 理解和表述；` +
      `历史消息前若带有 [YYYY-MM-DD HH:mm:ss] 形式的时间戳，同样是 UTC+8。` +
      `这些时间戳只是系统为帮助你判断消息发生时间而附加的标注，不属于消息正文；你自己回复时不要在开头添加任何这种 [时间] 前缀。`,
  });

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
    // 记忆/历史注入是锦上添花：DB 抖动时静默降级为"本轮不带记忆"，绝不阻断回复
    try {
      const injectRecent = !cfg.summary?.enabled;
      const memMsg = buildMemorySystemMessage(platform, username, displayName, injectRecent);
      if (memMsg) messages.push({ role: 'system', content: memMsg });

      if (injectRecent) {
        const recentTurns = cfg.memory?.recentTurns ?? 6;
        for (const turn of getRecentConversation(platform, username, recentTurns)) {
          messages.push({
            role: turn.role,
            content: `[${formatUtc8(turn.created_at)}] ${turn.content}`,
          });
        }
      }
    } catch (e) {
      console.warn('[AI] 注入记忆/历史失败(忽略，本轮不带记忆):', (e as Error).message);
    }
  }

  if (ctx?.contextMessage) {
    messages.push({ role: 'user', content: `以下是被引用的消息内容:\n${ctx.contextMessage}` });
  }

  const effMsg = bareMention ? '（我直接 @ 了你，没有具体问题，麻烦你看看情况自然地回应一下。）' : userMessage;
  const userText = `[${displayName}]: ${effMsg}`;
  const imageUrls = (ctx?.images || []).filter((u) => /^https?:\/\//.test(u)).slice(0, 6);

  const MAX_TOTAL_IMAGES = 6;
  const perImageMax = cfg.maxImageBytes ?? 6 * 1024 * 1024;
  // 整条请求所有内联图片共享一份字节预算，初始图与 read_image 后续加载都从这里扣
  const imageBudget: ImageBudget = { remainingBytes: cfg.maxTotalImageBytes ?? 12 * 1024 * 1024 };
  const loadedImageUrls = new Set<string>(imageUrls);
  let imagesLoaded = 0;

  if (imageUrls.length > 0) {
    const imgParts: ContentPart[] = [];
    for (const url of imageUrls) {
      if (imagesLoaded >= MAX_TOTAL_IMAGES) break;
      const dataUri = await loadImageDataUri(url, imageBudget, perImageMax);
      if (dataUri) {
        imgParts.push({ type: 'image_url', image_url: { url: dataUri } });
        imagesLoaded++;
      }
    }
    if (imgParts.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: userText }, ...imgParts] });
    } else {
      // 一张都没下成：用纯文本并明确告知"有图但加载不了"，杜绝模型反过来说用户没发图
      console.warn(`[AI] 用户发送的 ${imageUrls.length} 张图片全部内联失败，降级为纯文本`);
      messages.push({
        role: 'user',
        content:
          userText +
          `\n（系统提示：用户随消息发送了 ${imageUrls.length} 张图片，但系统未能加载它们；请勿声称用户没有发图，可如实说明你这边暂时看不到图片，并请对方换种方式提供。）`,
      });
    }
  } else {
    messages.push({ role: 'user', content: userText });
  }

  if (memoryOn) {
    try {
      const logText = bareMention
        ? '[直接@机器人]'
        : userMessage || (imageUrls.length ? '[发送了图片]' : '');
      logConversation(platform, username, 'user', logText);
    } catch (e) {
      console.warn('[AI] 记录用户消息到记忆失败(忽略):', (e as Error).message);
    }
  }

  const tools = buildTools();
  const maxIterations = Math.max(
    1,
    imageUrls.length ? Math.min(cfg.maxToolIterations ?? 5, 3) : cfg.maxToolIterations ?? 5
  );
  // pendingImages 存的是已内联好的 base64 data URI（不是原始直链）
  const pendingImages: string[] = [];
  const toolCtx: ToolContext = {
    platform,
    username,
    channelId: ctx?.channelId,
    excludeMessageId: ctx?.messageId,
    backfill: ctx?.backfillChannel,
    // read_image 走这里：本机下载并内联，绝不把直链交给网关；返回真正成功加载的张数
    addImages: async (urls): Promise<number> => {
      let added = 0;
      for (const u of urls) {
        if (imagesLoaded >= MAX_TOTAL_IMAGES) break;
        if (loadedImageUrls.has(u)) continue;
        loadedImageUrls.add(u);
        const dataUri = await loadImageDataUri(u, imageBudget, perImageMax);
        if (!dataUri) continue;
        pendingImages.push(dataUri);
        imagesLoaded++;
        added++;
      }
      return added;
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
        } else if (messagesHaveImages(messages)) {
          // 带图请求失败：一律先去掉图片用纯文本重试，绝不让单张图(失效/防盗链/被网关拒)终结整条回复
          console.warn(
            `[AI] 带图请求失败(${err.status ?? '?'}${isImageFetchError(err) ? '/上游拉取图片失败' : ''})，去掉图片改用纯文本重试`
          );
          stripImageParts(messages);
          try {
            data = await callApi(messages, tools, useTools ? (lastIter ? false : 'auto') : false);
          } catch {
            // 已有工具上下文则转入收尾(基于已查到的信息再答/兜底 NON_ANSWER)，否则才上抛
            if (iter > 0) break;
            throw e;
          }
        } else {
          // 中途瞬时失败但已积累工具结果：跳出去走收尾降级，不要让一轮抖动终结整条回复
          if (iter > 0) {
            console.warn(`[AI] 工具循环中途请求失败(${err.status ?? '?'})，转入收尾降级: ${err.message}`);
            break;
          }
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

      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (useTools && !lastIter && toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: contentToText(msg.content),
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const fn = call.function || ({} as ToolCall['function']);
          const name = typeof fn.name === 'string' ? fn.name : '';
          // arguments 多数网关给字符串，但也有给已解析对象的；统一成字符串，避免 .slice / JSON.parse 抛错
          const argStr =
            typeof fn.arguments === 'string'
              ? fn.arguments
              : fn.arguments == null
                ? ''
                : JSON.stringify(fn.arguments);
          console.log(`[AI] 工具调用: ${name} ${argStr.slice(0, 120)}`);
          const result = await executeTool(name, argStr, toolCtx);
          const safeResult =
            result.length > MAX_TOOL_RESULT
              ? result.slice(0, MAX_TOOL_RESULT) + '\n…（工具结果过长，已截断）'
              : result;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: safeResult,
          });
        }

        if (pendingImages.length > 0) {
          const parts: ContentPart[] = [
            { type: 'text', text: '（read_image 工具加载的图片，请查看后回答）' },
          ];
          // pendingImages 已是内联好的 base64 data URI
          for (const dataUri of pendingImages.splice(0)) {
            parts.push({ type: 'image_url', image_url: { url: dataUri } });
          }
          messages.push({ role: 'user', content: parts });
        }
        continue;
      }

      finalText = contentToText(msg.content).trim();
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
        finalText = contentToText(data.choices?.[0]?.message?.content).trim();
        finalFinishReason = data.choices?.[0]?.finish_reason || '';
        if (!finalText) {
          console.warn(`[AI] 收尾(去掉工具)仍为空 (finish_reason=${data.choices?.[0]?.finish_reason || 'n/a'})`);
        }
      } catch (e) {
        console.warn('[AI] 收尾(去掉工具)请求失败:', (e as Error).message);
        if (messagesHaveImages(messages)) {
          // 收尾这步也可能被坏图卡住：去掉图片再纯文本试一次，别直接给非答复
          stripImageParts(messages);
          try {
            const d = await callApi(messages, tools, false, escalated);
            finalText = contentToText(d.choices?.[0]?.message?.content).trim();
            finalFinishReason = d.choices?.[0]?.finish_reason || '';
          } catch (e2) {
            console.warn('[AI] 收尾去图重试仍失败:', (e2 as Error).message);
          }
        }
      }
      if (!finalText) {
        finalText = NON_ANSWER;
      }
    }

    let reply = finalText;
    let reactions: string[] = [];
    let replyTruncated = finalFinishReason === 'length';

    if (reactionsOn && finalText && finalText !== NON_ANSWER) {
      let candidate = finalText;
      let candidateTruncated = replyTruncated;
      let parsed = parseReplyJson(candidate);

      // 非法 JSON 且这段不是被截断的 -> 要求模型重新生成 (最多 2 次)
      if (!parsed && !candidateTruncated) {
        for (let r = 0; r < 2 && !parsed; r++) {
          console.warn('[AI] 最终回复不是合法 JSON，要求重新生成');
          messages.push({
            role: 'user',
            content:
              '你刚才的回复不是合法 JSON。请只输出 {"reply":"...","reactions":[":short_code:", ...]} 这个 JSON，不要代码块、不要额外文字；reply 里的双引号和换行要按 JSON 转义（\\" 与 \\n）。重新输出。',
          });
          try {
            const d = await callApi(messages, tools, false);
            candidate = contentToText(d.choices?.[0]?.message?.content).trim();
            candidateTruncated = (d.choices?.[0]?.finish_reason || '') === 'length';
            messages.push({ role: 'assistant', content: candidate });
            parsed = parseReplyJson(candidate);
            if (!parsed && candidateTruncated) break;
          } catch (e) {
            console.warn('[AI] 重新生成失败:', (e as Error).message);
            break;
          }
        }
      }

      replyTruncated = candidateTruncated;
      if (parsed) {
        reply = parsed.reply;
        reactions = parsed.reactions;
      } else {
        // 截断或重试仍失败: 从最新这段里抢救 reply 文本
        reply = salvageReply(candidate);
      }
    }

    if (!reply.trim()) {
      reply = NON_ANSWER;
      replyTruncated = false;
    }

    // 先把干净文本写进记忆，再给"发送用"的文本加截断提示。落库失败只告警，绝不丢弃已算好的回复
    if (memoryOn && reply !== NON_ANSWER) {
      try {
        logConversation(platform, username, 'assistant', reply);
      } catch (e) {
        console.warn('[AI] 记录回复到记忆失败(忽略):', (e as Error).message);
      }
    }

    if (replyTruncated && reply !== NON_ANSWER) {
      reply += '\n\n（回复因长度上限被截断，可回复"继续"获取后续）';
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

