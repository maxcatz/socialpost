import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import open from 'open';
import clipboardy from 'clipboardy';
import matter from 'gray-matter';
import { input, select } from '@inquirer/prompts';
import { TelegramClient } from 'telegram';
import { parsePost } from './parser.js';
import { printReport, publishToAccounts, selectAccounts } from './runner.js';
import { connectTelegram, downloadPostMedia, fetchNewPosts, SourcePost } from './sources/telegramReader.js';
import { AccountsConfig, RelayConfig } from './types.js';

const STATE_FILE = path.resolve('./relay_state.json');
const DRAFTS_DIR = 'posts/drafts';
const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app';
const DEFAULT_PROMPT = 'Переведи на русский язык. Сохрани абзацы, эмодзи и ссылки. Верни только перевод без пояснений:';

type RelayState = Record<string, number>; // channel -> last processed message id

function loadState(): RelayState {
    return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
}

function saveState(state: RelayState) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Gemini "Copy" button returns Markdown, but publishers send plain text.
 */
function cleanGeminiText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\*\*(.+?)\*\*/gs, '$1')
        .replace(/__(.+?)__/gs, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[*-]\s+/gm, '• ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function printPost(title: string, text: string) {
    console.log(`\n========== ${title} ==========`);
    console.log(text || '(no text)');
    console.log('='.repeat(title.length + 22));
}

/**
 * Copies the source text with the prompt, opens Gemini and waits until the user copies the final result.
 * Returns the approved text or null if the post was skipped.
 */
async function reviewInGemini(post: SourcePost, relay: RelayConfig): Promise<string | null> {
    const request = `${relay.prompt || DEFAULT_PROMPT}\n\n${post.text}`;
    clipboardy.writeSync(request);
    await open(relay.geminiUrl || DEFAULT_GEMINI_URL);

    console.log('\n✅ Source text with the prompt copied to clipboard, Gemini opened.');
    console.log('Next steps:');
    console.log('1. Press Cmd+V in Gemini and send.');
    console.log('2. Edit the translation in the chat as usual.');
    console.log('3. When it is ready, click "Copy" under the final answer and come back here.\n');

    while (true) {
        await input({ message: 'Press Enter after copying the final text from Gemini...' });

        const copied = clipboardy.readSync().trim();
        if (!copied || copied === request.trim()) {
            console.log('⚠️ Clipboard still contains the source request. Copy the answer in Gemini first.');
            continue;
        }

        const text = cleanGeminiText(copied);
        printPost('TRANSLATION', text);

        const action = await select({
            message: 'What next?',
            choices: [
                { name: '✅ Approve', value: 'approve' },
                { name: '🔄 Read clipboard again', value: 'retry' },
                { name: '📋 Copy source request again', value: 'copy' },
                { name: '⏭  Skip this post', value: 'skip' },
            ],
        });

        if (action === 'approve') return text;
        if (action === 'skip') return null;
        if (action === 'copy') {
            clipboardy.writeSync(request);
            console.log('📋 Source request copied again.');
        }
    }
}

async function chooseMedia(files: string[]): Promise<string | undefined> {
    if (files.length <= 1) return files[0];

    // PostData supports a single media file
    return select({
        message: `The post has ${files.length} media files. Which one to attach?`,
        choices: [
            ...files.map(f => ({ name: path.basename(f), value: f })),
            { name: 'No media', value: '' },
        ],
    }).then(v => v || undefined);
}

function writeDraft(post: SourcePost, text: string, media?: string): string {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    const filePath = path.join(DRAFTS_DIR, `${post.channel}_${post.id}.md`);

    const data: Record<string, string> = { source: post.url };
    if (media) data.media = `./${media}`;

    fs.writeFileSync(filePath, matter.stringify(`\n${text}\n`, data));
    return filePath;
}

async function processPost(client: TelegramClient, post: SourcePost, relay: RelayConfig, accounts: AccountsConfig): Promise<'done' | 'stop'> {
    const mediaCount = post.messages.filter(m => m.photo || m.video).length;
    printPost(`@${post.channel} #${post.id} | ${post.date.toLocaleString()}`, post.text);
    console.log(`🔗 ${post.url}${mediaCount ? ` | 📎 media: ${mediaCount}` : ''}`);

    const action = await select({
        message: 'Action:',
        choices: [
            { name: '🌐 Translate in Gemini', value: 'translate' },
            { name: '⏭  Skip', value: 'skip' },
            { name: '🛑 Stop (continue from here next time)', value: 'stop' },
        ],
    });

    if (action === 'stop') return 'stop';
    if (action === 'skip') return 'done';

    const files = mediaCount ? await downloadPostMedia(client, post, DRAFTS_DIR) : [];
    if (files.length) console.log(`📥 Media saved: ${files.join(', ')}`);

    const text = await reviewInGemini(post, relay);
    if (text === null) return 'done';

    const media = await chooseMedia(files);
    const draftPath = writeDraft(post, text, media);
    console.log(`📝 Draft saved: ${draftPath}`);

    const next = await select({
        message: 'Publish now?',
        choices: [
            { name: '🚀 Publish', value: 'publish' },
            { name: '✏️  Open draft in editor first', value: 'edit' },
            { name: '💾 Keep draft only (publish later with yarn start)', value: 'keep' },
        ],
    });

    if (next === 'keep') return 'done';
    if (next === 'edit') {
        await open(path.resolve(draftPath));
        await input({ message: 'Save the file and press Enter to publish...' });
    }

    const selectedAccounts = await selectAccounts(accounts).catch((error) => {
        if (error.message !== 'NO_SELECTION') throw error;
        console.log(`⚠️ No accounts selected. Draft kept: ${draftPath}`);
        return null;
    });
    if (!selectedAccounts) return 'done';

    const results = await publishToAccounts(parsePost(draftPath), draftPath, accounts, selectedAccounts);
    printReport(results);
    return 'done';
}

async function main() {
    const accounts: AccountsConfig = JSON.parse(fs.readFileSync(path.resolve('./accounts.json'), 'utf8'));
    const relay = accounts.relay;
    if (!relay || !relay.channels?.length) {
        console.error('❌ Error: "relay" section with "channels" is missing in accounts.json!');
        process.exit(1);
    }

    const state = loadState();
    let client: TelegramClient | undefined;

    try {
        client = await connectTelegram(relay);

        channels: for (const channel of relay.channels) {
            const fetched = await fetchNewPosts(client, channel, state[channel] || 0, relay.limit || 10);
            let posts: SourcePost[];
            if (relay.latestOnly && fetched.length > 1) {
                // Prefer the post with the most text content, not just the latest by ID.
                // In channels like m_feiglin, the last post may be a short continuation with an image,
                // while the previous one contains the full text.
                const longest = fetched.reduce((a, b) => a.text.length >= b.text.length ? a : b);
                posts = [longest];
            } else {
                posts = fetched;
            }
            console.log(`\n📡 @${channel}: ${posts.length} new post(s)`);

            for (const post of posts) {
                const result = await processPost(client, post, relay, accounts);
                if (result === 'stop') break channels;

                state[channel] = post.id;
                saveState(state);
            }
        }

        console.log('\n👋 Done.');
    } catch (error: any) {
        if (error.message === 'NO_SELECTION') console.log('\n⚠️ No accounts selected. Exiting...');
        else if (error.name === 'ExitPromptError') console.log('\n🚪 Process cancelled by user.');
        else console.error('\n❌ A critical error occurred:', error.message);
    } finally {
        await client?.destroy();
    }
}

main();
