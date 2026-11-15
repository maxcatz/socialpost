import fs from 'node:fs';
import open from 'open';
import clipboardy from 'clipboardy';
import { input } from '@inquirer/prompts';
import { revealFileInFinder, copyImageToClipboard } from '../utils.js';
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
 * The mimeType is already inferred by the parser.
 */
export function getMedia(post: PostData): MediaData | null {
    if (!post.media || !post.mimeType) {
        return null;
    }
    
    return { mimeType: post.mimeType, buffer: fs.readFileSync(post.media) };
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

/**
 * For image posts: waits for the user to paste the text first, then puts the image into the clipboard.
 * Videos (and non-macOS systems) fall back to revealing the file in Finder.
 */
export async function offerMediaInClipboard(
    post: PostData,
    message = '📋 Вставьте текст (Cmd+V), затем нажмите Enter — скопирую картинку в буфер обмена:'
): Promise<void> {
    if (!post.media) return;

    if (post.mimeType?.startsWith('image/') && process.platform === 'darwin') {
        await input({ message });
        try {
            await copyImageToClipboard(post.media, post.mimeType);
            console.log('✅ Картинка скопирована в буфер обмена — вставьте её через Cmd+V.');
            return;
        } catch (error: any) {
            console.warn(`⚠️ Не удалось скопировать картинку (${error.message.trim()}).`);
        }
    }
    await revealFileInFinder(post.media);
}

/**
 * The user publishes the post in the browser themselves; the URL is optional.
 * An empty answer falls back to a matching URL from the clipboard (if its host contains `urlHost`).
 */
export async function askPublishedUrl(accountName: string, urlHost: string): Promise<string> {
    console.log('\n=========================================');
    console.log(`👉 Проверьте пост в Chrome и нажмите «Опубликовать» для [${accountName}].`);
    console.log('   Затем нажмите Enter здесь (или вставьте URL поста, если нужен в отчёте).');
    console.log('=========================================\n');

    const answer = (await input({ message: `URL поста [${accountName}] (необязательно):` })).trim();
    console.log('-----------------------------------------\n');
    if (answer) return answer;

    try {
        const clip = clipboardy.readSync().trim();
        if (/^https?:\/\/\S+$/.test(clip) && clip.includes(urlHost)) return clip;
    } catch {
        // clipboard is unavailable — ignore
    }
    return 'опубликовано (URL не указан)';
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

    // 2. Open target URL in browser
    await open(urlToOpen);

    // 3. Print instructions
    console.log(`\n=========================================`);
    console.log(`✅ Opened ${platform} URL for: [${accountName}]`);
    console.log(`✅ Post text successfully copied to clipboard!`);
    console.log(`=========================================\n`);
    console.log('Next steps:');
    instructions.forEach((inst, index) => {
        console.log(`${index + 1}. ${inst}`);
    });
    console.log('');

    // 4. Media: image goes to the clipboard after the text is pasted, video is revealed in Finder
    await offerMediaInClipboard(post);

    // 5. Prompt for the final published URL
    const postUrl = await input({
        message: `Paste the URL for the published post on [${accountName}]:`,
        validate: (value) => value.trim() !== '' || 'URL cannot be empty',
    });
    console.log('-----------------------------------------\n');

    return { platform, name: accountName, url: postUrl.trim() };
}
