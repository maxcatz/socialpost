import { PostData, FacebookConfig, PublishResult } from '../types.js';
import { getEnvToken, getMedia, RunSafe, MediaData } from './common.js';

// Bigger videos are uploaded in parts: a single request with the whole file is cut off by Facebook
const SIMPLE_VIDEO_LIMIT = 40 * 1024 * 1024;

/**
 * Parses a Graph API response; on a non-JSON answer (e.g. the request was too big) shows the HTTP status.
 */
async function readJson(res: Response): Promise<any> {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Facebook вернул не JSON (HTTP ${res.status} ${res.statusText}): ${text.slice(0, 200) || 'пустой ответ'}`);
    }
}

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
        if (media.buffer.length > SIMPLE_VIDEO_LIMIT) {
            return this.uploadVideoInChunks(media, token, pageId, description);
        }

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
        const result = await readJson(res);

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

    /**
     * Resumable upload for big videos: start -> transfer chunks -> finish (the single-request upload breaks on them).
     */
    private static async uploadVideoInChunks(
        media: MediaData,
        token: string,
        pageId: string,
        description?: string
    ): Promise<string> {
        const url = `https://graph-video.facebook.com/v25.0/${pageId}/videos`;
        const total = media.buffer.length;
        const call = async (fields: Record<string, string | Blob>) => {
            const form = new FormData();
            form.append('access_token', token);
            for (const [key, value] of Object.entries(fields)) form.append(key, value as any);
            const result = await readJson(await fetch(url, { method: 'POST', body: form as any }));
            if (result.error) throw new Error(`Video upload failed: ${result.error.message}`);
            return result;
        };

        console.log(`⏳ Uploading video in parts (${Math.round(total / 1048576)} MB)...`);
        const started = await call({ upload_phase: 'start', file_size: String(total) });
        const sessionId: string = started.upload_session_id;
        const videoId: string = started.video_id;
        let start = Number(started.start_offset);
        let end = Number(started.end_offset);

        while (start < end) {
            const chunk = new Blob([new Uint8Array(media.buffer.subarray(start, end))], { type: media.mimeType });
            const next = await call({ upload_phase: 'transfer', upload_session_id: sessionId, start_offset: String(start), video_file_chunk: chunk });
            start = Number(next.start_offset);
            end = Number(next.end_offset);
            process.stdout.write(`\r⬆️ Facebook: ${Math.round((start / total) * 100)}%`);
        }
        process.stdout.write('\n');

        await call({
            upload_phase: 'finish',
            upload_session_id: sessionId,
            published: 'true',
            ...(description ? { description } : {}),
        });
        console.log(`✅ Video uploaded successfully. ID: ${videoId}`);
        return videoId;
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
