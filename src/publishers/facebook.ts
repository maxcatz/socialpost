import fs from 'node:fs';
import {PostData, FacebookConfig, PublishResult} from '../types.js';

export async function publishFacebookPost(post: PostData, accounts: FacebookConfig[]) : Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    if (accounts.length === 0) return results;

    const message = `${post.content}\n\n${post.facebook_tags || ''}`.trim();
    const imageBuffer = post.image ? fs.readFileSync(post.image) : undefined;
    const endpoint = post.image ? 'photos' : 'feed';

    for (const acc of accounts) {
        console.log(`\n▶ Publishing to Facebook: [${acc.name}] (Page ID: ${acc.pageId})...`);
        const token = process.env[acc.tokenEnv];

        if (!token) {
            console.error(`❌ Ошибка: Токен ${acc.tokenEnv} не найден в файле .env. Пропускаем этот аккаунт.`);
            continue; // Переходим к следующему аккаунту
        }
        try {
            const formData = new FormData();
            formData.append('message', message);
            formData.append('access_token', token);
            formData.append('published', 'true');

            if (imageBuffer) {
                formData.append('source', new Blob([imageBuffer]));
            }

            const url = `https://graph.facebook.com/v25.0/${acc.pageId}/${endpoint}`;
            const res = await fetch(url, { method: 'POST', body: formData as any });
            const result = await res.json() as any;

            if (result.error) {
                console.error(`❌ Facebook Error [${acc.name}]:`, result.error.message);
            } else {
                console.log(`✅ Success! Post ID: ${result.id || result.post_id}`);
                console.log(`🔗 Link: https://facebook.com/${acc.pageId}/posts/${result.id || result.post_id}`);
            }
            const postUrl = result.id ? `https://facebook.com/${acc.pageId}/posts/${result.id}` : null;
            results.push({ platform: 'Facebook', name: acc.name, url });
        } catch (error: any) {
            console.error(`❌ System error in Facebook publisher [${acc.name}]:`, error.message);
        }
    }
    return results;
}