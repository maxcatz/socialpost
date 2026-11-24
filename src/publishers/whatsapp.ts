import clipboardy from 'clipboardy';
import { input } from '@inquirer/prompts';
import { Page } from 'playwright-core';
import { connectChrome } from '../browser.js';
import { copyImageToClipboard } from '../utils.js';
import { PostData, PublishResult, WhatsAppConfig } from '../types.js';
import { offerMediaInClipboard, publishManual, RunSafe } from './common.js';

// WhatsApp Web
const CHAT_LIST = '#pane-side';
const QR_CODE = 'canvas[aria-label]';
const COMPOSE_BOX = 'footer div[contenteditable="true"]';
const CAPTION_BOX = '[contenteditable="true"]:not(footer [contenteditable]):not(#side [contenteditable])';
const ATTACH_BUTTON = /^(Attach|Прикрепить|צירוף|צרף)$/i;
const MEDIA_INPUT = 'input[type="file"][accept*="image"]';
// Longer texts go as a separate message, the media follows without a caption
const CAPTION_LIMIT = 1024;
const LOGIN_TIMEOUT = 3 * 60_000;

export class WhatsAppPublisher {
    @RunSafe('WhatsApp')
    static async publish(post: PostData, account: WhatsAppConfig): Promise<PublishResult> {
        console.log(`\n▶ Preparing WhatsApp for: [${account.name}]...`);

        let page: Page;
        try {
            const context = await connectChrome();
            page = await context.newPage();
        } catch (error: any) {
            console.warn(`⚠️ Автоматический режим недоступен (${error.message}). Переключаюсь на ручной режим.`);
            return WhatsAppPublisher.publishManually(post, account);
        }

        try {
            await WhatsAppPublisher.fillChat(page, post, account);
        } catch (error: any) {
            console.warn(`⚠️ Не удалось подготовить сообщение автоматически: ${error.message}`);
            console.warn('   Текст скопирован в буфер обмена, доделайте вручную в открытой вкладке.');
            clipboardy.writeSync(post.content);
            await offerMediaInClipboard(post);
        }

        console.log('\n=========================================');
        console.log(`👉 Проверьте сообщение в WhatsApp и нажмите «Отправить» для [${account.name}].`);
        console.log('=========================================\n');
        await input({ message: 'Нажмите Enter после отправки...' });
        await page.close().catch(() => undefined);
        return { platform: 'WhatsApp', name: account.name, url: 'отправлено' };
    }

    private static async fillChat(page: Page, post: PostData, account: WhatsAppConfig): Promise<void> {
        const code = account.inviteLink.match(/(?:code=|chat\.whatsapp\.com\/)([\w-]+)/)?.[1];
        if (!code) throw new Error(`не удалось извлечь код группы из ссылки ${account.inviteLink}`);

        const groupUrl = `https://web.whatsapp.com/accept?code=${code}`;
        await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
        await page.bringToFront();
        await WhatsAppPublisher.waitForChat(page, groupUrl);

        const media = post.media;
        if (media && post.content.length <= CAPTION_LIMIT) {
            // Media with the text as its caption — one message
            await WhatsAppPublisher.attachMedia(page, post);
            await WhatsAppPublisher.typeText(page, page.locator(CAPTION_BOX).last(), post.content);
            console.log('✅ Медиа прикреплено, текст вставлен в подпись.');
            return;
        }

        await WhatsAppPublisher.typeText(page, page.locator(COMPOSE_BOX).first(), post.content);
        console.log('✅ Текст вставлен.');
        if (!media) return;

        console.log(`ℹ️ Текст длиннее ${CAPTION_LIMIT} символов — медиа будет отдельным сообщением.`);
        await input({ message: 'Отправьте текст в WhatsApp, затем нажмите Enter здесь — прикреплю медиа...' });
        await WhatsAppPublisher.attachMedia(page, post);
        console.log('✅ Медиа прикреплено.');
    }

    /**
     * Waits until the group chat is open; asks to scan the QR code if WhatsApp Web is not logged in.
     */
    private static async waitForChat(page: Page, groupUrl: string): Promise<void> {
        const compose = page.locator(COMPOSE_BOX).first();
        const qr = page.locator(QR_CODE).first();
        const ready = await Promise.race([
            compose.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'chat'),
            qr.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'login'),
        ]).catch(() => 'timeout');

        if (ready === 'login') {
            console.log('📱 Войдите в WhatsApp Web: на телефоне WhatsApp → Настройки → Связанные устройства → Привязать устройство, и отсканируйте QR в Chrome.');
            await page.locator(CHAT_LIST).waitFor({ timeout: LOGIN_TIMEOUT });
            // After the login WhatsApp opens the chat list, not the group — follow the invite link again
            await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
            await compose.waitFor({ state: 'visible', timeout: 60_000 });
        } else if (ready === 'timeout') {
            throw new Error('чат группы не открылся (проверьте ссылку-приглашение и что вы участник группы)');
        }
    }

    /**
     * Types multi-line text: Shift+Enter between lines, because Enter sends the message.
     */
    private static async typeText(page: Page, box: ReturnType<Page['locator']>, text: string): Promise<void> {
        await box.waitFor({ state: 'visible', timeout: 15_000 });
        await box.click();
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (i > 0) await page.keyboard.press('Shift+Enter');
            if (lines[i]) await page.keyboard.insertText(lines[i]);
        }
    }

    /**
     * Attaches the media through the "Attach → Photos & videos" file input, falling back to pasting
     * an image from the clipboard. Resolves when the media editor with the caption box is open.
     */
    private static async attachMedia(page: Page, post: PostData): Promise<void> {
        const mediaPath = post.media!;
        const caption = page.locator(CAPTION_BOX);
        const editorOpened = async () => {
            await caption.last().waitFor({ state: 'visible', timeout: post.mimeType?.startsWith('video/') ? 60_000 : 15_000 });
        };

        try {
            await page.locator('footer').getByRole('button', { name: ATTACH_BUTTON }).first().click({ timeout: 5_000 });
            const fileInput = page.locator(MEDIA_INPUT).first();
            await fileInput.waitFor({ state: 'attached', timeout: 5_000 });
            await fileInput.setInputFiles(mediaPath);
            await editorOpened();
            return;
        } catch {
            await page.keyboard.press('Escape').catch(() => undefined);
        }

        if (post.mimeType?.startsWith('image/') && (await copyImageToClipboard(mediaPath, post.mimeType).catch(() => false))) {
            await page.locator(COMPOSE_BOX).first().click({ timeout: 5_000 });
            await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
            await editorOpened();
            return;
        }

        throw new Error('не удалось прикрепить медиа');
    }

    private static async publishManually(post: PostData, account: WhatsAppConfig): Promise<PublishResult> {
        return publishManual({
            platform: 'WhatsApp',
            accountName: account.name,
            urlToOpen: account.inviteLink,
            instructions: [
                'The WhatsApp app should now be in focus.',
                'Press Cmd+V to paste the text.',
                ...(post.media ? ['Media found. You may need to drag it manually.'] : []),
                'Press Enter to send.',
            ],
            post,
        });
    }
}
