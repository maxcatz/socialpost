import clipboardy from 'clipboardy';
import open from 'open';
import {PostData, PublishResult, YouTubeConfig} from '../types.js';
import { revealFileInFinder } from '../utils.js';
import { input } from '@inquirer/prompts';

export async function prepareYouTubePost(post: PostData, filePath: string, account: YouTubeConfig):Promise<PublishResult> {

    console.log('\n▶ Preparing posts for YouTube...');

    // Copy the final text to the clipboard once
    clipboardy.writeSync(post.content);

    // Open the folder containing the image once
    if (post.image) {
        await revealFileInFinder(post.image);
    }

    // Open community tabs for all configured channels
        const communityUrl = `https://www.youtube.com/${account.channelHandle}/posts`;
        await open(communityUrl);
        console.log(`✅ Opened posts tab for: [${account.name}] (${account.channelHandle})`);

        console.log('\n=========================================');
        console.log('✅ Post text successfully copied to clipboard!');
        console.log('=========================================\n');
        console.log('Next steps (for each opened tab):');
        console.log('1. Click on the post input field.');
        console.log('2. Press Cmd+V / Ctrl+V to paste the text.');
        console.log('3. Drag and drop the highlighted image from the file explorer.');
        console.log('4. Click "Post".');
        console.log('5. Once published, click "Share" or the post timestamp to copy the post URL.\n');
        const postUrl = await input({
            message: `Paste the URL for the published post on [${account.name}]:`,
            validate: (value) => value.trim() !== '' || 'URL cannot be empty',
        });
       return  { platform: 'YouTube', name: account.name, url: postUrl.trim() };
}