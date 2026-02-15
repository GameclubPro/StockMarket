import 'dotenv/config';

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: toNumber(process.env.PORT, 3000),
  botToken: process.env.BOT_TOKEN ?? '',
  vkAppSecret: process.env.VK_APP_SECRET ?? '',
  appSecret: process.env.APP_SECRET ?? '',
  tgMiniAppUrl: process.env.TG_MINIAPP_URL ?? 'https://t.me/JoinRush_bot?startapp=home',
  vkMiniAppUrl: process.env.VK_MINIAPP_URL ?? 'https://vk.com/app54453849',
  platformLinkCodeTtlSec: toNumber(process.env.PLATFORM_LINK_CODE_TTL_SEC, 300),
  botWebhookSecret: process.env.BOT_WEBHOOK_SECRET ?? '',
  maxAuthAgeSec: toNumber(process.env.MAX_AUTH_AGE_SEC, 86400),
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
};
