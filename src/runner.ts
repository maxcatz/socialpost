import { checkbox, Separator } from '@inquirer/prompts';
import { FacebookPublisher } from './publishers/facebook.js';
import { TelegramPublisher } from './publishers/telegram.js';
import { YouTubePublisher } from './publishers/youtube.js';
import { WhatsAppPublisher } from './publishers/whatsapp.js';
import { AccountsConfig, FacebookConfig, PostData, PublishResult, TelegramConfig, WhatsAppConfig, YouTubeConfig } from './types.js';

type Platform = 'telegram' | 'facebook' | 'youtube' | 'whatsapp';

// Тип для хранения информации о выбранном аккаунте
export interface SelectedAccount {
    platform: Platform;
    index: number;
}

export async function selectAccounts(accounts: AccountsConfig): Promise<SelectedAccount[]> {
    const promptChoices: any[] = [];

    // Helper для добавления аккаунтов в меню
    const addChoices = (platform: Platform, list: { name: string }[]) => {
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

export async function publishToAccounts(
    postData: PostData,
    filePath: string,
    accounts: AccountsConfig,
    selectedAccounts: SelectedAccount[]
): Promise<PublishResult[]> {
    const results: PublishResult[] = [];

    for (const s of selectedAccounts) {
        const acc = accounts[s.platform][s.index];
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

    return results;
}

export function printReport(results: PublishResult[]) {
    const reportText = [
        `\n🎉 All tasks completed!`,
        ...results.map(r => `• ${r.platform} (${r.name}): ${r.url || 'Failed'}`)
    ].join('\n');

    console.log(reportText);
}
