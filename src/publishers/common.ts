import fs from 'node:fs';
import open from 'open';
import clipboardy from 'clipboardy';
import { input } from '@inquirer/prompts';
import { revealFileInFinder } from '../utils.js';
import { PostData, PublishResult } from '../types.js';

/**
 * Gets environment variable token or throws a descriptive error.
 */
export function getEnvToken(tokenEnv: string): string {
    const token = process.env[tokenEnv];
    if (!token) {
        throw new Error(`❌ Ошибка: Токен ${tokenEnv} не найден в файле .env. Пропускаем этот аккаунт.`);
    }
    return token;
}

export interface MediaData {
    mimeType: string;
    buffer: Buffer;
}

/**
 * Reads the media attachment if present in the post.
 * Uses media and mimeType fields from frontmatter.
 */
export function getMedia(post: PostData): MediaData | null {
    if (!post.media) {
        return null;
    }
    
    const mimeType = post.mimeType || inferMimeType(post.media);
    
    return { mimeType, buffer: fs.readFileSync(post.media) };
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

/**
 * Decorator to wrap publisher methods in a try/catch block.
 */
export function RunSafe(platform: string) {
    return function <This, Args extends any[], Return extends PublishResult>(
        originalMethod: (this: This, ...args: Args) => Promise<Return>,
        context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>
    ) {
        return async function (this: This, ...args: Args): Promise<Return> {
            const account = args[1] as { name: string } | undefined;
            try {
                return await originalMethod.apply(this, args);
            } catch (error: any) {
                console.error(`❌ System error in ${platform} publisher [${account?.name || 'unknown'}]:`, error.message);
                return { platform, name: account?.name || 'unknown', url: null } as unknown as Return;
            }
        };
    };
}

export interface ManualPublishOptions {
    platform: string;
    accountName: string;
    urlToOpen: string;
    instructions: string[];
    post: PostData;
}

/**
 * Helper to handle manual publication steps (opening link, copying text, opening finder, and prompting for URL).
 */
export async function publishManual(options: ManualPublishOptions): Promise<PublishResult> {
    const { platform, accountName, urlToOpen, instructions, post } = options;

    console.log(`\n▶ Preparing ${platform} for: [${accountName}]...`);

    // 1. Copy the final text to the clipboard
    clipboardy.writeSync(post.content);

    // 2. Open the media file in finder
    if (post.media) {
        await revealFileInFinder(post.media);
    }

    // 3. Open target URL in browser
    await open(urlToOpen);

    // 4. Print instructions
    console.log(`\n=========================================`);
    console.log(`✅ Opened ${platform} URL for: [${accountName}]`);
    console.log(`✅ Post text successfully copied to clipboard!`);
    console.log(`=========================================\n`);
    console.log('Next steps:');
    instructions.forEach((inst, index) => {
        console.log(`${index + 1}. ${inst}`);
    });
    console.log('');

    // 5. Prompt for the final published URL
    const postUrl = await input({
        message: `Paste the URL for the published post on [${accountName}]:`,
        validate: (value) => value.trim() !== '' || 'URL cannot be empty',
    });
    console.log('-----------------------------------------\n');

    return { platform, name: accountName, url: postUrl.trim() };
}
