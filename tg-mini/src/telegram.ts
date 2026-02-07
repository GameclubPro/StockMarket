import {
  bindViewportCssVars,
  expandViewport,
  init,
  initData,
  miniApp,
  mountViewport,
  requestFullscreen,
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
  const bindVars = () => {
    try {
      if (bindViewportCssVars.isAvailable?.()) bindViewportCssVars();
    } catch {
      // noop
    }
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
        .finally(() => {
          bindVars();
          expandToFullscreen();
        });
      return;
    }
  } catch {
    // noop
  }

  bindVars();
  expandToFullscreen();
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
