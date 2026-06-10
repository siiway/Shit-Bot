import cron from 'node-cron';
import * as http from 'http';
import { loadConfig, getConfig } from './config';
import { fetchAllTweets } from './rss/fetcher';
import { filterTweets, getPassedTweets } from './filters';
import { initDiscord, shutdownDiscord, getDiscordClient } from './bots/discord';
import { initTelegram, shutdownTelegram, getTelegramBot } from './bots/telegram';
import { initDatabase, closeDatabase, markMultipleAsSent, cleanupOldRecords, cleanupExpiredImages } from './storage';
import { sendForApproval, sendToAllGroups, handleTelegramApproval, handleDiscordApproval, setTelegramBot, setDiscordClient } from './approval';
import { initRenderer, shutdownRenderer } from './renderer';
import { initTwitterClient, loginWithCredentials } from './twitter';
import { startWebServer } from './web/server';
import { Tweet } from './types';

let isRunning = false;
let cronJob: cron.ScheduledTask | null = null;
let webServer: http.Server | null = null;

async function processAndSendTweets(username: string, tweets: Tweet[]): Promise<void> {
  const config = getConfig();
  const userConfig = config.users.find((u) => u.username === username);

  if (!userConfig) {
    console.warn(`No config found for user @${username}`);
    return;
  }

  const processed = filterTweets(tweets, userConfig);
  const passed = getPassedTweets(processed);

  if (passed.length === 0) {
    return;
  }

  console.log(`Processing ${passed.length} tweets from @${username}`);

  if (config.enableApproval) {
    for (const tweet of passed) {
      await sendForApproval(tweet);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } else {
    for (const tweet of passed) {
      await sendToAllGroups(tweet);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    markMultipleAsSent(passed.map(t => ({
      id: t.id,
      author: t.author,
      content: t.content,
      url: t.url,
    })));
  }
}

async function pollAndSend(): Promise<void> {
  if (isRunning) {
    console.log('Previous poll still running, skipping...');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    console.log(`\n[${new Date().toISOString()}] Starting poll...`);

    cleanupExpiredImages(getConfig().imageCacheTtlMinutes);

    const allTweets = await fetchAllTweets();

    let totalProcessed = 0;
    let totalPassed = 0;

    for (const [username, tweets] of allTweets) {
      await processAndSendTweets(username, tweets);
      totalProcessed += tweets.length;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Poll completed in ${elapsed}s`);
  } catch (error) {
    console.error('Error during poll:', error);
  } finally {
    isRunning = false;
  }
}

async function start(): Promise<void> {
  console.log('=== X/Twitter Monitor Bot ===\n');

  try {
    loadConfig();
    console.log('Configuration loaded');
  } catch (error) {
    console.error('Failed to load configuration:', error);
    process.exit(1);
  }

  initDatabase();

  const config = getConfig();

  if (config.sendAsImage) {
    console.log('Initializing image renderer...');
    const rendererReady = await initRenderer();
    if (!rendererReady) {
      console.warn('Image renderer failed to initialize, will send as text');
    }
  }

  console.log('Initializing Twitter client...');
  let twitterReady = await initTwitterClient();

  if (!twitterReady && config.twitter.username && config.twitter.password) {
    console.log('Cookies not valid, attempting login with credentials...');
    try {
      const result = await loginWithCredentials();
      config.twitter.authToken = result.authToken;
      config.twitter.ct0 = result.ct0;
      twitterReady = await initTwitterClient();
    } catch (error) {
      console.error('Login failed:', error);
    }
  }

  if (!twitterReady) {
    console.error('Twitter client failed to initialize. Exiting.');
    process.exit(1);
  }

  let discordReady = false;
  let telegramReady = false;

  if (config.discord.enabled) {
    discordReady = await initDiscord();
    if (!discordReady) {
      console.warn('Discord initialization failed');
    }
  }

  if (config.telegram.enabled) {
    telegramReady = await initTelegram();
    if (!telegramReady) {
      console.warn('Telegram initialization failed');
    } else {
      const telegramBot = getTelegramBot();
      if (telegramBot) {
        setTelegramBot(telegramBot);
        
        telegramBot.action(/^approve_/, handleTelegramApproval);
        telegramBot.action(/^reject_/, handleTelegramApproval);
        telegramBot.action(/^post_/, handleTelegramApproval);
        
        telegramBot.launch();
        console.log('Telegram bot launched with approval handlers');
      }
    }
  }

  if (config.discord.enabled && discordReady) {
    const discordClient = getDiscordClient();
    if (discordClient) {
      setDiscordClient(discordClient);

      discordClient.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;
        const customId = interaction.customId;
        if (customId.startsWith('approve_') || customId.startsWith('reject_') || customId.startsWith('post_')) {
          await handleDiscordApproval(interaction);
        }
      });
      console.log('Discord approval handlers registered');
    }
  }

  if (config.discord.enabled && !discordReady && config.telegram.enabled && !telegramReady) {
    console.error('Both Discord and Telegram failed to initialize. Exiting.');
    process.exit(1);
  }

  console.log(`\nMonitoring ${config.users.length} users:`);
  for (const user of config.users) {
    console.log(`  - @${user.username}`);
  }

  console.log(`\nPoll interval: ${config.pollIntervalMinutes} minute(s)`);
  webServer = startWebServer();
  console.log('Starting initial poll...\n');

  await pollAndSend();

  const cronExpression = `*/${config.pollIntervalMinutes} * * * *`;
  cronJob = cron.schedule(cronExpression, pollAndSend);
  console.log(`Cron job scheduled: ${cronExpression}`);
}

async function shutdown(): Promise<void> {
  console.log('\nShutting down...');

  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

  if (webServer) {
    webServer.close();
    webServer = null;
  }

  await shutdownDiscord();
  await shutdownTelegram();
  await shutdownRenderer();
  closeDatabase();

  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
