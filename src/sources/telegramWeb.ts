import fs from 'node:fs';
import path from 'node:path';
import { downloadVideoByMessage } from './telegramApi.js';

/**
 * Reads public Telegram channels through their web preview (https://t.me/s/<channel>),
 * without any Telegram account or API keys. The page shows the ~20 latest posts.
 */

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export interface SourceMedia {
    type: 'photo' | 'video';
    url?: string;      // direct file URL; missing for videos that are too big for the web preview
    messageId?: number; // message in the channel, used to download through the Telegram API
    file?: string;      // local path after downloadPostMedia
}

export interface SourcePost {
    channel: string;
    id: number;     // id of the last message in the post (albums contain several), used as cursor
    url: string;
    date: Date;
    text: string;
    media: SourceMedia[];
    replyTo?: number;
}

// A media-only message posted right after (or as a reply to) a text post is its continuation
const CONTINUATION_WINDOW = 3 * 60_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rlm: '', lrm: '' };

function decodeEntities(text: string): string {
    return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
        if (code[0] === '#') {
            const num = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return String.fromCodePoint(num);
        }
        return ENTITIES[code.toLowerCase()] ?? match;
    });
}

function htmlToText(html: string): string {
    return decodeEntities(
        html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
    )
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Returns the inner HTML of the <div> that starts at `start` (handles nested divs).
 */
function innerDiv(html: string, start: number): string {
    const contentStart = html.indexOf('>', start) + 1;
    const tag = /<(\/?)div\b[^>]*>/gi;
    tag.lastIndex = contentStart;
    let depth = 1;
    for (let m = tag.exec(html); m; m = tag.exec(html)) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) return html.slice(contentStart, m.index);
    }
    return html.slice(contentStart);
}

function parsePost(channel: string, block: string): SourcePost | null {
    const postMatch = block.match(/data-post="[^"/]+\/(\d+)"/);
    if (!postMatch) return null;

    const replyTo = block.match(/<a class="tgme_widget_message_reply[^>]*href="https:\/\/t\.me\/[^/"]+\/(\d+)"/)?.[1];
    // Skip the quoted text of the message this post replies to
    const withoutReply = block.replace(/<a class="tgme_widget_message_reply[\s\S]*?<\/a>/g, '');

    const textStart = withoutReply.search(/<div class="tgme_widget_message_text js-message_text"/);
    const text = textStart >= 0 ? htmlToText(innerDiv(withoutReply, textStart)) : '';

    // Albums link every photo/video to its own message id; the last one is the cursor
    const ids = [Number(postMatch[1])];
    const media: SourceMedia[] = [];
    for (const m of withoutReply.matchAll(/<a class="tgme_widget_message_(photo_wrap|video_player)[\s\S]*?<\/a>/g)) {
        const mediaId = m[0].match(/href="https:\/\/t\.me\/[^/"]+\/(\d+)/)?.[1];
        if (mediaId) ids.push(Number(mediaId));
        if (m[1] === 'photo_wrap') {
            const url = m[0].match(/background-image:url\('([^']+)'\)/)?.[1];
            media.push({ type: 'photo', url, messageId: mediaId ? Number(mediaId) : undefined });
        } else {
            const url = m[0].match(/<video[^>]*\ssrc="([^"]+)"/)?.[1];
            media.push({ type: 'video', url: url ? decodeEntities(url) : undefined, messageId: mediaId ? Number(mediaId) : undefined });
        }
    }

    const id = Math.max(...ids);
    const datetime = block.match(/<time datetime="([^"]+)"/)?.[1];

    return {
        channel,
        id,
        url: `https://t.me/${channel}/${postMatch[1]}`,
        date: datetime ? new Date(datetime) : new Date(),
        text,
        media,
        replyTo: replyTo ? Number(replyTo) : undefined,
    };
}

/**
 * Merges media-only continuations into the preceding text post (posts must be sorted by id).
 */
function mergeContinuations(posts: SourcePost[]): SourcePost[] {
    const merged: SourcePost[] = [];
    for (const post of posts) {
        const prev = merged.at(-1);
        const isContinuation = prev && !post.text && post.media.length > 0 && prev.text !== ''
            && (post.replyTo === prev.id || post.date.getTime() - prev.date.getTime() <= CONTINUATION_WINDOW);
        if (isContinuation) {
            prev.media.push(...post.media);
            prev.id = post.id;
        } else {
            merged.push(post);
        }
    }
    return merged;
}

async function fetchPage(channel: string): Promise<string> {
    const res = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`t.me/s/${channel}: HTTP ${res.status}`);
    const html = await res.text();
    if (!html.includes('tgme_widget_message_wrap') && !html.includes('tgme_channel_info')) {
        throw new Error(`@${channel} has no public web preview (private channel or wrong username?)`);
    }
    return html;
}

/**
 * Returns posts newer than minId, oldest first (at most `limit` of the latest ones).
 */
export async function fetchNewPosts(channel: string, minId: number, limit: number): Promise<SourcePost[]> {
    const html = await fetchPage(channel);
    const posts = html
        .split(/(?=<div class="tgme_widget_message_wrap)/)
        .slice(1)
        .map(block => parsePost(channel, block))
        .filter((p): p is SourcePost => p !== null && p.id > minId)
        // Skip service messages (channel photo changed, pinned, etc.)
        .filter(p => p.text !== '' || p.media.length > 0)
        .sort((a, b) => a.id - b.id);

    return mergeContinuations(posts).slice(-limit);
}

/**
 * Id of the newest post in the channel (0 if empty). Used to start watching a channel "from now".
 */
export async function getLatestPostId(channel: string): Promise<number> {
    const html = await fetchPage(channel);
    const ids = [...html.matchAll(/data-post="[^"/]+\/(\d+)"/g)].map(m => Number(m[1]));
    return ids.length ? Math.max(...ids) : 0;
}

/**
 * Downloads photos/videos of the post into dir. Returns relative paths of saved files.
 * Videos that are too big for the web preview are reported and skipped.
 */
export async function downloadPostMedia(post: SourcePost, dir: string, log: (message: string) => void = console.log): Promise<string[]> {
    fs.mkdirSync(dir, { recursive: true });
    const files: string[] = [];

    for (const [index, item] of post.media.entries()) {
        if (!item.url) {
            // Too big for the web preview: take it through the Telegram account (see telegramApi.ts)
            const filePath = path.join(dir, `${post.channel}_${item.messageId ?? post.id}${post.media.length > 1 ? `_${index + 1}` : ''}.mp4`);
            if (item.type === 'video' && item.messageId) {
                try {
                    if (await downloadVideoByMessage(post.channel, item.messageId, filePath)) {
                        log(`🎬 Видео скачано через Telegram API: ${filePath}`);
                        files.push(filePath);
                        item.file = filePath;
                        continue;
                    }
                } catch (error: any) {
                    log(`⚠️ Через Telegram API не удалось скачать видео (${error.message.split('\n')[0]}).`);
                }
            }
            log(`⚠️ Видео не скачано — скачайте его вручную: ${post.url}`);
            continue;
        }
        const res = await fetch(item.url, { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) {
            log(`⚠️ Не удалось скачать ${item.type} (HTTP ${res.status}): ${post.url}`);
            continue;
        }
        const ext = item.type === 'photo' ? 'jpg' : 'mp4';
        const suffix = post.media.length > 1 ? `_${index + 1}` : '';
        const filePath = path.join(dir, `${post.channel}_${post.id}${suffix}.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
        files.push(filePath);
        item.file = filePath;
    }

    return files;
}
