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

    let resolvedImage: string | undefined = undefined;
    if (data.image) {
        const absolutePath = path.resolve(data.image);
        if (fs.existsSync(absolutePath)) {
            resolvedImage = absolutePath;
        } else {
            // Если путь прописан, но файла физически нет, выдаем предупреждение
            console.warn(`\n⚠️ Warning: Image specified but not found at [${absolutePath}]. Publishing as text-only.`);
        }
    }
    let resolvedVideo: string | undefined = undefined;
    if (data.video) {
        const absoluteVideoPath = path.resolve(data.video);
        if (fs.existsSync(absoluteVideoPath)) {
            resolvedVideo = absoluteVideoPath;
        } else {
            console.warn(`\n⚠️ Warning: Video specified but not found at [${absoluteVideoPath}].`);
        }
    }

    return {
        title: data.title,
        image: resolvedImage,
        video: resolvedVideo,
        facebook_tags: data.facebook_tags,
        content: finalPostText
    };
}