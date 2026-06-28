import { PostData, PublishResult, TelegramConfig } from '../types.js';
import { getEnvToken, getMedia, RunSafe } from './common.js';

interface TelegramResponse {
    ok: boolean;
    description?: string;
    result: {
        message_id: number;
    };
}

export class TelegramPublisher {
    @RunSafe('Telegram')
    static async publish(post: PostData, account: TelegramConfig): Promise<PublishResult> {
        console.log(`\n▶ Publishing to Telegram: [${account.name}] (Chat ID: ${account.chatId})...`);
        
        const token = getEnvToken(account.tokenEnv);
        const media = getMedia(post);
        let messageId: number;

        if (media) {
            const sendMedia = (caption?: string, replyId?: number) =>
                media.mimeType.startsWith('video')
                    ? this.sendVideo(token, account.chatId, media.buffer, caption, replyId)
                    : this.sendPhoto(token, account.chatId, media.buffer, caption, replyId);

            if (post.content.length <= 1024) {
                // Short text: Send media with caption
                messageId = await sendMedia(post.content);
            } else {
                // Long text: Send text first, then reply with media
                const textMessageId = await this.sendMessage(token, account.chatId, post.content);
                messageId = await sendMedia(undefined, textMessageId);
            }
        } else {
            // Text only post
            messageId = await this.sendMessage(token, account.chatId, post.content);
        }

        const postUrl = `https://t.me/${account.channelName}/${messageId}`;
        console.log(`✅ Text posted to [${account.name}]. Link: ${postUrl}`);
        return { platform: 'Telegram', name: account.name, url: postUrl };
    }

    private static async request(token: string, method: string, body: FormData | string, isJson = false): Promise<TelegramResponse> {
        const url = `https://api.telegram.org/bot${token}/${method}`;
        const headers: Record<string, string> = {};
        if (isJson) {
            headers['Content-Type'] = 'application/json';
        }

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: isJson ? body : (body as FormData)
        });

        const result = await res.json() as TelegramResponse;
        if (!result.ok) {
            throw new Error(result.description || 'Unknown Telegram API error');
        }
        return result;
    }

    private static async sendMessage(token: string, chatId: string, text: string): Promise<number> {
        const result = await this.request(
            token,
            'sendMessage',
            JSON.stringify({ chat_id: chatId, text: text.substring(0, 4096) }),
            true
        );
        return result.result.message_id;
    }

    private static async sendPhoto(token: string, chatId: string, photo: Buffer, caption?: string, replyId?: number): Promise<number> {
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('photo', new Blob([new Uint8Array(photo)]), 'image.jpg');
        if (caption) formData.append('caption', caption);
        if (replyId) formData.append('reply_to_message_id', replyId.toString());

        const result = await this.request(token, 'sendPhoto', formData);
        return result.result.message_id;
    }

    private static async sendVideo(token: string, chatId: string, video: Buffer, caption?: string, replyId?: number): Promise<number> {
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('video', new Blob([new Uint8Array(video)]), 'video.mp4');
        if (caption) formData.append('caption', caption);
        if (replyId) formData.append('reply_to_message_id', replyId.toString());

        const result = await this.request(token, 'sendVideo', formData);
        return result.result.message_id;
    }
}