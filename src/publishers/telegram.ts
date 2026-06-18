import fs from 'node:fs';
import { PostData, TelegramConfig } from '../types.js';

export async function publishToTelegram(post: PostData, accounts: TelegramConfig[]) {
    if (accounts.length === 0) return;

    const imageBuffer = post.image ? fs.readFileSync(post.image) : undefined;

    for (const acc of accounts) {
        console.log(`\n▶ Publishing to Telegram: [${acc.name}] (Chat ID: ${acc.chatId})...`);
        const token = process.env[acc.tokenEnv];

        if (!token) {
            console.error(`❌ Ошибка: Токен ${acc.tokenEnv} не найден в файле .env. Пропускаем этот аккаунт.`);
            continue; // Переходим к следующему аккаунту
        }
        try {
            // SCENARIO 1: No image - use sendMessage
            if (!imageBuffer) {
                const url = `https://api.telegram.org/bot${token}/sendMessage`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: acc.chatId, text: post.content })
                });
                const result = await res.json() as any;
                if (!result.ok) console.error(`❌ Error [${acc.name}]:`, result.description);
                else console.log(`✅ Text posted to [${acc.name}]`);
                continue;
            }

            if (post.content.length <= 1024) {
                // Option 1: Short text. Send everything together (photo + caption)
                const url = `https://api.telegram.org/bot${token}/sendPhoto`;
                const formData = new FormData();
                formData.append('chat_id', acc.chatId);
                formData.append('caption', post.content);
                formData.append('photo', new Blob([imageBuffer]), 'image.jpg');

                const res = await fetch(url, { method: 'POST', body: formData as any });
                const result = await res.json() as any;

                if (!result.ok) console.error(`❌ Telegram Error [${acc.name}]:`, result.description);
                else console.log(`✅ Post successfully published to [${acc.name}]`);

            } else if (imageBuffer) {
                // Option 2: Text is longer than 1024 chars. Send text first, then photo as a reply.
                const textUrl = `https://api.telegram.org/bot${token}/sendMessage`;
                // Truncate to 4096 just in case to avoid API errors
                const textToSend = post.content.substring(0, 4096);

                const textRes = await fetch(textUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: acc.chatId, text: textToSend })
                });
                const textResult = await textRes.json() as any;

                if (!textResult.ok) {
                    console.error(`❌ Error sending text [${acc.name}]:`, textResult.description);
                    continue; // Skip photo if text failed
                }

                // Get ID of the recently sent text message
                const messageId = textResult.result.message_id;
                const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
                const photoFormData = new FormData();

                photoFormData.append('chat_id', acc.chatId);
                photoFormData.append('photo', new Blob([imageBuffer]), 'image.jpg');
                photoFormData.append('reply_to_message_id', messageId.toString()); // Make it a reply

                const photoRes = await fetch(photoUrl, { method: 'POST', body: photoFormData as any });
                const photoResult = await photoRes.json() as any;

                if (!photoResult.ok) console.error(`❌ Error sending photo reply [${acc.name}]:`, photoResult.description);
                else console.log(`✅ Text and photo reply successfully sent to [${acc.name}]`);
            }
        } catch (error: any) {
            console.error(`❌ System error in Telegram publisher [${acc.name}]:`, error.message);
        }
    }
}