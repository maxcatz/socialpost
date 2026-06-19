import fs from 'node:fs';
import {PostData, PublishResult, TelegramConfig} from '../types.js';

export async function publishToTelegram(post: PostData, account: TelegramConfig): Promise<PublishResult> {

    const imageBuffer = post.image ? fs.readFileSync(post.image) : undefined;
    try {

        console.log(`\n▶ Publishing to Telegram: [${account.name}] (Chat ID: ${account.chatId})...`);
        const token = process.env[account.tokenEnv];

        if (!token) {
            throw new Error(`❌ Ошибка: Токен ${account.tokenEnv} не найден в файле .env. Пропускаем этот аккаунт.`);
        }

        // SCENARIO 1: No image - use sendMessage
        if (!imageBuffer) {
            const url = `https://api.telegram.org/bot${token}/sendMessage`;
            const res = await fetch(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({chat_id: account.chatId, text: post.content})
            });
            const result = await res.json() as any;
            if (!result.ok) {
                throw new Error(`❌ Error [${account.name}]:`, result.description);
            } else {
                console.log(`✅ Text posted to [${account.name}]. Link: https://t.me/${account.channelName}/${result.result.message_id}`);
                const postUrl = `https://t.me/${account.channelName}/${result.result.message_id}`;
                return {platform: 'Telegram', name: account.name, url: postUrl};
            }
        } else if (post.content.length <= 1024) {
            // Option 1: Short text. Send everything together (photo + caption)
            const url = `https://api.telegram.org/bot${token}/sendPhoto`;
            const formData = new FormData();
            formData.append('chat_id', account.chatId);
            formData.append('caption', post.content);
            formData.append('photo', new Blob([imageBuffer]), 'image.jpg');

            const res = await fetch(url, {method: 'POST', body: formData as any});
            const result = await res.json() as any;

            if (!result.ok) throw new Error(`❌ Telegram Error [${account.name}]:`, result.description);
            else {
                console.log(`✅ Text posted to [${account.name}]. Link: https://t.me/${account.channelName}/${result.result.message_id}`);
                const postUrl = `https://t.me/${account.channelName}/${result.result.message_id}`;
                return {platform: 'Telegram', name: account.name, url: postUrl};
            }

        } else if (imageBuffer) {
            // Option 2: Text is longer than 1024 chars. Send text first, then photo as a reply.
            const textUrl = `https://api.telegram.org/bot${token}/sendMessage`;
            // Truncate to 4096 just in case to avoid API errors
            const textToSend = post.content.substring(0, 4096);

            const textRes = await fetch(textUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({chat_id: account.chatId, text: textToSend})
            });
            const textResult = await textRes.json() as any;

            if (!textResult.ok) {
                throw new Error(`❌ Error sending text [${account.name}]:`, textResult.description);
            }

            // Get ID of the recently sent text message
            const messageId = textResult.result.message_id;
            const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
            const photoFormData = new FormData();

            photoFormData.append('chat_id', account.chatId);
            photoFormData.append('photo', new Blob([imageBuffer]), 'image.jpg');
            photoFormData.append('reply_to_message_id', messageId.toString()); // Make it a reply

            const photoRes = await fetch(photoUrl, {method: 'POST', body: photoFormData as any});
            const photoResult = await photoRes.json() as any;

            if (!photoResult.ok) throw new Error(`❌ Error sending photo reply [${account.name}]:`, photoResult.description);
            else {
                console.log(`✅ Text posted to [${account.name}]. Link: https://t.me/${account.channelName}/${photoResult.result.message_id}`);
                const postUrl =  `https://t.me/${account.channelName}/${photoResult.result.message_id}`;
                return ({platform: 'Telegram', name: account.name, url: postUrl});
            }
        }
    } catch (error: any) {
        console.error(`❌ System error in Telegram publisher [${account.name}]:`, error.message);
        return { platform: 'Telegram', name: account.name, url: "Error" };
    }
}