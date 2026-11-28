import { Page } from 'playwright-core';
import { connectChrome } from '../browser.js';

// Gemini web UI, verified 2026-11-23
const EDITOR = 'rich-textarea [contenteditable="true"]';
const RESPONSE = 'model-response';
const RESPONSE_TEXT = 'message-content';
const USER_QUERY = 'user-query';
const USER_QUERY_LINE = '.query-text-line';
const STOP_BUTTON = /Stop response|Остановить|עצור/i;
const SEND_BUTTON = /Send message|Отправить|שליחה/i;

const GENERATION_TIMEOUT = 5 * 60_000;
// If the answer shows no progress for this long, the tab probably lost the stream
// (Gemini keeps spinning although the answer is ready on the server) — reload the chat.
const STALL_TIMEOUT = 40_000;
const MAX_RELOADS = 2;
// A chat that already has an id (gemini.google.com/app/<id> or a Gem chat) can be reloaded safely
const CHAT_URL = /\/(app|gem\/[^/]+)\/[0-9a-f]{6,}/i;

/**
 * Opens a new Gemini chat (or a Gem, if geminiUrl points to one) in the script's Chrome profile.
 */
export async function openGeminiChat(geminiUrl: string): Promise<Page> {
    const context = await connectChrome();
    const page = await context.newPage();
    await page.bringToFront();
    await page.goto(geminiUrl, { waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    return page;
}

/**
 * Waits until the chat UI is usable. The editor appears before Gemini finishes initializing;
 * a message sent too early may never get its answer streamed into the tab.
 */
async function waitForReady(page: Page) {
    await page.locator(EDITOR).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    if (CHAT_URL.test(page.url())) {
        // An existing chat: its history renders ~1s after the editor. A message sent before that
        // may start a new chat instead of continuing this one.
        await page.locator(USER_QUERY).first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => undefined);
        let count = -1;
        for (let i = 0; i < 10; i++) {
            const now = await page.locator(USER_QUERY).count();
            if (now === count) break;
            count = now;
            await page.waitForTimeout(700);
        }
    }
    await page.waitForTimeout(1500);
}

/**
 * Sends the request to the chat and returns the text of Gemini's answer.
 */
export async function askGemini(page: Page, request: string): Promise<string> {
    const responsesBefore = await page.locator(RESPONSE).count();

    const editor = page.locator(EDITOR).first();
    await editor.click();
    // insertText keeps line breaks without triggering Enter (= send) on every new line
    await page.keyboard.insertText(request);

    const sendButton = page.getByRole('button', { name: SEND_BUTTON }).first();
    if (await sendButton.isVisible().catch(() => false)) await sendButton.click();
    else await page.keyboard.press('Enter');

    return waitForAnswer(page, { responsesBefore, request });
}

/**
 * Returns the text of the last Gemini answer in the chat (waits if it is still being generated).
 * Used after the user refined the translation in the chat manually.
 */
export async function readLastAnswer(page: Page): Promise<string> {
    return waitForAnswer(page, {});
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Waits for the answer to finish and returns its text. If the tab stalls (no progress for
 * STALL_TIMEOUT), reloads the chat: after the reload Gemini shows the answer finished on the server.
 * With `responsesBefore`, waits for a new answer; after a reload (the count of loaded turns may
 * change) the answer is recognized by the last user message matching `request`.
 */
async function waitForAnswer(page: Page, expected: { responsesBefore?: number; request?: string }): Promise<string> {
    const stop = page.getByRole('button', { name: STOP_BUTTON });
    const deadline = Date.now() + GENERATION_TIMEOUT;
    let reloaded = 0;
    let lastState = '';
    let lastProgress = Date.now();

    const isOurAnswer = async (): Promise<boolean> => {
        if (expected.responsesBefore === undefined) return true;
        if (!reloaded) return (await page.locator(RESPONSE).count()) > expected.responsesBefore;
        const lastQuery = page.locator(USER_QUERY).last();
        if (!(await lastQuery.count())) return false;
        const lines = await lastQuery.locator(USER_QUERY_LINE).allInnerTexts();
        const shown = normalize(lines.join(' '));
        const sent = normalize(expected.request ?? '');
        const probe = Math.min(80, shown.length, sent.length);
        return probe > 0 && shown.slice(0, probe) === sent.slice(0, probe);
    };

    while (Date.now() < deadline) {
        const generating = await stop.first().isVisible().catch(() => false);
        const ours = await isOurAnswer().catch(() => false);
        let text = '';
        if (ours) {
            const answer = page.locator(RESPONSE).last().locator(RESPONSE_TEXT).first();
            if (await answer.count()) text = (await answer.innerText().catch(() => '')).trim();
            if (text && !generating) return text;
        }

        const state = `${ours}|${generating}|${text.length}`;
        if (state !== lastState) {
            lastState = state;
            lastProgress = Date.now();
        } else if (Date.now() - lastProgress > STALL_TIMEOUT && reloaded < MAX_RELOADS && CHAT_URL.test(page.url())) {
            console.log('⏳ Gemini завис в этой вкладке — перезагружаю чат...');
            reloaded++;
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
            await waitForReady(page).catch(() => undefined);
            lastState = '';
            lastProgress = Date.now();
            continue;
        }
        await page.waitForTimeout(1000);
    }
    throw new Error('Gemini did not finish the answer in time');
}

/**
 * Texts of the user's messages in the chat, oldest first (the first one is the translation request).
 */
export async function readUserMessages(page: Page): Promise<string[]> {
    const queries = page.locator(USER_QUERY);
    const messages: string[] = [];
    for (let i = 0, count = await queries.count(); i < count; i++) {
        const lines = await queries.nth(i).locator(USER_QUERY_LINE).allInnerTexts();
        const text = lines.map(l => l.trim()).filter(Boolean).join('\n');
        if (text) messages.push(text);
    }
    return messages;
}
