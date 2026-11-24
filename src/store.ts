import fs from 'node:fs';
import path from 'node:path';
import { drive_v3, google } from 'googleapis';

/**
 * Storage for the small state files of the relay (relay_state.json, translation_rules.md, .gemini_chat).
 * With Google Drive configured, Drive is the source of truth and the local copy is a cache/backup.
 * Without it (or on Drive errors), only local files are used.
 *
 * Drive access uses the drive.file scope: the app only sees files it created itself.
 * Needs YT_CLIENT_ID, YT_CLIENT_SECRET and DRIVE_REFRESH_TOKEN (see `yarn drive-auth`).
 */

const FOLDER_NAME = 'socialpost-state';
const MIME_TEXT = 'text/plain';

let drive: drive_v3.Drive | null = null;
let folderId: string | null = null;
let notConfiguredWarned = false;

function driveConfigured(): boolean {
    return Boolean(process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET && process.env.DRIVE_REFRESH_TOKEN);
}

function readLocal(name: string): string | null {
    const filePath = path.resolve(name);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function writeLocal(name: string, content: string) {
    fs.writeFileSync(path.resolve(name), content);
}

function warn(action: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Google Drive: не удалось ${action} (${message.split('\n')[0]}). Работаю с локальной копией.`);
}

/**
 * Creates the Drive client and the state folder on first use. Returns null if Drive is not configured.
 */
async function connect(): Promise<drive_v3.Drive | null> {
    if (!driveConfigured()) {
        if (!notConfiguredWarned) {
            notConfiguredWarned = true;
            console.warn('⚠️ Google Drive не настроен (нет DRIVE_REFRESH_TOKEN в .env): состояние хранится только на этом компьютере. Запустите `yarn drive-auth`.');
        }
        return null;
    }
    if (!drive) {
        const auth = new google.auth.OAuth2(process.env.YT_CLIENT_ID, process.env.YT_CLIENT_SECRET);
        auth.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });
        drive = google.drive({ version: 'v3', auth });
    }
    if (!folderId) {
        const found = await drive.files.list({
            q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id)',
        });
        folderId = found.data.files?.[0]?.id ?? null;
        if (!folderId) {
            const created = await drive.files.create({
                requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
                fields: 'id',
            });
            folderId = created.data.id ?? null;
        }
    }
    return drive;
}

async function findFileId(client: drive_v3.Drive, name: string): Promise<string | null> {
    const found = await client.files.list({
        q: `name='${name}' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id)',
    });
    return found.data.files?.[0]?.id ?? null;
}

async function uploadFile(client: drive_v3.Drive, name: string, content: string) {
    const id = await findFileId(client, name);
    const media = { mimeType: MIME_TEXT, body: content };
    if (id) {
        await client.files.update({ fileId: id, media });
    } else {
        await client.files.create({
            requestBody: { name, parents: [folderId!] },
            media,
            fields: 'id',
        });
    }
}

/**
 * Reads a state file. Drive is preferred; a local file that is not on Drive yet is uploaded to it
 * (this moves the existing files to Drive on the first run).
 */
export async function readStore(name: string): Promise<string | null> {
    const local = readLocal(name);
    let client: drive_v3.Drive | null;
    try {
        client = await connect();
    } catch (error) {
        warn('подключиться к Drive', error);
        return local;
    }
    if (!client) return local;

    try {
        const id = await findFileId(client, name);
        if (!id) {
            if (local !== null) await uploadFile(client, name, local);
            return local;
        }
        const res = await client.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
        const content = String(res.data);
        writeLocal(name, content);
        return content;
    } catch (error) {
        warn(`прочитать ${name}`, error);
        return local;
    }
}

/**
 * Saves a state file locally and, if Drive is configured, to Drive.
 */
export async function writeStore(name: string, content: string): Promise<void> {
    writeLocal(name, content);
    let client: drive_v3.Drive | null;
    try {
        client = await connect();
    } catch (error) {
        warn('подключиться к Drive', error);
        return;
    }
    if (!client) return;

    try {
        await uploadFile(client, name, content);
    } catch (error) {
        warn(`сохранить ${name}`, error);
    }
}

/**
 * Content of a file on Drive: string if present, null if absent, undefined if Drive is not available.
 */
export async function fetchRemote(name: string): Promise<string | null | undefined> {
    let client: drive_v3.Drive | null;
    try {
        client = await connect();
    } catch (error) {
        warn('подключиться к Drive', error);
        return undefined;
    }
    if (!client) return undefined;

    try {
        const id = await findFileId(client, name);
        if (!id) return null;
        const res = await client.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
        return String(res.data);
    } catch (error) {
        warn(`прочитать ${name}`, error);
        return undefined;
    }
}

/**
 * Uploads content to Drive without touching the local file. Throws if Drive is not configured or fails.
 */
export async function pushRemote(name: string, content: string): Promise<void> {
    const client = await connect();
    if (!client) throw new Error('Google Drive не настроен (нужен DRIVE_REFRESH_TOKEN в .env)');
    await uploadFile(client, name, content);
}
