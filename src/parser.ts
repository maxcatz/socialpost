import fs from 'node:fs';
import matter from 'gray-matter';
import path from 'node:path';
import { PostData } from './types.js';

export function parsePost(filePath: string): PostData {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const { data, content } = matter(fileContent);

    // Add bold title for ALL platforms if it exists in front-matter
    let finalPostText = content.trim();
    if (data.title) {
        finalPostText = `*${data.title}*\n\n${finalPostText}`;
    }

    return {
        title: data.title,
        // Convert image path to absolute if provided
        image: data.image ? path.resolve(data.image) : undefined,
        facebook_tags: data.facebook_tags,
        content: finalPostText
    };
}