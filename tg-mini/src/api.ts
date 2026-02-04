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

export type OfferDto = {
  id: string;
  platform: 'TELEGRAM' | 'YOUTUBE' | 'TIKTOK' | 'INSTAGRAM' | 'X';
  action: 'SUBSCRIBE' | 'SUBSCRIBE_LIKE' | 'LIKE_COMMENT';
  ratio: 'ONE_ONE' | 'ONE_TWO' | 'TWO_ONE';
  link: string;
  note: string;
  createdAt: string;
  user: {
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
};

export type TaskDto = {
  id: string;
  slug: string;
  title: string;
  description: string;
  points: number;
  completed: boolean;
};

const request = async (path: string, options: RequestInit = {}) => {
  const token = localStorage.getItem('sessionToken');
  const headers = new Headers(options.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    throw new Error('request failed');
  }

  return response.json();
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

export const fetchOffers = async (platform?: string) => {
  const query = platform ? `?platform=${platform}` : '';
  const data = await request(`/api/offers${query}`);
  return data as { ok: boolean; offers: OfferDto[] };
};

export const createOffer = async (payload: {
  platform: OfferDto['platform'];
  action: OfferDto['action'];
  ratio: OfferDto['ratio'];
  link: string;
  note?: string;
}) => {
  const data = await request('/api/offers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return data as { ok: boolean; offer: OfferDto };
};

export const respondToOffer = async (id: string) => {
  const data = await request(`/api/offers/${id}/respond`, {
    method: 'POST',
  });
  return data as { ok: boolean };
};

export const fetchTasks = async () => {
  const data = await request('/api/tasks');
  return data as { ok: boolean; points: number; tasks: TaskDto[] };
};

export const fetchMe = async () => {
  const data = await request('/api/me');
  return data as { ok: boolean; points: number; stats: { offers: number; requests: number } };
};
