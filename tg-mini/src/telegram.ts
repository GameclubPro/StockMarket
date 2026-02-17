import {
  bindViewportCssVars,
  expandViewport,
  init,
  initData,
  miniApp,
  mountViewport,
  requestContentSafeAreaInsets,
  requestFullscreen,
  requestSafeAreaInsets,
  retrieveLaunchParams,
  themeParams,
} from '@telegram-apps/sdk';
import bridge from '@vkontakte/vk-bridge';

type User = {
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
};

type VkLaunchParams = {
  vk_user_id?: string;
  sign?: string;
  [key: string]: string | undefined;
};

type VkBridgeUserInfo = {
  id: number;
  first_name?: string;
  last_name?: string;
  photo_200?: string;
  photo_100?: string;
  photo_50?: string;
};

type VkBridgeAuthTokenResponse = {
  access_token?: string;
  scope?: string;
  expires_in?: number;
};

type VkBridgeApiError = {
  error_code?: number;
  error_msg?: string;
};

type VkBridgeApiMethodResponse<T> = {
  response?: T;
  error?: VkBridgeApiError;
};

type VkBridgeGroupItem = {
  id?: number;
  name?: string;
  screen_name?: string;
};

type VkBridgeGroupsGetResponse = {
  count?: number;
  items?: VkBridgeGroupItem[];
};

type VkBridgeErrorPayload = {
  error_type?: string;
  error_data?: {
    error_reason?: string;
    error_description?: string;
    error_code?: number | string;
    [key: string]: unknown;
  };
  message?: string;
  type?: string;
  [key: string]: unknown;
};

export type PlatformUserProfile = {
  label?: string;
  photoUrl?: string;
};
export type VkAuthProfilePayload = {
  id?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
};
export type RuntimePlatform = 'TELEGRAM' | 'VK';
export type PlatformSwitchOpenMethod = 'VK_BRIDGE' | 'WINDOW_OPEN' | 'WINDOW_PREOPEN';
export type PlatformSwitchOpenErrorCode =
  | 'invalid_url'
  | 'bridge_failed'
  | 'popup_blocked'
  | 'unknown_url_scheme'
  | 'open_failed';
export type PlatformSwitchOpenResult =
  | { ok: true; method: PlatformSwitchOpenMethod }
  | { ok: false; method?: PlatformSwitchOpenMethod; errorCode: PlatformSwitchOpenErrorCode };
export type PlatformSwitchOpenOptions = {
  runtime?: RuntimePlatform;
  preparedWindow?: Window | null;
  skipVkBridge?: boolean;
  targetPlatform?: RuntimePlatform;
};
type VkBridgeImportGroup = {
  id: number;
  name: string;
  screen_name?: string;
};

const TG_LINK_PARAM_PREFIX = 'link_';

let initialized = false;
let vkInitialized = false;
let vkProfileCache: VkBridgeUserInfo | null = null;
let vkProfileRequest: Promise<VkBridgeUserInfo | null> | null = null;

const initViewportFullscreen = () => {
  const setInsetVars = (topPx: number, bottomPx: number) => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root) return;

    const roundedTop = Math.max(0, Math.round(topPx));
    const roundedBottom = Math.max(0, Math.round(bottomPx));

    root.style.setProperty('--tg-top-reserved', `${roundedTop}px`);
    root.style.setProperty('--tg-bottom-reserved', `${roundedBottom}px`);
    root.style.setProperty('--tg-safe-top-actual', `${roundedTop}px`);
    root.style.setProperty('--tg-safe-bottom-actual', `${roundedBottom}px`);

    // Backward-compatible vars for existing styles/tools.
    root.style.setProperty('--tg-header-overlay-offset', '0px');
    root.style.setProperty('--tg-legacy-top-offset', `${roundedTop}px`);
    root.style.setProperty('--tg-legacy-bottom-offset', `${roundedBottom}px`);
  };

  const setConservativeFallbackInsets = () => {
    const tg = (window as any)?.Telegram?.WebApp;
    const isFullscreen = Boolean(tg?.isFullscreen);
    const fallbackTop = isFullscreen ? 64 : 34;
    setInsetVars(fallbackTop, 0);
  };

  const readInset = (value: unknown) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, numeric);
  };

  const syncViewportInsets = () => {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    const tg = (window as any)?.Telegram?.WebApp;
    if (!root || !tg) return;

    const viewportHeight = Number(tg.viewportHeight);
    const stableHeight = Number(tg.viewportStableHeight);
    const baseHeight =
      Number.isFinite(viewportHeight) && viewportHeight > 0
        ? viewportHeight
        : Number.isFinite(stableHeight) && stableHeight > 0
          ? stableHeight
          : 0;

    const topFromInsets = Math.max(
      readInset(tg.contentSafeAreaInset?.top),
      readInset(tg.safeAreaInset?.top)
    );
    const bottomFromInsets = Math.max(
      readInset(tg.contentSafeAreaInset?.bottom),
      readInset(tg.safeAreaInset?.bottom)
    );

    const isFullscreen = Boolean(tg.isFullscreen);
    const viewportDelta =
      baseHeight > 0 ? Math.max(0, Math.round(window.innerHeight - baseHeight)) : 0;
    const expectedTopControls = isFullscreen ? (topFromInsets > 0 ? 56 : 64) : 34;
    const topFromDelta = Math.max(0, Math.min(88, viewportDelta));
    const fullscreenTopBuffer = isFullscreen ? 8 : 0;

    // Use content safe insets first, fallback to viewport delta, and keep a conservative floor
    // for Telegram top controls to avoid overlap in fullscreen edge-cases.
    const topReserve =
      Math.max(topFromInsets, topFromDelta, expectedTopControls) + fullscreenTopBuffer;

    const mainButtonVisible = Boolean(tg.MainButton?.isVisible);
    const mainButtonReserve = mainButtonVisible ? 62 : 0;
    const bottomReserve = Math.max(bottomFromInsets, mainButtonReserve);

    setInsetVars(topReserve, bottomReserve);
  };

  const scheduleSync = () => {
    if (typeof window === 'undefined') return;
    [0, 120, 360, 800, 1600, 3000].forEach((delay) => {
      window.setTimeout(syncViewportInsets, delay);
    });
  };

  const requestInsets = async () => {
    try {
      if (requestSafeAreaInsets.isAvailable?.()) {
        await requestSafeAreaInsets();
      }
    } catch {
      // noop
    }

    try {
      if (requestContentSafeAreaInsets.isAvailable?.()) {
        await requestContentSafeAreaInsets();
      }
    } catch {
      // noop
    }
  };

  const bindVars = () => {
    try {
      if (bindViewportCssVars.isAvailable?.()) bindViewportCssVars();
    } catch {
      // noop
    }

    syncViewportInsets();
  };

  const refreshInsetsAndSync = () => {
    void requestInsets().finally(() => {
      syncViewportInsets();
      scheduleSync();
    });
  };

  const expandToFullscreen = () => {
    try {
      if (expandViewport.isAvailable?.()) expandViewport();
    } catch {
      // noop
    }

    try {
      if (requestFullscreen.isAvailable?.()) {
        void requestFullscreen()
          .catch(() => undefined)
          .finally(() => {
            refreshInsetsAndSync();
          });
      }
    } catch {
      // noop
    }

    refreshInsetsAndSync();
  };

  try {
    const tg = (window as any)?.Telegram?.WebApp;
    if (tg?.onEvent) {
      tg.onEvent('viewportChanged', syncViewportInsets);
      tg.onEvent('safeAreaChanged', syncViewportInsets);
      tg.onEvent('contentSafeAreaChanged', syncViewportInsets);
      tg.onEvent('fullscreenChanged', refreshInsetsAndSync);
    }
  } catch {
    // noop
  }

  try {
    window.addEventListener('resize', syncViewportInsets, { passive: true });
  } catch {
    // noop
  }

  setConservativeFallbackInsets();
  scheduleSync();

  void (async () => {
    try {
      if (mountViewport.isAvailable?.()) {
        await mountViewport();
      }
    } catch {
      // noop
    }

    await requestInsets();
    bindVars();
    expandToFullscreen();
  })();
};

const normalizeVkLaunchParamsInput = (raw: string) => {
  let normalized = raw.trim();
  if (!normalized) return '';
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

const getVkLaunchParams = (): URLSearchParams => {
  if (typeof window === 'undefined') return new URLSearchParams();

  const search = window.location.search?.trim() ?? '';
  const hash = window.location.hash?.trim() ?? '';
  const candidates = [search, hash];

  for (const candidate of candidates) {
    const normalized = normalizeVkLaunchParamsInput(candidate);
    if (!normalized) continue;
    const params = new URLSearchParams(normalized);
    if (params.has('vk_user_id') && params.has('sign')) {
      return params;
    }
  }

  return new URLSearchParams();
};

const getVkLaunchData = (): VkLaunchParams => {
  const params = getVkLaunchParams();
  const data: VkLaunchParams = {};
  params.forEach((value, key) => {
    data[key] = value;
  });
  return data;
};

const getVkUserLabelFallback = () => {
  const vkUserId = getVkLaunchData().vk_user_id;
  if (!vkUserId) return 'Гость';
  return `VK ID ${vkUserId}`;
};

const applyVkInsetFallback = () => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  root.style.setProperty('--tg-top-reserved', '0px');
  root.style.setProperty('--tg-bottom-reserved', '0px');
  root.style.setProperty('--tg-safe-top-actual', '0px');
  root.style.setProperty('--tg-safe-bottom-actual', '0px');
};

export const isVk = () => {
  const params = getVkLaunchParams();
  return params.has('vk_user_id') && params.has('sign');
};

export const getVkLaunchParamsRaw = () => getVkLaunchParams().toString();
export const getRuntimePlatform = (): RuntimePlatform => (isVk() ? 'VK' : 'TELEGRAM');

const resolveVkAppId = () => {
  const fromLaunch = Number(getVkLaunchData().vk_app_id ?? '');
  if (Number.isFinite(fromLaunch) && fromLaunch > 0) return fromLaunch;

  const fromEnv = Number(import.meta.env.VITE_VK_APP_ID ?? '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;

  return null;
};

const serializeVkBridgeError = (error: unknown) => {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.name;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const parseVkBridgeErrorCode = (error: unknown) => {
  const payload = (error as VkBridgeErrorPayload | null) ?? null;
  const textParts = [
    payload?.error_type,
    payload?.type,
    payload?.message,
    payload?.error_data?.error_reason,
    payload?.error_data?.error_description,
    serializeVkBridgeError(error),
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ')
    .toLowerCase();

  if (
    textParts.includes('access_denied') ||
    textParts.includes('user_denied') ||
    textParts.includes('permission denied') ||
    textParts.includes('auth denied') ||
    textParts.includes('cancel') ||
    textParts.includes('отказ')
  ) {
    return 'vk_token_access_denied';
  }

  if (
    textParts.includes('unsupported') ||
    textParts.includes('not supported') ||
    textParts.includes('method is not available') ||
    textParts.includes('method is not supported') ||
    textParts.includes('bridge_unavailable') ||
    textParts.includes('client is not vk') ||
    textParts.includes('unknown_method') ||
    textParts.includes('not implemented')
  ) {
    return 'vk_token_method_unsupported';
  }

  return 'vk_token_bridge_failed';
};

const classifyVkApiTokenErrorCode = (payload: { code: number; message: string }) => {
  const normalized = payload.message.toLowerCase();

  if (
    normalized.includes('expired') ||
    normalized.includes('истек') ||
    normalized.includes('session expired') ||
    normalized.includes('token has expired')
  ) {
    return 'vk_user_token_expired';
  }

  const scopeMissingByMessage =
    (normalized.includes('permission') ||
      normalized.includes('access denied') ||
      normalized.includes('no access') ||
      normalized.includes('scope') ||
      normalized.includes('доступ') ||
      normalized.includes('прав')) &&
    (normalized.includes('group') ||
      normalized.includes('groups') ||
      normalized.includes('сообществ') ||
      normalized.includes('групп'));

  if (scopeMissingByMessage || payload.code === 7 || payload.code === 15) {
    return 'vk_user_token_scope_missing';
  }

  return 'vk_user_token_invalid';
};

const normalizeVkGroupScreenName = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-z0-9_.]{2,64}$/i.test(normalized)) return undefined;
  return normalized;
};

const requestVkApiMethodViaBridge = async <T>(
  method: string,
  params: Record<'access_token', string> & Record<string, string | number>
) => {
  try {
    const payload = (await bridge.send('VKWebAppCallAPIMethod', {
      method,
      request_id: `jr_${method}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      params: {
        ...params,
        v: '5.199',
      },
    })) as VkBridgeApiMethodResponse<T>;

    if (payload?.error) {
      const code = Number(payload.error.error_code ?? 0);
      const message = payload.error.error_msg?.trim() || 'vk_api_error';
      const classified = classifyVkApiTokenErrorCode({
        code: Number.isFinite(code) ? code : 0,
        message,
      });
      throw new Error(classified);
    }

    if (typeof payload?.response === 'undefined') {
      throw new Error('vk_token_bridge_failed');
    }

    return payload.response;
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message === 'vk_user_token_invalid' ||
        error.message === 'vk_user_token_scope_missing' ||
        error.message === 'vk_user_token_expired'
      ) {
        throw error;
      }
      if (error.message.startsWith('vk_token_')) {
        throw error;
      }
    }
    throw new Error(parseVkBridgeErrorCode(error));
  }
};

const normalizePlatformLinkCode = (value: string) => {
  const normalized = value.trim().toUpperCase();
  return /^LINK_[A-Z0-9]{8,32}$/.test(normalized) ? normalized : '';
};

const PLATFORM_LINK_URL_KEYS = ['jr_link_code', 'link_code', 'startapp', 'vk_ref'] as const;

const extractLinkCodeFromStartLikeValue = (value: string) => {
  const normalized = value.trim();
  if (!normalized) return '';

  const normalizedCode = normalizePlatformLinkCode(normalized);
  if (normalizedCode) return normalizedCode;

  if (normalized.toLowerCase().startsWith(TG_LINK_PARAM_PREFIX)) {
    return normalizePlatformLinkCode(normalized.slice(TG_LINK_PARAM_PREFIX.length));
  }

  return '';
};

const parseHashState = (hashValue: string) => {
  const normalized = hashValue.replace(/^#/, '').trim();
  if (!normalized) return { path: '', params: new URLSearchParams() };

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

const applyHashState = (url: URL, state: { path: string; params: URLSearchParams }) => {
  const query = state.params.toString();
  if (state.path && query) {
    url.hash = `#${state.path}?${query}`;
    return;
  }
  if (state.path) {
    url.hash = `#${state.path}`;
    return;
  }
  url.hash = query ? `#${query}` : '';
};

const readUrlParam = (key: string) => {
  if (typeof window === 'undefined') return '';
  const readFromParams = (params: URLSearchParams) => {
    const value = params.get(key);
    return typeof value === 'string' ? value.trim() : '';
  };

  const fromSearch = readFromParams(new URLSearchParams(window.location.search || ''));
  if (fromSearch) return fromSearch;

  const hashRaw = (window.location.hash || '').replace(/^#/, '').trim();
  if (hashRaw) {
    const fromHashDirect = readFromParams(
      new URLSearchParams(hashRaw.startsWith('?') ? hashRaw.slice(1) : hashRaw)
    );
    if (fromHashDirect) return fromHashDirect;

    const queryIndex = hashRaw.indexOf('?');
    if (queryIndex >= 0) {
      const fromHashQuery = readFromParams(new URLSearchParams(hashRaw.slice(queryIndex + 1)));
      if (fromHashQuery) return fromHashQuery;
    }
  }

  const fromVkLaunch = readFromParams(getVkLaunchParams());
  if (fromVkLaunch) return fromVkLaunch;

  return '';
};

const getTelegramInitDataRaw = () => {
  try {
    const raw = initData.raw?.();
    if (raw) return raw;
  } catch {
    // noop
  }

  try {
    const globalInitData = (window as any)?.Telegram?.WebApp?.initData;
    if (typeof globalInitData === 'string' && globalInitData) {
      return globalInitData;
    }
  } catch {
    // noop
  }

  try {
    const params: any = retrieveLaunchParams();
    return (
      params?.tgWebAppDataRaw ||
      params?.tgWebAppData?.raw ||
      params?.tgWebAppDataUnsafe?.raw ||
      params?.tgWebAppDataUnsafe?.initData ||
      ''
    );
  } catch {
    return '';
  }
};

const getTelegramStartParam = () => {
  try {
    const raw = getTelegramInitDataRaw();
    if (raw) {
      const params = new URLSearchParams(raw);
      const value = params.get('start_param');
      if (value) return value.trim();
    }
  } catch {
    // noop
  }

  try {
    const launch: any = retrieveLaunchParams();
    const candidate =
      launch?.tgWebAppStartParam ||
      launch?.tgWebAppData?.start_param ||
      launch?.tgWebAppDataUnsafe?.start_param;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  } catch {
    // noop
  }

  try {
    const unsafeStart = (window as any)?.Telegram?.WebApp?.initDataUnsafe?.start_param;
    if (typeof unsafeStart === 'string' && unsafeStart.trim()) return unsafeStart.trim();
  } catch {
    // noop
  }

  return '';
};

export const getPlatformLinkCode = () => {
  if (isVk()) {
    const vkRefCode = extractLinkCodeFromStartLikeValue(readUrlParam('vk_ref'));
    if (vkRefCode) return vkRefCode;

    const vkCode = readUrlParam('jr_link_code') || readUrlParam('link_code');
    return normalizePlatformLinkCode(vkCode);
  }

  const startParam = getTelegramStartParam();
  const startParamCode = extractLinkCodeFromStartLikeValue(startParam);
  if (startParamCode) return startParamCode;

  const startAppCode = extractLinkCodeFromStartLikeValue(readUrlParam('startapp'));
  if (startAppCode) return startAppCode;

  const fallbackCode = readUrlParam('jr_link_code') || readUrlParam('link_code');
  return normalizePlatformLinkCode(fallbackCode);
};

export const clearPlatformLinkCodeFromUrl = () => {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    for (const key of PLATFORM_LINK_URL_KEYS) {
      url.searchParams.delete(key);
    }

    const hashState = parseHashState(url.hash);
    const hasHashLinkCode = PLATFORM_LINK_URL_KEYS.some((key) => hashState.params.has(key));
    if (hasHashLinkCode) {
      for (const key of PLATFORM_LINK_URL_KEYS) {
        hashState.params.delete(key);
      }
      applyHashState(url, hashState);
    }

    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, '', next);
  } catch {
    // noop
  }
};

const classifyOpenLinkErrorCode = (error: unknown): PlatformSwitchOpenErrorCode => {
  const raw = serializeVkBridgeError(error).toLowerCase();
  if (raw.includes('unknown_url_scheme') || raw.includes('unknown url scheme')) {
    return 'unknown_url_scheme';
  }
  return 'open_failed';
};

const buildTelegramDeepLinkFromHttpUrl = (parsed: URL) => {
  const host = parsed.hostname.toLowerCase();
  if (host !== 't.me' && host !== 'telegram.me') return '';
  const path = parsed.pathname.replace(/^\/+/, '');
  const domain = path.split('/').find(Boolean);
  if (!domain) return '';
  const params = new URLSearchParams();
  params.set('domain', domain);
  for (const [key, value] of parsed.searchParams.entries()) {
    params.set(key, value);
  }
  return `tg://resolve?${params.toString()}`;
};

export const tryPrepareExternalWindow = () => {
  try {
    const popup = window.open('', '_blank');
    if (!popup) return null;
    try {
      popup.opener = null;
    } catch {
      // noop
    }
    return popup;
  } catch {
    return null;
  }
};

export const openPlatformSwitchLink = async (
  url: string,
  options?: PlatformSwitchOpenOptions
): Promise<PlatformSwitchOpenResult> => {
  const target = url.trim();
  if (!target) {
    return { ok: false, errorCode: 'invalid_url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { ok: false, errorCode: 'invalid_url' };
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    return { ok: false, errorCode: 'invalid_url' };
  }

  const isVkRuntime = options?.runtime ? options.runtime === 'VK' : isVk();
  const useTelegramDeepLink = isVkRuntime && options?.targetPlatform === 'TELEGRAM';
  const telegramDeepLink = useTelegramDeepLink ? buildTelegramDeepLinkFromHttpUrl(parsed) : '';
  const primaryTarget = telegramDeepLink || target;

  const preparedWindow = options?.preparedWindow;
  if (preparedWindow && !preparedWindow.closed) {
    try {
      preparedWindow.location.replace(primaryTarget);
      return { ok: true, method: 'WINDOW_PREOPEN' };
    } catch (error) {
      return {
        ok: false,
        method: 'WINDOW_PREOPEN',
        errorCode: classifyOpenLinkErrorCode(error),
      };
    }
  }

  let vkBridgeErrorCode: PlatformSwitchOpenErrorCode | '' = '';
  if (isVkRuntime && !options?.skipVkBridge && options?.targetPlatform !== 'TELEGRAM') {
    try {
      await (bridge as any).send('VKWebAppOpenLink', {
        url: target,
        force_external: true,
      } as any);
      return { ok: true, method: 'VK_BRIDGE' };
    } catch (error) {
      const classified = classifyOpenLinkErrorCode(error);
      vkBridgeErrorCode = classified === 'unknown_url_scheme' ? 'unknown_url_scheme' : 'bridge_failed';
      // Fallback to browser popup below.
    }
  }

  try {
    const popup = window.open(primaryTarget, '_blank', 'noopener,noreferrer');
    if (popup) {
      return { ok: true, method: 'WINDOW_OPEN' };
    }
    return {
      ok: false,
      method: 'WINDOW_OPEN',
      errorCode: vkBridgeErrorCode || 'popup_blocked',
    };
  } catch (error) {
    return {
      ok: false,
      method: 'WINDOW_OPEN',
      errorCode: vkBridgeErrorCode || classifyOpenLinkErrorCode(error),
    };
  }
};

export const requestVkUserToken = async (scope = 'groups') => {
  if (!isVk()) {
    throw new Error('vk_token_runtime_not_vk');
  }

  const appId = resolveVkAppId();
  if (!appId) {
    throw new Error('vk_token_app_id_missing');
  }

  const normalizeVkScopeList = (value: string) =>
    value
      .toLowerCase()
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

  try {
    const response = (await bridge.send('VKWebAppGetAuthToken', {
      app_id: appId,
      scope,
    })) as VkBridgeAuthTokenResponse;
    const token = response?.access_token?.trim();
    if (!token) {
      throw new Error('vk_token_bridge_failed');
    }
    const requestedScope = normalizeVkScopeList(scope);
    if (requestedScope.length > 0) {
      const grantedScope = new Set(normalizeVkScopeList(response?.scope ?? ''));
      const hasAllScopes = requestedScope.every((entry) => grantedScope.has(entry));
      if (!hasAllScopes) {
        throw new Error('vk_user_token_scope_missing');
      }
    }
    return token;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('vk_token_') || error.message === 'vk_user_token_scope_missing')
    ) {
      throw error;
    }
    throw new Error(parseVkBridgeErrorCode(error));
  }
};

export const fetchVkAdminGroupsViaBridge = async (vkUserToken: string) => {
  if (!isVk()) {
    throw new Error('vk_token_runtime_not_vk');
  }

  const token = vkUserToken.trim();
  if (!token) {
    throw new Error('vk_user_token_invalid');
  }

  const count = 1000;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let page = 0;
  const groupsMap = new Map<number, VkBridgeImportGroup>();

  while (offset < total && page < 20) {
    page += 1;
    const response = await requestVkApiMethodViaBridge<VkBridgeGroupsGetResponse>('groups.get', {
      filter: 'admin,editor,moder',
      extended: 1,
      count,
      offset,
      access_token: token,
    });

    const items = Array.isArray(response.items) ? response.items : [];
    const totalRaw = Number(response.count ?? items.length);
    total = Number.isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : items.length;
    if (items.length === 0) break;

    for (const item of items) {
      const id = Number(item.id ?? 0);
      const groupId = Number.isFinite(id) ? Math.floor(id) : 0;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (groupId <= 0 || !name) continue;
      const screenName = normalizeVkGroupScreenName(item.screen_name);
      groupsMap.set(groupId, {
        id: groupId,
        name,
        ...(screenName ? { screen_name: screenName } : {}),
      });
    }

    offset += items.length;
  }

  return Array.from(groupsMap.values());
};

const initVk = () => {
  if (vkInitialized || !isVk()) return;
  vkInitialized = true;

  try {
    void bridge.send('VKWebAppInit');
  } catch {
    // noop
  }

  applyVkInsetFallback();
  void loadPlatformProfile();
};

export const isTelegram = () => {
  try {
    retrieveLaunchParams();
    return true;
  } catch {
    return false;
  }
};

const getUserFromLaunchParams = (): User | undefined => {
  try {
    const params: any = retrieveLaunchParams();
    const data = params?.tgWebAppData || params?.tgWebAppDataRaw || params?.tgWebAppDataUnsafe;
    return data?.user as User | undefined;
  } catch {
    return undefined;
  }
};

const getUserFromWebAppGlobal = (): User | undefined => {
  try {
    const tg = (window as any)?.Telegram?.WebApp;
    return tg?.initDataUnsafe?.user as User | undefined;
  } catch {
    return undefined;
  }
};

export const getUserLabel = () => {
  if (isVk()) {
    if (vkProfileCache) {
      const fullName = [vkProfileCache.first_name, vkProfileCache.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (fullName) return fullName;
    }
    return getVkUserLabelFallback();
  }

  let user: User | undefined;

  try {
    const maybeUser = initData.user?.();
    if (maybeUser) user = maybeUser as User;
  } catch {
    user = undefined;
  }

  if (!user) user = getUserFromLaunchParams();
  if (!user) user = getUserFromWebAppGlobal();
  if (!user) return 'Гость';
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (user.username) return user.username;
  return 'Гость';
};

export const getUserPhotoUrl = () => {
  if (isVk()) {
    return vkProfileCache?.photo_200 || vkProfileCache?.photo_100 || vkProfileCache?.photo_50 || '';
  }

  let user: User | undefined;

  try {
    const maybeUser = initData.user?.();
    if (maybeUser) user = maybeUser as User;
  } catch {
    user = undefined;
  }

  if (!user) user = getUserFromLaunchParams();
  if (!user) user = getUserFromWebAppGlobal();
  return user?.photo_url || '';
};

const loadVkBridgeProfile = async (): Promise<VkBridgeUserInfo | null> => {
  if (!isVk()) return null;

  if (vkProfileCache) {
    return vkProfileCache;
  }

  if (!vkProfileRequest) {
    vkProfileRequest = bridge
      .send('VKWebAppGetUserInfo')
      .then((profile) => {
        vkProfileCache = profile as VkBridgeUserInfo;
        return vkProfileCache;
      })
      .catch(() => {
        vkProfileCache = null;
        return null;
      })
      .finally(() => {
        vkProfileRequest = null;
      });
  }

  return await vkProfileRequest;
};

export const loadPlatformProfile = async (): Promise<PlatformUserProfile | null> => {
  if (!isVk()) return null;

  const profile = await loadVkBridgeProfile();
  if (!profile) {
    return { label: getVkUserLabelFallback(), photoUrl: '' };
  }

  const label = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
  return {
    label: label || getVkUserLabelFallback(),
    photoUrl: profile.photo_200 || profile.photo_100 || profile.photo_50 || '',
  };
};

export const loadVkAuthProfile = async (): Promise<VkAuthProfilePayload | null> => {
  if (!isVk()) return null;
  const profile = await loadVkBridgeProfile();
  const launchId = getVkLaunchData().vk_user_id?.trim() ?? '';
  const profileId =
    profile && Number.isFinite(profile.id) && profile.id > 0 ? String(Math.floor(profile.id)) : launchId;
  const firstName = profile?.first_name?.trim() ?? '';
  const lastName = profile?.last_name?.trim() ?? '';
  const photoUrl =
    profile?.photo_200?.trim() || profile?.photo_100?.trim() || profile?.photo_50?.trim() || '';

  return {
    id: profileId || undefined,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    photoUrl: photoUrl || undefined,
  };
};

export const getInitDataRaw = () => {
  if (isVk()) {
    return getVkLaunchParamsRaw();
  }
  return getTelegramInitDataRaw();
};

export const initTelegram = () => {
  if (!isTelegram()) {
    initVk();
    return;
  }
  if (initialized) return;

  try {
    init();
  } catch {
    return;
  }

  initialized = true;

  try {
    if (themeParams.mountSync?.isAvailable?.()) themeParams.mountSync();
  } catch {
    // noop
  }

  try {
    if (themeParams.bindCssVars?.isAvailable?.()) themeParams.bindCssVars();
  } catch {
    // noop
  }

  try {
    if (miniApp.mountSync?.isAvailable?.()) miniApp.mountSync();
  } catch {
    // noop
  }

  initViewportFullscreen();

  try {
    if (typeof initData.restore === 'function') initData.restore();
  } catch {
    // noop
  }

  try {
    if (miniApp.ready?.isAvailable?.()) miniApp.ready();
  } catch {
    // noop
  }

};
