import type {
  AdminModerationActionPayload,
  AdminModerationSnapshot,
  AdminPanelStats,
  ApplicationDto,
  CampaignDto,
  CampaignReportReason,
  DailyBonusSpin,
  DailyBonusStatus,
  GroupDto,
  ImportVkGroupsResponse,
  ReferralBonus,
  ReferralListItem,
  ReferralStats,
  RuntimeCapabilities,
  RuntimePlatform,
  SwitchLinkResponse,
  UserDto,
  VkBridgeImportGroup,
  VerificationDto,
} from './types/app';
import { getInitDataRaw } from './telegram';

const API_BASE = import.meta.env.VITE_API_URL ?? import.meta.env.VITE_API_BASE ?? '';

export type {
  AdminModerationActionPayload,
  AdminModerationSnapshot,
  AdminPanelStats,
  ApplicationDto,
  BlockedPayload,
  CampaignDto,
  CampaignReportReason,
  DailyBonusSpin,
  DailyBonusStatus,
  GroupDto,
  ImportVkGroupsResponse,
  ReferralBonus,
  ReferralListItem,
  ReferralStats,
  RuntimeCapabilities,
  RuntimePlatform,
  SwitchLinkResponse,
  UserDto,
  VkBridgeImportGroup,
  VerificationDto,
} from './types/app';

export class ApiRequestError<T = unknown> extends Error {
  status: number;
  payload: T | null;

  constructor(message: string, status: number, payload: T | null = null) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.payload = payload;
  }
}

const withAuthHeaders = (base?: HeadersInit) => {
  const headers = new Headers(base);
  const token = localStorage.getItem('sessionToken');
  if (token) headers.set('authorization', `Bearer ${token}`);

  const initData = getInitDataRaw();
  if (initData) headers.set('x-init-data', initData);

  return headers;
};

const request = async (path: string, options: RequestInit = {}) => {
  const headers = withAuthHeaders(options.headers);

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = 'request failed';
    let payload: unknown = null;
    try {
      const data = await response.json();
      payload = data;
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      // ignore
    }
    throw new ApiRequestError(message, response.status, payload);
  }

  return response.json();
};

export const verifyInitData = async (
  initData: string,
  options?: { linkCode?: string }
) => {
  const response = await fetch(`${API_BASE}/api/auth/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      initData,
      ...(options?.linkCode ? { linkCode: options.linkCode } : {}),
    }),
  });

  if (!response.ok) {
    let message = 'auth failed';
    let payload: unknown = null;
    try {
      const data = await response.json();
      payload = data;
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      // ignore
    }
    throw new ApiRequestError(message, response.status, payload);
  }

  const data = (await response.json()) as {
    ok: boolean;
    token?: string;
    balance?: number;
    user?: UserDto;
    referralBonus?: ReferralBonus | null;
  };
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
  return data as {
    ok: boolean;
    user: UserDto;
    runtimePlatform?: RuntimePlatform;
    balance: number;
    stats: { groups: number; campaigns: number; applications: number };
    capabilities?: RuntimeCapabilities;
  };
};

export const createPlatformSwitchLink = async (targetPlatform: RuntimePlatform) => {
  const data = await request('/api/platform/switch-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPlatform }),
  });
  return data as SwitchLinkResponse;
};

export const fetchAdminPanelStats = async (period: 'today' | '7d' | '30d' = 'today') => {
  const params = new URLSearchParams({ period });
  const response = await fetch(`${API_BASE}/api/admin/panel?${params.toString()}`, {
    headers: withAuthHeaders(),
  });
  if (response.status === 401 || response.status === 403) return null;

  if (!response.ok) {
    let message = 'request failed';
    let payload: unknown = null;
    try {
      const data = await response.json();
      payload = data;
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      // ignore
    }
    throw new ApiRequestError(message, response.status, payload);
  }

  const data = (await response.json()) as {
    ok: boolean;
    allowed?: boolean;
    stats?: AdminPanelStats;
  };
  if (!data.ok || !data.allowed || !data.stats) return null;
  return data as { ok: true; allowed: true; stats: AdminPanelStats };
};

export const fetchAdminModeration = async () => {
  const response = await fetch(`${API_BASE}/api/admin/moderation`, {
    headers: withAuthHeaders(),
  });
  if (response.status === 401 || response.status === 403) return null;

  if (!response.ok) {
    let message = 'request failed';
    let payload: unknown = null;
    try {
      const data = await response.json();
      payload = data;
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      // ignore
    }
    throw new ApiRequestError(message, response.status, payload);
  }

  const data = (await response.json()) as { ok: boolean } & AdminModerationSnapshot;
  if (!data.ok) return null;
  return data;
};

export const moderateCampaign = async (
  campaignId: string,
  payload: AdminModerationActionPayload
) => {
  const data = await request(`/api/admin/moderation/campaigns/${campaignId}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return data as {
    ok: boolean;
    result: {
      campaignDeleted: boolean;
      fineApplied: number;
      userBlocked: boolean;
      blockedUntil: string | null;
      clearedReports: number;
    };
  };
};

export const cleanupStaleApplications = async () => {
  const data = await request('/api/admin/moderation/stale/cleanup', {
    method: 'POST',
  });
  return data as { ok: boolean; cleaned: number; thresholdHours: number };
};

export const unblockUser = async (userId: string) => {
  const data = await request(`/api/admin/moderation/users/${userId}/unblock`, {
    method: 'POST',
  });
  return data as { ok: boolean; user: { id: string; isBlocked: boolean } };
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
  return data as {
    ok: boolean;
    application?: ApplicationDto;
    campaign?: CampaignDto;
    balance?: number;
    verification?: VerificationDto;
  };
};

export const recheckApplication = async (id: string) => {
  const data = await request(`/api/applications/${id}/recheck`, { method: 'POST' });
  return data as {
    ok: boolean;
    application?: ApplicationDto;
    campaign?: CampaignDto;
    balance?: number;
    verification?: VerificationDto;
  };
};

export const hideCampaign = async (id: string) => {
  const data = await request(`/api/campaigns/${id}/hide`, { method: 'POST' });
  return data as { ok: boolean; hidden?: boolean };
};

export const reportCampaign = async (id: string, reason: CampaignReportReason) => {
  const data = await request(`/api/campaigns/${id}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return data as { ok: boolean; reported?: boolean; hidden?: boolean };
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
  title?: string;
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

export const importVkAdminGroups = async (vkUserToken: string) => {
  const data = await request('/api/groups/import-vk-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vkUserToken }),
  });
  return data as ImportVkGroupsResponse;
};

export const importVkAdminGroupsFromBridge = async (groups: VkBridgeImportGroup[]) => {
  const data = await request('/api/groups/import-vk-admin-bridge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groups }),
  });
  return data as ImportVkGroupsResponse;
};

export const fetchDailyBonusStatus = async () => {
  const data = await request('/api/daily-bonus/status');
  return data as { ok: boolean } & DailyBonusStatus;
};

export const spinDailyBonus = async () => {
  const data = await request('/api/daily-bonus/spin', { method: 'POST' });
  return data as { ok: boolean } & DailyBonusSpin;
};

export const fetchReferralStats = async () => {
  const data = await request('/api/referrals/me');
  return data as { ok: boolean } & ReferralStats;
};

export const fetchReferralList = async () => {
  const data = await request('/api/referrals/list');
  return data as { ok: boolean; referrals: ReferralListItem[] };
};
