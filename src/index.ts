import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkbox, Separator } from '@inquirer/prompts';
import { parsePost } from './parser.js';
import { publishFacebookPost } from './publishers/facebook.js';
import { publishToTelegram } from './publishers/telegram.js';
import { prepareYouTubePost } from './publishers/youtube.js';
import { AccountsConfig } from './types.js';
import {publishToWhatsAppGroup} from "./publishers/whatsapp";

// Тип для хранения информации о выбранном аккаунте
interface SelectedAccount {
    platform: 'telegram' | 'facebook' | 'youtube' | 'whatsapp';
    index: number;
}

async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('❌ Error: Please provide a path to the Markdown file!');
        process.exit(1);
    }

    // Загрузка конфигурации аккаунтов
    const configPath = path.resolve('./accounts.json');
    if (!fs.existsSync(configPath)) {
        console.error('❌ Error: accounts.json file not found!');
        process.exit(1);
    }

    const accounts: AccountsConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Динамически формируем список для выбора
    const promptChoices: any[] = [];

    if (accounts.telegram && accounts.telegram.length > 0) {
        promptChoices.push(new Separator('── Telegram ──'));
        accounts.telegram.forEach((acc, index) => {
            promptChoices.push({
                name: `Telegram - ${acc.name}`,
                value: { platform: 'telegram', index },
                checked: true,
            });
        });
    }

    if (accounts.facebook && accounts.facebook.length > 0) {
        promptChoices.push(new Separator('── Facebook ──'));
        accounts.facebook.forEach((acc, index) => {
            promptChoices.push({
                name: `Facebook - ${acc.name}`,
                value: { platform: 'facebook', index },
                checked: true,
            });
        });
    }

    if (accounts.youtube && accounts.youtube.length > 0) {
        promptChoices.push(new Separator('── YouTube ──'));
        accounts.youtube.forEach((acc, index) => {
            promptChoices.push({
                name: `YouTube - ${acc.name}`,
                value: { platform: 'youtube', index },
                checked: true,
            });
        });
    }

    if (accounts.whatsapp && accounts.whatsapp.length > 0) {
        promptChoices.push(new Separator('── WhatsApp ──'));
        accounts.whatsapp.forEach((acc, index) => {
            promptChoices.push({ name: `WhatsApp - ${acc.name}`, value: { platform: 'whatsapp', index }, checked: true });
        });
    }

    if (promptChoices.length === 0) {
        console.error('❌ Error: No accounts found in accounts.json!');
        process.exit(1);
    }

    try {
        // 1. Интерактивный вопрос пользователю
        const selectedAccounts = await checkbox<SelectedAccount>({
            message: 'Select specific accounts to publish to:',
            choices: promptChoices,
            loop: false, // Отключает зацикливание списка при скролле (удобнее для длинных списков)
        });

        if (selectedAccounts.length === 0) {
            console.log('\n⚠️ No accounts selected. Exiting...');
            process.exit(0);
        }

        // 2. Группируем выбранные аккаунты обратно по платформам
        const selectedTelegram = selectedAccounts
            .filter(s => s.platform === 'telegram')
            .map(s => accounts.telegram[s.index]);

        const selectedFacebook = selectedAccounts
            .filter(s => s.platform === 'facebook')
            .map(s => accounts.facebook[s.index]);

        const selectedYouTube = selectedAccounts
            .filter(s => s.platform === 'youtube')
            .map(s => accounts.youtube[s.index]);

        const selectedWhatsApp = selectedAccounts
            .filter(s => s.platform === 'whatsapp')
            .map(s => accounts.whatsapp[s.index]);

        // 3. Парсим файл
        console.log(`\n📄 Processing file: ${filePath}`);
        const postData = parsePost(filePath);

        // 4. Публикуем (передаем только отфильтрованные массивы аккаунтов)
        if (selectedFacebook.length > 0) {
            await publishFacebookPost(postData, selectedFacebook);
        }

        if (selectedTelegram.length > 0) {
            await publishToTelegram(postData, selectedTelegram);
        }

        if (selectedYouTube.length > 0) {
            await prepareYouTubePost(postData, filePath, selectedYouTube);
        }

        for (const acc of selectedWhatsApp) {
            await publishToWhatsAppGroup(postData, acc);
        }

        console.log('\n🎉 All tasks completed successfully!');
    } catch (error: any) {
        if (error.name === 'ExitPromptError') {
            console.log('\n🚪 Process cancelled by user.');
        } else {
            console.error('\n❌ A critical error occurred:', error.message);
        }
    }
}

main();