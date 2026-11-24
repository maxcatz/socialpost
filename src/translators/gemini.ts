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

/**
 * Opens a new Gemini chat (or a Gem, if geminiUrl points to one) in the script's Chrome profile.
 */
export async function openGeminiChat(geminiUrl: string): Promise<Page> {
    const context = await connectChrome();
    const page = await context.newPage();
    await page.goto(geminiUrl, { waitUntil: 'domcontentloaded' });
    await page.locator(EDITOR).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.bringToFront();
    return page;
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

    // Wait for the new answer to appear, then for the generation to finish
    await page.waitForFunction(
        ([selector, count]) => document.querySelectorAll(selector as string).length > (count as number),
        [RESPONSE, responsesBefore] as const,
        { timeout: GENERATION_TIMEOUT }
    );
    return readLastAnswer(page);
}

/**
 * Returns the text of the last Gemini answer in the chat (waits if it is still being generated).
 * Used both after askGemini and after the user refined the translation in the chat manually.
 */
export async function readLastAnswer(page: Page): Promise<string> {
    const stop = page.getByRole('button', { name: STOP_BUTTON });
    const deadline = Date.now() + GENERATION_TIMEOUT;

    while (Date.now() < deadline) {
        const generating = await stop.first().isVisible().catch(() => false);
        if (!generating) {
            const answer = page.locator(RESPONSE).last().locator(RESPONSE_TEXT).first();
            if (await answer.count()) {
                const text = (await answer.innerText()).trim();
                if (text) return text;
            }
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

/**
 * Asks Gemini to generate a picture (e.g. "Сгенерируй картинку к этому тексту") and returns its file.
 * The picture is a blob: URL inside the page, so it is read through the page.
 */
export async function generateImage(page: Page, request: string): Promise<{ buffer: Buffer; ext: string }> {
    const responsesBefore = await page.locator(RESPONSE).count();

    const editor = page.locator(EDITOR).first();
    await editor.click();
    await page.keyboard.insertText(request);
    const sendButton = page.getByRole('button', { name: SEND_BUTTON }).first();
    if (await sendButton.isVisible().catch(() => false)) await sendButton.click();
    else await page.keyboard.press('Enter');

    const deadline = Date.now() + GENERATION_TIMEOUT;
    let idle = 0; // seconds the answer has finished without a picture
    while (Date.now() < deadline) {
        const generating = await page.getByRole('button', { name: STOP_BUTTON }).first().isVisible().catch(() => false);
        const src = (await page.locator(RESPONSE).count()) > responsesBefore
            ? await page.locator(RESPONSE).last().locator('img').first()
                .evaluate((img: HTMLImageElement) => (img.naturalWidth > 0 ? img.src : null))
                .catch(() => null)
            : null;

        if (src && !generating) {
            // Redraw the picture on a canvas: fetch() cannot read the page's blob: URL reliably
            const dataUrl = await page.locator(RESPONSE).last().locator('img').first().evaluate((img: HTMLImageElement) => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d')!.drawImage(img, 0, 0);
                return canvas.toDataURL('image/png');
            });
            return { buffer: Buffer.from(dataUrl.split(',')[1], 'base64'), ext: 'png' };
        }

        if (!generating && !src) {
            // The answer is finished but has no picture (e.g. Gemini refused): give the image a few seconds to load
            idle++;
            if (idle > 20) throw new Error('Gemini не прислал картинку');
        }
        await page.waitForTimeout(1000);
    }
    throw new Error('Gemini не прислал картинку вовремя');
}
