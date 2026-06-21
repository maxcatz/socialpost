import {PostData, PublishResult, YouTubeConfig} from '../types.js';
import {publishManual, RunSafe} from './common.js';
import fs from "node:fs";
import { google } from 'googleapis';

export class YouTubePublisher {
  @RunSafe('YouTube')
  static async publish(post: PostData, filePath: string, account: YouTubeConfig): Promise<PublishResult> {

    let uploadedVideoUrl: string | undefined;
    let finalPostData = {...post};

    // 1. If there is a video, upload it via API first
    if (post.media && post.mimeType?.startsWith('video/') && fs.existsSync(post.media)) {
      console.log(`🎥 Video detected: ${post.media}. Starting upload...`);
      uploadedVideoUrl = await this.uploadVideoViaApi(post.media, post.title, post.content);

      console.log('\n=========================================');
      console.log(`✅ Video uploaded successfully!`);
      console.log(`🔗 Video URL: ${uploadedVideoUrl}`);
      console.log('=========================================\n');

      // Automatically append the video link to the post content for the clipboard
      finalPostData.content = `${post.content}\n\nWatch the video: ${uploadedVideoUrl}`;
    }

    // 2. Proceed to manual post publication
    console.log('📝 Starting manual post publication mode...');

    const instructions = [
      'Click on the post input field.',
      'Press Cmd+V / Ctrl+V to paste the text.'
    ];

    // Adapt instructions based on whether a video was uploaded
    if (uploadedVideoUrl) {
      instructions.push(
        'The video link has been automatically added to your clipboard text!',
        'You can optionally attach an image from the opened folder.'
      );
    } else {
      instructions.push('Drag and drop the highlighted image from the file explorer.');
    }

    instructions.push(
      'Click "Post".',
      'Once published, copy the post URL from the browser address bar to complete the script.'
    );

    return publishManual({
      platform: 'YouTube',
      accountName: account.name,
      urlToOpen: `https://www.youtube.com/${account.channelHandle}/posts`,
      instructions,
      post: finalPostData
    });
  }

  /**
   * Uploads a video file to YouTube via the Data API v3.
   * Throws an error if upload fails or credentials are missing.
   */
  private static async uploadVideoViaApi(videoPath: string, title: string, description: string): Promise<string> {
    const clientId = process.env.YT_CLIENT_ID;
    const clientSecret = process.env.YT_CLIENT_SECRET;
    const refreshToken = process.env.YT_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Missing YouTube API credentials (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN) in .env file.');
    }

    // Initialize OAuth2 client
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });

    // Enforce YouTube API limits
    const safeTitle = title ? title.substring(0, 100) : 'New Video';
    const safeDescription = description ? description.substring(0, 5000) : '';

    // Get file size for progress calculation (optional but helpful for large files)
    const fileSize = fs.statSync(videoPath).size;

    const res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: safeTitle,
          description: safeDescription,
          categoryId: '22', // 22 = People & Blogs
        },
        status: {
          privacyStatus: 'public', // Can be 'private', 'unlisted', or 'public'
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(videoPath),
      },
    }, {
      // Track upload progress in the console
      onUploadProgress: (evt) => {
        const progress = (evt.bytesRead / fileSize) * 100;
        process.stdout.write(`\r⬆️ Uploading: ${Math.round(progress)}%`);
      }
    });

    process.stdout.write('\n'); // Clear the progress line after upload

    if (!res.data.id) {
      throw new Error('YouTube API did not return a video ID.');
    }

    return `https://youtu.be/${res.data.id}`;
  }
}
