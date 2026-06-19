import fs from 'node:fs';
import {PostData, FacebookConfig, PublishResult} from '../types.js';

export async function publishFacebookPost(post: PostData, account: FacebookConfig): Promise<PublishResult> {

    const message = `${post.content}\n\n${post.facebook_tags || ''}`.trim();
    const imageBuffer = post.image ? fs.readFileSync(post.image) : undefined;
    const videoBuffer = post.video ? fs.readFileSync(post.video) : undefined;
    const endpoint = post.video? 'videos': post.image ? 'photos' : 'feed';

    try {
        console.log(`\n▶ Publishing to Facebook: [${account.name}] (Page ID: ${account.pageId})...`);
        const token = process.env[account.tokenEnv];
        if (!token) {
            throw new Error(`❌ Ошибка: Токен ${account.tokenEnv} не найден в файле .env. Пропускаем этот аккаунт.`);
        }
        const formData = new FormData();
        formData.append('access_token', token);
        formData.append('published', 'true');

        if (imageBuffer) {
            formData.append('source', new Blob([imageBuffer]));
            formData.append('message', message);
        } else if(videoBuffer) {
            formData.append('source', new Blob([videoBuffer]));
            formData.append('description', message);
        } else {
            formData.append('message', message);
        }

        const url = `https://graph.facebook.com/v25.0/${account.pageId}/${endpoint}`;
        const res = await fetch(url, {method: 'POST', body: formData as any});
        const result = await res.json() as any;

        if (result.error) {
            console.error(`❌ Facebook Error [${account.name}]:`, result.error.message);
        } else {
            console.log(`✅ Success! Post ID: ${result.id || result.post_id}`);
            console.log(`🔗 Link: https://facebook.com/${account.pageId}/posts/${result.id || result.post_id}`);
        }
        const postUrl = result.id ? `https://facebook.com/${account.pageId}/posts/${result.id}` : null;
        return {platform: 'Facebook', name: account.name, url: postUrl};
    } catch (error: any) {
        console.error(`❌ System error in Facebook publisher [${account.name}]:`, error.message);
    }
}