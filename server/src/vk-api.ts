import { config } from './config.js';

type VkApiErrorPayload = {
  error_code?: number;
  error_msg?: string;
};

type VkApiEnvelope<T> = {
  response?: T;
  error?: VkApiErrorPayload;
};

type VkGroupByIdResponseItem = {
  id?: number;
  name?: string;
  screen_name?: string;
};

type VkGroupIsMemberResponse =
  | number
  | {
      member?: number;
      request?: number;
    }
  | Array<{
      member?: number;
      request?: number;
    }>;

export type VkMembershipResult = 'MEMBER' | 'NOT_MEMBER' | 'PENDING_REQUEST' | 'UNAVAILABLE';
export type VkGroupCreateResolution = {
  groupId: number;
  name: string;
  screenName?: string;
  canonicalInviteLink: string;
};

const VK_API_BASE = 'https://api.vk.com/method';
const VK_ALLOWED_HOSTS = new Set(['vk.com', 'www.vk.com', 'm.vk.com']);

const withHttpsPrefix = (value: string) => (/^https?:\/\//i.test(value) ? value : `https://${value}`);

const toPositiveInt = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  if (rounded <= 0) return null;
  return rounded;
};

const normalizeVkApiError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown');
};

const normalizeVkRefToken = (value: string) =>
  value
    .trim()
    .replace(/^@+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

const parseVkRefToken = (value: string) => {
  const normalized = normalizeVkRefToken(value);
  if (!normalized) return null;

  const communityMatch = normalized.match(/^(public|club|event)(\d+)$/i);
  if (communityMatch?.[2]) return `-${communityMatch[2]}`;

  const userMatch = normalized.match(/^id(\d+)$/i);
  if (userMatch?.[1]) return userMatch[1];

  const wallMatch = normalized.match(/^wall(-?\d+)_\d+$/i);
  if (wallMatch?.[1]) return wallMatch[1];

  if (/^-?\d+$/.test(normalized)) return normalized;
  if (/^[a-z0-9_.]{2,64}$/i.test(normalized)) return normalized;

  return null;
};

const normalizeVkScreenName = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeVkRefToken(value);
  if (!normalized) return undefined;
  if (!/^[a-z0-9_.]{2,64}$/i.test(normalized)) return undefined;
  return normalized;
};

const requestVkMethod = async <T>(
  method: string,
  params: Record<string, string | number>,
  options?: {
    token?: string;
    version?: string;
    timeoutMs?: number;
  }
) => {
  const token = (options?.token ?? config.vkApiToken ?? '').trim();
  if (!token) throw new Error('vk_api_token_missing');

  const version = (options?.version ?? config.vkApiVersion ?? '5.199').trim() || '5.199';
  const timeoutMs = Math.max(500, Math.floor(options?.timeoutMs ?? config.vkVerifyTimeoutMs ?? 4000));
  const url = new URL(`${VK_API_BASE}/${method}`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('v', version);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`vk_http_${response.status}`);
    }
    const payload = (await response.json()) as VkApiEnvelope<T>;
    if (payload.error) {
      const code = Number(payload.error.error_code ?? 0);
      const message = payload.error.error_msg?.trim() || 'vk_api_error';
      throw new Error(`vk_api_${code || 'unknown'}:${message}`);
    }
    if (typeof payload.response === 'undefined') {
      throw new Error('vk_api_empty_response');
    }
    return payload.response;
  } finally {
    clearTimeout(timeout);
  }
};

const parseVkMemberResult = (raw: VkGroupIsMemberResponse): VkMembershipResult => {
  if (typeof raw === 'number') {
    return raw === 1 ? 'MEMBER' : 'NOT_MEMBER';
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return 'NOT_MEMBER';
    return parseVkMemberResult(raw[0] ?? { member: 0 });
  }
  if (!raw || typeof raw !== 'object') return 'UNAVAILABLE';

  const member = Number(raw.member ?? 0);
  if (member === 1) return 'MEMBER';

  const request = Number(raw.request ?? 0);
  if (request === 1) return 'PENDING_REQUEST';

  return 'NOT_MEMBER';
};

export const isVkSubscribeAutoAvailable = () => Boolean((config.vkApiToken ?? '').trim());

export const resolveVkGroupRefFromLink = (inviteLink: string) => {
  const raw = inviteLink.trim();
  if (!raw) return null;

  const directRef = parseVkRefToken(raw.split(/[?#]/)[0] ?? '');
  const looksLikeDomain = /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(raw);
  if (directRef && !raw.includes('://') && !looksLikeDomain) {
    return directRef;
  }

  try {
    const parsed = new URL(withHttpsPrefix(raw));
    const host = parsed.hostname.toLowerCase();
    if (!VK_ALLOWED_HOSTS.has(host)) return null;

    const slug = parsed.pathname
      .replace(/^\/+/, '')
      .split('/')[0]
      ?.trim();
    if (!slug) return null;
    return parseVkRefToken(slug);
  } catch {
    return null;
  }
};

export const resolveVkGroupId = async (
  ref: string,
  options?: {
    token?: string;
    version?: string;
    timeoutMs?: number;
  }
) => {
  const normalized = ref.trim();
  if (!normalized) return null;

  const directNumeric = normalized.match(/^-?\d+$/);
  if (directNumeric) {
    const numeric = Math.abs(Number(normalized));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  try {
    const response = await requestVkMethod<VkGroupByIdResponseItem[] | VkGroupByIdResponseItem>(
      'groups.getById',
      {
        group_id: normalized,
      },
      options
    );
    const first = Array.isArray(response) ? response[0] : response;
    return toPositiveInt(first?.id);
  } catch {
    return null;
  }
};

export const checkVkMembership = async (
  groupId: number,
  userId: string | number,
  options?: {
    token?: string;
    version?: string;
    timeoutMs?: number;
  }
): Promise<VkMembershipResult> => {
  const group = toPositiveInt(groupId);
  const user = toPositiveInt(userId);
  if (!group || !user) return 'UNAVAILABLE';

  try {
    const response = await requestVkMethod<VkGroupIsMemberResponse>(
      'groups.isMember',
      {
        group_id: group,
        user_id: user,
        extended: 1,
      },
      options
    );
    return parseVkMemberResult(response);
  } catch (error) {
    const message = normalizeVkApiError(error);
    if (message.includes('vk_api_15:')) {
      return 'UNAVAILABLE';
    }
    return 'UNAVAILABLE';
  }
};

export const resolveVkGroupForCreate = async (
  inviteLink: string,
  options?: {
    token?: string;
    version?: string;
    timeoutMs?: number;
  }
): Promise<VkGroupCreateResolution | null> => {
  const ref = resolveVkGroupRefFromLink(inviteLink);
  if (!ref) return null;

  const numericRef = ref.match(/^-?\d+$/);
  const groupLookupRef = numericRef ? String(Math.abs(Number(ref))) : ref;
  if (!groupLookupRef) return null;

  try {
    const response = await requestVkMethod<VkGroupByIdResponseItem[] | VkGroupByIdResponseItem>(
      'groups.getById',
      {
        group_id: groupLookupRef,
      },
      options
    );
    const first = Array.isArray(response) ? response[0] : response;
    const groupId = toPositiveInt(first?.id);
    const name = typeof first?.name === 'string' ? first.name.trim() : '';
    if (!groupId || !name) return null;

    const screenName = normalizeVkScreenName(first?.screen_name);
    const canonicalInviteLink = `https://vk.com/public${groupId}`;

    return {
      groupId,
      name,
      screenName,
      canonicalInviteLink,
    };
  } catch {
    return null;
  }
};
