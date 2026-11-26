import process from 'node:process';
import { parsePost } from './parser.js';
import { printReport, publishToAccounts, selectAccounts } from './runner.js';
import { loadAccounts } from './accounts.js';
import { disconnectChrome } from './browser.js';
import { disconnectTelegram } from './sources/telegramApi.js';

async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('❌ Error: Please provide a path to the Markdown file!');
        process.exit(1);
    }

    const accounts = await loadAccounts();

    try {
        const selectedAccounts = await selectAccounts(accounts);
        const postData = parsePost(filePath);
        const results = await publishToAccounts(postData, filePath, accounts, selectedAccounts);
        printReport(results);

    } catch (error: any) {
        if (error.message === 'NO_SELECTION') console.log('\n⚠️ No accounts selected. Exiting...');
        else if (error.name === 'ExitPromptError') console.log('\n🚪 Process cancelled by user.');
        else console.error('\n❌ A critical error occurred:', error.message);
    } finally {
        await disconnectChrome();
        await disconnectTelegram();
    }
}

main();
