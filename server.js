import 'dotenv/config'; // должен быть первым импортом
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { auth, needUsername, sameOrigin } from './middleware.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import friendsRouter from './routes/friends.js';
import playlistsRouter from './routes/playlists.js';
import libraryRouter from './routes/library.js';
import activityRouter from './routes/activity.js';

for (const k of ['APP_ORIGIN', 'TELEGRAM_BOT_TOKEN']) {
  if (!process.env[k]) throw new Error(`Не задана переменная окружения ${k} (см. .env.example)`);
}
const isProd = process.env.NODE_ENV === 'production';
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

app.use(
  helmet({
    // popup-окно входа Google требует same-origin-allow-popups
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", 'https://accounts.google.com/gsi/client'],
        'frame-src': ['https://accounts.google.com/gsi/'],
        'connect-src': ["'self'", 'https://accounts.google.com/gsi/'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
        'img-src': ["'self'", 'data:', 'https://*.googleusercontent.com', 'https://avatars.yandex.net'],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': isProd ? [] : null,
      },
    },
  })
);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.get('/api/health', (req, res) => res.json({ ok: true })); // для проверки Railway

const limiter = (limit, windowMs = 60_000) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', limiter(300), sameOrigin(process.env.APP_ORIGIN));

app.get('/api/config', (req, res) => res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null, yandex: !!(process.env.YANDEX_CLIENT_ID && process.env.YANDEX_CLIENT_SECRET) }));
app.use('/api/auth', authRouter);
app.use('/api/me', auth, meRouter);
app.use('/api/friends', auth, needUsername, friendsRouter);
app.use('/api/playlists', auth, needUsername, playlistsRouter);
app.use('/api/library', auth, needUsername, libraryRouter);
app.use('/api/activity', auth, needUsername, limiter(120), activityRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, 'public')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM now_playing WHERE updated_at < ?').run(Date.now() - 864e5);
}, 3600_000).unref();

const port = Number(process.env.PORT) || 3000;
app.listen(port, process.env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'), () => console.log(`Волна: http://localhost:${port}`));
