import crypto from 'node:crypto';

export type VkLaunchData = Record<string, string> & {
  vk_user_id: string;
  sign: string;
  vk_ref?: string;
  vk_platform?: string;
  vk_ts?: string;
};

const toBase64Url = (value: string) =>
  value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const normalizeSign = (value: string) => toBase64Url(value.trim());

const safeCompare = (left: string, right: string) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
};

const normalizeLaunchParamsInput = (input: string) => {
  const raw = input.trim();
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).search.replace(/^\?/, '');
    } catch {
      return '';
    }
  }

  let normalized = raw;
  if (normalized.startsWith('?')) normalized = normalized.slice(1);
  if (normalized.startsWith('#')) normalized = normalized.slice(1);
  if (normalized.startsWith('/')) normalized = normalized.slice(1);

  const queryIndex = normalized.indexOf('?');
  if (queryIndex >= 0) {
    normalized = normalized.slice(queryIndex + 1);
  }

  const hashIndex = normalized.indexOf('#');
  if (hashIndex >= 0) {
    normalized = normalized.slice(hashIndex + 1);
    if (normalized.startsWith('?')) normalized = normalized.slice(1);
  }

  return normalized;
};

export const extractVkLaunchParams = (launchParams: string) =>
  new URLSearchParams(normalizeLaunchParamsInput(launchParams));

export const isVkLaunchParamsPayload = (launchParams: string) => {
  const params = extractVkLaunchParams(launchParams);
  return params.has('vk_user_id') && params.has('sign');
};

const buildSignedDataString = (params: URLSearchParams) => {
  return [...params.entries()]
    .filter(([key]) => key.startsWith('vk_'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
};

export const verifyVkLaunchParams = (
  launchParams: string,
  appSecret: string,
  maxAgeSec: number
) => {
  if (!appSecret) throw new Error('VK_APP_SECRET is missing');

  const params = extractVkLaunchParams(launchParams);
  const sign = params.get('sign');
  const userId = params.get('vk_user_id');
  if (!sign) throw new Error('sign missing');
  if (!userId) throw new Error('vk_user_id missing');

  const dataString = buildSignedDataString(params);
  const calculatedSign = toBase64Url(
    crypto.createHmac('sha256', appSecret).update(dataString).digest('base64')
  );
  const providedSign = normalizeSign(sign);

  if (!safeCompare(calculatedSign, providedSign)) {
    throw new Error('invalid sign');
  }

  const tsRaw = params.get('vk_ts');
  if (tsRaw) {
    const ts = Number(tsRaw);
    if (Number.isFinite(ts)) {
      const ageSec = Math.floor(Date.now() / 1000) - ts;
      if (ageSec > maxAgeSec) {
        throw new Error('auth date expired');
      }
    }
  }

  const data: Record<string, string> = {};
  params.forEach((value, key) => {
    data[key] = value;
  });

  return data as VkLaunchData;
};
