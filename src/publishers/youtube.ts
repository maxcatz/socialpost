import clipboardy from 'clipboardy';
import open from 'open';
import { PostData, YouTubeConfig } from '../types.js';
import { revealFileInFinder } from '../utils.js';

export async function prepareYouTubePost(post: PostData, filePath: string, accounts: YouTubeConfig[]) {
    if (accounts.length === 0) return;

    console.log('\n▶ Preparing posts for YouTube...');

    // Copy the final text to the clipboard once
    clipboardy.writeSync(post.content);

    // Open the folder containing the image once
    if (post.image) {
        await revealFileInFinder(post.image);
    }

    // Open community tabs for all configured channels
    for (const acc of accounts) {
        const communityUrl = `https://www.youtube.com/${acc.channelHandle}/posts`;
        await open(communityUrl);
        console.log(`✅ Opened community tab for: [${acc.name}] (${acc.channelHandle})`);
    }

    console.log('\n=========================================');
    console.log('✅ Post text successfully copied to clipboard!');
    console.log('=========================================\n');
    console.log('Next steps (for each opened tab):');
    console.log('1. Click on the post input field.');
    console.log('2. Press Cmd+V / Ctrl+V to paste the text.');
    console.log('3. Drag and drop the highlighted image from the file explorer.');
    console.log('4. Click "Post".\n');
}