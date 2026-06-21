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

export interface AccountsConfig {
    telegram: TelegramConfig[];
    facebook: FacebookConfig[];
    youtube: YouTubeConfig[];
    whatsapp: WhatsAppConfig[];
}

export interface PublishResult {
    platform: string;
    name: string;
    url: string | null;
}