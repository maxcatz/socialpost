import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fetchRemote, pushRemote } from './store.js';

const ACCOUNTS_FILE = 'accounts.json';
const BACKUP_DIR = 'state-backup';

const command = process.argv[2];
const localPath = path.resolve(ACCOUNTS_FILE);

async function main() {
    if (command === 'push') {
        await pushRemote(ACCOUNTS_FILE, fs.readFileSync(localPath, 'utf8'));
        console.log('✅ accounts.json отправлен на Google Drive.');
    } else if (command === 'pull') {
        const remote = await fetchRemote(ACCOUNTS_FILE);
        if (!remote) throw new Error('на Google Drive нет accounts.json (или Drive недоступен)');
        // Keep the previous local version in case it was not what you wanted
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        fs.copyFileSync(localPath, path.join(BACKUP_DIR, `accounts.json.${Date.now()}.bak`));
        fs.writeFileSync(localPath, remote);
        console.log('✅ accounts.json заменён версией с Google Drive. Прежняя копия — в state-backup/.');
    } else {
        console.error('Использование: yarn accounts-push | yarn accounts-pull');
        process.exit(1);
    }
}

main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
});
