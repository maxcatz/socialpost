import fs from 'node:fs';
import path from 'node:path';
import { fetchRemote, pushRemote } from './store.js';
import { AccountsConfig } from './types.js';

// accounts.json is kept on Drive too. It has no secrets (tokens stay in .env), so it can sync safely.
const ACCOUNTS_FILE = 'accounts.json';

const normalize = (raw: string) => JSON.stringify(JSON.parse(raw));

/**
 * Loads accounts.json. If Drive has a different version, stops instead of silently overwriting either side:
 * run `yarn accounts-pull` (take Drive's version) or `yarn accounts-push` (send this computer's version).
 */
export async function loadAccounts(): Promise<AccountsConfig> {
    const local = fs.readFileSync(path.resolve(ACCOUNTS_FILE), 'utf8');
    const remote = await fetchRemote(ACCOUNTS_FILE);

    if (remote === undefined) {
        console.warn('⚠️ Google Drive недоступен: использую локальный accounts.json.');
    } else if (remote === null) {
        // First run: move the local file to Drive
        await pushRemote(ACCOUNTS_FILE, local).catch(error => console.warn(`⚠️ Не удалось отправить accounts.json на Drive: ${error.message}`));
    } else if (normalize(remote) !== normalize(local)) {
        throw new Error('accounts.json отличается от версии на Google Drive. Выполните `yarn accounts-pull` (взять версию с Drive) или `yarn accounts-push` (отправить эту на Drive).');
    }

    return JSON.parse(local);
}
