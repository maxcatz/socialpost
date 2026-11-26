import fs from 'node:fs';
import matter from 'gray-matter';
import path from 'node:path';
import { PostData } from './types.js';

export function parsePost(filePath: string): PostData {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const { data, content } = matter(fileContent);

    if (data.image && data.video) {
        console.error('\n❌ File validation error!');
        console.error('The post front-matter contains both an image and a video.');
        console.error('Please specify only one media format.');
        process.exit(1);
    }

    // Add bold title for ALL platforms if it exists in front-matter
    let finalPostText = content.trim();
    if (data.title) {
        finalPostText = `${data.title}\n\n${finalPostText}`;
    }

    let resolvedMedia: string | undefined = undefined;
    // Поддерживаем media, video и image — в приоритете media, затем video, затем image
    const mediaField = data.media || data.video || data.image;
    if (mediaField) {
        const absolutePath = path.resolve(mediaField);
        if (fs.existsSync(absolutePath)) {
            resolvedMedia = absolutePath;
        } else {
            // Если путь прописан, но файла физически нет, выдаем предупреждение
            console.warn(`\n⚠️ Warning: Media specified but not found at [${absolutePath}]. Publishing as text-only.`);
        }
    }

    // Если mimeType не указан в frontmatter, определяем его автоматически
    let mimeType = data.mimeType;
    if (!mimeType && resolvedMedia) {
        mimeType = inferMimeType(resolvedMedia);
    }

    return {
        title: data.title,
        media: resolvedMedia,
        mimeType,
        facebook_tags: data.facebook_tags,
        mediaSource: data.media_source,
        content: finalPostText
    };
}

/**
 * Infers MIME type from file extension.
 */
function inferMimeType(filePath: string): string {
    const ext = filePath.toLowerCase().split('.').pop();
    const mimeTypes: Record<string, string> = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'mp4': 'video/mp4',
        'mov': 'video/quicktime',
        'avi': 'video/x-msvideo',
        'webm': 'video/webm'
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
}