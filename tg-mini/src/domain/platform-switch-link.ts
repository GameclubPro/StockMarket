const TELEGRAM_WEB_HOSTS = new Set(['t.me', 'telegram.me']);

const parseAsUrl = (value: string | URL) => {
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const buildTelegramDeepLinkFromHttpUrl = (value: string | URL) => {
  const parsed = parseAsUrl(value);
  if (!parsed) return '';
  if (!/^https?:$/i.test(parsed.protocol)) return '';

  const host = parsed.hostname.toLowerCase();
  if (!TELEGRAM_WEB_HOSTS.has(host)) return '';

  const normalizedPath = parsed.pathname.replace(/^\/+/, '');
  const domain = normalizedPath.split('/').find(Boolean);
  if (!domain) return '';

  const params = new URLSearchParams();
  params.set('domain', domain);
  for (const [key, rawValue] of parsed.searchParams.entries()) {
    params.set(key, rawValue);
  }
  return `tg://resolve?${params.toString()}`;
};

