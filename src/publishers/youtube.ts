import fs from 'node:fs';
import clipboardy from 'clipboardy';
import { input } from '@inquirer/prompts';
import { google } from 'googleapis';
import { Page } from 'playwright-core';
import { connectChrome } from '../browser.js';
import { copyImageToClipboard, revealFileInFinder } from '../utils.js';
import { PostData, PublishResult, YouTubeConfig } from '../types.js';
import { publishManual, offerMediaInClipboard, askPublishedUrl, RunSafe } from './common.js';

// Post composer on the channel's Posts tab (visible to the channel owner only)
const COMPOSER = 'ytd-backstage-post-dialog-renderer';
const EDITOR = `${COMPOSER} #contenteditable-root[contenteditable="true"], ${COMPOSER} [contenteditable="true"]`;
const PLACEHOLDER = `${COMPOSER} #unopened-dialog #placeholder-area, ${COMPOSER} #commentbox-placeholder`;
const CREATE_POST_BUTTON = /Create post|Create a post|Создать публикацию|Создать пост|יצירת פוסט/i;
const IMAGE_BUTTON = /^(Add (an )?)?image$|Изображение|Добавить изображение|^תמונה$|הוספת תמונה/i;
const IMAGE_PICKER = 'ytd-backstage-multi-image-select-renderer';
const SELECT_FILE_LINK = /select from your computer|выберите на компьютере|выбрать на компьютере|בחירה מהמחשב/i;
const CONSENT_BUTTON = /Accept all|Принять все|קבל הכל|אשר הכל/i;
const SIGN_IN_LINK = /Sign in|Войти|כניסה/i;

export class YouTubePublisher {
  @RunSafe('YouTube')
  static async publish(post: PostData, filePath: string, account: YouTubeConfig): Promise<PublishResult> {

    let uploadedVideoUrl: string | undefined;
    let finalPostData = {...post};

    console.log(`\n▶ Preparing YouTube for: [${account.name}]...`);

    // 1. If there is a video, upload it via API first
    if (post.media && post.mimeType?.startsWith('video/') && fs.existsSync(post.media)) {
      console.log(`🎥 Video detected: ${post.media}. Starting upload...`);
      try {
        uploadedVideoUrl = await this.uploadVideoViaApi(post.media, post.title, post.content);

        console.log('\n=========================================');
        console.log(`✅ Video uploaded successfully!`);
        console.log(`🔗 Video URL: ${uploadedVideoUrl}`);
        console.log('=========================================\n');

        // The video link goes into the post text (YouTube shows it as a video card)
        finalPostData.content = `${post.content}\n\nWatch the video: ${uploadedVideoUrl}`;
      } catch (error: any) {
        console.warn(`⚠️ Не удалось загрузить видео через API (${error.message}). Публикую пост без видео.`);
      }
    }

    // 2. Fill in the post in Chrome; the user presses "Post"
    let page: Page;
    try {
      const context = await connectChrome();
      page = await context.newPage();
    } catch (error: any) {
      console.warn(`⚠️ Автоматический режим недоступен (${error.message}). Переключаюсь на ручной режим.`);
      return this.publishManually(finalPostData, account);
    }

    try {
      await this.fillComposer(page, finalPostData, account, Boolean(uploadedVideoUrl));
    } catch (error: any) {
      console.warn(`⚠️ Не удалось подготовить пост автоматически: ${error.message}`);
      console.warn('   Текст скопирован в буфер обмена, доделайте вручную в открытой вкладке.');
      clipboardy.writeSync(finalPostData.content);
      await offerMediaInClipboard(finalPostData);
    }

    const url = await askPublishedUrl(account.name, 'youtube.com');
    // Put the real post link into the clipboard (not the "URL не указан" placeholder)
    if (/^https?:\/\//.test(url)) {
      clipboardy.writeSync(url);
      console.log('📋 Ссылка на пост скопирована в буфер обмена.');
    }
    await page.close().catch(() => undefined);
    return { platform: 'YouTube', name: account.name, url };
  }

  private static async fillComposer(page: Page, post: PostData, account: YouTubeConfig, videoAlreadyLinked: boolean): Promise<void> {
    const postsUrl = `https://www.youtube.com/${account.channelHandle}/posts`;
    await page.goto(postsUrl, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    // Cookie consent screen (EU) - best effort
    await page.getByRole('button', { name: CONSENT_BUTTON }).first().click({ timeout: 2_000 }).catch(() => undefined);

    const editor = page.locator(EDITOR).first();
    const placeholder = page.locator(PLACEHOLDER).first();
    // The composer starts collapsed ("What's on your mind?"): the editor stays hidden until the placeholder is clicked
    const editorAppears = async (timeout: number): Promise<boolean> => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await editor.isVisible()) return true;
        if (await placeholder.isVisible()) await placeholder.click({ timeout: 2_000 }).catch(() => undefined);
        await page.waitForTimeout(500);
      }
      return false;
    };

    // 1. Find the post editor (maybe behind a "Create post" button, maybe the user is not signed in)
    if (!(await editorAppears(15_000))) {
      await page.getByRole('button', { name: CREATE_POST_BUTTON }).first().click({ timeout: 3_000 }).catch(() => undefined);
      if (!(await editorAppears(5_000))) {
        const signedOut = page.url().includes('accounts.google.com') || (await page.getByRole('link', { name: SIGN_IN_LINK }).count()) > 0;
        if (!signedOut) {
          throw new Error('не найдено поле для нового поста (нужен вход в Google с аккаунта, владеющего каналом)');
        }
        console.log('🔑 В этом Chrome нет входа в YouTube. Войдите в Google в открытом окне (один раз — сессия сохранится).');
        await input({ message: 'После входа нажмите Enter:' });
        await page.goto(postsUrl, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: CREATE_POST_BUTTON }).first().click({ timeout: 5_000 }).catch(() => undefined);
        if (!(await editorAppears(30_000))) {
          throw new Error('не найдено поле для нового поста после входа');
        }
      }
    }

    // 2. Type the text
    await editor.click();
    const lines = post.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press('Shift+Enter');
      if (lines[i]) await page.keyboard.insertText(lines[i]);
    }
    console.log('✅ Текст вставлен.');

    // 3. Media: images are attached; a video is already in the text as a link
    if (!post.media) return;
    if (post.mimeType?.startsWith('video/')) {
      if (videoAlreadyLinked) {
        console.log('ℹ️ Видео загружено через API, ссылка на него уже в тексте поста.');
      } else {
        console.warn('⚠️ Видео нельзя прикрепить к посту файлом — показываю файл в Finder.');
        await revealFileInFinder(post.media);
      }
      return;
    }
    try {
      await this.attachImage(page, post);
      console.log('✅ Картинка прикреплена.');
    } catch (error: any) {
      console.warn(`⚠️ Не удалось прикрепить картинку (${error.message}).`);
      await offerMediaInClipboard(post, '📋 Кликните в поле поста и нажмите Enter здесь — скопирую картинку в буфер (затем Cmd+V):');
    }
  }

  /**
   * Attaches an image and verifies that a preview appeared in the composer.
   * Order: "Image" button -> file chooser / file input, then paste from the clipboard.
   */
  private static async attachImage(page: Page, post: PostData): Promise<void> {
    const mediaPath = post.media!;
    const composer = page.locator(COMPOSER).first();
    // Uploaded images are shown as data:/blob: previews (the channel avatar and empty placeholders are not)
    const previews = composer.locator('img[src^="data:image"], img[src^="blob:"]');
    const before = await previews.count();
    const hasPreview = async (timeout: number): Promise<boolean> => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if ((await previews.count()) > before) return true;
        await page.waitForTimeout(500);
      }
      return false;
    };

    // 1. "Image" button opens an upload area; the file goes into its input (or via "select from your computer")
    try {
      // There are two such buttons (collapsed and expanded composer) — use the visible one
      await composer.getByRole('button', { name: IMAGE_BUTTON }).locator('visible=true').first().click({ timeout: 5_000 });
      const picker = composer.locator(IMAGE_PICKER).first();
      await picker.waitFor({ state: 'visible', timeout: 5_000 });
      const input = picker.locator('#dropzone input[type="file"]');
      if ((await input.count()) > 0) {
        await input.first().setInputFiles(mediaPath, { timeout: 5_000 });
      } else {
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 });
        await picker.getByText(SELECT_FILE_LINK).first().click({ timeout: 5_000 });
        await (await chooserPromise).setFiles(mediaPath);
      }
      if (await hasPreview(15_000)) return;
    } catch {
      // fall through to the clipboard paste
    }

    // 2. Paste from the clipboard into the editor
    if (await copyImageToClipboard(mediaPath, post.mimeType).catch(() => false)) {
      await page.bringToFront();
      await page.locator(EDITOR).first().click({ timeout: 5_000 });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
      if (await hasPreview(10_000)) return;
    }

    throw new Error('превью картинки не появилось в окне поста');
  }

  private static async publishManually(post: PostData, account: YouTubeConfig): Promise<PublishResult> {
    const instructions = [
      'Click on the post input field.',
      'Press Cmd+V / Ctrl+V to paste the text.',
      'If there is an image, paste it (it will be copied to the clipboard after you press Enter).',
      'Click "Post".',
      'Once published, copy the post URL from the browser address bar to complete the script.',
    ];

    return publishManual({
      platform: 'YouTube',
      accountName: account.name,
      urlToOpen: `https://www.youtube.com/${account.channelHandle}/posts`,
      instructions,
      post,
    });
  }

  /**
   * Uploads a video file to YouTube via the Data API v3.
   * Throws an error if upload fails or credentials are missing.
   */
  private static async uploadVideoViaApi(videoPath: string, title: string | undefined, description: string): Promise<string> {
    const clientId = process.env.YT_CLIENT_ID;
    const clientSecret = process.env.YT_CLIENT_SECRET;
    const refreshToken = process.env.YT_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Missing YouTube API credentials (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN) in .env file.');
    }

    // Initialize OAuth2 client
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });

    // Enforce YouTube API limits
    const safeTitle = title ? title.substring(0, 100) : 'New Video';
    const safeDescription = description ? description.substring(0, 5000) : '';

    // Get file size for progress calculation (optional but helpful for large files)
    const fileSize = fs.statSync(videoPath).size;

    const res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: safeTitle,
          description: safeDescription,
          categoryId: '22', // 22 = People & Blogs
        },
        status: {
          privacyStatus: 'public', // Can be 'private', 'unlisted', or 'public'
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(videoPath),
      },
    }, {
      // Track upload progress in the console
      onUploadProgress: (evt) => {
        const progress = (evt.bytesRead / fileSize) * 100;
        process.stdout.write(`\r⬆️ Uploading: ${Math.round(progress)}%`);
      }
    });

    process.stdout.write('\n'); // Clear the progress line after upload

    if (!res.data.id) {
      throw new Error('YouTube API did not return a video ID.');
    }

    return `https://youtu.be/${res.data.id}`;
  }
}
