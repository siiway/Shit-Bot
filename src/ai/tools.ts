import { getConfig } from '../config';
import { webSearch, fetchUrl, assertSafeUrl } from './websearch';
import { recallMemories, saveMemory, updateMemory, deleteMemory } from './memory';
import { getRecentChannelMessages, formatForSummary } from './summary';

export interface ToolContext {
  platform: string;
  username: string;
  channelId?: string;
  excludeMessageId?: string;
  backfill?: (targetTotal: number) => Promise<void>;
  addImages?: (urls: string[]) => number;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export function buildTools(): OpenAITool[] {
  const ai = getConfig().ai;
  const tools: OpenAITool[] = [];

  if (ai.webSearch?.enabled) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '联网搜索实时/最新信息。当问题涉及近期事件、行情、版本、事实核查或你不确定的内容时使用。返回若干条标题+链接+摘要。若你已知确切网址，请改用 open_url 直接读取，不要用搜索。同一问题不要反复搜相近关键词。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，尽量精炼具体' },
            max_results: {
              type: 'integer',
              description: '返回结果数量 (1-10，默认 5)',
            },
          },
          required: ['query'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'open_url',
        description:
          '打开一个网页链接并读取其正文文本。当用户直接给出或提到某个具体网址/域名(如 blog.example.com)、或你已从搜索结果拿到链接需要细读时，用本工具直接读取，而不是再去搜索。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要打开的 http(s) 链接' },
          },
          required: ['url'],
        },
      },
    });
  }

  if (ai.memory?.enabled) {
    tools.push({
      type: 'function',
      function: {
        name: 'recall_memory',
        description:
          '翻查你与当前对话者更早的历史对话(以及没进入背景画像的溢出记忆)。最近几轮已在上下文里；当对方提到"那个/上次/之前/继续"等更早的事、问"我们之前聊过什么/那件事"、或想确认久远的对话细节时调用。结果是私密背景，不要原样念给对方听。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                '话题/人名/事件等关键词；留空则返回最近的对话历史(适合"我们聊过什么"这类没有具体关键词的问题)。',
            },
          },
          required: [],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'save_memory',
        description:
          '把关于当前对话者、值得长期记住的事实静默存入记忆 (KV 形式)。例如其职业、偏好、长期目标、性格、重要经历等。key 用简短英文/拼音语义键 (如 occupation、likes、timezone)，value 用简洁自然语言。不要存一次性闲聊或敏感隐私。存完不要在回复里提及你存了记忆。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '语义键，简短稳定，如 occupation；同一类事实复用同一 key 以便更新' },
            value: { type: 'string', description: '记忆内容，写成一句可独立阅读的自洽自然语言陈述（如"是一名后端工程师，常用 Go"），不要只写孤立词' },
            weight: {
              type: 'number',
              description: '重要程度 0-1，越接近 1 越会被长期优先记住 (默认 0.5)',
            },
          },
          required: ['key', 'value'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'update_memory',
        description:
          '当某条已存在的记忆发生变化时更新它 (按 key)。可只改 value 或只调 weight。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '要更新的记忆键' },
            value: { type: 'string', description: '新的记忆内容 (可选)' },
            weight: { type: 'number', description: '新的权重 0-1 (可选)' },
          },
          required: ['key'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'forget_memory',
        description: '当某条记忆已被证伪或不再相关时删除它 (按 key)。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '要删除的记忆键' },
          },
          required: ['key'],
        },
      },
    });
  }

  tools.push({
    type: 'function',
    function: {
      name: 'read_image',
      description:
        '当你需要"看"某张图片才能回答、且你手上有这张图的真实 http(s) 直链时调用，系统会把它加载进上下文供你查看后再作答。\n' +
        '严格要求：① 只能传入对话内容、工具返回结果或网页正文里【真实出现过】的图片直链，绝对不要自行编造、猜测或拼接 URL；' +
        '② 用户当前消息附带的图、以及被引用消息里的图，已经直接展示在你眼前，不要再用本工具重复读取；' +
        '③ 如果你手上并没有一个确切的图片直链，就不要调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: '一个或多个图片的 http(s) 公网直链',
          },
        },
        required: ['urls'],
      },
    },
  });

  if (ai.summary?.enabled) {
    tools.push({
      type: 'function',
      function: {
        name: 'read_channel_history',
        description:
          '读取当前频道最近若干条聊天记录(已按时间从旧到新排好、同一人连续发言合并、只含昵称)。当用户要求总结/概括/回顾本频道或"上面"的消息、或说"刚才的聊天/我们刚聊的/上面的对话/我们的讨论/根据我们刚才聊的"等(这类通常指频道里多人之间的群聊，而不是你和TA的一对一私聊)、或你需要了解频道最近聊了什么时调用，然后据此作答。',
        parameters: {
          type: 'object',
          properties: {
            count: {
              type: 'integer',
              description:
                '要读取的最近消息条数。用户明确说了数量(如"200条")就填该数；用户没提具体数量就不要填此参数，会自动用系统默认值。',
            },
          },
          required: [],
        },
      },
    });
  }

  return tools;
}

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext
): Promise<string> {
  let args: Record<string, any> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `工具参数解析失败 (非合法 JSON): ${rawArgs?.slice(0, 200)}`;
  }

  try {
    switch (name) {
      case 'web_search': {
        const results = await webSearch(args.query, args.max_results);
        if (results.length === 0) return `「${args.query}」没有搜索到结果。`;
        return results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || '(无摘要)'}`
          )
          .join('\n');
      }
      case 'open_url': {
        const { text, images } = await fetchUrl(args.url);
        let out = text || '(该页面没有可读取的文本)';
        if (images.length > 0) {
          out +=
            `\n\n[页面中发现 ${images.length} 张图片，如需查看其中内容可调用 read_image 传入对应链接]:\n` +
            images.map((u) => `- ${u}`).join('\n');
        }
        return out;
      }
      case 'read_image': {
        if (!ctx.addImages) return '当前环境不支持加载图片。';
        const list: unknown[] = Array.isArray(args.urls)
          ? args.urls
          : args.url
            ? [args.url]
            : [];
        const candidates = list
          .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
          .slice(0, 6);
        const valid: string[] = [];
        for (const u of candidates) {
          try {
            await assertSafeUrl(u);
            valid.push(u);
          } catch {
            // 跳过内网/私网/元数据等不安全链接
          }
        }
        if (valid.length === 0) return '没有有效的图片链接(需 http(s) 公网直链)。';
        const added = ctx.addImages(valid);
        if (added <= 0) {
          return '这些图片可能已在上下文中、或本轮已达可加载图片数量上限。请基于已有的图片与信息作答，不要臆测未加载图片的内容。';
        }
        return `已加载 ${added} 张图片到上下文，请查看后回答。`;
      }
      case 'read_channel_history': {
        if (!ctx.channelId) return '无法读取频道历史(缺少频道上下文)。';
        const cfg = getConfig().ai.summary;
        const maxC = cfg?.maxMessagesPerChannel ?? 500;
        const def = cfg?.defaultCount ?? 100;
        let count =
          args.count === undefined || args.count === null ? def : parseInt(String(args.count), 10);
        if (!isFinite(count) || count < 1) count = def;
        count = Math.min(count, maxC);

        let msgs = getRecentChannelMessages(ctx.platform, ctx.channelId, count, ctx.excludeMessageId);
        if (msgs.length < count && ctx.backfill) {
          try {
            await ctx.backfill(Math.min(count + (ctx.excludeMessageId ? 1 : 0), maxC));
          } catch (e) {
            console.warn('[AI] 频道历史补全失败:', (e as Error).message);
          }
          msgs = getRecentChannelMessages(ctx.platform, ctx.channelId, count, ctx.excludeMessageId);
        }
        if (msgs.length === 0) return '这个频道还没有可读取的消息。';
        const hasImages = msgs.some((m) => m.images && m.images.length > 0);
        const hint = hasImages
          ? '（消息里的图片以 [图片: 链接] 标注；若需看图才能理解或作答，可调用 read_image 传入这些链接）\n'
          : '';
        return `(本频道最近 ${msgs.length} 条记录，时间从旧到新)\n` + hint + formatForSummary(msgs);
      }
      case 'recall_memory': {
        return recallMemories(ctx.platform, ctx.username, args.query || '');
      }
      case 'save_memory': {
        if (!args.key || !args.value) return 'save_memory 需要 key 和 value';
        const res = saveMemory(
          ctx.platform,
          ctx.username,
          args.key,
          args.value,
          args.weight
        );
        return `已${res.action === 'created' ? '记住' : '更新'}: ${res.key}`;
      }
      case 'update_memory': {
        if (!args.key) return 'update_memory 需要 key';
        const r = updateMemory(ctx.platform, ctx.username, args.key, args.value, args.weight);
        if (r === 'updated') return `已更新记忆: ${args.key}`;
        if (r === 'no-fields') return `记忆 ${args.key} 已存在，但未提供要更新的内容`;
        return `没有找到记忆: ${args.key} (可改用 save_memory)`;
      }
      case 'forget_memory': {
        if (!args.key) return 'forget_memory 需要 key';
        const ok = deleteMemory(ctx.platform, ctx.username, args.key);
        return ok ? `已删除记忆: ${args.key}` : `没有找到记忆: ${args.key}`;
      }
      default:
        return `未知工具: ${name}`;
    }
  } catch (e) {
    return `工具 ${name} 执行失败: ${(e as Error).message}`;
  }
}