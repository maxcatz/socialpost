import { PostData, PublishResult, YouTubeConfig } from '../types.js';
import { publishManual, RunSafe } from './common.js';

export class YouTubePublisher {
    @RunSafe('YouTube')
    static async publish(post: PostData, filePath: string, account: YouTubeConfig): Promise<PublishResult> {
        const instructions = [
            'Click on the post input field.',
            'Press Cmd+V / Ctrl+V to paste the text.',
            'Drag and drop the highlighted image or video from the file explorer.',
            'Click "Post".',
            'Once published, click "Share" or the post timestamp to copy the post URL.'
        ];

        return publishManual({
            platform: 'YouTube',
            accountName: account.name,
            urlToOpen: `https://www.youtube.com/${account.channelHandle}/posts`,
            instructions,
            post
        });
    }
}