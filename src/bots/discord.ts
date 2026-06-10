import { Client, GatewayIntentBits, TextChannel, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { ProcessedTweet } from '../types';
import { getConfig } from '../config';
import { formatContentForPlatform } from '../filters';
import { renderTweetImage } from '../renderer';

let client: Client | null = null;
let targetChannel: TextChannel | null = null;

export function getDiscordClient(): Client | null {
  return client;
}

export async function initDiscord(): Promise<boolean> {
  const config = getConfig();

  if (!config.discord.enabled) {
    console.log('Discord is disabled in config');
    return false;
  }

  try {
    client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    await client.login(config.discord.token);

    if (config.discord.channelId) {
      const channel = await client.channels.fetch(config.discord.channelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Discord channel ${config.discord.channelId} not found or is not a text channel`);
      }
      targetChannel = channel as TextChannel;
      console.log(`Discord bot connected, targeting channel: ${targetChannel.name}`);
    } else {
      console.log('Discord bot connected (groups will specify target channels)');
    }

    return true;
  } catch (error) {
    console.error('Failed to initialize Discord:', error);
    client = null;
    targetChannel = null;
    return false;
  }
}

export async function sendToDiscord(tweet: ProcessedTweet, channelId?: string, asImage?: boolean, preRenderedImage?: Buffer): Promise<boolean> {
  const config = getConfig();
  const sendImage = asImage ?? config.sendAsImage;

  if (!client) {
    console.error('Discord not initialized');
    return false;
  }

  let sendTo: TextChannel | null = null;

  if (channelId) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        sendTo = channel as TextChannel;
      }
    } catch (e) {
      console.error(`Failed to fetch Discord channel ${channelId}:`, e);
    }
  } else {
    sendTo = targetChannel;
  }

  if (!sendTo) {
    console.error(`Discord channel not available${channelId ? ` for ${channelId}` : ''}`);
    return false;
  }

  try {
    if (sendImage) {
      const imageBuffer = preRenderedImage || await renderTweetImage(tweet);
      if (imageBuffer) {
        const attachment = new AttachmentBuilder(imageBuffer, { name: `tweet_${tweet.id}.png` });
        const embed = new EmbedBuilder()
          .setAuthor({ name: `@${tweet.author}`, url: `https://x.com/${tweet.author}` })
          .setDescription(`[🔗 View on X](${tweet.url})`)
          .setURL(tweet.url)
          .setImage(`attachment://tweet_${tweet.id}.png`)
          .setColor((config.discord.embedColor || '#1DA1F2') as `#${string}`)
          .setTimestamp(tweet.publishedAt);

        await sendTo.send({ embeds: [embed], files: [attachment] });
        console.log(`Sent tweet ${tweet.id} as image to Discord${channelId ? ` (${channelId})` : ''}`);
        return true;
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

    embed.setFooter({ text: `${tweet.mediaUrls.length} media attachment(s)` });

    await sendTo.send({ embeds: [embed] });
    console.log(`Sent tweet ${tweet.id} to Discord${channelId ? ` (${channelId})` : ''}`);
    return true;
  } catch (error) {
    console.error(`Failed to send tweet ${tweet.id} to Discord:`, error);
    return false;
  }
}

export async function sendBatchToDiscord(tweets: ProcessedTweet[]): Promise<number> {
  let sent = 0;

  for (const tweet of tweets) {
    const success = await sendToDiscord(tweet);
    if (success) {
      sent++;
    }
    
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return sent;
}

export async function shutdownDiscord(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
    targetChannel = null;
    console.log('Discord bot disconnected');
  }
}
