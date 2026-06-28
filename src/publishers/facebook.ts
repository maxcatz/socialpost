import { PostData, FacebookConfig, PublishResult } from '../types.js';
import { getEnvToken, getMedia, RunSafe, MediaData } from './common.js';

export class FacebookPublisher {
    @RunSafe('Facebook')
    static async publish(post: PostData, account: FacebookConfig): Promise<PublishResult> {
        const message = `${post.content}\n\n${post.facebook_tags || ''}`.trim();
        const media = getMedia(post);

        console.log(`\n▶ Publishing to Facebook: [${account.name}] (Page ID: ${account.pageId})...`);
        const token = getEnvToken(account.tokenEnv);

        if (media && media.mimeType.startsWith('video/')) {
            const videoId = await this.uploadVideo(media, token, account.pageId, message);
            const postUrl = `https://facebook.com/reel/${videoId}`;
            console.log(`✅ Success! Video Post ID: ${videoId}`);
            console.log(`🔗 Link: ${postUrl}`);
            return { platform: 'Facebook', name: account.name, url: postUrl };
        }

        const mediaId = media ? await this.uploadImage(media, token, account.pageId) : undefined;

        console.log(`⏳ Publishing feed post...`);
        const postId = await this.publishFeed(token, account.pageId, message, mediaId);
        
        console.log(`✅ Success! Post ID: ${postId}`);
        const postUrl = `https://facebook.com/${account.pageId}/posts/${postId}`;
        console.log(`🔗 Link: ${postUrl}`);
        
        return { platform: 'Facebook', name: account.name, url: postUrl };
    }

    private static async uploadImage(
        media: MediaData,
        token: string,
        pageId: string
    ): Promise<string> {
        console.log(`⏳ Uploading image (${media.mimeType})...`);
        const formData = new FormData();
        formData.append('access_token', token);
        formData.append('published', 'false');
        formData.append('source', new Blob([new Uint8Array(media.buffer)], {type: media.mimeType}));

        const url = `https://graph.facebook.com/v25.0/${pageId}/photos`;
        const res = await fetch(url, { method: 'POST', body: formData as any });
        const result = await res.json() as any;

        if (result.error) {
            throw new Error(`Image upload failed: ${result.error.message}`);
        }

        const mediaId = result.id || result.post_id;
        if (!mediaId) {
            throw new Error(`Upload did not return an ID`);
        }
        console.log(`✅ Image uploaded successfully. ID: ${mediaId}`);
        return mediaId;
    }

    private static async uploadVideo(
        media: MediaData,
        token: string,
        pageId: string,
        description?: string
    ): Promise<string> {
        console.log(`⏳ Uploading and publishing video (${media.mimeType})...`);
        const formData = new FormData();
        formData.append('access_token', token);
        formData.append('published', 'true');
        formData.append('source', new Blob([new Uint8Array(media.buffer)], {type: media.mimeType}), 'video.mp4');
        if (description) {
            formData.append('description', description);
        }

        const url = `https://graph-video.facebook.com/v25.0/${pageId}/videos`;
        const res = await fetch(url, { method: 'POST', body: formData as any });
        const result = await res.json() as any;

        if (result.error) {
            throw new Error(`Video upload failed: ${result.error.message}`);
        }

        const mediaId = result.id || result.post_id;
        if (!mediaId) {
            throw new Error(`Upload did not return an ID`);
        }
        console.log(`✅ Video uploaded successfully. ID: ${mediaId}`);
        return mediaId;
    }

    private static async publishFeed(
        token: string,
        pageId: string,
        message: string,
        mediaId?: string
    ): Promise<string> {
        const formData = new FormData();
        formData.append('access_token', token);
        formData.append('published', 'true');
        formData.append('message', message);

        if (mediaId) {
            formData.append('attached_media', JSON.stringify([{ media_fbid: mediaId }]));
        }

        const url = `https://graph.facebook.com/v25.0/${pageId}/feed`;
        const res = await fetch(url, { method: 'POST', body: formData as any });
        const result = await res.json() as any;

        if (result.error) {
            throw new Error(`Feed publishing failed: ${result.error.message}`);
        }

        const postId = result.id || result.post_id;
        if (!postId) {
            throw new Error(`Publishing did not return an ID`);
        }
        return postId;
    }
}
