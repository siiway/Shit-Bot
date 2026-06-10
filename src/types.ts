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
  channelId: string;
  adminChannelId?: string;
  r14ChannelId?: string;
  approveRoleId?: string;
  embedColor?: string;
}

export interface TelegramTarget {
  chatId: string;
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  chatId: string;
  adminChatIds?: string[];
  targets?: Record<string, TelegramTarget>;
  parseMode?: 'HTML' | 'Markdown';
  apiRoot?: string;
}

export interface TwitterConfig {
  authToken: string;
  ct0: string;
  username?: string;
  password?: string;
  email?: string;
  totpSecret?: string;
}

export interface WebUIConfig {
  enabled: boolean;
  port: number;
  host: string;
  password?: string;
}

export interface AppConfig {
  users: UserConfig[];
  discord: DiscordConfig;
  telegram: TelegramConfig;
  twitter: TwitterConfig;
  webui: WebUIConfig;
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
  telegram?: GroupTelegramConfig;
  discord?: GroupDiscordConfig;
  approval?: GroupApprovalConfig;
}

export interface ProcessedTweet extends Tweet {
  matchedUser: UserConfig;
  passedFilters: boolean;
  filterReasons: string[];
}
