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
  const syncLegacyViewportOffsets = () => {
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

    const safeTop = Number(tg.safeAreaInset?.top);
    const contentTop = Number(tg.contentSafeAreaInset?.top);
    const safeBottom = Number(tg.safeAreaInset?.bottom);
    const contentBottom = Number(tg.contentSafeAreaInset?.bottom);
    const topFromInsets = Math.max(
      Number.isFinite(safeTop) ? safeTop : 0,
      Number.isFinite(contentTop) ? contentTop : 0
    );
    const bottomFromInsets = Math.max(
      Number.isFinite(safeBottom) ? safeBottom : 0,
      Number.isFinite(contentBottom) ? contentBottom : 0
    );

    const isFullscreen = Boolean(tg.isFullscreen);
    const viewportDelta =
      baseHeight > 0 ? Math.max(0, Math.round(window.innerHeight - baseHeight)) : 0;

    // Telegram can provide status-bar inset only (e.g. 20-28px) while header controls are
    // still overlaid on top of the webview. Add a separate overlay offset only in this case.
    const expectedHeaderHeight = isFullscreen ? 46 : 34;
    const hasHeaderInInsets = topFromInsets >= expectedHeaderHeight + 10;
    const hasHeaderInViewportDelta = viewportDelta >= expectedHeaderHeight - 4;
    const headerOverlayOffset = hasHeaderInInsets || hasHeaderInViewportDelta
      ? 0
      : expectedHeaderHeight;
    root.style.setProperty('--tg-header-overlay-offset', `${headerOverlayOffset}px`);

    const statusFloor = Math.max(topFromInsets, isFullscreen ? 20 : 16);
    const topOffset = Math.max(statusFloor, Math.min(88, viewportDelta));
    root.style.setProperty('--tg-legacy-top-offset', `${topOffset}px`);

    const bottomOffset = bottomFromInsets;
    if (bottomOffset > 0) {
      root.style.setProperty('--tg-legacy-bottom-offset', `${Math.round(bottomOffset)}px`);
    } else {
      root.style.setProperty('--tg-legacy-bottom-offset', '0px');
    }
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

    syncLegacyViewportOffsets();
  };

  const expandToFullscreen = () => {
    try {
      if (expandViewport.isAvailable?.()) expandViewport();
    } catch {
      // noop
    }

    try {
      if (requestFullscreen.isAvailable?.()) {
        void requestFullscreen();
      }
    } catch {
      // noop
    }
  };

  try {
    if (mountViewport.isAvailable?.()) {
      void mountViewport()
        .catch(() => undefined)
        .then(() => requestInsets())
        .finally(() => {
          bindVars();
          expandToFullscreen();
        });
      return;
    }
  } catch {
    // noop
  }

  void requestInsets().finally(() => {
    bindVars();
    expandToFullscreen();
  });

  try {
    const tg = (window as any)?.Telegram?.WebApp;
    if (tg?.onEvent) {
      tg.onEvent('viewportChanged', syncLegacyViewportOffsets);
      tg.onEvent('safeAreaChanged', syncLegacyViewportOffsets);
      tg.onEvent('contentSafeAreaChanged', syncLegacyViewportOffsets);
      tg.onEvent('fullscreenChanged', syncLegacyViewportOffsets);
    }
  } catch {
    // noop
  }

  try {
    window.addEventListener('resize', syncLegacyViewportOffsets, { passive: true });
  } catch {
    // noop
  }
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
