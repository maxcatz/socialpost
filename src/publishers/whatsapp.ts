import open from 'open';
import clipboardy from 'clipboardy';
import { PostData } from '../types.js';

export async function publishToWhatsAppGroup(post: PostData, account: { name: string, inviteLink: string }) {
    console.log(`\n▶ Preparing WhatsApp for: [${account.name}]...`);

    // 1. Копируем текст поста в буфер обмена
    clipboardy.writeSync(post.content);

    // 2. Открываем ссылку.
    // macOS автоматически переключит фокус на WhatsApp Desktop, если он запущен.
    await open(account.inviteLink);

    console.log(`✅ Opened WhatsApp group: ${account.name}`);
    console.log('-----------------------------------------');
    console.log('Next steps:');
    console.log('1. The WhatsApp app should now be in focus.');
    console.log('2. Press Cmd+V to paste the text.');
    console.log('3. Press Enter to send.');
    if (post.image) {
        console.log(`4. Image found: ${post.image}. You may need to drag it manually.`);
    }
    console.log('-----------------------------------------\n');
}