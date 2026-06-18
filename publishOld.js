import fs from 'node:fs/promises';
import matter from 'gray-matter';

async function publishToFacebook(text, tags) {
    const pageId = process.env.FB_PAGE_ID;
    const token = process.env.FB_PAGE_TOKEN;

    if (!pageId || !token) {
        throw new Error("Не заданы FB_PAGE_ID или FB_PAGE_TOKEN в файле .env");
    }

    // Объединяем текст и теги
    const payload = tags ? `${text}\n\n${tags}` : text;

    console.log(`Отправка в Facebook (Страница: ${pageId})...`);

    const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: payload,
            access_token: token,
            published: true
        })
    });

    const data = await res.json();

    if (data.error) {
        throw new Error(`Ошибка API Facebook: ${data.error.message}`);
    }

    return data;
}
async function publishToFacebookWithImage(text, tags, imagePath) {
    const pageId = process.env.FB_PAGE_ID;
    const token = process.env.FB_PAGE_TOKEN;

    // 1. Загружаем фото на сервер Facebook
    console.log(`Загрузка изображения: ${imagePath}...`);
    const formData = new FormData();
    formData.append('source', new Blob([fs.readFileSync(imagePath)]));
    formData.append('message', tags ? `${text}\n\n${tags}` : text);
    formData.append('access_token', token);
    formData.append('published', 'true'); // Публикуем сразу

    const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
        method: 'POST',
        body: formData
    });

    const data = await res.json();
    if (data.error) throw new Error(`Ошибка Facebook API: ${data.error.message}`);

    return data;
}
async function main() {
    // Берем путь к файлу из аргументов. Если не передан, используем тестовый.
    const filePath = process.argv[2] || './test_article.md';

    try {
        console.log(`Чтение файла: ${filePath}`);
        const fileContent = await fs.readFile(filePath, 'utf8');

        // Отделяем шапку с настройками от самого текста
        const parsed = matter(fileContent);
        const meta = parsed.data;
        const fullText = parsed.content.trim();

        console.log(`\n📄 Статья: "${meta.title || 'Без названия'}"`);
        console.log(`Длина текста: ${fullText.length} символов\n`);

        const fbResult = await publishToFacebook(fullText, meta.facebook_tags);

        console.log('\n✅ УСПЕХ! Пост опубликован.');

        // Формируем ссылку на пост
        const [pageId, postId] = fbResult.id.split('_');
        console.log(`Ссылка: https://facebook.com/${pageId}/posts/${postId}`);

    } catch (error) {
        console.error("\n❌ ОШИБКА:");
        console.error(error.message);
    }
}

main();
