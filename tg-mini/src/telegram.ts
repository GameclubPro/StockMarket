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

export type PlatformUserProfile = {
  label?: string;
  photoUrl?: string;
};

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

export const loadPlatformProfile = async (): Promise<PlatformUserProfile | null> => {
  if (!isVk()) return null;

  if (vkProfileCache) {
    const label = [vkProfileCache.first_name, vkProfileCache.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      label: label || getVkUserLabelFallback(),
      photoUrl: vkProfileCache.photo_200 || vkProfileCache.photo_100 || vkProfileCache.photo_50 || '',
    };
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

  const profile = await vkProfileRequest;
  if (!profile) {
    return { label: getVkUserLabelFallback(), photoUrl: '' };
  }

  const label = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
  return {
    label: label || getVkUserLabelFallback(),
    photoUrl: profile.photo_200 || profile.photo_100 || profile.photo_50 || '',
  };
};

export const getInitDataRaw = () => {
  if (isVk()) {
    return getVkLaunchParamsRaw();
  }

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
