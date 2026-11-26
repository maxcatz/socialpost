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
const ATTACH_BUTTON = /^(Attach|Прикрепить|צירוף|צרף)$/i;
const PREVIEW_IMAGE = 'img[src^="blob:"]';
const PHOTO_VIDEO_ITEM = /^(Photos & videos|Фото и видео)$/i;
// Caption field of the media editor: an editable box outside the chat footer (the message box is in the footer)
const CAPTION_EDITOR = '[contenteditable="true"]:not(footer [contenteditable="true"]):not(#side [contenteditable="true"])';
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
        await WhatsAppPublisher.closePopups(page);

        const media = post.media;
        const isImage = Boolean(media && post.mimeType?.startsWith('image/'));

        if (isImage && post.content.length <= CAPTION_LIMIT) {
            // Same as by hand: the text goes into the message box, then the picture is pasted.
            // WhatsApp opens the picture editor with the text as its caption; you press Send.
            await WhatsAppPublisher.typeText(page, page.locator(COMPOSE_BOX).first(), post.content);
            await WhatsAppPublisher.pasteImage(page, post);
            console.log('✅ Картинка с текстом в подписи открыта в WhatsApp. Проверьте и нажмите «Отправить».');
            return;
        }

        if (media && !isImage && post.content.length <= CAPTION_LIMIT) {
            // Video: "Photos & videos" from the attach menu, the text goes into the caption
            await WhatsAppPublisher.attachVideo(page, post, post.content);
            console.log('✅ Видео открыто в WhatsApp с подписью. Проверьте и нажмите «Отправить».');
            return;
        }

        await WhatsAppPublisher.typeText(page, page.locator(COMPOSE_BOX).first(), post.content);
        console.log('✅ Текст вставлен.');
        if (!media) return;

        if (!isImage) {
            console.log(`ℹ️ Текст длиннее ${CAPTION_LIMIT} символов — видео будет отдельным сообщением.`);
            await input({ message: 'Отправьте текст в WhatsApp, затем нажмите Enter здесь — прикреплю видео...' });
            await WhatsAppPublisher.attachVideo(page, post, '');
            console.log('✅ Видео открыто в WhatsApp. Проверьте и нажмите «Отправить».');
            return;
        }

        console.log(`ℹ️ Текст длиннее ${CAPTION_LIMIT} символов — картинка будет отдельным сообщением.`);
        await input({ message: 'Отправьте текст в WhatsApp, затем нажмите Enter здесь — вставлю картинку...' });
        await WhatsAppPublisher.pasteImage(page, post);
        console.log('✅ Картинка открыта в WhatsApp. Проверьте и нажмите «Отправить».');
    }

    /**
     * Closes promo dialogs that cover the chat (e.g. "Now you can make voice and video calls").
     */
    private static async closePopups(page: Page): Promise<void> {
        for (const close of await page.locator('[role="dialog"] [aria-label="Close"]').all()) {
            await close.click({ timeout: 2_000 }).catch(() => undefined);
            await page.waitForTimeout(300);
        }
    }

    /**
     * Puts the picture into the clipboard and pastes it into the message box. WhatsApp shows the picture
     * editor (its preview is a blob: image). Does not send anything.
     */
    private static async pasteImage(page: Page, post: PostData): Promise<void> {
        const copied = await copyImageToClipboard(post.media!, post.mimeType!).catch(() => false);
        if (!copied) throw new Error('не удалось скопировать картинку в буфер (только macOS)');

        const previewsBefore = await page.locator(PREVIEW_IMAGE).count();
        await page.locator(COMPOSE_BOX).first().click({ timeout: 5_000 });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
        await page.waitForFunction(
            (count: number) => document.querySelectorAll('img[src^="blob:"]').length > count,
            previewsBefore,
            { timeout: 15_000 }
        ).catch(() => {
            throw new Error('редактор картинки в WhatsApp не открылся');
        });
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
     * Attaches a video the way a person does: attach menu -> "Photos & videos" -> file dialog.
     * (Putting the file into WhatsApp's hidden inputs is ignored for videos.) Optional caption goes into
     * the caption box of the editor. Does not send anything.
     */
    private static async attachVideo(page: Page, post: PostData, caption: string): Promise<void> {
        const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
        await page.locator('footer').getByRole('button', { name: ATTACH_BUTTON }).first().click({ timeout: 5_000 });
        await page.getByText(PHOTO_VIDEO_ITEM).first().click({ timeout: 5_000 });
        await (await chooser).setFiles(post.media!);

        await page.waitForFunction(() => document.querySelectorAll('video[src^="blob:"]').length > 0, null, { timeout: 60_000 })
            .catch(() => {
                throw new Error('редактор видео в WhatsApp не открылся');
            });

        if (caption) {
            await page.locator(CAPTION_EDITOR).last().click({ timeout: 5_000 });
            await page.keyboard.insertText(caption);
        }
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
