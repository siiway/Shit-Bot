import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { AppConfig, GroupConfig } from './types';

const CONFIG_CANDIDATES = [
  'config.yaml',
  'config.yml',
  'config.toml',
  'config.json',
];

function resolveBaseDir(): string {
  const cwd = process.cwd();
  for (const candidate of CONFIG_CANDIDATES) {
    if (fs.existsSync(path.join(cwd, candidate))) return cwd;
  }
  return path.join(__dirname, '..');
}

dotenv.config();

const BASE_DIR = resolveBaseDir();

let config: AppConfig | null = null;
let loadedConfigPath: string | null = null;
let rawConfigData: Record<string, any> | null = null;

export function findConfigFile(): string {
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = path.join(BASE_DIR, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  throw new Error(
    `No config file found. Supported: ${CONFIG_CANDIDATES.join(', ')}`
  );
}

function parseConfigFile(filePath: string): Record<string, any> {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');

  switch (ext) {
    case '.yaml':
    case '.yml':
      return parseYaml(content) as Record<string, any>;
    case '.toml':
      return parseToml(content);
    case '.json':
      return JSON.parse(content);
    default:
      throw new Error(`Unsupported config format: ${ext}`);
  }
}

export function loadConfig(configPath?: string): AppConfig {
  if (config) {
    return config;
  }

  const filePath = configPath || findConfigFile();
  rawConfigData = parseConfigFile(filePath);
  const rawConfig = rawConfigData;
  loadedConfigPath = filePath;

  const loadedConfig = {
    ...rawConfig,
    discord: {
      ...rawConfig.discord,
      token: process.env.DISCORD_TOKEN || rawConfig.discord?.token,
    },
    telegram: {
      ...rawConfig.telegram,
      token: process.env.TELEGRAM_TOKEN || rawConfig.telegram?.token,
    },
    twitter: {
      authToken: process.env.TWITTER_AUTH_TOKEN || rawConfig.twitter?.authToken || '',
      ct0: process.env.TWITTER_CT0 || rawConfig.twitter?.ct0 || '',
      username: process.env.TWITTER_USERNAME || rawConfig.twitter?.username,
      password: process.env.TWITTER_PASSWORD || rawConfig.twitter?.password,
      email: process.env.TWITTER_EMAIL || rawConfig.twitter?.email,
      totpSecret: process.env.TWITTER_TOTP_SECRET || rawConfig.twitter?.totpSecret,
    },
    webui: {
      enabled: rawConfig.webui?.enabled ?? true,
      port: rawConfig.webui?.port ?? 3000,
      host: rawConfig.webui?.host ?? '0.0.0.0',
      password: rawConfig.webui?.password ?? '',
    },
    xToImageApiUrl: process.env.X_TO_IMAGE_API_URL || rawConfig.xToImageApiUrl,
    xToImageApiToken: process.env.X_TO_IMAGE_API_TOKEN || rawConfig.xToImageApiToken,
    xToImageApiTheme: process.env.X_TO_IMAGE_API_THEME as 'light' | 'dim' | 'dark' | undefined || rawConfig.xToImageApiTheme,
  } as AppConfig;

  validateConfig(loadedConfig);
  config = loadedConfig;
  console.log(`Configuration loaded from ${filePath}`);
  return config;
}

function validateConfig(cfg: AppConfig): void {
  if (!cfg.users || cfg.users.length === 0) {
    throw new Error('No users configured to monitor');
  }

  if (cfg.discord.enabled && (!cfg.discord.token || !cfg.discord.channelId)) {
    throw new Error('Discord is enabled but token or channelId is missing');
  }

  if (cfg.telegram.enabled && (!cfg.telegram.token || !cfg.telegram.chatId)) {
    throw new Error('Telegram is enabled but token or chatId is missing');
  }

  const hasCookies = cfg.twitter.authToken && cfg.twitter.ct0;
  const hasLogin = cfg.twitter.username && cfg.twitter.password;

  if (!hasCookies && !hasLogin) {
    console.warn('No Twitter auth configured, will use guest mode (limited rate/access)');
  }

  if (!cfg.pollIntervalMinutes || cfg.pollIntervalMinutes < 1) {
    cfg.pollIntervalMinutes = 5;
  }

  if (!cfg.maxPostsPerFetch || cfg.maxPostsPerFetch < 1) {
    cfg.maxPostsPerFetch = 20;
  }

  if (!cfg.maxTweetAgeMinutes || cfg.maxTweetAgeMinutes < 1) {
    cfg.maxTweetAgeMinutes = 60;
  }

  if (!cfg.imageCacheTtlMinutes || cfg.imageCacheTtlMinutes < 1) {
    cfg.imageCacheTtlMinutes = 60;
  }

  if (cfg.groups && cfg.groups.length > 0) {
    const names = new Set<string>();
    for (const g of cfg.groups) {
      if (!g.name) {
        throw new Error('Each group must have a name');
      }
      if (names.has(g.name)) {
        throw new Error(`Duplicate group name: ${g.name}`);
      }
      names.add(g.name);

      if (g.telegram && !g.telegram.chatId) {
        throw new Error(`Group "${g.name}" has telegram config but no chatId`);
      }
      if (g.discord && !g.discord.channelId) {
        throw new Error(`Group "${g.name}" has discord config but no channelId`);
      }
    }
  }

  if (cfg.enableApproval) {
    const hasRootAdmins =
      (cfg.telegram.enabled && cfg.telegram.adminChatIds && cfg.telegram.adminChatIds.length > 0) ||
      (cfg.discord.enabled && cfg.discord.adminChannelId);

    const hasGroupAdmins = cfg.groups?.some(g =>
      (g.telegram && g.approval?.telegramAdminChatIds?.length) ||
      (g.discord && g.approval?.discordAdminChannelId)
    );

    if (!hasRootAdmins && !hasGroupAdmins) {
      console.warn('Approval enabled but no admin configured, disabling approval');
      cfg.enableApproval = false;
    }
  }
}

export function getConfig(): AppConfig {
  if (!config) {
    return loadConfig();
  }
  return config;
}

export function getEffectiveGroups(): GroupConfig[] {
  const cfg = getConfig();
  if (cfg.groups && cfg.groups.length > 0) {
    return cfg.groups;
  }

  const groups: GroupConfig[] = [{
    name: 'default',
    telegram: cfg.telegram.enabled ? {
      chatId: cfg.telegram.chatId,
      targets: cfg.telegram.targets,
    } : undefined,
    discord: cfg.discord.enabled ? {
      channelId: cfg.discord.channelId,
      r14ChannelId: cfg.discord.r14ChannelId,
    } : undefined,
    approval: {
      telegramAdminChatIds: cfg.telegram.adminChatIds,
      discordAdminChannelId: cfg.discord.adminChannelId,
      discordApproveRoleId: cfg.discord.approveRoleId,
    },
  }];

  return groups;
}

export function getConfigPath(): string | null {
  return loadedConfigPath;
}

export function saveConfig(newConfig: AppConfig): void {
  if (!loadedConfigPath || !rawConfigData) {
    throw new Error('No config file loaded');
  }

  rawConfigData.users = newConfig.users;
  rawConfigData.discord = newConfig.discord;
  rawConfigData.telegram = newConfig.telegram;
  rawConfigData.twitter = newConfig.twitter;
  rawConfigData.webui = newConfig.webui;
  rawConfigData.enableApproval = newConfig.enableApproval;
  rawConfigData.sendAsImage = newConfig.sendAsImage;
  rawConfigData.xToImageApiUrl = newConfig.xToImageApiUrl;
  rawConfigData.xToImageApiToken = newConfig.xToImageApiToken;
  rawConfigData.xToImageApiTheme = newConfig.xToImageApiTheme;
  rawConfigData.imageCacheTtlMinutes = newConfig.imageCacheTtlMinutes;
  rawConfigData.pollIntervalMinutes = newConfig.pollIntervalMinutes;
  rawConfigData.maxPostsPerFetch = newConfig.maxPostsPerFetch;
  rawConfigData.maxTweetAgeMinutes = newConfig.maxTweetAgeMinutes;
  rawConfigData.groups = newConfig.groups;

  const ext = path.extname(loadedConfigPath).toLowerCase();
  let content: string;

  switch (ext) {
    case '.yaml':
    case '.yml':
      content = stringifyYaml(rawConfigData);
      break;
    case '.json':
      content = JSON.stringify(rawConfigData, null, 2);
      break;
    default:
      throw new Error(`Unsupported config format for saving: ${ext}`);
  }

  fs.writeFileSync(loadedConfigPath, content, 'utf-8');

  config = newConfig;
  console.log(`Configuration saved to ${loadedConfigPath}`);
}

export function reloadConfig(): AppConfig {
  config = null;
  rawConfigData = null;
  loadedConfigPath = null;
  return loadConfig();
}
