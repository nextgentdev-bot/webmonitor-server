import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const number = (key, fallback) => Number.isFinite(Number(process.env[key])) ? Number(process.env[key]) : fallback;
const bool = (key, fallback) => process.env[key] == null ? fallback : ['1', 'true', 'yes', 'on'].includes(process.env[key].toLowerCase());

export const config = {
  port: number('PORT', 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/web_monitor',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'local-development-secret',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-this-password',
  maxWebsites: number('MAX_WEBSITES', 1000),
  workerConcurrency: Math.max(1, number('WORKER_CONCURRENCY', 2)),
  checkTimeoutMs: number('CHECK_TIMEOUT_MS', 30000),
  navigationTimeoutMs: number('NAVIGATION_TIMEOUT_MS', 30000),
  maxRetries: Math.max(1, number('MAX_RETRIES', 2)),
  retryDelaySeconds: Math.max(10, number('RETRY_DELAY_SECONDS', 120)),
  slowPageMs: number('SLOW_PAGE_MS', 7000),
  googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  googleOAuthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || '',
  defaultDailyTime: process.env.DEFAULT_DAILY_TIME || '02:00',
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'Asia/Dhaka',
  instantAlertsDefault: bool('INSTANT_ALERTS', true),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  smtp: { host: process.env.SMTP_HOST || '', port: number('SMTP_PORT', 587), secure: bool('SMTP_SECURE', false), user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '', from: process.env.EMAIL_FROM || '', to: process.env.EMAIL_TO || '' }
};
