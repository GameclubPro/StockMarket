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

type User = {
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
};

let initialized = false;

const initViewportFullscreen = () => {
  const setInsetVars = (topPx: number, bottomPx: number) => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root) return;

    const roundedTop = Math.max(0, Math.round(topPx));
    const roundedBottom = Math.max(0, Math.round(bottomPx));

    root.style.setProperty('--tg-top-reserved', `${roundedTop}px`);
    root.style.setProperty('--tg-bottom-reserved', `${roundedBottom}px`);

    // Backward-compatible vars for existing styles/tools.
    root.style.setProperty('--tg-header-overlay-offset', '0px');
    root.style.setProperty('--tg-legacy-top-offset', `${roundedTop}px`);
    root.style.setProperty('--tg-legacy-bottom-offset', `${roundedBottom}px`);
  };

  const setConservativeFallbackInsets = () => {
    const tg = (window as any)?.Telegram?.WebApp;
    const isFullscreen = Boolean(tg?.isFullscreen);
    const fallbackTop = isFullscreen ? 46 : 34;
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
    const expectedTopControls = isFullscreen ? 46 : 34;
    const topFromDelta = Math.max(0, Math.min(88, viewportDelta));

    // Use content safe insets first, fallback to viewport delta, and keep a conservative floor
    // for Telegram top controls to avoid overlap in fullscreen edge-cases.
    const topReserve = Math.max(topFromInsets, topFromDelta, expectedTopControls);

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
            scheduleSync();
          });
      }
    } catch {
      // noop
    }

    scheduleSync();
  };

  try {
    const tg = (window as any)?.Telegram?.WebApp;
    if (tg?.onEvent) {
      tg.onEvent('viewportChanged', syncViewportInsets);
      tg.onEvent('safeAreaChanged', syncViewportInsets);
      tg.onEvent('contentSafeAreaChanged', syncViewportInsets);
      tg.onEvent('fullscreenChanged', syncViewportInsets);
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

export const getUserLabel = () => {
  let user: User | undefined;

  try {
    const maybeUser = initData.user?.();
    if (maybeUser) user = maybeUser as User;
  } catch {
    user = undefined;
  }

  if (!user) user = getUserFromLaunchParams();
  if (!user) return 'Гость';
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (user.username) return user.username;
  return 'Гость';
};

export const getUserPhotoUrl = () => {
  let user: User | undefined;

  try {
    const maybeUser = initData.user?.();
    if (maybeUser) user = maybeUser as User;
  } catch {
    user = undefined;
  }

  if (!user) user = getUserFromLaunchParams();
  return user?.photo_url || '';
};

export const getInitDataRaw = () => {
  try {
    const raw = initData.raw?.();
    if (raw) return raw;
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
  if (initialized || !isTelegram()) return;

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
