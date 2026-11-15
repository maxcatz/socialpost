import fs from 'node:fs';
import path from 'node:path';
import { input, password } from '@inquirer/prompts';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { RelayConfig } from '../types.js';

const SESSION_FILE = path.resolve('./.telegram_session');

export interface SourcePost {
    channel: string;
    id: number;               // id of the last message in the post (used as cursor)
    url: string;
    date: Date;
    text: string;
    messages: Api.Message[];  // all messages of the post (several for albums)
}

/**
 * Connects to Telegram as a user (MTProto). Asks for phone/code only on the first run,
 * then reuses the session saved in .telegram_session.
 */
export async function connectTelegram(relay: RelayConfig): Promise<TelegramClient> {
    const apiId = Number(process.env[relay.apiIdEnv]);
    const apiHash = process.env[relay.apiHashEnv];
    if (!apiId || !apiHash) {
        throw new Error(`Telegram API credentials not found in .env (${relay.apiIdEnv}, ${relay.apiHashEnv}). Get them at https://my.telegram.org`);
    }

    const savedSession = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : '';
    const client = new TelegramClient(new StringSession(savedSession), apiId, apiHash, { connectionRetries: 5 });
    client.setLogLevel(LogLevel.ERROR);

    await client.start({
        phoneNumber: async () => input({ message: 'Telegram phone number (+972...):' }),
        phoneCode: async () => input({ message: 'Code from Telegram:' }),
        password: async () => password({ message: '2FA password:', mask: '*' }),
        onError: (err) => { throw err; },
    });

    fs.writeFileSync(SESSION_FILE, String(client.session.save()), { mode: 0o600 });
    return client;
}

/**
 * Returns posts newer than minId, oldest first. Album messages (same groupedId) are merged into one post.
 */
export async function fetchNewPosts(client: TelegramClient, channel: string, minId: number, limit: number): Promise<SourcePost[]> {
    const messages = await client.getMessages(channel, { limit, minId });
    const sorted = [...messages].filter(m => m instanceof Api.Message).sort((a, b) => a.id - b.id);

    const posts: SourcePost[] = [];
    const albums = new Map<string, SourcePost>();

    for (const msg of sorted) {
        const groupKey = msg.groupedId ? msg.groupedId.toString() : null;
        const existing = groupKey ? albums.get(groupKey) : undefined;

        if (existing) {
            existing.messages.push(msg);
            existing.id = msg.id;
            if (!existing.text && msg.message) existing.text = msg.message;
            continue;
        }

        const post: SourcePost = {
            channel,
            id: msg.id,
            url: `https://t.me/${channel}/${msg.id}`,
            date: new Date(msg.date * 1000),
            text: msg.message || '',
            messages: [msg],
        };
        posts.push(post);
        if (groupKey) albums.set(groupKey, post);
    }

    // Skip service messages and posts without text and media
    return posts.filter(p => p.text.trim() !== '' || p.messages.some(m => m.photo || m.video));
}

/**
 * Downloads photos/videos of the post into dir. Returns relative paths of saved files.
 */
export async function downloadPostMedia(client: TelegramClient, post: SourcePost, dir: string): Promise<string[]> {
    fs.mkdirSync(dir, { recursive: true });
    const files: string[] = [];

    for (const msg of post.messages) {
        const ext = msg.photo ? 'jpg' : msg.video ? 'mp4' : null;
        if (!ext) continue;

        const buffer = await client.downloadMedia(msg, {});
        if (!buffer || typeof buffer === 'string') continue;

        const filePath = path.join(dir, `${post.channel}_${msg.id}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        files.push(filePath);
    }

    return files;
}
