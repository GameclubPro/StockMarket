const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export type UserDto = {
  id: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  totalEarned?: number | null;
};

export type GroupDto = {
  id: string;
  title: string;
  username?: string | null;
  inviteLink: string;
  description?: string | null;
  category?: string | null;
  createdAt: string;
};

export type CampaignDto = {
  id: string;
  actionType: 'SUBSCRIBE' | 'REACTION';
  targetMessageId?: number | null;
  rewardPoints: number;
  totalBudget: number;
  remainingBudget: number;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  createdAt: string;
  group: GroupDto;
  owner?: UserDto;
};

export type ApplicationDto = {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
  createdAt: string;
  reviewedAt?: string | null;
  campaign: CampaignDto;
  applicant?: UserDto;
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
    let message = 'request failed';
    try {
      const data = await response.json();
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      // ignore
    }
    throw new Error(message);
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

  const data = (await response.json()) as { ok: boolean; token?: string; balance?: number; user?: UserDto };
  if (!data.ok) {
    throw new Error('auth failed');
  }

  if (data.token) {
    localStorage.setItem('sessionToken', data.token);
  }

  return data;
};

export const fetchMe = async () => {
  const data = await request('/api/me');
  return data as { ok: boolean; user: UserDto; balance: number; stats: { groups: number; campaigns: number; applications: number } };
};

export const fetchCampaigns = async (category?: string, actionType?: 'subscribe' | 'reaction') => {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (actionType) params.set('actionType', actionType);
  const query = params.toString() ? `?${params.toString()}` : '';
  const data = await request(`/api/campaigns${query}`);
  return data as { ok: boolean; campaigns: CampaignDto[] };
};

export const fetchMyCampaigns = async () => {
  const data = await request('/api/campaigns/my');
  return data as { ok: boolean; campaigns: CampaignDto[] };
};

export const createCampaign = async (payload: {
  groupId: string;
  actionType: 'subscribe' | 'reaction';
  rewardPoints: number;
  totalBudget: number;
  targetMessageLink?: string;
}) => {
  const data = await request('/api/campaigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return data as { ok: boolean; campaign: CampaignDto; balance?: number };
};

export const applyCampaign = async (id: string) => {
  const data = await request(`/api/campaigns/${id}/apply`, { method: 'POST' });
  return data as { ok: boolean; application?: ApplicationDto; campaign?: CampaignDto; balance?: number };
};

export const fetchMyApplications = async () => {
  const data = await request('/api/applications/my');
  return data as { ok: boolean; applications: ApplicationDto[] };
};

export const fetchIncomingApplications = async () => {
  const data = await request('/api/applications/incoming');
  return data as { ok: boolean; applications: ApplicationDto[] };
};

export const approveApplication = async (id: string) => {
  const data = await request(`/api/applications/${id}/approve`, { method: 'POST' });
  return data as { ok: boolean };
};

export const rejectApplication = async (id: string) => {
  const data = await request(`/api/applications/${id}/reject`, { method: 'POST' });
  return data as { ok: boolean };
};

export const createGroup = async (payload: {
  title: string;
  username?: string;
  inviteLink: string;
  description?: string;
  category?: string;
}) => {
  const data = await request('/api/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return data as { ok: boolean; group: GroupDto };
};

export const fetchMyGroups = async () => {
  const data = await request('/api/groups/my');
  return data as { ok: boolean; groups: GroupDto[] };
};
