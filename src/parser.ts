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
    if (data.media) {
        const absolutePath = path.resolve(data.media);
        if (fs.existsSync(absolutePath)) {
            resolvedMedia = absolutePath;
        } else {
            // Если путь прописан, но файла физически нет, выдаем предупреждение
            console.warn(`\n⚠️ Warning: Media specified but not found at [${absolutePath}]. Publishing as text-only.`);
        }
    }

    return {
        title: data.title,
        media: resolvedMedia,
        mimeType: data.mimeType,
        facebook_tags: data.facebook_tags,
        content: finalPostText
    };
}