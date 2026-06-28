import { Client, GatewayIntentBits, TextChannel, EmbedBuilder, AttachmentBuilder, Message, REST, Routes, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { ProcessedTweet } from '../types';
import { getConfig } from '../config';
import { formatContentForPlatform } from '../filters';
import { renderTweetImage } from '../renderer';
import { storeSentMessage, getRecentSentMessages, deleteSentMessage, getSentMessageByMessageId } from '../storage';
import { chatWithAI, isAiEnabled } from '../ai/chat';
import { listMemories, deleteMemory } from '../ai/memory';
import { recordChannelMessage, getChannelMessageCount, getOldestStoredMessageId } from '../ai/summary';

let client: Client | null = null;
let targetChannel: TextChannel | null = null;

function callWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('请求超时')), timeoutMs);
    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function getDiscordClient(): Client | null {
  return client;
}

export async function initDiscord(): Promise<boolean> {
  const config = getConfig();

  if (!config.discord.enabled) {
    console.log('Discord 已在配置中禁用');
    return false;
  }

  try {
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });

    await client.login(config.discord.token);

    console.log('Discord bot 已连接 (群组指定目标频道)');

    return true;
  } catch (error) {
    console.error('Discord 初始化失败:', error);
    client = null;
    targetChannel = null;
    return false;
  }
}

export async function sendToDiscord(tweet: ProcessedTweet, channelId?: string, asImage?: boolean, preRenderedImage?: Buffer, approvalId?: string): Promise<Message | null> {
  const config = getConfig();
  const sendImage = asImage ?? config.sendAsImage;

  if (!client) {
    console.error('Discord 未初始化');
    return null;
  }

  let sendTo: TextChannel | null = null;

  if (channelId) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        sendTo = channel as TextChannel;
      }
    } catch (e) {
      console.error(`获取 Discord 频道 ${channelId} 失败:`, e);
    }
  }

  if (!sendTo) {
    console.error(`Discord 频道不可用${channelId ? ` (${channelId})` : ""}`);
    return null;
  }

  try {
    let sentMessage: Message | null;

    if (sendImage) {
      const imageBuffer = preRenderedImage || await renderTweetImage(tweet);
      if (imageBuffer) {
        const buf = Buffer.from(imageBuffer);
        const attachment = new AttachmentBuilder(buf, { name: `tweet_${tweet.id}.png` });
        const embed = new EmbedBuilder()
          .setAuthor({ name: `@${tweet.author}`, url: `https://x.com/${tweet.author}` })
          .setDescription(`[🔗 在 X 上查看](${tweet.url})`)
          .setURL(tweet.url)
          .setImage(`attachment://tweet_${tweet.id}.png`)
          .setColor((config.discord.embedColor || '#1DA1F2') as `#${string}`)
          .setTimestamp(tweet.publishedAt);

        if (approvalId) {
          embed.setFooter({ text: `🆔 ${approvalId}` });
        }

        sentMessage = await sendWithRetry(sendTo, { embeds: [embed], files: [attachment] }, tweet.id);
        if (sentMessage) {
          storeSentMessage(sendTo.id, sentMessage.id, tweet.id);
          console.log(`[Discord] 以图片形式发送推文 ${tweet.id}${channelId ? ` (${channelId})` : ""}`);
          return sentMessage;
        }
      }
    }

    const embed = new EmbedBuilder()
      .setAuthor({ name: `@${tweet.author}`, url: `https://x.com/${tweet.author}`, iconURL: `https://unavatar.io/twitter/${tweet.author}` })
      .setDescription(formatContentForPlatform(tweet.content, 'discord'))
      .setURL(tweet.url)
      .setTimestamp(tweet.publishedAt)
      .setColor((config.discord.embedColor || '#1DA1F2') as `#${string}`);

    if (tweet.mediaUrls.length > 0 && tweet.mediaUrls[0]) {
      embed.setImage(tweet.mediaUrls[0]);
    }

    const footerParts: string[] = [];
    if (approvalId) footerParts.push(`🆔 ${approvalId}`);
    if (tweet.mediaUrls.length > 0) footerParts.push(`${tweet.mediaUrls.length} 个媒体附件`);
    if (footerParts.length > 0) {
      embed.setFooter({ text: footerParts.join(' | ') });
    }

    sentMessage = await sendWithRetry(sendTo, { embeds: [embed] }, tweet.id);
    if (sentMessage) {
      storeSentMessage(sendTo.id, sentMessage.id, tweet.id);
      console.log(`[Discord] 发送推文 ${tweet.id}${channelId ? ` (${channelId})` : ""}`);
      return sentMessage;
    }

    console.error(`[Discord] 推文 ${tweet.id} 发送失败, 所有重试均未成功`);
    return null;
  } catch (error) {
    console.error(`[Discord] 发送推文 ${tweet.id} 失败:`, error);
    return null;
  }
}

async function sendWithRetry(channel: TextChannel, payload: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] }, tweetId: string): Promise<Message | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await callWithTimeout(() => channel.send(payload), 15000);
      return msg;
    } catch (error) {
      console.error(`[Discord] 发送尝试 ${attempt}/3 失败, 推文 ${tweetId}:`, (error as Error).message);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
      }
    }
  }
  return null;
}

export async function sendBatchToDiscord(tweets: ProcessedTweet[]): Promise<number> {
  let sent = 0;

  for (const tweet of tweets) {
    const msg = await sendToDiscord(tweet);
    if (msg) {
      sent++;
    }
    
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return sent;
}

export async function recallMessages(channelId: string, count: number): Promise<number> {
  if (!client) return 0;

  const records = getRecentSentMessages(channelId, count);
  let deleted = 0;

  for (const record of records) {
    try {
      const channel = await client.channels.fetch(record.channel_id);
      if (channel && channel.isTextBased()) {
        const message = await (channel as TextChannel).messages.fetch(record.message_id);
        await message.delete();
        deleteSentMessage(record.message_id);
        deleted++;
      }
    } catch (error) {
      deleteSentMessage(record.message_id);
    }
  }

  return deleted;
}

export async function recallMessageById(messageId: string): Promise<boolean> {
  if (!client) return false;

  const record = getSentMessageByMessageId(messageId);

  if (record) {
    try {
      const channel = await client.channels.fetch(record.channel_id);
      if (channel && channel.isTextBased()) {
        const message = await (channel as TextChannel).messages.fetch(messageId);
        await message.delete();
        deleteSentMessage(messageId);
        return true;
      }
    } catch {}
    deleteSentMessage(messageId);
    return false;
  }

  for (const [, channel] of client.channels.cache) {
    if (!channel.isTextBased()) continue;
    try {
      const message = await (channel as TextChannel).messages.fetch(messageId);
      if (message.author.id === client.user?.id) {
        await message.delete();
        return true;
      }
    } catch {}
  }

  return false;
}

export async function registerDiscordCommands(): Promise<void> {
  if (!client) return;

  try {
    const rest = new REST({ version: '10' }).setToken(getConfig().discord.token);

    const commands = [
      {
        name: 'recall',
        description: '撤回 bot 发送的消息 (需要审批权限)',
        options: [
          {
            name: 'count',
            description: '撤回最近 N 条消息 (默认 5)',
            type: 4,
            required: false,
          },
          {
            name: 'message_id',
            description: '指定要撤回的消息 ID',
            type: 3,
            required: false,
          },
          {
            name: 'link',
            description: '指定要撤回的消息链接',
            type: 3,
            required: false,
          },
        ],
      },
      {
        name: '撤回消息',
        type: 3,
      },
      {
        name: 'memory',
        description: '查看 AI 对你的全部记忆',
      },
      {
        name: 'delete-memory',
        description: '直接删除指定 key 的记忆 (不经过 AI)',
        options: [
          {
            name: 'key',
            description: '要删除的记忆键 (可用 /memory 查看)',
            type: 3,
            required: true,
          },
        ],
      },
    ];

    await rest.put(
      Routes.applicationCommands(client.user!.id),
      { body: commands }
    );

    console.log('Discord 斜杠命令已注册');
  } catch (error) {
    console.error('Discord 命令注册失败:', error);
  }
}

export async function handleMemoryCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const username = interaction.user.username;
  const mems = listMemories('discord', username);
  if (mems.length === 0) {
    await interaction.reply({ content: '你还没有任何记忆。', flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = mems.map((m) => `key: ${m.key}，value: ${m.value}`);
  let body = `共 ${mems.length} 条记忆：\n` + lines.join('\n');
  if (body.length > 1900) body = body.slice(0, 1900) + '\n…（过长已截断）';
  await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
}

export async function handleDeleteMemoryCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const username = interaction.user.username;
  const key = interaction.options.getString('key', true);
  const ok = deleteMemory('discord', username, key);
  await interaction.reply({
    content: ok ? `已删除记忆：${key}` : `没有找到记忆：${key}（可用 /memory 查看现有键）`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function shutdownDiscord(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
    targetChannel = null;
    console.log('Discord bot 已断开');
  }
}

export function initDiscordAiChat(): boolean {
  if (!client || !isAiEnabled()) {
    if (client && !isAiEnabled()) {
      console.log('AI 聊天未启用，跳过 Discord AI 消息监听');
    }
    return false;
  }

  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;
    if (!client?.user) return;

    const guildAllowed = isAiAllowedGuild(message.guildId);

    if (guildAllowed && message.channel.isTextBased()) {
      const author = message.member?.displayName || message.author.username;
      recordChannelMessage('discord', message.channelId, message.id, author, message.cleanContent, message.createdTimestamp);
    }

    const botMentioned = message.mentions.has(client.user.id);
    if (!botMentioned) return;

    if (!guildAllowed) {
      console.log(`[AI] 服务器 ${message.guildId || 'DM'} 不在 AI 允许列表中，跳过`);
      return;
    }

    const content = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
      .trim();

    let imageUrls = extractImageUrls(message);
    const bareMention = !content && imageUrls.length === 0 && !message.reference?.messageId;

    if (bareMention && !getConfig().ai.summary?.enabled) {
      try {
        await message.reply('你好！请 @我 然后输入你的问题，我会尽力回答。');
      } catch (e) {
        // ignore
      }
      return;
    }

    let contextMessage: string | undefined;
    if (message.reference?.messageId) {
      try {
        if (message.channel.isTextBased()) {
          const refMsg = await message.channel.messages.fetch(message.reference.messageId);
          if (refMsg) {
            const refAuthor = refMsg.member?.displayName || refMsg.author.username;
            const refContent = refMsg.content.slice(0, 2000);
            contextMessage = `[${refAuthor}]: ${refContent}`;
            console.log(`[AI] 获取到引用消息 (${refAuthor}): ${refContent.slice(0, 80)}...`);
            const refImgs = extractImageUrls(refMsg);
            if (refImgs.length) imageUrls = [...imageUrls, ...refImgs].slice(0, 6);
          }
        }
      } catch (e) {
        console.error(`[AI] 获取引用消息失败 (messageId=${message.reference.messageId}):`, (e as Error).message);
      }
    } else if (message.reference) {
      console.warn(`[AI] 检测到 message.reference 但无 messageId:`, JSON.stringify(message.reference));
    }

    if (contextMessage) {
      console.log(`[AI] 带上下文回复 ${message.author.username} (引用: ${contextMessage.slice(0, 40)}...)`);
    }

    const displayName = message.member?.displayName || message.author.username;
    const summaryEnabled = !!getConfig().ai.summary?.enabled;
    const channel = message.channel;

    const stopTyping = channel.isTextBased() ? startTyping(channel as TextChannel) : () => {};

    let reply = '';
    let reactions: string[] = [];
    try {
      const res = await chatWithAI(content, {
        username: message.author.username,
        displayName,
        contextMessage,
        platform: 'discord',
        channelId: message.channelId,
        messageId: message.id,
        images: imageUrls.length ? imageUrls : undefined,
        bareMention,
        backfillChannel: summaryEnabled && channel.isTextBased()
          ? (target: number) => backfillChannelHistory(channel as TextChannel, message.channelId, target)
          : undefined,
      });
      reply = res.reply;
      reactions = res.reactions;
    } finally {
      stopTyping();
    }

    for (const emoji of reactions) {
      try {
        await message.react(emoji);
      } catch (e) {
        console.warn(`[AI] 贴表情失败 (${emoji}):`, (e as Error).message);
      }
    }

    await sendChunkedReply(message, reply);
    console.log(`[AI] 回复 ${message.author.username}: ${reply.slice(0, 60).replace(/\s+/g, ' ')}...`);
  });

  console.log('Discord AI 聊天监听器已注册');
  return true;
}

function isAiAllowedGuild(guildId: string | null): boolean {
  const allowed = getConfig().ai.allowedGuildIds;
  if (!allowed || allowed.length === 0) return true;
  return !!guildId && allowed.map(String).includes(guildId);
}

const exhaustedChannels = new Set<string>();

async function backfillChannelHistory(
  channel: TextChannel,
  channelId: string,
  targetTotal: number
): Promise<void> {
  let have = getChannelMessageCount('discord', channelId);
  if (have >= targetTotal) return;
  if (exhaustedChannels.has(channelId)) return;

  let before = getOldestStoredMessageId('discord', channelId) || undefined;
  let guard = 0;

  while (have < targetTotal && guard < 40) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) {
      exhaustedChannels.add(channelId);
      break;
    }

    const arr = [...batch.values()];
    for (const m of arr) {
      if (m.author.bot) continue;
      const author = m.member?.displayName || m.author.username;
      recordChannelMessage('discord', channelId, m.id, author, m.cleanContent, m.createdTimestamp);
    }
    before = arr[arr.length - 1].id;
    have = getChannelMessageCount('discord', channelId);
    guard++;

    if (batch.size < 100) {
      exhaustedChannels.add(channelId);
      break;
    }
  }

  console.log(`[AI] 频道 ${channelId} 历史补全至 ${have} 条 (目标 ${targetTotal})`);
}

function extractImageUrls(message: Message): string[] {
  const urls: string[] = [];
  for (const att of message.attachments.values()) {
    const ct = att.contentType?.toLowerCase() || '';
    const supported = ct
      ? ct === 'image/png' || ct === 'image/jpeg' || ct === 'image/webp'
      : /\.(png|jpe?g|webp)$/i.test(att.name || '');
    if (supported && att.url && (att.size ?? 0) <= 10 * 1024 * 1024) urls.push(att.url);
    if (urls.length >= 6) break;
  }
  return urls;
}

function startTyping(channel: TextChannel): () => void {
  const send = () => {
    channel.sendTyping().catch(() => {});
  };
  send();
  const timer = setInterval(send, 8000);
  return () => clearInterval(timer);
}

async function sendChunkedReply(message: Message, text: string): Promise<void> {
  const maxLen = 1900;
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let chunk = remaining.slice(0, maxLen);
    const lastNewline = chunk.lastIndexOf('\n');
    if (remaining.length > maxLen && lastNewline > maxLen / 2) {
      chunk = remaining.slice(0, lastNewline);
    }
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }

  try {
    for (const chunk of chunks) {
      await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
      if (chunks.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } catch (error) {
    console.error('Discord AI 回复发送失败:', error);
  }
}
