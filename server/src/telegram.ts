import crypto from 'node:crypto';

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
};

export type TelegramAuthData = {
  user?: TelegramUser;
  auth_date?: string;
  start_param?: string;
  hash?: string;
  [key: string]: string | TelegramUser | undefined;
};

const buildDataCheckString = (data: URLSearchParams) => {
  const pairs: string[] = [];
  data.forEach((value, key) => {
    if (key === 'hash') return;
    pairs.push(`${key}=${value}`);
  });
  return pairs.sort().join('\n');
};

const hmac = (key: crypto.BinaryLike, message: string) =>
  crypto.createHmac('sha256', key).update(message).digest('hex');

export const verifyInitData = (initData: string, botToken: string, maxAgeSec: number) => {
  if (!botToken) throw new Error('BOT_TOKEN is missing');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('hash missing');

  const dataCheckString = buildDataCheckString(params);
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = hmac(secretKey, dataCheckString);
  if (calculatedHash !== hash) throw new Error('invalid hash');

  const authDate = params.get('auth_date');
  if (authDate) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - Number(authDate);
    if (Number.isFinite(diff) && diff > maxAgeSec) {
      throw new Error('auth date expired');
    }
  }

  const data: TelegramAuthData = {};
  params.forEach((value, key) => {
    data[key] = value;
  });

  if (typeof data.user === 'string') {
    try {
      data.user = JSON.parse(data.user) as TelegramUser;
    } catch {
      // ignore parse errors
    }
  }

  return data;
};
