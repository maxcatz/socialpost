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
    channels: string[];     // public source channels: usernames without @ (read via https://t.me/s/<name>)
    geminiUrl?: string;     // chat or Gem URL, default https://gemini.google.com/app
    sameChat?: boolean;     // translate all posts in one Gemini chat (default true); its URL is kept in .gemini_chat
    prompt?: string;        // text prepended to the source post
    limit?: number;         // max messages per channel per run (default 10)
    latestOnly?: boolean;   // process only the newest post of each channel, skip older ones
    pollInterval?: number;  // --watch: seconds between checks (default 60)
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