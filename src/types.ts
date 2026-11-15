export interface PostData {
    title?: string;
    media?: string;
    mimeType?: string;
    facebook_tags?: string;
    content: string; // The post text with the title already included
}

export interface TelegramConfig {
    name: string;
    chatId: string;
    tokenEnv: string;
    channelName: string;
}

export interface FacebookConfig {
    name: string;
    pageId: string;
    tokenEnv: string;
}

export interface YouTubeConfig {
    name: string;
    channelHandle: string;
}
export interface WhatsAppConfig {
    name: string;
    inviteLink: string;
}

export interface FacebookGroupConfig {
    name: string;
    groupId: string;
    url: string;
}

export interface RelayConfig {
    apiIdEnv: string;       // env var name for TG API ID
    apiHashEnv: string;     // env var name for TG API hash
    channels: string[];     // source channel names without @
    geminiUrl?: string;     // chat or Gem URL, default https://gemini.google.com/app
    prompt?: string;        // text prepended to the source post
    limit?: number;         // max messages per channel per run (default 10)
    latestOnly?: boolean;   // process only the newest post of each channel, skip older ones
}

export interface AccountsConfig {
    telegram: TelegramConfig[];
    facebook: FacebookConfig[];
    youtube: YouTubeConfig[];
    whatsapp: WhatsAppConfig[];
    groups?: FacebookGroupConfig[];
    relay?: RelayConfig;
}

export interface PublishResult {
    platform: string;
    name: string;
    url: string | null;
}