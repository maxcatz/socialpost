import { PostData, PublishResult, WhatsAppConfig } from '../types.js';
import { publishManual, RunSafe } from './common.js';

export class WhatsAppPublisher {
    @RunSafe('WhatsApp')
    static async publish(post: PostData, account: WhatsAppConfig): Promise<PublishResult> {
        const instructions = [
            'The WhatsApp app should now be in focus.',
            'Press Cmd+V to paste the text.',
            ...(post.image || post.video ? ['Media found. You may need to drag it manually.'] : []),
            'Press Enter to send.',
            'Once published, click "Share" or the post timestamp to copy the post URL.'
        ];

        return publishManual({
            platform: 'WhatsApp',
            accountName: account.name,
            urlToOpen: account.inviteLink,
            instructions,
            post
        });
    }
}