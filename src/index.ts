import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parsePost } from './parser.js';
import { printReport, publishToAccounts, selectAccounts } from './runner.js';
import { AccountsConfig } from './types.js';
import { disconnectChrome } from './browser.js';

async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('❌ Error: Please provide a path to the Markdown file!');
        process.exit(1);
    }

    const accounts: AccountsConfig = JSON.parse(fs.readFileSync(path.resolve('./accounts.json'), 'utf8'));

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
    }
}

main();
