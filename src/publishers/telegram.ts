import { PostData, PublishResult, TelegramConfig } from '../types.js';
import { getEnvToken, getMediaBuffers, RunSafe } from './common.js';

export class TelegramPublisher {
    @RunSafe('Telegram')
    static async publish(post: PostData, account: TelegramConfig): Promise<PublishResult> {
        const { imageBuffer, videoBuffer } = getMediaBuffers(post);
        let postUrl = "";

        console.log(`\n▶ Publishing to Telegram: [${account.name}] (Chat ID: ${account.chatId})...`);
        const token = getEnvToken(account.tokenEnv);

        if (videoBuffer) {
            if (post.content.length <= 1024) {
                // Текст короткий, отправляем как подпись к видео
                const url = `https://api.telegram.org/bot${token}/sendVideo`;
                const formData = new FormData();
                formData.append('chat_id', account.chatId);
                formData.append('caption', post.content);
                formData.append('video', new Blob([videoBuffer]), 'video.mp4');

                const res = await fetch(url, { method: 'POST', body: formData as any });
                const result = await res.json() as any;
                if (!result.ok) throw new Error(result.description);
                postUrl = `https://t.me/${account.channelName}/${result.result.message_id}`;

            } else {
                // Текст длинный (> 1024). Отправляем текст, затем видео в реплай.
                const textUrl = `https://api.telegram.org/bot${token}/sendMessage`;
                const textRes = await fetch(textUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: account.chatId, text: post.content.substring(0, 4096) })
                });
                const textResult = await textRes.json() as any;
                if (!textResult.ok) throw new Error(textResult.description);

                const messageId = textResult.result.message_id;

                const videoUrl = `https://api.telegram.org/bot${token}/sendVideo`;
                const videoFormData = new FormData();
                videoFormData.append('chat_id', account.chatId);
                videoFormData.append('video', new Blob([videoBuffer]), 'video.mp4');
                videoFormData.append('reply_to_message_id', messageId.toString());

                const videoRes = await fetch(videoUrl, { method: 'POST', body: videoFormData as any });
                const videoResult = await videoRes.json() as any;
                if (!videoResult.ok) throw new Error(videoResult.description);

                postUrl = `https://t.me/${account.channelName}/${videoResult.result.message_id}`;
            }
        }
        // SCENARIO 1: No image - use sendMessage
        else if (!imageBuffer) {
            const url = `https://api.telegram.org/bot${token}/sendMessage`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: account.chatId, text: post.content })
            });
            const result = await res.json() as any;
            if (!result.ok) {
                throw new Error(result.description);
            } else {
                console.log(`✅ Text posted to [${account.name}]. Link: https://t.me/${account.channelName}/${result.result.message_id}`);
                postUrl = `https://t.me/${account.channelName}/${result.result.message_id}`;
            }
        } else if (post.content.length <= 1024) {
            // Option 1: Short text. Send everything together (photo + caption)
            const url = `https://api.telegram.org/bot${token}/sendPhoto`;
            const formData = new FormData();
            formData.append('chat_id', account.chatId);
            formData.append('caption', post.content);
            formData.append('photo', new Blob([imageBuffer]), 'image.jpg');

            const res = await fetch(url, { method: 'POST', body: formData as any });
            const result = await res.json() as any;

            if (!result.ok) throw new Error(result.description);
            else {
                console.log(`✅ Text posted to [${account.name}]. Link: https://t.me/${account.channelName}/${result.result.message_id}`);
                postUrl = `https://t.me/${account.channelName}/${result.result.message_id}`;
                return { platform: 'Telegram', name: account.name, url: postUrl };
            }

        } else if (imageBuffer) {
            // Option 2: Text is longer than 1024 chars. Send text first, then photo as a reply.
            const textUrl = `https://api.telegram.org/bot${token}/sendMessage`;
            // Truncate to 4096 just in case to avoid API errors
            const textToSend = post.content.substring(0, 4096);

            const textRes = await fetch(textUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: account.chatId, text: textToSend })
            });
            const textResult = await textRes.json() as any;

            if (!textResult.ok) {
                throw new Error(`Error sending text: ${textResult.description}`);
            }

            // Get ID of the recently sent text message
            const messageId = textResult.result.message_id;
            const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
            const photoFormData = new FormData();

            photoFormData.append('chat_id', account.chatId);
            photoFormData.append('photo', new Blob([imageBuffer]), 'image.jpg');
            photoFormData.append('reply_to_message_id', messageId.toString()); // Make it a reply

            const photoRes = await fetch(photoUrl, { method: 'POST', body: photoFormData as any });
            const photoResult = await photoRes.json() as any;

            if (!photoResult.ok) throw new Error(`Error sending photo reply: ${photoResult.description}`);
            else {
                console.log(`✅ Text posted to [${account.name}]. Link: https://t.me/${account.channelName}/${photoResult.result.message_id}`);
                postUrl = `https://t.me/${account.channelName}/${photoResult.result.message_id}`;
                return { platform: 'Telegram', name: account.name, url: postUrl };
            }
        }
        return { platform: 'Telegram', name: account.name, url: postUrl };
    }
}