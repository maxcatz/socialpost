export interface PostData {
    title?: string;
    image?: string;
    facebook_tags?: string;
    content: string; // The post text with the title already included
}

export interface TelegramConfig {
    name: string;
    chatId: string;
    tokenEnv: string; // Имя переменной из .env
}

export interface FacebookConfig {
    name: string;
    pageId: string;
    tokenEnv: string; // Имя переменной из .env
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