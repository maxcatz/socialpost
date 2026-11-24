import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import open from 'open';
import clipboardy from 'clipboardy';
import matter from 'gray-matter';
import { checkbox, input, select } from '@inquirer/prompts';
import { Page } from 'playwright-core';
import { parsePost } from './parser.js';
import { printReport, publishToAccounts, selectAccounts } from './runner.js';
import { downloadPostMedia, fetchNewPosts, getLatestPostId, SourcePost } from './sources/telegramWeb.js';
import { askGemini, openGeminiChat, readLastAnswer, readUserMessages } from './translators/gemini.js';
import { disconnectChrome } from './browser.js';
import { readStore, writeStore } from './store.js';
import { loadAccounts } from './accounts.js';
import { notify } from './utils.js';
import { AccountsConfig, RelayConfig } from './types.js';

// State files are kept by store.ts (local copy + Google Drive when configured)
const STATE_FILE = 'relay_state.json';
const RULES_FILE = 'translation_rules.md';
const GEMINI_CHAT_FILE = '.gemini_chat'; // URL of the shared translation chat
const RULES_HEADER = [
    '# Правила перевода и стиля — добавляются к каждому запросу в Gemini.',
    '# Каждое правило — пункт списка "- ...". Файл можно редактировать вручную; строки с # игнорируются.',
    '',
].join('\n');
const DRAFTS_DIR = 'posts/drafts';
const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app';
const DEFAULT_PROMPT = 'Переведи на русский язык. Сохрани абзацы, эмодзи и ссылки. Верни только перевод без пояснений:';
const DEFAULT_POLL_INTERVAL = 60; // seconds
const SETTLE_TIME = 2 * 60_000;   // --watch: wait this long after a text post for its photo/video continuation

const WATCH = process.argv.includes('--watch');

type RelayState = Record<string, number>; // channel -> last processed message id

async function loadState(): Promise<RelayState> {
    const raw = await readStore(STATE_FILE);
    return raw ? JSON.parse(raw) : {};
}

async function saveState(state: RelayState) {
    await writeStore(STATE_FILE, JSON.stringify(state, null, 2));
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

async function loadRules(): Promise<string> {
    return ((await readStore(RULES_FILE)) ?? '')
        .split('\n')
        .filter(line => line.trim() && !line.trim().startsWith('#'))
        .join('\n');
}

async function buildRequest(post: SourcePost, relay: RelayConfig): Promise<string> {
    const rules = await loadRules();
    const parts = [relay.prompt || DEFAULT_PROMPT];
    if (rules) parts.push(`Обязательно соблюдай мои правила перевода и стиля:\n${rules}`, 'Текст:');
    parts.push(post.text);
    return parts.join('\n\n');
}

let geminiPage: Page | null = null;

/**
 * Returns the Gemini tab with the shared translation chat: keeps it open between posts and reopens
 * the saved chat after a restart (needs a Google account signed in to Gemini in this Chrome).
 * With relay.sameChat = false every post gets a new chat.
 */
async function getGeminiPage(relay: RelayConfig): Promise<Page> {
    const sameChat = relay.sameChat !== false;
    if (sameChat && geminiPage && !geminiPage.isClosed()) {
        await geminiPage.bringToFront();
        return geminiPage;
    }
    await closeGeminiPage();

    const savedChat = sameChat ? ((await readStore(GEMINI_CHAT_FILE)) ?? '').trim() : '';
    geminiPage = await openGeminiChat(savedChat || relay.geminiUrl || DEFAULT_GEMINI_URL);
    if (savedChat) {
        // Gemini redirects to a new chat if the saved one is unavailable (deleted or not signed in)
        const reopened = geminiPage.url().startsWith(savedChat);
        console.log(reopened ? '💬 Продолжаю общий чат переводов в Gemini.' : '⚠️ Сохранённый чат Gemini недоступен — начинаю новый.');
    }
    return geminiPage;
}

async function rememberGeminiChat(page: Page, relay: RelayConfig) {
    // A chat gets its own URL (/app/<id>) after the first answer
    if (relay.sameChat !== false && /\/app\/[\w-]+/.test(page.url())) {
        await writeStore(GEMINI_CHAT_FILE, page.url().split('?')[0]);
    }
}

async function closeGeminiPage() {
    await geminiPage?.close().catch(() => undefined);
    geminiPage = null;
}

/**
 * Offers to save the user's remarks from the Gemini chat (user messages after the translation request)
 * as rules for future translations.
 */
async function offerToSaveRemarks(page: Page | null, requestIndex: number, extraRemarks: string[]): Promise<void> {
    const fromChat = page ? (await readUserMessages(page).catch(() => [])).slice(requestIndex + 1) : [];
    const existing = await loadRules();
    const remarks = [...new Set([...fromChat, ...extraRemarks])].filter(r => !existing.includes(r));
    if (!remarks.length) return;

    const toSave = await checkbox({
        message: 'Сохранить замечания как правила для следующих переводов? (пробел — выбрать, Enter — подтвердить)',
        choices: remarks.map(r => ({ name: r.replace(/\n/g, ' ⏎ '), value: r, checked: true })),
    });
    if (!toSave.length) return;

    const current = await readStore(RULES_FILE);
    const content = current ? current.replace(/\n*$/, '\n') : RULES_HEADER;
    const bullets = toSave.map(r => `- ${r.replace(/\n/g, '\n  ')}`).join('\n');
    await writeStore(RULES_FILE, `${content}${bullets}\n`);
    console.log(`📚 Сохранено правил: ${toSave.length} → ${path.basename(RULES_FILE)}`);
}

function printPost(title: string, text: string) {
    console.log(`\n========== ${title} ==========`);
    console.log(text || '(no text)');
    console.log('='.repeat(title.length + 22));
}

/**
 * Sends the source text with the prompt to Gemini in Chrome and shows the answer.
 * The user can refine the translation in the chat and re-read it. If the automation fails,
 * falls back to the clipboard: the user pastes the request and copies the answer manually.
 * Returns the approved text or null if the post was skipped.
 */
async function reviewInGemini(post: SourcePost, relay: RelayConfig): Promise<string | null> {
    const request = await buildRequest(post, relay);
    const terminalRemarks: string[] = [];
    const geminiUrl = relay.geminiUrl || DEFAULT_GEMINI_URL;
    let page: Page | null = null;
    let text: string | null = null;
    let requestIndex = 0; // position of this post's request among the user's messages in the chat

    try {
        console.log('\n🌐 Sending the post to Gemini...');
        page = await getGeminiPage(relay);
        requestIndex = (await readUserMessages(page)).length;
        text = cleanGeminiText(await askGemini(page, request));
        await rememberGeminiChat(page, relay);
    } catch (error: any) {
        console.warn(`⚠️ Gemini automation failed (${error.message.split('\n')[0]}). Switching to clipboard mode.`);
        clipboardy.writeSync(request);
        if (!page) await open(geminiUrl);
        console.log('\n✅ Source text with the prompt copied to clipboard.');
        console.log('Next steps:');
        console.log('1. Press Cmd+V in Gemini and send.');
        console.log('2. Edit the translation in the chat as usual.');
        console.log('3. When it is ready, click "Copy" under the final answer and come back here.\n');
    }

    const readClipboard = (): string | null => {
        const copied = clipboardy.readSync().trim();
        if (!copied || copied === request.trim()) {
            console.log('⚠️ Clipboard still contains the source request. Copy the answer in Gemini first.');
            return null;
        }
        return cleanGeminiText(copied);
    };

    try {
        while (true) {
            if (text === null) {
                await input({ message: 'Press Enter after copying the final text from Gemini...' });
                text = readClipboard();
                if (text === null) continue;
            }

            printPost('TRANSLATION', text);
            const action = await select({
                message: 'What next?',
                choices: [
                    { name: '✅ Approve', value: 'approve' },
                    ...(page ? [
                        { name: '💬 Write a remark to Gemini (fix the translation)', value: 'remark' },
                        { name: '🔄 Re-read the last Gemini answer (after refining it in the chat)', value: 'reread' },
                    ] : []),
                    { name: '📋 Take the text from clipboard', value: 'clipboard' },
                    { name: '📝 Copy source request to clipboard', value: 'copy' },
                    { name: '⏭  Skip this post', value: 'skip' },
                ],
            });

            if (action === 'approve' || action === 'skip') {
                await offerToSaveRemarks(page, requestIndex, terminalRemarks);
                return action === 'approve' ? text : null;
            }
            if (action === 'remark' && page) {
                const remark = (await input({ message: 'Замечание для Gemini:' })).trim();
                if (!remark) continue;
                terminalRemarks.push(remark);
                try {
                    console.log('🌐 Gemini is fixing the translation...');
                    text = cleanGeminiText(await askGemini(page, remark));
                } catch (error: any) {
                    console.warn(`⚠️ Could not get the answer: ${error.message.split('\n')[0]}`);
                }
                continue;
            }
            if (action === 'copy') {
                clipboardy.writeSync(request);
                console.log('📋 Source request copied again.');
            } else if (action === 'clipboard') {
                text = readClipboard() ?? text;
            } else if (action === 'reread' && page) {
                try {
                    text = cleanGeminiText(await readLastAnswer(page));
                } catch (error: any) {
                    console.warn(`⚠️ Could not read the answer: ${error.message.split('\n')[0]}`);
                }
            }
        }
    } finally {
        // The shared chat stays open for the next post
        if (relay.sameChat === false) await closeGeminiPage();
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

async function processPost(post: SourcePost, relay: RelayConfig, accounts: AccountsConfig): Promise<'done' | 'stop'> {
    const mediaCount = post.media.length;
    printPost(`@${post.channel} #${post.id} | ${post.date.toLocaleString()}`, post.text);
    console.log(`🔗 ${post.url}${mediaCount ? ` | 📎 media: ${mediaCount}` : ''}`);

    // In watch mode the post goes to Gemini right away — Skip is offered after the translation
    const action = WATCH ? 'translate' : await select({
        message: 'Action:',
        choices: [
            { name: '🌐 Translate in Gemini', value: 'translate' },
            { name: '⏭  Skip', value: 'skip' },
            { name: '🛑 Stop (continue from here next time)', value: 'stop' },
        ],
    });

    if (action === 'stop') return 'stop';
    if (action === 'skip') return 'done';

    const files = mediaCount ? await downloadPostMedia(post, DRAFTS_DIR) : [];
    if (files.length) console.log(`📥 Media saved: ${files.join(', ')}`);

    const text = post.text.trim()
        ? await reviewInGemini(post, relay)
        : await select({
            message: 'The post has no text. What to do?',
            choices: [
                { name: '⏭  Skip', value: null },
                { name: '🚀 Publish the media without text', value: '' },
            ],
        });
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

/**
 * Processes new posts of one channel. Returns 'stop' if the user chose to stop.
 */
async function processChannel(channel: string, state: RelayState, relay: RelayConfig, accounts: AccountsConfig): Promise<'done' | 'stop'> {
    if (WATCH && state[channel] === undefined) {
        // First time watching this chat: don't dump its history, start from the current message
        state[channel] = await getLatestPostId(channel);
        await saveState(state);
        console.log(`📌 @${channel}: watching for new posts from now on`);
        return 'done';
    }

    let fetched = await fetchNewPosts(channel, state[channel] || 0, relay.limit || 10);
    const newest = fetched.at(-1);
    if (WATCH && newest && newest.media.length === 0 && Date.now() - newest.date.getTime() < SETTLE_TIME) {
        // A fresh text post: its photo/video often follows as a separate message — take it on the next check
        fetched = fetched.slice(0, -1);
    }
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

    if (!WATCH || posts.length) console.log(`\n📡 @${channel}: ${posts.length} new post(s)`);
    if (WATCH && posts.length) {
        process.stdout.write('\x07');
        await notify(`New post in @${channel}`, posts[0].text.slice(0, 120) || 'Media post');
    }

    for (const post of posts) {
        const result = await processPost(post, relay, accounts);
        if (result === 'stop') return 'stop';

        state[channel] = post.id;
        await saveState(state);
    }

    // latestOnly skips the other fetched posts — don't fetch them again next time
    const lastFetchedId = Math.max(0, ...fetched.map(p => p.id));
    if (lastFetchedId > (state[channel] || 0)) {
        state[channel] = lastFetchedId;
        await saveState(state);
    }
    return 'done';
}

/**
 * Watches the channels until the user stops: re-checks the web preview every pollInterval seconds.
 * Posts are processed one at a time; posts that arrive meanwhile are picked up by the next pass.
 */
function watchChannels(state: RelayState, relay: RelayConfig, accounts: AccountsConfig): Promise<void> {
    return new Promise<void>((resolve) => {
        let pending = true;
        let running = false;
        let stopped = false;
        const poll = setInterval(wake, (relay.pollInterval || DEFAULT_POLL_INTERVAL) * 1000);

        const stop = () => {
            if (stopped) return;
            stopped = true;
            clearInterval(poll);
            process.off('SIGINT', stop);
            resolve();
        };

        async function wake() {
            pending = true;
            if (running || stopped) return;
            running = true;
            try {
                while (pending && !stopped) {
                    pending = false;
                    for (const channel of relay.channels) {
                        if (await processChannel(channel, state, relay, accounts) === 'stop') return stop();
                    }
                }
            } catch (error: any) {
                if (error.name === 'ExitPromptError') return stop();
                console.error(`\n❌ Error while checking channels: ${error.message}`);
            } finally {
                running = false;
            }
        }

        // Ctrl+C while idle (during prompts inquirer handles it and throws ExitPromptError)
        process.on('SIGINT', stop);
        console.log(`\n👀 Watching ${relay.channels.map(c => `@${c}`).join(', ')}. Press Ctrl+C to exit.`);
        void wake();
    });
}

async function main() {
    const accounts = await loadAccounts();
    const relay = accounts.relay;
    if (!relay || !relay.channels?.length) {
        console.error('❌ Error: "relay" section with "channels" is missing in accounts.json!');
        process.exit(1);
    }

    const state = await loadState();

    try {
        if (WATCH) {
            await watchChannels(state, relay, accounts);
        } else {
            for (const channel of relay.channels) {
                if (await processChannel(channel, state, relay, accounts) === 'stop') break;
            }
        }

        console.log('\n👋 Done.');
    } catch (error: any) {
        if (error.message === 'NO_SELECTION') console.log('\n⚠️ No accounts selected. Exiting...');
        else if (error.name === 'ExitPromptError') console.log('\n🚪 Process cancelled by user.');
        else console.error('\n❌ A critical error occurred:', error.message);
    } finally {
        await disconnectChrome();
        process.exit(0);
    }
}

main();
