import { PostData, PublishResult, TelegramConfig } from '../types.js';
import { getEnvToken, getMedia, RunSafe } from './common.js';
import { forwardFromAccount, sendVideoFromAccount } from '../sources/telegramApi.js';

const BOT_UPLOAD_LIMIT = 50 * 1024 * 1024;
const FILE_ID_WAIT = 2 * 60_000;

// file_id of big videos already passed to the bot, so the next channel does not upload it again
const fileIds = new Map<string, string>();

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
            // The bot can upload at most 50 MB; bigger videos go through your Telegram account (up to 2 GB)
            const viaAccount = media.mimeType.startsWith('video') && media.buffer.length > BOT_UPLOAD_LIMIT;
            const sendMedia = async (caption?: string, replyId?: number) =>
                viaAccount
                    ? this.sendVideo(token, account.chatId, await this.bigVideoFileId(token, post, media.buffer.length), caption, replyId)
                    : media.mimeType.startsWith('video')
                        ? this.sendVideo(token, account.chatId, media.buffer, caption, replyId)
                        : this.sendPhoto(token, account.chatId, media.buffer, caption, replyId);

            let textMessageId: number | undefined;
            try {
                if (post.content.length <= 1024) {
                    // Short text: Send media with caption
                    messageId = await sendMedia(post.content);
                } else {
                    // Long text: Send text first, then reply with media
                    textMessageId = await this.sendMessage(token, account.chatId, post.content);
                    messageId = await sendMedia(undefined, textMessageId);
                }
            } catch (error: any) {
                if (!viaAccount) throw error;
                // The big video could not be sent (e.g. the account is not an admin): publish at least the text
                console.warn(`⚠️ Видео не отправлено: ${error.message.split('\n')[0]}`);
                messageId = textMessageId ?? await this.sendMessage(token, account.chatId, post.content);
                console.warn(`   Опубликован только текст. Видео добавьте вручную: ${post.media}`);
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

    /**
     * The bot cannot upload more than 50 MB, but it can send any file it has by file_id.
     * So your account sends the video to the bot's private chat, the bot reads its file_id from the update.
     */
    private static async bigVideoFileId(token: string, post: PostData, size: number): Promise<string> {
        const filePath = post.media!;
        const cached = fileIds.get(filePath);
        if (cached) return cached;

        const api = async (method: string, params: Record<string, unknown> = {}) => {
            const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });
            const result = await res.json() as any;
            if (!result.ok) throw new Error(`${method}: ${result.description}`);
            return result.result;
        };

        console.log(`ℹ️ Видео ${Math.round(size / 1048576)} МБ — больше лимита бота (50 МБ). Передаю его боту через ваш аккаунт Telegram...`);
        const bot = await api('getMe');

        /** Waits for the message in the bot's chat that `matches` and returns the video's file_id. */
        const waitForVideo = async (offset: number, matches: (message: any) => boolean): Promise<string> => {
            const deadline = Date.now() + FILE_ID_WAIT;
            while (Date.now() < deadline) {
                const updates = await api('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] });
                for (const update of updates) {
                    offset = update.update_id + 1;
                    const message = update.message;
                    const fileId = message && matches(message) ? (message.video ?? message.document)?.file_id : undefined;
                    if (!fileId) continue;
                    // Confirm the updates and clean up the helper message in the bot's chat
                    await api('getUpdates', { offset, limit: 1, timeout: 0 }).catch(() => undefined);
                    await api('deleteMessage', { chat_id: message.chat.id, message_id: message.message_id }).catch(() => undefined);
                    return fileId;
                }
            }
            throw new Error('бот не получил видео от вашего аккаунта');
        };
        // Skip updates that came before: start right after the latest one
        const nextOffset = async () => {
            const [last] = await api('getUpdates', { offset: -1, limit: 1 });
            return last ? last.update_id + 1 : 0;
        };

        let fileId: string | undefined;

        // 1. Forward the original post: instant, nothing is uploaded
        const source = post.mediaSource?.match(/^([\w]+)\/(\d+)$/);
        if (source) {
            const [, channel, id] = source;
            try {
                const offset = await nextOffset();
                await forwardFromAccount(bot.username, channel, Number(id));
                fileId = await waitForVideo(offset, (m) => {
                    const origin = m.forward_origin;
                    return origin?.type === 'channel' && origin.message_id === Number(id)
                        && origin.chat?.username?.toLowerCase() === channel.toLowerCase();
                });
                console.log('✅ Видео переслано из оригинального поста.');
            } catch (error: any) {
                console.warn(`⚠️ Не удалось переслать оригинальный пост (${error.message.split('\n')[0]}), загружаю файл.`);
            }
        }

        // 2. Upload the file from this computer (e.g. the channel forbids forwarding)
        if (!fileId) {
            const offset = await nextOffset();
            const tag = `socialpost:${Date.now()}`;
            await sendVideoFromAccount(bot.username, filePath, tag);
            fileId = await waitForVideo(offset, (m) => m.caption === tag);
        }

        fileIds.set(filePath, fileId);
        return fileId;
    }

    private static async sendVideo(token: string, chatId: string, video: Buffer | string, caption?: string, replyId?: number): Promise<number> {
        if (typeof video === 'string') {
            // Already on Telegram servers: send by file_id, no size limit
            const result = await this.request(token, 'sendVideo', JSON.stringify({
                chat_id: chatId,
                video,
                supports_streaming: true,
                ...(caption ? { caption } : {}),
                ...(replyId ? { reply_to_message_id: replyId } : {}),
            }), true);
            return result.result.message_id;
        }
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('video', new Blob([new Uint8Array(video)]), 'video.mp4');
        if (caption) formData.append('caption', caption);
        if (replyId) formData.append('reply_to_message_id', replyId.toString());

        const result = await this.request(token, 'sendVideo', formData);
        return result.result.message_id;
    }
}