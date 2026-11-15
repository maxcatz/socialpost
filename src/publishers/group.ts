import clipboardy from 'clipboardy';
import { Page } from 'playwright-core';
import { connectChrome } from '../browser.js';
import { copyImageToClipboard } from '../utils.js';
import { PostData, PublishResult, FacebookGroupConfig } from '../types.js';
import { publishManual, offerMediaInClipboard, askPublishedUrl, RunSafe } from './common.js';

const COMPOSER_TRIGGER = /Write something|Create a public post|Create post|Напишите|Создать публичную|Создать публикацию|כתוב|יצירת פוסט|כתיבת פוסט|פרסום ציבורי/i;
const PHOTO_VIDEO_BUTTON = /Photo\/video|Photo|Фото|תמונה|וידאו|תמונות/i;
const DIALOG = 'div[role="dialog"]';
const TEXTBOX = 'div[role="textbox"][contenteditable="true"]';
// Appear in the composer once a photo/video is attached
const ATTACHMENT_CONTROLS = /Remove post attachment|Edit photos|Remove attachment|Удалить вложение|Редактировать фото|הסר|עריכת תמונ|ערוך/i;

export class FacebookGroupPublisher {
  @RunSafe('Facebook Group')
  static async publish(post: PostData, account: FacebookGroupConfig): Promise<PublishResult> {
    console.log(`\n▶ Preparing Facebook Group for: [${account.name}]...`);

    let page: Page;
    try {
      const context = await connectChrome();
      page = await context.newPage();
    } catch (error: any) {
      console.warn(`⚠️ Автоматический режим недоступен (${error.message}). Переключаюсь на ручной режим.`);
      return FacebookGroupPublisher.publishManually(post, account);
    }

    try {
      await FacebookGroupPublisher.fillComposer(page, post, account);
    } catch (error: any) {
      console.warn(`⚠️ Не удалось подготовить пост автоматически: ${error.message}`);
      console.warn('   Текст скопирован в буфер обмена, доделайте вручную в открытой вкладке.');
      clipboardy.writeSync(post.content);
      await offerMediaInClipboard(post);
    }

    const url = await askPublishedUrl(account.name, 'facebook.com');
    await page.close().catch(() => undefined);
    return { platform: 'Facebook Group', name: account.name, url };
  }

  private static async fillComposer(page: Page, post: PostData, account: FacebookGroupConfig): Promise<void> {
    await page.goto(account.url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    // 1. Open the composer dialog
    const trigger = page.getByRole('button', { name: COMPOSER_TRIGGER }).first();
    try {
      await trigger.waitFor({ state: 'visible', timeout: 30_000 });
    } catch {
      throw new Error('не найдено поле для нового поста (возможно, нужно войти в Facebook в этом Chrome)');
    }
    await trigger.click();

    // 2. Type the text into the editor
    const textbox = FacebookGroupPublisher.composerDialog(page).locator(TEXTBOX).first();
    await textbox.waitFor({ state: 'visible', timeout: 15_000 });
    await textbox.click();
    const lines = post.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press('Enter');
      if (lines[i]) await page.keyboard.insertText(lines[i]);
    }
    console.log('✅ Текст вставлен.');

    // 3. Attach the media
    if (post.media) {
      try {
        await FacebookGroupPublisher.attachMedia(page, post);
        console.log('✅ Медиа прикреплено.');
      } catch (error: any) {
        console.warn(`⚠️ Не удалось прикрепить медиа (${error.message}).`);
        await offerMediaInClipboard(post, '📋 Кликните в поле поста и нажмите Enter здесь — скопирую картинку в буфер (затем Cmd+V):');
      }
    }
  }

  /**
   * Facebook opens several role=dialog elements; the real composer is the one that contains the text editor.
   */
  private static composerDialog(page: Page) {
    return page.locator(DIALOG).filter({ has: page.locator(TEXTBOX) }).first();
  }

  /**
   * Attaches the media and verifies that it actually appeared in the composer.
   * Order: file chooser / file input, then (images only) paste from the clipboard.
   */
  private static async attachMedia(page: Page, post: PostData): Promise<void> {
    const mediaPath = post.media!;
    const dialog = FacebookGroupPublisher.composerDialog(page);
    const controls = dialog.getByRole('button', { name: ATTACHMENT_CONTROLS });
    const previews = dialog.locator('img, video');
    const controlsBefore = await controls.count();
    const previewsBefore = await previews.count();
    const hasPreview = async (timeout: number): Promise<boolean> => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if ((await controls.count()) > controlsBefore || (await previews.count()) > previewsBefore) return true;
        await page.waitForTimeout(500);
      }
      return false;
    };

    // 1. Photo/video button -> file chooser or a file input that appears in the dialog
    try {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 4_000 }).catch(() => null);
      await dialog.getByRole('button', { name: PHOTO_VIDEO_BUTTON }).first().click({ timeout: 5_000 }).catch(() => undefined);
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(mediaPath);
      } else {
        const inputs = dialog.locator('input[type="file"]');
        if ((await inputs.count()) > 0) await inputs.last().setInputFiles(mediaPath, { timeout: 5_000 });
      }
      if (await hasPreview(post.mimeType?.startsWith('video/') ? 60_000 : 10_000)) return;
    } catch {
      // fall through to the clipboard paste
    }

    // 2. Images: paste from the clipboard into the editor
    if (post.mimeType?.startsWith('image/') && (await copyImageToClipboard(mediaPath, post.mimeType).catch(() => false))) {
      const textbox = dialog.locator(TEXTBOX).first();
      await page.bringToFront();
      await textbox.click({ timeout: 5_000 });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
      if (await hasPreview(10_000)) return;
    }

    throw new Error('превью медиа не появилось в окне поста');
  }

  private static async publishManually(post: PostData, account: FacebookGroupConfig): Promise<PublishResult> {
    const instructions = [
      'Click on the post input field in the group.',
      'Press Cmd+V / Ctrl+V to paste the text.',
      'If there is an image, drag and drop it from the opened file explorer.',
      'Click "Post" (Опубликовать).',
      'Once published, copy the post URL from the browser address bar to complete the script.',
    ];

    return publishManual({
      platform: 'Facebook Group',
      accountName: account.name,
      urlToOpen: `${account.url}/posts`,
      instructions,
      post,
    });
  }
}
