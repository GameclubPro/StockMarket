const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export type VerifyResponse = {
  ok: boolean;
  user?: {
    id: string;
    telegramId: string;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    photoUrl?: string | null;
  };
  token?: string;
  error?: string;
};

export const verifyInitData = async (initData: string) => {
  const response = await fetch(`${API_BASE}/api/auth/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ initData }),
  });

  if (!response.ok) {
    throw new Error('auth failed');
  }

  const data = (await response.json()) as VerifyResponse;
  if (!data.ok) {
    throw new Error(data.error || 'auth failed');
  }

  if (data.token) {
    localStorage.setItem('sessionToken', data.token);
  }

  return data;
};

export const getSessionToken = () => localStorage.getItem('sessionToken') ?? '';
