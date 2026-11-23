import os from 'node:os';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';

function run(file: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(file, args, (error, _stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve()));
    });
}

/**
 * Puts an image file into the system clipboard (macOS only), so it can be pasted with Cmd+V.
 * Returns false if the platform or the file type is not supported.
 */
export async function copyImageToClipboard(filePath: string, mimeType?: string): Promise<boolean> {
    if (os.platform() !== 'darwin' || !mimeType?.startsWith('image/')) return false;

    const absolutePath = path.resolve(filePath);
    let source = absolutePath;
    let clipboardClass = 'JPEG picture';
    if (mimeType !== 'image/jpeg') {
        // Convert everything else (png, gif, webp) to PNG, which the clipboard handles reliably
        source = path.join(os.tmpdir(), `socialpost-clipboard-${process.pid}.png`);
        await run('sips', ['-s', 'format', 'png', absolutePath, '--out', source]);
        clipboardClass = '\u00abclass PNGf\u00bb';
    }
    await run('osascript', [
        '-e', 'on run argv',
        '-e', `set the clipboard to (read (POSIX file (item 1 of argv)) as ${clipboardClass})`,
        '-e', 'end run',
        source,
    ]);
    return true;
}

/**
 * Shows a system notification (macOS only) — used by the relay watcher when a new post arrives.
 */
export function notify(title: string, message: string): Promise<void> {
    if (os.platform() !== 'darwin') return Promise.resolve();
    return run('osascript', [
        '-e', 'on run argv',
        '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
        '-e', 'end run',
        title,
        message,
    ]).catch(() => undefined);
}

export function revealFileInFinder(filePath: string): Promise<void> {
    return new Promise((resolve) => {
        const absolutePath = path.resolve(filePath);

        if (os.platform() === 'darwin') {
            // macOS: open folder and reveal file
            exec(`open -R "${absolutePath}"`, () => resolve());
        } else if (os.platform() === 'win32') {
            // Windows: open folder and select file
            exec(`explorer.exe /select,"${absolutePath}"`, () => resolve());
        } else {
            resolve();
        }
    });
}