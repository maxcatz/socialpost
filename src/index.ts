import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkbox, Separator } from '@inquirer/prompts';
import { parsePost } from './parser.js';
import { FacebookPublisher } from './publishers/facebook.js';
import { TelegramPublisher } from './publishers/telegram.js';
import { YouTubePublisher } from './publishers/youtube.js';
import {AccountsConfig, FacebookConfig, PublishResult, TelegramConfig, WhatsAppConfig, YouTubeConfig} from './types.js';
import { WhatsAppPublisher } from "./publishers/whatsapp.js";

// Тип для хранения информации о выбранном аккаунте
interface SelectedAccount {
    platform: 'telegram' | 'facebook' | 'youtube' | 'whatsapp';
    index: number;
}

async function selectAccounts(accounts: AccountsConfig): Promise<SelectedAccount[]> {
    const promptChoices: any[] = [];

    // Helper для добавления аккаунтов в меню
    const addChoices = (platform: string, list: any[]) => {
        if (!list || list.length === 0) return;
        promptChoices.push(new Separator(`── ${platform.toUpperCase()} ──`));
        list.forEach((acc, index) => {
            promptChoices.push({ name: `${platform} - ${acc.name}`, value: { platform, index }, checked: true });
        });
    };

    addChoices('telegram', accounts.telegram);
    addChoices('facebook', accounts.facebook);
    addChoices('youtube', accounts.youtube);
    addChoices('whatsapp', accounts.whatsapp);

    if (promptChoices.length === 0) throw new Error('No accounts found in accounts.json!');

    const selected = await checkbox<SelectedAccount>({
        message: 'Select specific accounts to publish to:',
        choices: promptChoices,
        loop: false,
    });

    if (selected.length === 0) throw new Error('NO_SELECTION');
    return selected;
}



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
        const results: PublishResult[] = [];

        for (const s of selectedAccounts) {
            const acc = accounts[s.platform as keyof AccountsConfig][s.index];
            let result: PublishResult;

            // Dynamic publisher call with await inside the loop
            if (s.platform === 'facebook') {
                result = await FacebookPublisher.publish(postData, acc as FacebookConfig);
            } else if (s.platform === 'telegram') {
                result = await TelegramPublisher.publish(postData, acc as TelegramConfig);
            } else if (s.platform === 'youtube') {
                result = await YouTubePublisher.publish(postData, filePath, acc as YouTubeConfig);
            } else if (s.platform === 'whatsapp') {
                result = await WhatsAppPublisher.publish(postData, acc as WhatsAppConfig);
            } else {
                throw new Error(`Unsupported platform: ${s.platform}`);
            }

            results.push(result);
        }

        // 4. Make report
        const reportText = [
            `\n🎉 All tasks completed!`,
            ...results.map(r => `• ${r.platform} (${r.name}): ${r.url || 'Failed'}`)
        ].join('\n');

        console.log(reportText);

    } catch (error: any) {
        if (error.message === 'NO_SELECTION') console.log('\n⚠️ No accounts selected. Exiting...');
        else if (error.name === 'ExitPromptError') console.log('\n🚪 Process cancelled by user.');
        else console.error('\n❌ A critical error occurred:', error.message);
    }
}

main();
