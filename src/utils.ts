import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

export function revealFileInFinder(filePath: string) {
    const absolutePath = path.resolve(filePath);

    if (os.platform() === 'darwin') {
        // macOS: open folder and reveal file
        exec(`open -R "${absolutePath}"`);
    } else if (os.platform() === 'win32') {
        // Windows: open folder and select file
        exec(`explorer.exe /select,"${absolutePath}"`);
    }
}