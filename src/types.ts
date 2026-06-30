export interface Tweet {
  id: string;
  author: string;
  authorName: string;
  content: string;
  url: string;
  publishedAt: Date;
  mediaUrls: string[];
  isRetweet: boolean;
  isReply: boolean;
}

export interface FilterConfig {
  keywords?: {
    include?: string[];
    exclude?: string[];
  };
  engagement?: {
    minLikes?: number;
    minRetweets?: number;
    minReplies?: number;
  };
  media?: {
    requireMedia?: boolean;
    allowedTypes?: ('image' | 'video' | 'gif')[];
  };
  excludeRetweets?: boolean;
  excludeReplies?: boolean;
}

export interface UserConfig {
  username: string;
  displayName?: string;
  filters?: FilterConfig;
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  adminChannelId?: string;
  approveRoleId?: string;
  embedColor?: string;
}

export interface TelegramTarget {
  chatId: string;
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  adminChatIds?: string[];
  parseMode?: 'HTML' | 'Markdown';
  apiRoot?: string;
}

export interface TwitterConfig {
  enabled?: boolean;
  authToken: string;
  ct0: string;
  username?: string;
  password?: string;
  email?: string;
  totpSecret?: string;
}

export interface AIWebSearchConfig {
  enabled: boolean;
  provider?: 'duckduckgo' | 'tavily' | 'serper' | 'searxng' | 'brave';
  apiKey?: string;
  baseUrl?: string;
  maxResults?: number;
}

export interface AISummaryConfig {
  enabled: boolean;
  maxMessagesPerChannel?: number;
  defaultCount?: number;
}

export interface AIMemoryConfig {
  enabled: boolean;
  maxProfileItems?: number;
  maxProfileChars?: number;
  recentTurns?: number;
  recallLimit?: number;
  logConversations?: boolean;
  maxConversationsPerUser?: number;
}

export interface AIConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  allowedGuildIds?: string[];
  maxToolIterations?: number;
  reactions?: boolean;
  // 单张图片内联(base64)时允许的原始字节上限；超过则跳过该图
  maxImageBytes?: number;
  // 单次请求所有内联图片的原始字节总预算；防止请求体过大被网关 400
  maxTotalImageBytes?: number;
  webSearch?: AIWebSearchConfig;
  memory?: AIMemoryConfig;
  summary?: AISummaryConfig;
}

export interface WebUIConfig {
  enabled: boolean;
  port: number;
  host: string;
  password?: string;
}

export interface AppConfig {
  users?: UserConfig[];
  discord: DiscordConfig;
  telegram: TelegramConfig;
  twitter: TwitterConfig;
  webui: WebUIConfig;
  ai: AIConfig;
  enableApproval: boolean;
  sendAsImage: boolean;
  xToImageApiUrl?: string;
  xToImageApiToken?: string;
  xToImageApiTheme?: 'light' | 'dim' | 'dark';
  imageCacheTtlMinutes: number;
  pollIntervalMinutes: number;
  maxPostsPerFetch: number;
  maxTweetAgeMinutes: number;
  groups?: GroupConfig[];
}

export interface GroupTelegramConfig {
  chatId: string;
  targets?: Record<string, { chatId: string }>;
}

export interface GroupDiscordConfig {
  channelId: string;
  r14ChannelId?: string;
}

export interface GroupApprovalConfig {
  telegramAdminChatIds?: string[];
  discordAdminChannelId?: string;
  discordApproveRoleId?: string;
}

export interface GroupConfig {
  name: string;
  users?: UserConfig[];
  telegram?: GroupTelegramConfig;
  discord?: GroupDiscordConfig;
  approval?: GroupApprovalConfig;
  blockedUsers?: string[];
}

export interface ProcessedTweet extends Tweet {
  matchedUser: UserConfig;
  passedFilters: boolean;
  filterReasons: string[];
}
