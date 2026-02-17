const PLATFORM_LINK_CODE_PREFIX = 'LINK_';
const TG_LINK_CODE_PREFIX = 'link_';

export type PlatformLinkCodeResolution = {
  linkCode: string;
  hasBodyLinkCode: boolean;
  hasStartParamLinkCode: boolean;
  bodyCodeInvalid: boolean;
};

const normalizeHashInput = (hashValue: string) => hashValue.replace(/^#/, '').trim();

const parseHashState = (hashValue: string) => {
  const normalized = normalizeHashInput(hashValue);
  if (!normalized) {
    return { path: '', params: new URLSearchParams() };
  }

  const queryIndex = normalized.indexOf('?');
  if (queryIndex >= 0) {
    const path = normalized.slice(0, queryIndex);
    const query = normalized.slice(queryIndex + 1);
    return { path, params: new URLSearchParams(query) };
  }

  if (normalized.includes('=') || normalized.includes('&')) {
    return { path: '', params: new URLSearchParams(normalized) };
  }

  return { path: normalized, params: new URLSearchParams() };
};

const applyHashState = (target: URL, state: { path: string; params: URLSearchParams }) => {
  const query = state.params.toString();
  if (state.path && query) {
    target.hash = `#${state.path}?${query}`;
    return;
  }
  if (state.path) {
    target.hash = `#${state.path}`;
    return;
  }
  target.hash = query ? `#${query}` : '';
};

export const normalizePlatformLinkCode = (value: string) => value.trim().toUpperCase();

export const isPlatformLinkCode = (value: string) =>
  new RegExp(`^${PLATFORM_LINK_CODE_PREFIX}[A-Z0-9]{8,32}$`).test(value);

const extractLinkCodeCandidate = (value?: string) => {
  const raw = value?.trim() ?? '';
  if (!raw) return '';

  const normalizedRaw = normalizePlatformLinkCode(raw);
  if (isPlatformLinkCode(normalizedRaw)) return normalizedRaw;

  if (raw.toLowerCase().startsWith(TG_LINK_CODE_PREFIX)) {
    const normalized = normalizePlatformLinkCode(raw.slice(TG_LINK_CODE_PREFIX.length));
    if (isPlatformLinkCode(normalized)) return normalized;
  }

  return '';
};

export const resolvePlatformLinkCode = (payload: {
  bodyLinkCode?: string;
  startParam?: string;
}): PlatformLinkCodeResolution => {
  const bodyRaw = payload.bodyLinkCode?.trim() ?? '';
  const hasBodyLinkCode = bodyRaw.length > 0;
  const bodyNormalized = hasBodyLinkCode ? normalizePlatformLinkCode(bodyRaw) : '';
  const bodyValid = bodyNormalized ? isPlatformLinkCode(bodyNormalized) : false;
  const bodyCodeInvalid = hasBodyLinkCode && !bodyValid;

  const startCode = extractLinkCodeCandidate(payload.startParam);
  const hasStartParamLinkCode = Boolean(startCode);

  return {
    linkCode: bodyValid ? bodyNormalized : startCode,
    hasBodyLinkCode,
    hasStartParamLinkCode,
    bodyCodeInvalid,
  };
};

export const buildTelegramSwitchUrl = (code: string, tgMiniAppUrl?: string) => {
  const startParam = `${TG_LINK_CODE_PREFIX}${code}`;
  const fallback = `https://t.me/JoinRush_bot?startapp=${startParam}&link_code=${code}&jr_link_code=${code}`;
  try {
    const parsed = new URL(tgMiniAppUrl || fallback);
    parsed.searchParams.set('startapp', startParam);
    parsed.searchParams.set('link_code', code);
    parsed.searchParams.set('jr_link_code', code);
    return parsed.toString();
  } catch {
    return fallback;
  }
};

export const buildVkSwitchUrl = (code: string, vkMiniAppUrl?: string) => {
  const startParam = `${TG_LINK_CODE_PREFIX}${code}`;
  const fallback = `https://vk.com/app54453849?vk_ref=${startParam}&jr_link_code=${code}&link_code=${code}`;
  try {
    const parsed = new URL(vkMiniAppUrl || fallback);
    parsed.searchParams.set('vk_ref', startParam);
    parsed.searchParams.set('jr_link_code', code);
    parsed.searchParams.set('link_code', code);

    const hashState = parseHashState(parsed.hash);
    hashState.params.set('vk_ref', startParam);
    hashState.params.set('jr_link_code', code);
    hashState.params.set('link_code', code);
    applyHashState(parsed, hashState);

    return parsed.toString();
  } catch {
    return fallback;
  }
};

