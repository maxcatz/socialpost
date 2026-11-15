import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { chromium, BrowserContext } from 'playwright-core';

// Отдельный профиль: войдите в Facebook в нём один раз — сессия сохранится.
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(os.homedir(), '.socialpost-chrome');

function chromeExecutable(): string | undefined {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const candidates: Record<string, string> = {
        darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    };
    const candidate = candidates[os.platform()];
    return candidate && fs.existsSync(candidate) ? candidate : undefined;
}

let cached: BrowserContext | null = null;

function launch(): Promise<BrowserContext> {
    return chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: chromeExecutable(),
        channel: chromeExecutable() ? undefined : 'chrome',
        headless: false,
        viewport: null,
        // Убираем признаки автоматизации (баннер и navigator.webdriver)
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
}

/**
 * Kills leftover Chrome processes that hold our dedicated profile (e.g. started by an older version of the script).
 */
async function killStaleChrome(): Promise<void> {
    if (os.platform() === 'win32') return;
    // '--' is required: otherwise pkill treats the pattern (starting with '--') as an option and does nothing
    const pattern = `user-data-dir=${PROFILE_DIR}`;
    const exec = (cmd: string) =>
        new Promise<boolean>((resolve) => execFile(cmd, ['-f', '--', pattern], (error) => resolve(!error)));
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    await exec('pkill');
    for (let i = 0; i < 20 && (await exec('pgrep')); i++) {
        await sleep(500);
        if (i === 9) await new Promise<void>((resolve) => execFile('pkill', ['-9', '-f', '--', pattern], () => resolve()));
    }
    // Remove stale lock files left by the killed process
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        fs.rmSync(path.join(PROFILE_DIR, name), { force: true });
    }
}

/**
 * Opens a Chrome window with a dedicated persistent profile (~/.socialpost-chrome)
 * and returns its browser context. The window is closed by `disconnectChrome`.
 */
export async function connectChrome(): Promise<BrowserContext> {
    // cached is reset by the 'close' handler if the user closed the window
    if (cached) return cached;

    console.log(`🌐 Открываю Chrome (профиль: ${PROFILE_DIR})...`);
    try {
        cached = await launch();
    } catch {
        // Most likely the profile is locked by a Chrome instance that is still running
        console.log('⚠️ Профиль занят другим процессом Chrome, закрываю его и пробую снова...');
        await killStaleChrome();
        try {
            cached = await launch();
        } catch (error: any) {
            throw new Error(`не удалось запустить Chrome: ${error.message.split('\n')[0]}. Задайте CHROME_PATH в .env, если Chrome установлен нестандартно.`);
        }
    }

    cached.on('close', () => { cached = null; });
    return cached;
}

/**
 * Closes the Chrome window opened by the script.
 */
export async function disconnectChrome(): Promise<void> {
    if (cached) {
        const context = cached;
        cached = null;
        await context.close().catch(() => undefined);
    }
}
