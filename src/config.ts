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

const DATA_CONFIG_CANDIDATES = [
  'data/config.yaml',
  'data/config.yml',
  'data/config.toml',
  'data/config.json',
];

export function findConfigFile(): string {
  for (const candidate of DATA_CONFIG_CANDIDATES) {
    const fullPath = path.join(BASE_DIR, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = path.join(BASE_DIR, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  throw new Error(
    `找不到配置文件。支持的格式: ${CONFIG_CANDIDATES.join(', ')}`
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
      throw new Error(`不支持的配置格式: ${ext}`);
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
      enabled: rawConfig.twitter?.enabled ?? true,
      authToken: process.env.TWITTER_AUTH_TOKEN || rawConfig.twitter?.authToken || '',
      ct0: process.env.TWITTER_CT0 || rawConfig.twitter?.ct0 || '',
      username: process.env.TWITTER_USERNAME || rawConfig.twitter?.username,
      password: process.env.TWITTER_PASSWORD || rawConfig.twitter?.password,
      email: process.env.TWITTER_EMAIL || rawConfig.twitter?.email,
      totpSecret: process.env.TWITTER_TOTP_SECRET || rawConfig.twitter?.totpSecret,
    },
    ai: {
      enabled: rawConfig.ai?.enabled ?? false,
      apiUrl: process.env.AI_API_URL || rawConfig.ai?.apiUrl || 'https://api.openai.com/v1',
      apiKey: process.env.AI_API_KEY || rawConfig.ai?.apiKey || '',
      model: rawConfig.ai?.model || 'gpt-3.5-turbo',
      systemPrompt: rawConfig.ai?.systemPrompt || '你是一个有帮助的助手。',
      maxTokens: rawConfig.ai?.maxTokens ?? 1024,
      temperature: rawConfig.ai?.temperature ?? 0.7,
      allowedGuildIds: rawConfig.ai?.allowedGuildIds ?? [],
      maxToolIterations: rawConfig.ai?.maxToolIterations ?? 8,
      reactions: rawConfig.ai?.reactions ?? true,
      webSearch: {
        enabled: rawConfig.ai?.webSearch?.enabled ?? false,
        provider: rawConfig.ai?.webSearch?.provider || 'duckduckgo',
        apiKey: process.env.AI_WEB_SEARCH_API_KEY || rawConfig.ai?.webSearch?.apiKey || '',
        baseUrl: rawConfig.ai?.webSearch?.baseUrl || '',
        maxResults: rawConfig.ai?.webSearch?.maxResults ?? 5,
      },
      memory: {
        enabled: rawConfig.ai?.memory?.enabled ?? false,
        maxProfileItems: rawConfig.ai?.memory?.maxProfileItems ?? 12,
        maxProfileChars: rawConfig.ai?.memory?.maxProfileChars ?? 800,
        recentTurns: rawConfig.ai?.memory?.recentTurns ?? 6,
        recallLimit: rawConfig.ai?.memory?.recallLimit ?? 8,
        logConversations: rawConfig.ai?.memory?.logConversations ?? true,
        maxConversationsPerUser: rawConfig.ai?.memory?.maxConversationsPerUser ?? 500,
      },
      summary: {
        enabled: rawConfig.ai?.summary?.enabled ?? false,
        maxMessagesPerChannel: rawConfig.ai?.summary?.maxMessagesPerChannel ?? 500,
        defaultCount: rawConfig.ai?.summary?.defaultCount ?? 100,
      },
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
  console.log(`配置已从 ${filePath} 加载`);
  return config;
}

function validateConfig(cfg: AppConfig): void {
  const twitterEnabled = cfg.twitter.enabled !== false;

  if (!cfg.groups || cfg.groups.length === 0) {
    if (twitterEnabled) {
      throw new Error('未配置群组, 至少需要一个包含用户的群组。');
    }
  } else {
    let hasAnyUser = false;
    const names = new Set<string>();

    for (const g of cfg.groups) {
      if (!g.name) {
        throw new Error('每个群组必须有名称');
      }
      if (names.has(g.name)) {
        throw new Error(`群组名称重复: ${g.name}`);
      }
      names.add(g.name);

      if (g.users && g.users.length > 0) {
        hasAnyUser = true;
      }

      if (g.telegram && !g.telegram.chatId) {
        throw new Error(`Group "${g.name}" has telegram config but no chatId`);
      }
      if (g.discord && !g.discord.channelId) {
        throw new Error(`Group "${g.name}" has discord config but no channelId`);
      }
    }

    if (twitterEnabled && !hasAnyUser) {
      throw new Error('At least one group must have users configured');
    }

    const hasWildcardGroup = cfg.groups.some(g => g.users?.some(u => u.username === '*'));
    const hasDefaultUsers = (cfg.users || []).length > 0;
    if (twitterEnabled && hasWildcardGroup && !hasDefaultUsers) {
      throw new Error('Groups use wildcard "*" but no top-level users are configured');
    }
  }

  if (cfg.discord.enabled) {
    if (!cfg.discord.token) {
      throw new Error('Discord is enabled but token is missing');
    }
  }

  if (cfg.telegram.enabled) {
    if (!cfg.telegram.token) {
      throw new Error('Telegram is enabled but token is missing');
    }
  }

  const hasCookies = cfg.twitter.authToken && cfg.twitter.ct0;
  const hasLogin = cfg.twitter.username && cfg.twitter.password;

  if (!hasCookies && !hasLogin) {
    console.warn('未配置 Twitter 认证, 将使用访客模式 (速率和访问受限)');
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

  if (cfg.ai.enabled) {
    if (!cfg.ai.apiKey) {
      console.warn('AI 聊天已启用但未配置 API Key，将禁用 AI 聊天');
      cfg.ai.enabled = false;
    }
    if (!cfg.ai.apiUrl) {
      cfg.ai.apiUrl = 'https://api.openai.com/v1';
    }
    if (!cfg.ai.model) {
      cfg.ai.model = 'gpt-3.5-turbo';
    }
  }

  if (cfg.enableApproval) {
    const hasGroupAdmins = cfg.groups?.some(g =>
      (g.telegram && g.approval?.telegramAdminChatIds?.length) ||
      (g.discord && g.approval?.discordAdminChannelId)
    );

    if (!hasGroupAdmins) {
      console.warn('审批模式已启用但未配置管理员, 正在禁用审批');
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
  const defaultUsers = cfg.users || [];
  const groups = cfg.groups || [];
  return groups.map(g => {
    if (!g.users) return g;
    const hasWildcard = g.users.some(u => u.username === '*');
    if (!hasWildcard) return g;
    const filtered = g.users.filter(u => u.username !== '*');
    return { ...g, users: [...filtered, ...defaultUsers] };
  });
}

export function getAllMonitoredUsers(): Array<{ username: string; groups: string[] }> {
  const groups = getEffectiveGroups();
  const userMap = new Map<string, Set<string>>();

  for (const g of groups) {
    const users = g.users || [];
    for (const u of users) {
      if (!userMap.has(u.username)) {
        userMap.set(u.username, new Set());
      }
      userMap.get(u.username)!.add(g.name);
    }
  }

  return Array.from(userMap.entries()).map(([username, groupSet]) => ({
    username,
    groups: Array.from(groupSet),
  }));
}

export function getGroupNamesForUser(username: string): string[] {
  const groups = getEffectiveGroups();
  const names: string[] = [];

  for (const g of groups) {
    const users = g.users || [];
    if (users.some(u => u.username === username)) {
      names.push(g.name);
    }
  }

  return names;
}

export function isUserInGroup(username: string, groupName: string): boolean {
  const group = getEffectiveGroups().find(g => g.name === groupName);
  if (!group) return false;
  const users = group.users || [];
  return users.some(u => u.username === username);
}

export function getConfigPath(): string | null {
  return loadedConfigPath;
}

export function saveConfig(newConfig: AppConfig): void {
  if (!loadedConfigPath || !rawConfigData) {
    throw new Error('没有加载配置文件');
  }

  rawConfigData.discord = newConfig.discord;
  rawConfigData.telegram = newConfig.telegram;
  rawConfigData.twitter = newConfig.twitter;
  rawConfigData.webui = newConfig.webui;
  rawConfigData.ai = newConfig.ai;
  rawConfigData.enableApproval = newConfig.enableApproval;
  rawConfigData.sendAsImage = newConfig.sendAsImage;
  rawConfigData.xToImageApiUrl = newConfig.xToImageApiUrl;
  rawConfigData.xToImageApiToken = newConfig.xToImageApiToken;
  rawConfigData.xToImageApiTheme = newConfig.xToImageApiTheme;
  rawConfigData.imageCacheTtlMinutes = newConfig.imageCacheTtlMinutes;
  rawConfigData.pollIntervalMinutes = newConfig.pollIntervalMinutes;
  rawConfigData.maxPostsPerFetch = newConfig.maxPostsPerFetch;
  rawConfigData.maxTweetAgeMinutes = newConfig.maxTweetAgeMinutes;
  rawConfigData.users = newConfig.users;
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
      throw new Error(`不支持的保存配置格式: ${ext}`);
  }

  try {
    fs.writeFileSync(loadedConfigPath, content, 'utf-8');
  } catch (err: any) {
    if (err.code === 'EROFS') {
      const fallback = path.join(BASE_DIR, DATA_CONFIG_CANDIDATES[0]);
      const fallbackDir = path.dirname(fallback);
      fs.mkdirSync(fallbackDir, { recursive: true });
      fs.writeFileSync(fallback, content, 'utf-8');
      loadedConfigPath = fallback;
      console.log(`配置文件只读, 已保存至 ${fallback}`);
    } else {
      throw err;
    }
  }

  config = newConfig;
  console.log(`配置已保存至 ${loadedConfigPath}`);
}

export function reloadConfig(): AppConfig {
  config = null;
  rawConfigData = null;
  loadedConfigPath = null;
  return loadConfig();
}
