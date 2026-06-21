import { PostData, FacebookConfig, PublishResult } from '../types.js';
import { getEnvToken, getMedia, RunSafe } from './common.js';
import {type} from "node:os";

export class FacebookPublisher {
    @RunSafe('Facebook')
    static async publish(post: PostData, account: FacebookConfig): Promise<PublishResult> {
        const message = `${post.content}\n\n${post.facebook_tags || ''}`.trim();
        const media = getMedia(post);

        console.log(`\n▶ Publishing to Facebook: [${account.name}] (Page ID: ${account.pageId})...`);
        const token = getEnvToken(account.tokenEnv);

        const formData = new FormData();
        formData.append('access_token', token);
        formData.append('published', 'true');

        if (media) {
            if (media.type === 'video') {
                formData.append('source', new Blob([new Uint8Array(media.buffer)], {type: 'video/mp4'}));
                formData.append('description', message);
            } else {
                formData.append('source', new Blob([new Uint8Array(media.buffer)], {type: 'image/jpeg'}));
                formData.append('message', message);
            }
        } else {
            formData.append('message', message);
        }

        const endpoint = media ? (media.type === 'video' ? 'videos' : 'photos') : 'feed';
        const url = `https://graph.facebook.com/v25.0/${account.pageId}/${endpoint}`;
        const res = await fetch(url, { method: 'POST', body: formData as any });
        const result = await res.json() as any;

        if (result.error) {
            console.error(`❌ Facebook Error [${account.name}]:`, result.error.message);
        } else {
            const id = result.id || result.post_id;
            console.log(`✅ Success! Post ID: ${id}`);
            console.log(`🔗 Link: https://facebook.com/${account.pageId}/posts/${id}`);
        }
        const postUrl = result.id ? `https://facebook.com/${account.pageId}/posts/${result.id}` : null;
        return { platform: 'Facebook', name: account.name, url: postUrl };
    }
}
