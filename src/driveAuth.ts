import http from 'node:http';
import process from 'node:process';
import open from 'open';
import { google } from 'googleapis';

/**
 * One-time setup: gets a refresh token that lets the relay keep its state files in Google Drive.
 * Run: yarn drive-auth — then put the printed DRIVE_REFRESH_TOKEN into .env.
 */

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const clientId = process.env.YT_CLIENT_ID;
const clientSecret = process.env.YT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
    console.error('❌ В .env должны быть YT_CLIENT_ID и YT_CLIENT_SECRET.');
    process.exit(1);
}

const auth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
const authUrl = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [SCOPE] });

const server = http.createServer(async (req, res) => {
    const code = new URL(req.url ?? '/', REDIRECT_URI).searchParams.get('code');
    if (!code) {
        res.end('Ожидаю авторизацию...');
        return;
    }
    try {
        const { tokens } = await auth.getToken(code);
        res.end('Готово, вкладку можно закрыть.');
        if (tokens.refresh_token) {
            console.log('\n✅ Добавьте в .env:');
            console.log(`DRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
        } else {
            console.error('❌ Google не вернул refresh_token. Удалите доступ приложению на https://myaccount.google.com/permissions и запустите снова.');
        }
    } catch (error: any) {
        res.end('Ошибка авторизации, смотрите терминал.');
        console.error(`❌ ${error.message}`);
    } finally {
        server.close();
    }
});

server.listen(PORT, () => {
    console.log('Откройте ссылку и войдите в Google-аккаунт, на котором будут храниться файлы:\n');
    console.log(authUrl);
    open(authUrl).catch(() => undefined);
});
