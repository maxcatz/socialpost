import fs from 'node:fs';
import matter from 'gray-matter';
import clipboardy from 'clipboardy';
import open from 'open';
import * as process from "node:process";
import { exec } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

interface FrontMatter {
  title: string;
  image?: string;
  facebook_tags?: string;
}

async function prepareYouTubePost(filePath: string) {
  // 1. Читаем Markdown файл
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(fileContent);

  // Можно добавить логику: если есть Title в front-matter, добавить его жирным шрифтом
  let finalPostText = content.trim();
  if (data.title) {
    finalPostText = `*${data.title}*\n\n${finalPostText}`;
  }

  // 2. Копируем готовый текст в буфер обмена
  clipboardy.writeSync(finalPostText);

  // 3. Формируем ссылку на вкладку "Сообщество" вашего канала
  // ВАЖНО: Замените @ВАШ_КАНАЛ на ваш реальный handle (например, @zehut)
  const channelHandle = process.env.CHANNEL_HANDLE || 'public';
  const communityUrl = `https://www.youtube.com/${channelHandle}/posts`;

  // 4. Открываем браузер на нужной странице
  await open(communityUrl);

  // 2. Открываем папку с картинкой и выделяем её
  await revealFileInFinder(filePath);

  // 5. Выводим четкую инструкцию в терминал
  console.log('\n=========================================');
  console.log('✅ Текст поста скопирован в буфер обмена!');
  console.log(`✅ Браузер открыт: ${communityUrl}`);
  console.log('=========================================\n');
  console.log('Что делать дальше:');
  console.log('1. Кликните в поле ввода поста на YouTube.');
  console.log('2. Нажмите Cmd+V для вставки текста.');
  console.log('3. Нажмите на иконку "Изображение" и перетащите выделенную картинку.');
  console.log('4. Нажмите "Опубликовать".\n');
}

async function revealFileInFinder(filePath: string) {
  const absolutePath = path.resolve(filePath);

  // Определяем ОС и запускаем соответствующую команду
  if (os.platform() === 'darwin') {
    // macOS: открыть папку и выделить файл
    exec(`open -R "${absolutePath}"`);
  } else if (os.platform() === 'win32') {
    // Windows: открыть папку и выделить файл
    exec(`explorer.exe /select,"${absolutePath}"`);
  }
}

async function publishToTelegram(filePath: string) {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(fileContent);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // Подготавливаем картинку
  const imagePath = data.image;
    const imageBuffer = imagePath?fs.readFileSync(imagePath):undefined;

  // Логика разделения
  if (content.length <= 1024) {
    // ВАРИАНТ 1: Текст короткий. Отправляем всё вместе (фото + подпись)
    const url = `https://api.telegram.org/bot${token}/sendPhoto`;
    const formData = new FormData();
    formData.append('chat_id', chatId as string);
    formData.append('caption', content);
    if(imageBuffer) {
      formData.append('photo', new Blob([imageBuffer]), 'image.jpg');
    }

    const res = await fetch(url, { method: 'POST', body: formData as any });
    const result = await res.json() as any;

    if (!result.ok) {
      console.error('Ошибка Telegram (Фото+Текст):', result.description);
    } else {
      console.log('Пост успешно опубликован (одним сообщением)!');
    }

  } else if (imageBuffer) {
    // ВАРИАНТ 2: Текст длиннее 1024. Сначала текст, потом фото реплаем.
    console.log('Текст длинный, разбиваем на два сообщения...');

    // 1. Отправляем текст (лимит Telegram для текста — 4096 символов)
    // На всякий случай обрезаем до 4096, чтобы API не выдал ошибку
    const textToSend = content.substring(0, 4096);
    const textUrl = `https://api.telegram.org/bot${token}/sendMessage`;

    const textRes = await fetch(textUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: textToSend
      })
    });

    const textResult = await textRes.json() as any;

    if (!textResult.ok) {
      console.error('Ошибка отправки текста:', textResult.description);
      return; // Прерываем, если текст не ушел
    }

    // Получаем ID только что отправленного текстового сообщения
    const messageId = textResult.result.message_id;
    console.log(`Текст отправлен. ID: ${messageId}. Отправляем фото...`);

    // 2. Отправляем фото как реплай к тексту
    const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
    const photoFormData = new FormData();
    photoFormData.append('chat_id', chatId as string);
    photoFormData.append('photo', new Blob([imageBuffer]), 'image.jpg');
    photoFormData.append('reply_to_message_id', messageId.toString()); // Делаем реплай

    const photoRes = await fetch(photoUrl, {
      method: 'POST',
      body: photoFormData as any
    });

    const photoResult = await photoRes.json() as any;

    if (!photoResult.ok) {
      console.error('Ошибка отправки фото-реплая:', photoResult.description);
    } else {
      console.log('Фото успешно отправлено как реплай!');
    }
  }
}

async function publishFacebookPost(filePath: string) {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(fileContent) as unknown as { data: FrontMatter, content: string };

  const message = `${content.trim()}\n\n${data.facebook_tags || ''}`;
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_TOKEN;

  if (!pageId || !token) throw new Error("FB_PAGE_ID или FB_PAGE_TOKEN не заданы");

  const formData = new FormData();
  formData.append('message', message);
  formData.append('access_token', token);
  formData.append('published', 'true');

  if (data.image) {
    console.log(`Прикрепляем изображение: ${data.image}`);
    const imageBuffer = fs.readFileSync(data.image);
    formData.append('source', new Blob([imageBuffer]));
  }

  const endpoint = data.image ? 'photos' : 'feed';
  const url = `https://graph.facebook.com/v25.0/${pageId}/${endpoint}`;

  const res = await fetch(url, { method: 'POST', body: formData });
  const result = await res.json() as any;

  if (result.error) {
    console.error('Ошибка Facebook:', result.error.message);
  } else {
    console.log(`Ссылка: https://facebook.com/${pageId}/posts/${result.id}`);
    console.log(`Успешно! ID поста: ${result.id || result.post_id}`);
  }
}

const filePath = process.argv[2];
if (!filePath) {
  console.error('Укажите путь к файлу!');
  process.exit(1);
}
// publishFacebookPost(filePath);
publishToTelegram(filePath);
//prepareYouTubePost(filePath);
