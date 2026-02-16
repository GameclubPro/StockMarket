import crypto from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';
import { type Application, type Campaign, type Platform, type Prisma, type User } from '@prisma/client';
import { config } from './config.js';
import { signSession, verifySession } from './auth.js';
import {
  calculatePayoutWithBonus,
  calculateUnsubscribePenalty,
  getRankByTotal,
} from './domain/economy.js';
import { calculateAdminFineApplied, resolveAdminBlockUntil } from './domain/moderation.js';
import {
  DAILY_BONUS_COOLDOWN_MS,
  DAILY_BONUS_REASON,
  pickDailyBonus,
  calculateDailyBonusStreakFromDates,
  getNextDailyBonusAt,
  isDailyBonusAvailable,
} from './domain/daily-bonus.js';
import { ApiError, normalizeApiError, toPublicErrorMessage } from './http/errors.js';
import { verifyInitData } from './telegram.js';
import { isVkLaunchParamsPayload, verifyVkLaunchParams } from './vk.js';
import {
  checkVkMembership,
  fetchVkAdminGroups,
  isVkSubscribeAutoAvailable,
  resolveVkGroupForCreate,
  resolveVkGroupId,
  resolveVkGroupRefFromLink,
  resolveVkUserIdByToken,
  type VkMembershipResult,
} from './vk-api.js';
import {
  ensureBotIsAdmin,
  exportChatInviteLink,
  extractUsername,
  getBotInfo,
  getChatMemberStatus,
  isActiveMemberStatus,
  isAdminMemberStatus,
  sendMessage,
} from './telegram-bot.js';
import { handleBotWebhookUpdate, type TelegramUpdate } from './telegram-webhook.js';

const authBodySchema = z.object({
  initData: z.string().min(1).transform((value) => value.trim()),
  linkCode: z
    .string()
    .max(32)
    .optional()
    .transform((value) => (value && value.trim() ? value.trim().toUpperCase() : undefined)),
});

const platformSwitchSchema = z.object({
  targetPlatform: z.enum(['TELEGRAM', 'VK']),
});

const groupCreateSchema = z.object({
  title: z
    .string()
    .max(80)
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  username: z.string().max(64).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  inviteLink: z
    .string()
    .max(500)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, { message: 'inviteLink is required' }),
  description: z.string().max(500).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  category: z.string().max(50).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
});

const vkGroupsImportSchema = z.object({
  vkUserToken: z.string().max(4096).transform((value) => value.trim()),
});

const campaignCreateSchema = z.object({
  groupId: z.string().min(1),
  actionType: z.enum(['subscribe', 'reaction']),
  rewardPoints: z.coerce.number().int().min(1).max(10000),
  totalBudget: z.coerce.number().int().min(1).max(1000000),
  targetMessageLink: z.string().min(1).optional(),
});

const campaignQuerySchema = z.object({
  category: z.string().max(50).optional(),
  actionType: z.enum(['subscribe', 'reaction']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const CAMPAIGN_REPORT_REASON_VALUES = [
  'SPAM_SCAM',
  'FAKE_TASK',
  'BROKEN_LINK',
  'PROHIBITED_CONTENT',
  'OTHER',
] as const;
type CampaignReportReason = (typeof CAMPAIGN_REPORT_REASON_VALUES)[number];
const campaignReportSchema = z.object({
  reason: z.enum(CAMPAIGN_REPORT_REASON_VALUES),
});

const adminPanelQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d']).optional(),
});

const adminModerationActionSchema = z
  .object({
    deleteCampaign: z.boolean().optional(),
    finePoints: z.coerce.number().int().min(1).max(1_000_000).optional(),
    fineReason: z
      .string()
      .max(200)
      .optional()
      .transform((value) => (value && value.trim() ? value.trim() : undefined)),
    blockMode: z.enum(['none', 'temporary', 'permanent']).optional().default('none'),
    blockDays: z.coerce.number().int().min(1).max(3650).optional(),
    blockReason: z
      .string()
      .max(200)
      .optional()
      .transform((value) => (value && value.trim() ? value.trim() : undefined)),
  })
  .superRefine((value, context) => {
    const hasAction =
      Boolean(value.deleteCampaign) || typeof value.finePoints === 'number' || value.blockMode !== 'none';
    if (!hasAction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one moderation action is required',
      });
    }
    if (value.blockMode === 'temporary' && typeof value.blockDays !== 'number') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockDays'],
        message: 'blockDays is required for temporary block',
      });
    }
    if (value.blockMode !== 'temporary' && typeof value.blockDays === 'number') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockDays'],
        message: 'blockDays is only allowed for temporary block',
      });
    }
  });

const REFERRAL_MILESTONES = [
  {
    milestone: 'JOIN',
    orders: 0,
    referrer: 10,
    referred: 10,
    reasonReferrer: 'Реферальный бонус: вход друга',
    reasonReferred: 'Бонус за вход по приглашению',
  },
  {
    milestone: 'ORDERS_5',
    orders: 5,
    referrer: 30,
    referred: 30,
    reasonReferrer: 'Реферальный бонус: 5 заказов',
    reasonReferred: 'Бонус за 5 заказов',
  },
  {
    milestone: 'ORDERS_15',
    orders: 15,
    referrer: 60,
    referred: 0,
    reasonReferrer: 'Реферальный бонус: 15 заказов',
    reasonReferred: '',
  },
  {
    milestone: 'ORDERS_30',
    orders: 30,
    referrer: 100,
    referred: 0,
    reasonReferrer: 'Реферальный бонус: 30 заказов',
    reasonReferred: '',
  },
] as const;

const REFERRAL_JOIN_MILESTONE = REFERRAL_MILESTONES[0];
const REFERRAL_CODE_BYTES = 5;
const REFERRAL_CODE_ATTEMPTS = 6;
const FIRST_LOGIN_WELCOME_BONUS_AMOUNT = 100;
const FIRST_LOGIN_WELCOME_BONUS_LIMIT = 50;
const FIRST_LOGIN_WELCOME_BONUS_REASON = 'system_welcome_bonus_first50';
const FIRST_LOGIN_WELCOME_BONUS_LEGACY_REASON = 'system_welcome_bonus_500_first50';
const FIRST_LOGIN_WELCOME_BONUS_REASON_FILTER = [
  FIRST_LOGIN_WELCOME_BONUS_REASON,
  FIRST_LOGIN_WELCOME_BONUS_LEGACY_REASON,
];
const FIRST_LOGIN_WELCOME_BONUS_LOCK_KEY = 'jr_welcome_bonus_500_first50';
const FIRST_LOGIN_WELCOME_BONUS_LOCK_TIMEOUT_SEC = 10;
const BOT_PANEL_ALLOWED_COMMANDS = new Set(['/admin', '/stats', '/panel']);
const BOT_PANEL_ALLOWED_TEXTS = new Set(['админ', 'админка', 'панель', 'статистика']);
const BOT_PANEL_DEFAULT_ADMIN_USERNAMES = ['@Nitchim'];
const ADMIN_PERIOD_DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_STALE_PENDING_MS = 24 * 60 * 60 * 1000;
const ADMIN_STALE_PENDING_HOURS = Math.round(ADMIN_STALE_PENDING_MS / (60 * 60 * 1000));
const ADMIN_LOW_BUDGET_MULTIPLIER = 3;
const ADMIN_REPORT_ALERT_THRESHOLD = 6;
const CAMPAIGN_REPORT_REASON_LABELS: Record<CampaignReportReason, string> = {
  SPAM_SCAM: 'Спам или скам',
  FAKE_TASK: 'Фейковое/обманчивое задание',
  BROKEN_LINK: 'Ссылка не работает',
  PROHIBITED_CONTENT: 'Запрещенный контент',
  OTHER: 'Другое',
};
let botPanelSeedPromise: Promise<void> | null = null;
let botPanelStoragePromise: Promise<void> | null = null;
type AdminPanelPeriodPreset = 'today' | '7d' | '30d';
type AdminPanelTrendDirection = 'up' | 'down' | 'flat';
type AdminPanelTrend = {
  current: number;
  previous: number;
  delta: number;
  deltaPct: number | null;
  direction: AdminPanelTrendDirection;
};
type AdminPanelAlert = {
  level: 'info' | 'warning' | 'critical';
  message: string;
};
type AdminPanelStats = {
  period: {
    preset: AdminPanelPeriodPreset;
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    updatedAt: string;
  };
  overview: {
    newUsers: number;
    totalUsers: number;
    activeUsers: number;
    activeCampaigns: number;
    pendingApplications: number;
    reviewedApplications: number;
    approvedApplications: number;
    rejectedApplications: number;
    approvalRate: number;
    pointsIssued: number;
    pointsSpent: number;
    pointsNet: number;
    welcomeBonusAmount: number;
    welcomeBonusGranted: number;
    welcomeBonusLimit: number;
    welcomeBonusRemaining: number;
  };
  trends: {
    newUsers: AdminPanelTrend;
    pointsIssued: AdminPanelTrend;
    reviewedApplications: AdminPanelTrend;
  };
  campaigns: {
    createdInPeriod: number;
    activeCount: number;
    pausedCount: number;
    completedCount: number;
    lowBudgetCount: number;
    topCampaigns: Array<{
      id: string;
      groupTitle: string;
      ownerLabel: string;
      actionType: 'SUBSCRIBE' | 'REACTION';
      status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
      spentBudget: number;
      totalBudget: number;
      remainingBudget: number;
      rewardPoints: number;
      approvalRate: number;
    }>;
  };
  applications: {
    pendingCount: number;
    stalePendingCount: number;
    reviewedInPeriod: number;
    avgReviewMinutes: number;
    recentPending: Array<{
      id: string;
      createdAt: string;
      applicantLabel: string;
      campaignId: string;
      campaignLabel: string;
      ownerLabel: string;
    }>;
    recentReviewed: Array<{
      id: string;
      status: 'APPROVED' | 'REJECTED';
      createdAt: string;
      reviewedAt: string;
      applicantLabel: string;
      campaignId: string;
      campaignLabel: string;
      ownerLabel: string;
    }>;
  };
  economy: {
    issuedPoints: number;
    spentPoints: number;
    netPoints: number;
    topCredits: Array<{
      id: string;
      amount: number;
      reason: string;
      userLabel: string;
      createdAt: string;
    }>;
    topDebits: Array<{
      id: string;
      amount: number;
      reason: string;
      userLabel: string;
      createdAt: string;
    }>;
  };
  referrals: {
    invitedInPeriod: number;
    rewardsInPeriod: number;
    topReferrers: Array<{
      userId: string;
      userLabel: string;
      rewards: number;
      invited: number;
    }>;
  };
  risks: {
    highRejectOwners: Array<{
      userId: string;
      ownerLabel: string;
      reviewed: number;
      rejected: number;
      rejectRate: number;
    }>;
    suspiciousApplicants: Array<{
      userId: string;
      userLabel: string;
      applications: number;
      approved: number;
      approveRate: number;
    }>;
    reports: {
      totalInPeriod: number;
      byReason: Array<{
        reason: CampaignReportReason;
        reasonLabel: string;
        count: number;
      }>;
      recent: Array<{
        id: string;
        campaignId: string;
        reason: CampaignReportReason;
        reasonLabel: string;
        reporterLabel: string;
        groupTitle: string;
        actionType: 'SUBSCRIBE' | 'REACTION';
        createdAt: string;
      }>;
    };
  };
  alerts: AdminPanelAlert[];
  // legacy fields for backward compatibility
  newUsersToday: number;
  totalUsers: number;
  bonusAmount: number;
  bonusGranted: number;
  bonusLimit: number;
  bonusRemaining: number;
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
};

type DbClient = Prisma.TransactionClient | typeof prisma;
type ReferralMilestone = (typeof REFERRAL_MILESTONES)[number];
type RuntimePlatform = 'TELEGRAM' | 'VK';
type UserBlockPayload = {
  reason: string | null;
  blockedUntil: string | null;
  isPermanent: boolean;
};
type UserBlockResolution = {
  user: User;
  blocked: UserBlockPayload | null;
};
type MiniAppAuthIdentity = {
  platform: RuntimePlatform;
  externalId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  startParam?: string;
};
type UserIdentityRecord = {
  userId: string;
  platform: RuntimePlatform;
  externalId: string;
};
type VerificationMode = 'NONE' | 'VK_SUBSCRIBE_AUTO';
type VerificationState = 'APPROVED' | 'PENDING_RETRY' | 'NOT_MEMBER' | 'UNAVAILABLE';
type VerificationDto = {
  mode: VerificationMode;
  state: VerificationState;
  checkedAt: string;
  nextRetryAt?: string;
  retryAfterSec?: number;
};
type RuntimeCapabilities = {
  vkSubscribeAutoAvailable: boolean;
  vkAdminImportAvailable: boolean;
  vkReactionManual: boolean;
  reason?: string;
};

const PLATFORM_LINK_CODE_PREFIX = 'LINK_';
const PLATFORM_LINK_CODE_BYTES = 6;
const PLATFORM_LINK_CODE_ATTEMPTS = 6;
const TG_LINK_CODE_PREFIX = 'link_';
const TG_IDENTITY_REQUIRED_MESSAGE = 'Эта операция доступна только после подключения Telegram-аккаунта.';
const VK_IDENTITY_REQUIRED_MESSAGE = 'Эта операция доступна только после подключения VK-аккаунта.';
const VK_SUBSCRIBE_AUTO_UNAVAILABLE_REASON =
  'VK SUBSCRIBE и подключение сообществ временно недоступны: на сервере не настроен VK_API_TOKEN.';

const getVkVerifyRetrySec = () => Math.max(1, Math.floor(config.vkVerifyRetrySec || 10));
const getVkVerifyCooldownMs = () => getVkVerifyRetrySec() * 1000;

const getRuntimeCapabilities = (): RuntimeCapabilities => {
  const vkSubscribeAutoAvailable = isVkSubscribeAutoAvailable();
  return {
    vkSubscribeAutoAvailable,
    vkAdminImportAvailable: vkSubscribeAutoAvailable,
    vkReactionManual: true,
    reason: vkSubscribeAutoAvailable ? undefined : VK_SUBSCRIBE_AUTO_UNAVAILABLE_REASON,
  };
};

const getVerificationCheckedAt = (application: {
  reviewedAt?: Date | null;
  lastVerificationAt?: Date | null;
  createdAt: Date;
}) => {
  return application.reviewedAt ?? application.lastVerificationAt ?? application.createdAt;
};

const buildVkSubscribeVerification = (
  application: Pick<Application, 'status' | 'createdAt' | 'reviewedAt' | 'lastVerificationAt'>,
  options?: {
    now?: Date;
    state?: VerificationState;
    forceUnavailable?: boolean;
  }
): VerificationDto => {
  const now = options?.now ?? new Date();
  const checkedAt = getVerificationCheckedAt(application);
  const cooldownMs = getVkVerifyCooldownMs();
  const nextRetryAtRaw = checkedAt.getTime() + cooldownMs;
  const retryMs = Math.max(0, nextRetryAtRaw - now.getTime());

  const defaultState: VerificationState =
    application.status === 'APPROVED'
      ? 'APPROVED'
      : options?.forceUnavailable
        ? 'UNAVAILABLE'
        : 'PENDING_RETRY';
  const state = options?.state ?? defaultState;

  const payload: VerificationDto = {
    mode: 'VK_SUBSCRIBE_AUTO',
    state,
    checkedAt: checkedAt.toISOString(),
  };

  if (state === 'PENDING_RETRY' || state === 'NOT_MEMBER') {
    payload.nextRetryAt = new Date(nextRetryAtRaw).toISOString();
    payload.retryAfterSec = Math.max(0, Math.ceil(retryMs / 1000));
  }

  return payload;
};

const buildApplicationVerification = (
  application: Pick<Application, 'status' | 'createdAt' | 'reviewedAt' | 'lastVerificationAt'>,
  campaign: Pick<Campaign, 'platform' | 'actionType'>,
  options?: { now?: Date }
): VerificationDto | undefined => {
  if (campaign.platform !== 'VK' || campaign.actionType !== 'SUBSCRIBE') {
    return undefined;
  }
  return buildVkSubscribeVerification(application, {
    now: options?.now,
    forceUnavailable: !isVkSubscribeAutoAvailable(),
  });
};

const attachApplicationVerification = <
  T extends Pick<Application, 'status' | 'createdAt' | 'reviewedAt' | 'lastVerificationAt'>
>(
  application: T,
  campaign: Pick<Campaign, 'platform' | 'actionType'>,
  options?: { now?: Date; verification?: VerificationDto }
) => {
  const verification =
    options?.verification ??
    buildApplicationVerification(application, campaign, {
      now: options?.now,
    });
  return {
    ...application,
    verification,
  };
};

const ensureVkSubscribeAutoEnabled = () => {
  if (!isVkSubscribeAutoAvailable()) {
    throw new ApiError('vk_subscribe_auto_unavailable', 409);
  }
};

const ensureVkGroupAddEnabled = () => {
  if (!isVkSubscribeAutoAvailable()) {
    throw new ApiError('vk_group_add_unavailable', 409);
  }
};

const buildVkInviteLinkCandidates = (groupId: number, screenName?: string) => {
  const set = new Set<string>();
  const normalizedId = Math.max(1, Math.floor(groupId));
  set.add(`https://vk.com/public${normalizedId}`);
  set.add(`https://vk.com/club${normalizedId}`);
  set.add(`https://vk.com/event${normalizedId}`);
  if (screenName?.trim()) {
    set.add(`https://vk.com/${screenName.trim().toLowerCase()}`);
  }
  return Array.from(set);
};

const resolveVkSubscribeMembership = async (payload: {
  inviteLink: string;
  externalUserId: string;
}): Promise<{ result: VkMembershipResult; groupId: number | null }> => {
  const ref = resolveVkGroupRefFromLink(payload.inviteLink);
  if (!ref) {
    throw new ApiError('vk_subscribe_link_invalid', 400);
  }
  const groupId = await resolveVkGroupId(ref);
  if (!groupId) {
    return { result: 'UNAVAILABLE', groupId: null };
  }
  const result = await checkVkMembership(groupId, payload.externalUserId);
  return { result, groupId };
};

const getVkRetryStateForApplication = (
  application: Pick<Application, 'lastVerificationAt'>,
  now = new Date()
) => {
  if (!application.lastVerificationAt) {
    return {
      onCooldown: false,
      retryAfterSec: 0,
      nextRetryAt: now,
    };
  }
  const cooldownMs = getVkVerifyCooldownMs();
  const nextRetryAt = new Date(application.lastVerificationAt.getTime() + cooldownMs);
  const retryAfterSec = Math.max(0, Math.ceil((nextRetryAt.getTime() - now.getTime()) / 1000));
  return {
    onCooldown: retryAfterSec > 0,
    retryAfterSec,
    nextRetryAt,
  };
};

const logVkVerifyMetrics = (
  request: FastifyRequest,
  payload: {
    result: VkMembershipResult;
    durationMs: number;
    autoApproved?: boolean;
  }
) => {
  request.log.info(
    {
      metric: 'vk_verify_attempt_total',
      result: payload.result,
      vk_verify_attempt_total: 1,
      vk_verify_duration_ms: payload.durationMs,
      vk_verify_auto_approve_total: payload.autoApproved ? 1 : 0,
      vk_verify_unavailable_total: payload.result === 'UNAVAILABLE' ? 1 : 0,
    },
    'vk verify attempt'
  );
};

const resolveMiniAppAuthIdentity = (authPayload: string): MiniAppAuthIdentity => {
  const rawPayload = authPayload.trim();
  if (!rawPayload) throw new Error('empty auth payload');

  if (isVkLaunchParamsPayload(rawPayload)) {
    const vkData = verifyVkLaunchParams(rawPayload, config.vkAppSecret, config.maxAuthAgeSec);
    const vkUserId = String(vkData.vk_user_id ?? '').trim();
    if (!vkUserId) throw new Error('vk_user_id missing');
    return {
      platform: 'VK',
      externalId: vkUserId,
      startParam: vkData.vk_ref,
    };
  }

  const tgAuth = verifyInitData(rawPayload, config.botToken, config.maxAuthAgeSec);
  const tgUser = tgAuth.user;
  if (!tgUser) throw new Error('no user');

  return {
    platform: 'TELEGRAM',
    externalId: String(tgUser.id),
    username: tgUser.username,
    firstName: tgUser.first_name,
    lastName: tgUser.last_name,
    photoUrl: tgUser.photo_url,
    startParam: tgAuth.start_param,
  };
};

const getLegacyTelegramIdByIdentity = (identity: MiniAppAuthIdentity) =>
  identity.platform === 'VK' ? `vk:${identity.externalId}` : identity.externalId;

const resolveUserLegacyPlatform = (telegramId: string): RuntimePlatform =>
  telegramId.startsWith('vk:') ? 'VK' : 'TELEGRAM';

const normalizePlatformLinkCode = (value: string) => value.trim().toUpperCase();

const isPlatformLinkCode = (value: string) =>
  new RegExp(`^${PLATFORM_LINK_CODE_PREFIX}[A-Z0-9]{8,32}$`).test(value);

const buildPlatformLinkCode = () =>
  `${PLATFORM_LINK_CODE_PREFIX}${crypto.randomBytes(PLATFORM_LINK_CODE_BYTES).toString('hex').toUpperCase()}`;

const createUniquePlatformLinkCode = async (db: DbClient) => {
  for (let attempt = 0; attempt < PLATFORM_LINK_CODE_ATTEMPTS; attempt += 1) {
    const code = buildPlatformLinkCode();
    const exists = await db.platformLinkCode.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!exists) return code;
  }
  throw new Error('platform_link_code_collision');
};

const resolveRequestPlatformFromInitData = (request: FastifyRequest): RuntimePlatform | null => {
  const initData = request.headers['x-init-data'];
  if (typeof initData !== 'string' || !initData.trim()) return null;
  try {
    return resolveMiniAppAuthIdentity(initData).platform;
  } catch {
    return null;
  }
};

const resolveRequestPlatform = (request: FastifyRequest, user?: Pick<User, 'telegramId'>): RuntimePlatform => {
  const byInitData = resolveRequestPlatformFromInitData(request);
  if (byInitData) return byInitData;
  if (user?.telegramId) return resolveUserLegacyPlatform(user.telegramId);
  return 'TELEGRAM';
};

const updateUserFromIdentity = async (db: DbClient, user: User, identity: MiniAppAuthIdentity) => {
  const data: Prisma.UserUpdateInput = {};
  if (identity.username !== undefined) data.username = identity.username;
  if (identity.firstName !== undefined) data.firstName = identity.firstName;
  if (identity.lastName !== undefined) data.lastName = identity.lastName;
  if (identity.photoUrl !== undefined) data.photoUrl = identity.photoUrl;

  if (Object.keys(data).length === 0) return user;
  return await db.user.update({
    where: { id: user.id },
    data,
  });
};

const upsertUserIdentity = async (
  db: DbClient,
  payload: { userId: string; identity: MiniAppAuthIdentity }
) => {
  const { userId, identity } = payload;
  await db.userIdentity.upsert({
    where: {
      userId_platform: {
        userId,
        platform: identity.platform,
      },
    },
    update: {
      externalId: identity.externalId,
      username: identity.username,
      firstName: identity.firstName,
      lastName: identity.lastName,
      photoUrl: identity.photoUrl,
    },
    create: {
      userId,
      platform: identity.platform,
      externalId: identity.externalId,
      username: identity.username,
      firstName: identity.firstName,
      lastName: identity.lastName,
      photoUrl: identity.photoUrl,
    },
  });
};

const loadUserByIdentity = async (db: DbClient, identity: MiniAppAuthIdentity) => {
  const identityRecord = await db.userIdentity.findUnique({
    where: {
      platform_externalId: {
        platform: identity.platform,
        externalId: identity.externalId,
      },
    },
    include: { user: true },
  });
  if (identityRecord) return identityRecord.user;

  const legacyTelegramId = getLegacyTelegramIdByIdentity(identity);
  return await db.user.findUnique({ where: { telegramId: legacyTelegramId } });
};

const ensureIdentityUser = async (
  db: DbClient,
  identity: MiniAppAuthIdentity,
  now = new Date()
): Promise<{ user: User; isFirstAuth: boolean }> => {
  let user = await loadUserByIdentity(db, identity);
  let isFirstAuth = false;

  if (!user) {
    const referralCode = await createUniqueReferralCode(db);
    user = await db.user.create({
      data: {
        telegramId: getLegacyTelegramIdByIdentity(identity),
        username: identity.username,
        firstName: identity.firstName,
        lastName: identity.lastName,
        photoUrl: identity.photoUrl,
        balance: 30,
        totalEarned: 0,
        rating: 0,
        firstAuthAt: now,
        referralCode,
      },
    });
    isFirstAuth = true;
  } else {
    isFirstAuth = !user.firstAuthAt;
    user = await updateUserFromIdentity(db, user, identity);
    if (!user.firstAuthAt) {
      user = await db.user.update({
        where: { id: user.id },
        data: { firstAuthAt: now },
      });
      isFirstAuth = true;
    }
  }

  await upsertUserIdentity(db, { userId: user.id, identity });
  return { user, isFirstAuth };
};

const consumePlatformLinkCode = async (
  db: Prisma.TransactionClient,
  payload: { code: string; targetPlatform: RuntimePlatform; now?: Date }
) => {
  const now = payload.now ?? new Date();
  const code = normalizePlatformLinkCode(payload.code);
  const link = await db.platformLinkCode.findUnique({
    where: { code },
  });
  if (!link || link.targetPlatform !== payload.targetPlatform) {
    throw new Error('platform_link_code_invalid');
  }
  if (link.consumedAt) {
    throw new Error('platform_link_code_already_used');
  }
  if (link.expiresAt.getTime() <= now.getTime()) {
    throw new Error('platform_link_code_expired');
  }

  await db.platformLinkCode.update({
    where: { id: link.id },
    data: { consumedAt: now },
  });

  return link;
};

const dedupeAndMoveByUniqueCampaign = async (
  tx: Prisma.TransactionClient,
  payload: {
    masterUserId: string;
    secondaryUserId: string;
    model: 'hiddenCampaign' | 'campaignReport' | 'application';
    campaignField: 'campaignId';
    userField: 'userId' | 'reporterId' | 'applicantId';
  }
) => {
  if (payload.model === 'hiddenCampaign') {
    const masterCampaigns = await tx.hiddenCampaign.findMany({
      where: { userId: payload.masterUserId },
      select: { campaignId: true },
    });
    if (masterCampaigns.length > 0) {
      await tx.hiddenCampaign.deleteMany({
        where: {
          userId: payload.secondaryUserId,
          campaignId: { in: masterCampaigns.map((item) => item.campaignId) },
        },
      });
    }
    await tx.hiddenCampaign.updateMany({
      where: { userId: payload.secondaryUserId },
      data: { userId: payload.masterUserId },
    });
    return;
  }

  if (payload.model === 'campaignReport') {
    const masterCampaigns = await tx.campaignReport.findMany({
      where: { reporterId: payload.masterUserId },
      select: { campaignId: true },
    });
    if (masterCampaigns.length > 0) {
      await tx.campaignReport.deleteMany({
        where: {
          reporterId: payload.secondaryUserId,
          campaignId: { in: masterCampaigns.map((item) => item.campaignId) },
        },
      });
    }
    await tx.campaignReport.updateMany({
      where: { reporterId: payload.secondaryUserId },
      data: { reporterId: payload.masterUserId },
    });
    return;
  }

  const masterCampaigns = await tx.application.findMany({
    where: { applicantId: payload.masterUserId },
    select: { campaignId: true },
  });
  if (masterCampaigns.length > 0) {
    await tx.application.deleteMany({
      where: {
        applicantId: payload.secondaryUserId,
        campaignId: { in: masterCampaigns.map((item) => item.campaignId) },
      },
    });
  }
  await tx.application.updateMany({
    where: { applicantId: payload.secondaryUserId },
    data: { applicantId: payload.masterUserId },
  });
};

const mergeUsersWithTelegramMaster = async (
  tx: Prisma.TransactionClient,
  payload: { userAId: string; userBId: string }
) => {
  if (payload.userAId === payload.userBId) {
    const sameUser = await tx.user.findUnique({ where: { id: payload.userAId } });
    if (!sameUser) throw new Error('user not found');
    return sameUser;
  }

  const [userA, userB, identities] = await Promise.all([
    tx.user.findUnique({ where: { id: payload.userAId } }),
    tx.user.findUnique({ where: { id: payload.userBId } }),
    tx.userIdentity.findMany({
      where: {
        userId: { in: [payload.userAId, payload.userBId] },
      },
      select: { userId: true, platform: true, externalId: true },
    }),
  ]);
  if (!userA || !userB) throw new Error('user not found');

  const hasTgA = identities.some((item) => item.userId === userA.id && item.platform === 'TELEGRAM');
  const hasTgB = identities.some((item) => item.userId === userB.id && item.platform === 'TELEGRAM');
  const masterUserId = hasTgA && !hasTgB ? userA.id : hasTgB && !hasTgA ? userB.id : userA.id;
  const secondaryUserId = masterUserId === userA.id ? userB.id : userA.id;

  const [masterUser, secondaryUser] = masterUserId === userA.id ? [userA, userB] : [userB, userA];

  const masterGroupAdminIds = await tx.groupAdmin.findMany({
    where: { userId: masterUser.id },
    select: { groupId: true },
  });
  if (masterGroupAdminIds.length > 0) {
    await tx.groupAdmin.deleteMany({
      where: {
        userId: secondaryUser.id,
        groupId: { in: masterGroupAdminIds.map((item) => item.groupId) },
      },
    });
  }
  await tx.groupAdmin.updateMany({
    where: { userId: secondaryUser.id },
    data: { userId: masterUser.id },
  });

  await dedupeAndMoveByUniqueCampaign(tx, {
    masterUserId: masterUser.id,
    secondaryUserId: secondaryUser.id,
    model: 'hiddenCampaign',
    campaignField: 'campaignId',
    userField: 'userId',
  });
  await dedupeAndMoveByUniqueCampaign(tx, {
    masterUserId: masterUser.id,
    secondaryUserId: secondaryUser.id,
    model: 'campaignReport',
    campaignField: 'campaignId',
    userField: 'reporterId',
  });
  await dedupeAndMoveByUniqueCampaign(tx, {
    masterUserId: masterUser.id,
    secondaryUserId: secondaryUser.id,
    model: 'application',
    campaignField: 'campaignId',
    userField: 'applicantId',
  });

  await tx.group.updateMany({
    where: { ownerId: secondaryUser.id },
    data: { ownerId: masterUser.id },
  });
  await tx.campaign.updateMany({
    where: { ownerId: secondaryUser.id },
    data: { ownerId: masterUser.id },
  });
  await tx.ledgerEntry.updateMany({
    where: { userId: secondaryUser.id },
    data: { userId: masterUser.id },
  });
  await tx.referral.updateMany({
    where: { referrerId: secondaryUser.id },
    data: { referrerId: masterUser.id },
  });

  const [masterReferred, secondaryReferred] = await Promise.all([
    tx.referral.findUnique({
      where: { referredUserId: masterUser.id },
      select: { id: true },
    }),
    tx.referral.findUnique({
      where: { referredUserId: secondaryUser.id },
      select: { id: true },
    }),
  ]);

  if (secondaryReferred) {
    if (masterReferred) {
      await tx.referral.delete({ where: { id: secondaryReferred.id } });
    } else {
      await tx.referral.update({
        where: { id: secondaryReferred.id },
        data: { referredUserId: masterUser.id },
      });
    }
  }

  const [masterIdentities, secondaryIdentities] = await Promise.all([
    tx.userIdentity.findMany({ where: { userId: masterUser.id } }),
    tx.userIdentity.findMany({ where: { userId: secondaryUser.id } }),
  ]);
  const masterByPlatform = new Map<RuntimePlatform, UserIdentityRecord>();
  for (const identity of masterIdentities) {
    masterByPlatform.set(identity.platform as RuntimePlatform, {
      userId: identity.userId,
      platform: identity.platform as RuntimePlatform,
      externalId: identity.externalId,
    });
  }
  for (const identity of secondaryIdentities) {
    const existing = masterByPlatform.get(identity.platform as RuntimePlatform);
    if (existing) {
      await tx.userIdentity.delete({ where: { id: identity.id } });
      continue;
    }
    await tx.userIdentity.update({
      where: { id: identity.id },
      data: { userId: masterUser.id },
    });
  }

  let mergedMaster = await tx.user.update({
    where: { id: masterUser.id },
    data: {
      balance: { increment: secondaryUser.balance },
      totalEarned: { increment: secondaryUser.totalEarned },
    },
  });

  const masterTelegramIdentity = await tx.userIdentity.findUnique({
    where: {
      userId_platform: {
        userId: masterUser.id,
        platform: 'TELEGRAM',
      },
    },
    select: { externalId: true },
  });
  if (masterTelegramIdentity && mergedMaster.telegramId !== masterTelegramIdentity.externalId) {
    mergedMaster = await tx.user.update({
      where: { id: masterUser.id },
      data: { telegramId: masterTelegramIdentity.externalId },
    });
  }

  await tx.user.delete({ where: { id: secondaryUser.id } });
  return mergedMaster;
};

const resolveTelegramNumericId = async (db: DbClient, user: User) => {
  const identity = await db.userIdentity.findUnique({
    where: {
      userId_platform: {
        userId: user.id,
        platform: 'TELEGRAM',
      },
    },
    select: { externalId: true },
  });

  const candidate = identity?.externalId ?? (user.telegramId.startsWith('vk:') ? '' : user.telegramId);
  const numeric = Number(candidate);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
};

const resolveVkExternalId = async (db: DbClient, user: User) => {
  const identity = await db.userIdentity.findUnique({
    where: {
      userId_platform: {
        userId: user.id,
        platform: 'VK',
      },
    },
    select: { externalId: true },
  });
  return identity?.externalId?.trim() ?? '';
};

const buildUserBlockPayload = (user: Pick<User, 'blockReason' | 'blockedUntil'>): UserBlockPayload => ({
  reason: user.blockReason ?? null,
  blockedUntil: user.blockedUntil ? user.blockedUntil.toISOString() : null,
  isPermanent: !user.blockedUntil,
});

const clearUserBlock = async (db: DbClient, userId: string) => {
  return await db.user.update({
    where: { id: userId },
    data: {
      isBlocked: false,
      blockedAt: null,
      blockedUntil: null,
      blockReason: null,
    },
  });
};

const resolveUserBlockState = async (
  db: DbClient,
  user: User,
  now = new Date()
): Promise<UserBlockResolution> => {
  if (!user.isBlocked) return { user, blocked: null };

  if (user.blockedUntil && user.blockedUntil.getTime() <= now.getTime()) {
    const unblocked = await clearUserBlock(db, user.id);
    return { user: unblocked, blocked: null };
  }

  return {
    user,
    blocked: buildUserBlockPayload(user),
  };
};

const generateReferralCode = () =>
  crypto.randomBytes(REFERRAL_CODE_BYTES).toString('hex').toUpperCase();

const normalizeReferralCode = (value: string) => value.trim().toUpperCase();
const isValidReferralCode = (value: string) => /^[A-Z0-9]{6,20}$/.test(value);

const createUniqueReferralCode = async (db: DbClient) => {
  for (let attempt = 0; attempt < REFERRAL_CODE_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();
    const existing = await db.user.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }
  throw new Error('referral_code_collision');
};

const ensureReferralCodeForUser = async (
  db: DbClient,
  payload: { userId: string; current?: string | null }
) => {
  const current = payload.current?.trim();
  if (current) return current;
  const code = await createUniqueReferralCode(db);
  const updated = await db.user.update({
    where: { id: payload.userId },
    data: { referralCode: code },
    select: { referralCode: true },
  });
  return updated.referralCode ?? code;
};

const linkReferralByCode = async (
  tx: Prisma.TransactionClient,
  payload: { referredUserId: string; referralCode: string; requireNoFirstAuth?: boolean }
) => {
  const normalized = normalizeReferralCode(payload.referralCode);
  if (!isValidReferralCode(normalized)) return null;

  const referred = await tx.user.findUnique({
    where: { id: payload.referredUserId },
    select: { id: true, firstAuthAt: true },
  });
  if (!referred) return null;
  if (payload.requireNoFirstAuth && referred.firstAuthAt) return null;

  const existing = await tx.referral.findUnique({
    where: { referredUserId: payload.referredUserId },
    select: { id: true },
  });
  if (existing) return null;

  const referrer = await tx.user.findUnique({
    where: { referralCode: normalized },
    select: { id: true },
  });
  if (!referrer || referrer.id === payload.referredUserId) return null;

  const referral = await tx.referral.create({
    data: {
      referrerId: referrer.id,
      referredUserId: payload.referredUserId,
      completedOrders: 0,
    },
  });

  const reward = await awardReferralMilestone(tx, referral, REFERRAL_JOIN_MILESTONE);
  const referredBonus =
    reward.referredGranted && REFERRAL_JOIN_MILESTONE.referred > 0
      ? {
          amount: REFERRAL_JOIN_MILESTONE.referred,
          reason:
            REFERRAL_JOIN_MILESTONE.reasonReferred || REFERRAL_JOIN_MILESTONE.reasonReferrer,
        }
      : null;

  return { referral, referredBonus };
};

const grantReferralReward = async (
  tx: Prisma.TransactionClient,
  payload: {
    referralId: string;
    userId: string;
    side: 'REFERRER' | 'REFERRED';
    milestone: 'JOIN' | 'ORDERS_5' | 'ORDERS_15' | 'ORDERS_30';
    amount: number;
    reason: string;
  }
) => {
  if (payload.amount <= 0) return false;
  const existing = await tx.referralReward.findUnique({
    where: {
      referralId_side_milestone: {
        referralId: payload.referralId,
        side: payload.side,
        milestone: payload.milestone,
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  await tx.referralReward.create({
    data: {
      referralId: payload.referralId,
      side: payload.side,
      milestone: payload.milestone,
      amount: payload.amount,
    },
  });

  await tx.user.update({
    where: { id: payload.userId },
    data: {
      balance: { increment: payload.amount },
      totalEarned: { increment: payload.amount },
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: payload.userId,
      type: 'EARN',
      amount: payload.amount,
      reason: payload.reason,
    },
  });

  return true;
};

const awardReferralMilestone = async (
  tx: Prisma.TransactionClient,
  referral: { id: string; referrerId: string; referredUserId: string },
  milestone: ReferralMilestone
) => {
  const referrerGranted = await grantReferralReward(tx, {
    referralId: referral.id,
    userId: referral.referrerId,
    side: 'REFERRER',
    milestone: milestone.milestone,
    amount: milestone.referrer,
    reason: milestone.reasonReferrer,
  });
  let referredGranted = false;
  if (milestone.referred > 0) {
    referredGranted = await grantReferralReward(tx, {
      referralId: referral.id,
      userId: referral.referredUserId,
      side: 'REFERRED',
      milestone: milestone.milestone,
      amount: milestone.referred,
      reason: milestone.reasonReferred || milestone.reasonReferrer,
    });
  }
  return { referrerGranted, referredGranted };
};

const acquireNamedDbLock = async (
  tx: Prisma.TransactionClient,
  key: string,
  timeoutSec: number
) => {
  const safeTimeout = Math.max(0, Math.floor(timeoutSec));
  const rows = await tx.$queryRaw<Array<{ acquired: number | bigint | null }>>`
    SELECT GET_LOCK(${key}, ${safeTimeout}) AS acquired
  `;
  return Number(rows[0]?.acquired ?? 0) === 1;
};

const releaseNamedDbLock = async (tx: Prisma.TransactionClient, key: string) => {
  try {
    await tx.$queryRaw`SELECT RELEASE_LOCK(${key})`;
  } catch {
    // ignore lock release errors
  }
};

const grantFirstLoginWelcomeBonusIfEligible = async (tx: Prisma.TransactionClient, user: User) => {
  const lockAcquired = await acquireNamedDbLock(
    tx,
    FIRST_LOGIN_WELCOME_BONUS_LOCK_KEY,
    FIRST_LOGIN_WELCOME_BONUS_LOCK_TIMEOUT_SEC
  );
  if (!lockAcquired) return user;

  try {
    const alreadyGranted = await tx.ledgerEntry.findFirst({
      where: {
        userId: user.id,
        reason: { in: FIRST_LOGIN_WELCOME_BONUS_REASON_FILTER },
      },
      select: { id: true },
    });
    if (alreadyGranted) return user;

    const grantedCount = await tx.ledgerEntry.count({
      where: { reason: { in: FIRST_LOGIN_WELCOME_BONUS_REASON_FILTER } },
    });
    if (grantedCount >= FIRST_LOGIN_WELCOME_BONUS_LIMIT) return user;

    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        balance: { increment: FIRST_LOGIN_WELCOME_BONUS_AMOUNT },
      },
    });

    await tx.ledgerEntry.create({
      data: {
        userId: user.id,
        type: 'REFUND',
        amount: FIRST_LOGIN_WELCOME_BONUS_AMOUNT,
        reason: FIRST_LOGIN_WELCOME_BONUS_REASON,
      },
    });

    return updated;
  } finally {
    await releaseNamedDbLock(tx, FIRST_LOGIN_WELCOME_BONUS_LOCK_KEY);
  }
};

const normalizeBotPanelUsername = (value: string | null | undefined) => {
  return value?.trim().replace(/^@+/, '').toLowerCase() ?? '';
};

const ensureBotPanelAccessStorage = async () => {
  if (botPanelStoragePromise) return await botPanelStoragePromise;

  botPanelStoragePromise = prisma
    .$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS BotPanelAccess (
        id VARCHAR(191) NOT NULL,
        telegramId VARCHAR(191) NULL,
        username VARCHAR(191) NULL,
        isEnabled BOOLEAN NOT NULL DEFAULT true,
        createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE INDEX BotPanelAccess_telegramId_key (telegramId),
        UNIQUE INDEX BotPanelAccess_username_key (username),
        INDEX BotPanelAccess_isEnabled_createdAt_idx (isEnabled, createdAt),
        PRIMARY KEY (id)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `)
    .then(() => undefined)
    .catch((error) => {
      botPanelStoragePromise = null;
      throw error;
    });

  return await botPanelStoragePromise;
};

const ensureDefaultBotPanelAccess = async () => {
  await ensureBotPanelAccessStorage();
  if (botPanelSeedPromise) return await botPanelSeedPromise;

  botPanelSeedPromise = (async () => {
    for (const rawUsername of BOT_PANEL_DEFAULT_ADMIN_USERNAMES) {
      const username = normalizeBotPanelUsername(rawUsername);
      if (!username) continue;
      await prisma.botPanelAccess.upsert({
        where: { username },
        update: { isEnabled: true },
        create: {
          username,
          isEnabled: true,
        },
      });
    }
  })().catch((error) => {
    botPanelSeedPromise = null;
    throw error;
  });

  return await botPanelSeedPromise;
};

const hasBotPanelAccess = async (payload: { telegramId: number | string; username?: string }) => {
  await ensureBotPanelAccessStorage();
  const telegramId = String(payload.telegramId ?? '').trim();
  const rawUsername = payload.username?.trim() ?? '';
  const username = normalizeBotPanelUsername(payload.username);
  const usernameVariants = new Set<string>();
  if (rawUsername) {
    usernameVariants.add(rawUsername);
    usernameVariants.add(rawUsername.toLowerCase());
    usernameVariants.add(rawUsername.startsWith('@') ? rawUsername.slice(1) : rawUsername);
    usernameVariants.add(
      rawUsername.startsWith('@') ? rawUsername.slice(1).toLowerCase() : rawUsername.toLowerCase()
    );
  }
  if (username) {
    usernameVariants.add(username);
    usernameVariants.add(`@${username}`);
  }
  const filters: Prisma.BotPanelAccessWhereInput[] = [];
  if (telegramId) {
    filters.push({ telegramId });
  }
  for (const candidate of usernameVariants) {
    filters.push({ username: candidate });
  }
  if (filters.length === 0) return false;

  const access = await prisma.botPanelAccess.findFirst({
    where: {
      isEnabled: true,
      OR: filters,
    },
    select: { id: true },
  });

  return Boolean(access);
};

const getStartOfDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
};

const addDays = (value: Date, days: number) =>
  new Date(value.getTime() + days * ADMIN_PERIOD_DAY_MS);

const getAdminPeriodRange = (preset: AdminPanelPeriodPreset, now = new Date()) => {
  const todayStart = getStartOfDay(now);
  const todayEnd = addDays(todayStart, 1);
  const days = preset === 'today' ? 1 : preset === '7d' ? 7 : 30;
  const from = addDays(todayEnd, -days);
  const to = todayEnd;
  const previousTo = from;
  const previousFrom = addDays(previousTo, -days);
  return { preset, from, to, previousFrom, previousTo };
};

const toPositiveInt = (value: number | null | undefined) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value ?? 0));
};

const toRatioPercent = (value: number, total: number) => {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Number(((value / total) * 100).toFixed(1));
};

const toAdminTrend = (current: number, previous: number): AdminPanelTrend => {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safePrevious = Number.isFinite(previous) ? previous : 0;
  const delta = safeCurrent - safePrevious;
  const deltaPct =
    safePrevious === 0 ? (safeCurrent === 0 ? 0 : null) : Number(((delta / safePrevious) * 100).toFixed(1));
  const direction: AdminPanelTrendDirection =
    delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  return {
    current: safeCurrent,
    previous: safePrevious,
    delta,
    deltaPct,
    direction,
  };
};

const getPersonLabel = (payload?: {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) => {
  const username = payload?.username?.trim();
  if (username) return `@${username.replace(/^@+/, '')}`;
  const fullName = [payload?.firstName?.trim(), payload?.lastName?.trim()]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (fullName) return fullName;
  return 'Без имени';
};

const getCampaignReportReasonLabel = (reason: CampaignReportReason) =>
  CAMPAIGN_REPORT_REASON_LABELS[reason] ?? CAMPAIGN_REPORT_REASON_LABELS.OTHER;

const getAdminPanelStats = async (options?: {
  now?: Date;
  periodPreset?: AdminPanelPeriodPreset;
}): Promise<AdminPanelStats> => {
  const now = options?.now ?? new Date();
  const periodPreset = options?.periodPreset ?? 'today';
  const period = getAdminPeriodRange(periodPreset, now);
  const stalePendingThreshold = new Date(now.getTime() - ADMIN_STALE_PENDING_MS);

  const [
    newUsers,
    previousNewUsers,
    totalUsers,
    activeCampaigns,
    pausedCampaigns,
    completedCampaigns,
    createdCampaignsInPeriod,
    pendingApplications,
    stalePendingCount,
    reviewedInPeriod,
    reviewedInPrevious,
    approvedInPeriod,
    rejectedInPeriod,
    welcomeBonusGranted,
    periodIssuedAggregate,
    periodSpentAggregate,
    previousIssuedAggregate,
    invitedInPeriod,
    referralRewardsAggregate,
    activeUserLedgerRows,
    activeUserApplicationRows,
    activeUserCampaignRows,
    activeCampaignBudgetRows,
    topCampaignPool,
    recentPendingRows,
    recentReviewedRows,
    reviewedForAverageRows,
    topCreditRows,
    topDebitRows,
    topReferrerRewardRows,
    reviewedOwnerRows,
    applicantWindowRows,
    reportCountInPeriod,
    reportByReasonRows,
    recentReportRows,
  ] = await Promise.all([
    prisma.user.count({
      where: {
        createdAt: {
          gte: period.from,
          lt: period.to,
        },
      },
    }),
    prisma.user.count({
      where: {
        createdAt: {
          gte: period.previousFrom,
          lt: period.previousTo,
        },
      },
    }),
    prisma.user.count(),
    prisma.campaign.count({ where: { status: 'ACTIVE' } }),
    prisma.campaign.count({ where: { status: 'PAUSED' } }),
    prisma.campaign.count({ where: { status: 'COMPLETED' } }),
    prisma.campaign.count({
      where: {
        createdAt: {
          gte: period.from,
          lt: period.to,
        },
      },
    }),
    prisma.application.count({ where: { status: 'PENDING' } }),
    prisma.application.count({
      where: {
        status: 'PENDING',
        createdAt: { lt: stalePendingThreshold },
      },
    }),
    prisma.application.count({
      where: {
        status: { in: ['APPROVED', 'REJECTED'] },
        reviewedAt: { gte: period.from, lt: period.to },
      },
    }),
    prisma.application.count({
      where: {
        status: { in: ['APPROVED', 'REJECTED'] },
        reviewedAt: { gte: period.previousFrom, lt: period.previousTo },
      },
    }),
    prisma.application.count({
      where: {
        status: 'APPROVED',
        reviewedAt: { gte: period.from, lt: period.to },
      },
    }),
    prisma.application.count({
      where: {
        status: 'REJECTED',
        reviewedAt: { gte: period.from, lt: period.to },
      },
    }),
    prisma.ledgerEntry.count({
      where: { reason: { in: FIRST_LOGIN_WELCOME_BONUS_REASON_FILTER } },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        createdAt: { gte: period.from, lt: period.to },
        amount: { gt: 0 },
      },
      _sum: { amount: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        createdAt: { gte: period.from, lt: period.to },
        amount: { lt: 0 },
      },
      _sum: { amount: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        createdAt: { gte: period.previousFrom, lt: period.previousTo },
        amount: { gt: 0 },
      },
      _sum: { amount: true },
    }),
    prisma.referral.count({
      where: {
        createdAt: { gte: period.from, lt: period.to },
      },
    }),
    prisma.referralReward.aggregate({
      where: {
        rewardedAt: { gte: period.from, lt: period.to },
      },
      _sum: { amount: true },
    }),
    prisma.ledgerEntry.findMany({
      where: { createdAt: { gte: period.from, lt: period.to } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.application.findMany({
      where: { createdAt: { gte: period.from, lt: period.to } },
      select: { applicantId: true },
      distinct: ['applicantId'],
    }),
    prisma.campaign.findMany({
      where: { createdAt: { gte: period.from, lt: period.to } },
      select: { ownerId: true },
      distinct: ['ownerId'],
    }),
    prisma.campaign.findMany({
      where: { status: 'ACTIVE' },
      select: { remainingBudget: true, rewardPoints: true },
    }),
    prisma.campaign.findMany({
      where: {
        OR: [{ createdAt: { gte: period.from, lt: period.to } }, { status: 'ACTIVE' }],
      },
      orderBy: { createdAt: 'desc' },
      take: 180,
      select: {
        id: true,
        actionType: true,
        status: true,
        rewardPoints: true,
        totalBudget: true,
        remainingBudget: true,
        group: { select: { title: true } },
        owner: { select: { username: true, firstName: true, lastName: true } },
      },
    }),
    prisma.application.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 8,
      select: {
        id: true,
        createdAt: true,
        applicant: { select: { username: true, firstName: true, lastName: true } },
        campaign: {
          select: {
            id: true,
            group: { select: { title: true } },
            owner: { select: { username: true, firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.application.findMany({
      where: {
        status: { in: ['APPROVED', 'REJECTED'] },
        reviewedAt: { gte: period.from, lt: period.to },
      },
      orderBy: { reviewedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        status: true,
        createdAt: true,
        reviewedAt: true,
        applicant: { select: { username: true, firstName: true, lastName: true } },
        campaign: {
          select: {
            id: true,
            group: { select: { title: true } },
            owner: { select: { username: true, firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.application.findMany({
      where: {
        status: { in: ['APPROVED', 'REJECTED'] },
        reviewedAt: { gte: period.from, lt: period.to },
      },
      orderBy: { reviewedAt: 'desc' },
      take: 120,
      select: { createdAt: true, reviewedAt: true },
    }),
    prisma.ledgerEntry.findMany({
      where: {
        createdAt: { gte: period.from, lt: period.to },
        amount: { gt: 0 },
      },
      orderBy: [{ amount: 'desc' }, { createdAt: 'desc' }],
      take: 5,
      select: {
        id: true,
        amount: true,
        reason: true,
        createdAt: true,
        user: { select: { username: true, firstName: true, lastName: true } },
      },
    }),
    prisma.ledgerEntry.findMany({
      where: {
        createdAt: { gte: period.from, lt: period.to },
        amount: { lt: 0 },
      },
      orderBy: [{ amount: 'asc' }, { createdAt: 'desc' }],
      take: 5,
      select: {
        id: true,
        amount: true,
        reason: true,
        createdAt: true,
        user: { select: { username: true, firstName: true, lastName: true } },
      },
    }),
    prisma.referralReward.groupBy({
      by: ['referralId'],
      where: {
        side: 'REFERRER',
        rewardedAt: { gte: period.from, lt: period.to },
      },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 12,
    }),
    prisma.application.findMany({
      where: {
        status: { in: ['APPROVED', 'REJECTED'] },
        reviewedAt: { gte: period.from, lt: period.to },
      },
      select: {
        status: true,
        campaign: {
          select: {
            ownerId: true,
            owner: { select: { username: true, firstName: true, lastName: true } },
          },
        },
      },
      take: 4000,
      orderBy: { reviewedAt: 'desc' },
    }),
    prisma.application.findMany({
      where: {
        createdAt: { gte: period.from, lt: period.to },
      },
      select: {
        applicantId: true,
        status: true,
        applicant: { select: { username: true, firstName: true, lastName: true } },
      },
      take: 5000,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.campaignReport.count({
      where: {
        reportedAt: { gte: period.from, lt: period.to },
      },
    }),
    prisma.campaignReport.groupBy({
      by: ['reason'],
      where: {
        reportedAt: { gte: period.from, lt: period.to },
      },
      _count: { _all: true },
    }),
    prisma.campaignReport.findMany({
      where: {
        reportedAt: { gte: period.from, lt: period.to },
      },
      orderBy: { reportedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        campaignId: true,
        reason: true,
        reportedAt: true,
        reporter: { select: { username: true, firstName: true, lastName: true } },
        campaign: {
          select: {
            actionType: true,
            group: { select: { title: true } },
          },
        },
      },
    }),
  ]);

  const activeUserIds = new Set<string>();
  for (const item of activeUserLedgerRows) activeUserIds.add(item.userId);
  for (const item of activeUserApplicationRows) activeUserIds.add(item.applicantId);
  for (const item of activeUserCampaignRows) activeUserIds.add(item.ownerId);
  const activeUsers = activeUserIds.size;

  const issuedPoints = toPositiveInt(periodIssuedAggregate._sum.amount);
  const spentPoints = Math.abs(periodSpentAggregate._sum.amount ?? 0);
  const previousIssuedPoints = toPositiveInt(previousIssuedAggregate._sum.amount);
  const netPoints = issuedPoints - spentPoints;
  const reviewedApplications = approvedInPeriod + rejectedInPeriod;
  const approvalRate = toRatioPercent(approvedInPeriod, reviewedApplications);
  const bonusRemaining = Math.max(0, FIRST_LOGIN_WELCOME_BONUS_LIMIT - welcomeBonusGranted);

  const lowBudgetCount = activeCampaignBudgetRows.reduce((count, campaign) => {
    if (campaign.remainingBudget <= campaign.rewardPoints * ADMIN_LOW_BUDGET_MULTIPLIER) {
      return count + 1;
    }
    return count;
  }, 0);

  const sortedTopCampaignPool = topCampaignPool
    .map((campaign) => ({
      ...campaign,
      spentBudget: Math.max(0, campaign.totalBudget - campaign.remainingBudget),
    }))
    .sort((a, b) => {
      if (b.spentBudget !== a.spentBudget) return b.spentBudget - a.spentBudget;
      return b.totalBudget - a.totalBudget;
    })
    .slice(0, 5);

  const topCampaignIds = sortedTopCampaignPool.map((campaign) => campaign.id);
  const topCampaignApplicationRows =
    topCampaignIds.length > 0
      ? await prisma.application.groupBy({
          by: ['campaignId', 'status'],
          where: {
            campaignId: { in: topCampaignIds },
          },
          _count: { _all: true },
        })
      : [];

  const topCampaignReviewStats = new Map<
    string,
    {
      approved: number;
      rejected: number;
    }
  >();
  for (const row of topCampaignApplicationRows) {
    const current = topCampaignReviewStats.get(row.campaignId) ?? { approved: 0, rejected: 0 };
    if (row.status === 'APPROVED') {
      current.approved += row._count._all;
    }
    if (row.status === 'REJECTED') {
      current.rejected += row._count._all;
    }
    topCampaignReviewStats.set(row.campaignId, current);
  }

  const topCampaigns = sortedTopCampaignPool.map((campaign) => {
    const reviewStats = topCampaignReviewStats.get(campaign.id) ?? { approved: 0, rejected: 0 };
    const reviewTotal = reviewStats.approved + reviewStats.rejected;
    return {
      id: campaign.id,
      groupTitle: campaign.group.title,
      ownerLabel: getPersonLabel(campaign.owner),
      actionType: campaign.actionType,
      status: campaign.status,
      spentBudget: campaign.spentBudget,
      totalBudget: campaign.totalBudget,
      remainingBudget: campaign.remainingBudget,
      rewardPoints: campaign.rewardPoints,
      approvalRate: toRatioPercent(reviewStats.approved, reviewTotal),
    };
  });

  const recentPending = recentPendingRows.map((item) => ({
    id: item.id,
    createdAt: item.createdAt.toISOString(),
    applicantLabel: getPersonLabel(item.applicant),
    campaignId: item.campaign.id,
    campaignLabel: item.campaign.group.title,
    ownerLabel: getPersonLabel(item.campaign.owner),
  }));

  const recentReviewed = recentReviewedRows
    .filter((item) => item.reviewedAt && (item.status === 'APPROVED' || item.status === 'REJECTED'))
    .map((item) => {
      const status: 'APPROVED' | 'REJECTED' =
        item.status === 'APPROVED' ? 'APPROVED' : 'REJECTED';
      return {
        id: item.id,
        status,
        createdAt: item.createdAt.toISOString(),
        reviewedAt: (item.reviewedAt as Date).toISOString(),
        applicantLabel: getPersonLabel(item.applicant),
        campaignId: item.campaign.id,
        campaignLabel: item.campaign.group.title,
        ownerLabel: getPersonLabel(item.campaign.owner),
      };
    });

  const reviewedDurations = reviewedForAverageRows
    .map((item) => {
      if (!item.reviewedAt) return null;
      return Math.max(0, item.reviewedAt.getTime() - item.createdAt.getTime());
    })
    .filter((value): value is number => typeof value === 'number');
  const avgReviewMinutes =
    reviewedDurations.length > 0
      ? Math.round(
          reviewedDurations.reduce((sum, value) => sum + value, 0) /
            reviewedDurations.length /
            60000
        )
      : 0;

  const topCredits = topCreditRows.map((item) => ({
    id: item.id,
    amount: Math.max(0, item.amount),
    reason: item.reason,
    userLabel: getPersonLabel(item.user),
    createdAt: item.createdAt.toISOString(),
  }));

  const topDebits = topDebitRows.map((item) => ({
    id: item.id,
    amount: Math.abs(item.amount),
    reason: item.reason,
    userLabel: getPersonLabel(item.user),
    createdAt: item.createdAt.toISOString(),
  }));

  const topReferralIds = topReferrerRewardRows.map((item) => item.referralId);
  const topReferralRows =
    topReferralIds.length > 0
      ? await prisma.referral.findMany({
          where: { id: { in: topReferralIds } },
          select: {
            id: true,
            referrerId: true,
            referrer: { select: { id: true, username: true, firstName: true, lastName: true } },
          },
        })
      : [];

  const topReferrerIds = Array.from(new Set(topReferralRows.map((item) => item.referrerId)));
  const invitedByTopReferrerRows =
    topReferrerIds.length > 0
      ? await prisma.referral.groupBy({
          by: ['referrerId'],
          where: {
            referrerId: { in: topReferrerIds },
            createdAt: { gte: period.from, lt: period.to },
          },
          _count: { _all: true },
        })
      : [];

  const invitedByReferrerMap = new Map<string, number>();
  for (const row of invitedByTopReferrerRows) {
    invitedByReferrerMap.set(row.referrerId, row._count._all);
  }

  const topReferralRowById = new Map(topReferralRows.map((item) => [item.id, item]));
  const topReferrers = topReferrerRewardRows
    .map((row) => {
      const referral = topReferralRowById.get(row.referralId);
      if (!referral) return null;
      const rewards = Math.max(0, row._sum.amount ?? 0);
      return {
        userId: referral.referrer.id,
        userLabel: getPersonLabel(referral.referrer),
        rewards,
        invited: invitedByReferrerMap.get(referral.referrer.id) ?? 0,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 5);

  const ownerRiskMap = new Map<
    string,
    { ownerLabel: string; reviewed: number; rejected: number }
  >();
  for (const item of reviewedOwnerRows) {
    const ownerId = item.campaign.ownerId;
    const stat = ownerRiskMap.get(ownerId) ?? {
      ownerLabel: getPersonLabel(item.campaign.owner),
      reviewed: 0,
      rejected: 0,
    };
    stat.reviewed += 1;
    if (item.status === 'REJECTED') {
      stat.rejected += 1;
    }
    ownerRiskMap.set(ownerId, stat);
  }
  const highRejectOwners = Array.from(ownerRiskMap.entries())
    .map(([userId, stat]) => ({
      userId,
      ownerLabel: stat.ownerLabel,
      reviewed: stat.reviewed,
      rejected: stat.rejected,
      rejectRate: toRatioPercent(stat.rejected, stat.reviewed),
    }))
    .filter((item) => item.reviewed >= 8 && item.rejectRate >= 45)
    .sort((a, b) => {
      if (b.rejectRate !== a.rejectRate) return b.rejectRate - a.rejectRate;
      return b.reviewed - a.reviewed;
    })
    .slice(0, 5);

  const applicantRiskMap = new Map<
    string,
    { userLabel: string; applications: number; approved: number }
  >();
  for (const item of applicantWindowRows) {
    const stat = applicantRiskMap.get(item.applicantId) ?? {
      userLabel: getPersonLabel(item.applicant),
      applications: 0,
      approved: 0,
    };
    stat.applications += 1;
    if (item.status === 'APPROVED') stat.approved += 1;
    applicantRiskMap.set(item.applicantId, stat);
  }
  const suspiciousApplicants = Array.from(applicantRiskMap.entries())
    .map(([userId, stat]) => ({
      userId,
      userLabel: stat.userLabel,
      applications: stat.applications,
      approved: stat.approved,
      approveRate: toRatioPercent(stat.approved, stat.applications),
    }))
    .filter((item) => item.applications >= 6 && item.approveRate <= 25)
    .sort((a, b) => {
      if (b.applications !== a.applications) return b.applications - a.applications;
      return a.approveRate - b.approveRate;
    })
    .slice(0, 5);

  const reportByReasonMap = new Map<CampaignReportReason, number>();
  for (const row of reportByReasonRows) {
    const reason = row.reason as CampaignReportReason;
    reportByReasonMap.set(reason, row._count._all);
  }
  const reportByReason = CAMPAIGN_REPORT_REASON_VALUES.map((reason) => ({
    reason,
    reasonLabel: getCampaignReportReasonLabel(reason),
    count: reportByReasonMap.get(reason) ?? 0,
  })).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.reasonLabel.localeCompare(b.reasonLabel, 'ru');
  });
  const recentReports = recentReportRows.map((item) => ({
    id: item.id,
    campaignId: item.campaignId,
    reason: item.reason as CampaignReportReason,
    reasonLabel: getCampaignReportReasonLabel(item.reason as CampaignReportReason),
    reporterLabel: getPersonLabel(item.reporter),
    groupTitle: item.campaign.group.title,
    actionType: item.campaign.actionType,
    createdAt: item.reportedAt.toISOString(),
  }));

  const alerts: AdminPanelAlert[] = [];
  if (bonusRemaining <= 5) {
    alerts.push({
      level: 'critical',
      message: `Лимит приветственного бонуса почти исчерпан (${bonusRemaining} слотов).`,
    });
  }
  if (stalePendingCount >= 8) {
    alerts.push({
      level: 'warning',
      message: `На проверке зависло ${stalePendingCount} заявок старше 24 часов.`,
    });
  }
  if (reviewedApplications >= 12 && approvalRate < 55) {
    alerts.push({
      level: 'warning',
      message: `Низкий апрув заявок за период: ${approvalRate}%.`,
    });
  }
  if (lowBudgetCount >= 10) {
    alerts.push({
      level: 'info',
      message: `У ${lowBudgetCount} активных кампаний бюджет на исходе.`,
    });
  }
  if (highRejectOwners.length > 0) {
    alerts.push({
      level: 'warning',
      message: `Обнаружены владельцы с повышенным reject rate (${highRejectOwners.length}).`,
    });
  }
  if (reportCountInPeriod >= ADMIN_REPORT_ALERT_THRESHOLD) {
    alerts.push({
      level: 'warning',
      message: `Поступило ${reportCountInPeriod} жалоб по заданиям за период.`,
    });
  }
  if (alerts.length === 0) {
    alerts.push({
      level: 'info',
      message: 'Сервис работает стабильно, критичных отклонений не обнаружено.',
    });
  }

  return {
    period: {
      preset: period.preset,
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      previousFrom: period.previousFrom.toISOString(),
      previousTo: period.previousTo.toISOString(),
      updatedAt: now.toISOString(),
    },
    overview: {
      newUsers,
      totalUsers,
      activeUsers,
      activeCampaigns,
      pendingApplications,
      reviewedApplications,
      approvedApplications: approvedInPeriod,
      rejectedApplications: rejectedInPeriod,
      approvalRate,
      pointsIssued: issuedPoints,
      pointsSpent: spentPoints,
      pointsNet: netPoints,
      welcomeBonusAmount: FIRST_LOGIN_WELCOME_BONUS_AMOUNT,
      welcomeBonusGranted,
      welcomeBonusLimit: FIRST_LOGIN_WELCOME_BONUS_LIMIT,
      welcomeBonusRemaining: bonusRemaining,
    },
    trends: {
      newUsers: toAdminTrend(newUsers, previousNewUsers),
      pointsIssued: toAdminTrend(issuedPoints, previousIssuedPoints),
      reviewedApplications: toAdminTrend(reviewedInPeriod, reviewedInPrevious),
    },
    campaigns: {
      createdInPeriod: createdCampaignsInPeriod,
      activeCount: activeCampaigns,
      pausedCount: pausedCampaigns,
      completedCount: completedCampaigns,
      lowBudgetCount,
      topCampaigns,
    },
    applications: {
      pendingCount: pendingApplications,
      stalePendingCount,
      reviewedInPeriod,
      avgReviewMinutes,
      recentPending,
      recentReviewed,
    },
    economy: {
      issuedPoints,
      spentPoints,
      netPoints,
      topCredits,
      topDebits,
    },
    referrals: {
      invitedInPeriod,
      rewardsInPeriod: toPositiveInt(referralRewardsAggregate._sum.amount),
      topReferrers,
    },
    risks: {
      highRejectOwners,
      suspiciousApplicants,
      reports: {
        totalInPeriod: reportCountInPeriod,
        byReason: reportByReason,
        recent: recentReports,
      },
    },
    alerts,
    // legacy fields
    newUsersToday: newUsers,
    totalUsers,
    bonusAmount: FIRST_LOGIN_WELCOME_BONUS_AMOUNT,
    bonusGranted: welcomeBonusGranted,
    bonusLimit: FIRST_LOGIN_WELCOME_BONUS_LIMIT,
    bonusRemaining,
    periodStart: period.from.toISOString(),
    periodEnd: period.to.toISOString(),
    updatedAt: now.toISOString(),
  };
};

const clearExpiredBlockedUsers = async (db: DbClient, now = new Date()) => {
  await db.user.updateMany({
    where: {
      isBlocked: true,
      blockedUntil: {
        not: null,
        lte: now,
      },
    },
    data: {
      isBlocked: false,
      blockedAt: null,
      blockedUntil: null,
      blockReason: null,
    },
  });
};

const getAdminModerationSnapshot = async (options?: { now?: Date }) => {
  const now = options?.now ?? new Date();
  const staleThreshold = new Date(now.getTime() - ADMIN_STALE_PENDING_MS);
  await clearExpiredBlockedUsers(prisma, now);

  const [reportRows, staleCount, staleOldest, blockedUsersRows] = await Promise.all([
    prisma.campaignReport.findMany({
      orderBy: { reportedAt: 'desc' },
      select: {
        id: true,
        campaignId: true,
        reason: true,
        reportedAt: true,
        reporter: { select: { username: true, firstName: true, lastName: true } },
        campaign: {
          select: {
            id: true,
            actionType: true,
            createdAt: true,
            totalBudget: true,
            remainingBudget: true,
            group: { select: { title: true } },
            owner: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                isBlocked: true,
                blockedUntil: true,
              },
            },
          },
        },
      },
    }),
    prisma.application.count({
      where: {
        status: 'PENDING',
        createdAt: { lt: staleThreshold },
      },
    }),
    prisma.application.findFirst({
      where: {
        status: 'PENDING',
        createdAt: { lt: staleThreshold },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.user.findMany({
      where: { isBlocked: true },
      orderBy: { blockedAt: 'desc' },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        blockedAt: true,
        blockedUntil: true,
        blockReason: true,
      },
      take: 100,
    }),
  ]);

  type ComplaintDraft = {
    campaignId: string;
    reportCount: number;
    lastReportedAt: Date;
    campaign: {
      id: string;
      groupTitle: string;
      actionType: 'SUBSCRIBE' | 'REACTION';
      createdAt: string;
      totalBudget: number;
      remainingBudget: number;
    };
    owner: {
      id: string;
      label: string;
      isBlocked: boolean;
      blockedUntil: string | null;
    };
    sampleReporters: string[];
    reasonCounts: Map<CampaignReportReason, number>;
  };

  const complaintsMap = new Map<string, ComplaintDraft>();
  for (const row of reportRows) {
    const reason = row.reason as CampaignReportReason;
    let complaint = complaintsMap.get(row.campaignId);
    if (!complaint) {
      complaint = {
        campaignId: row.campaignId,
        reportCount: 0,
        lastReportedAt: row.reportedAt,
        campaign: {
          id: row.campaign.id,
          groupTitle: row.campaign.group.title,
          actionType: row.campaign.actionType,
          createdAt: row.campaign.createdAt.toISOString(),
          totalBudget: row.campaign.totalBudget,
          remainingBudget: row.campaign.remainingBudget,
        },
        owner: {
          id: row.campaign.owner.id,
          label: getPersonLabel(row.campaign.owner),
          isBlocked: row.campaign.owner.isBlocked,
          blockedUntil: row.campaign.owner.blockedUntil
            ? row.campaign.owner.blockedUntil.toISOString()
            : null,
        },
        sampleReporters: [],
        reasonCounts: new Map<CampaignReportReason, number>(),
      };
      complaintsMap.set(row.campaignId, complaint);
    }

    complaint.reportCount += 1;
    if (row.reportedAt.getTime() > complaint.lastReportedAt.getTime()) {
      complaint.lastReportedAt = row.reportedAt;
    }
    complaint.reasonCounts.set(reason, (complaint.reasonCounts.get(reason) ?? 0) + 1);

    const reporterLabel = getPersonLabel(row.reporter);
    if (reporterLabel && !complaint.sampleReporters.includes(reporterLabel)) {
      complaint.sampleReporters.push(reporterLabel);
      if (complaint.sampleReporters.length > 3) {
        complaint.sampleReporters = complaint.sampleReporters.slice(0, 3);
      }
    }
  }

  const complaints = Array.from(complaintsMap.values())
    .map((item) => {
      const reasonRank = CAMPAIGN_REPORT_REASON_VALUES.map((reason) => ({
        reason,
        count: item.reasonCounts.get(reason) ?? 0,
      })).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return CAMPAIGN_REPORT_REASON_VALUES.indexOf(a.reason) - CAMPAIGN_REPORT_REASON_VALUES.indexOf(b.reason);
      });
      const topReason = reasonRank[0]?.reason ?? 'OTHER';
      return {
        campaignId: item.campaignId,
        reportCount: item.reportCount,
        lastReportedAt: item.lastReportedAt.toISOString(),
        topReason,
        topReasonLabel: getCampaignReportReasonLabel(topReason),
        campaign: item.campaign,
        owner: item.owner,
        sampleReporters: item.sampleReporters,
      };
    })
    .sort((a, b) => new Date(b.lastReportedAt).getTime() - new Date(a.lastReportedAt).getTime());

  const blockedUsers = blockedUsersRows.map((user) => ({
    id: user.id,
    label: getPersonLabel(user),
    blockedAt: user.blockedAt ? user.blockedAt.toISOString() : now.toISOString(),
    blockedUntil: user.blockedUntil ? user.blockedUntil.toISOString() : null,
    blockReason: user.blockReason ?? null,
  }));

  return {
    ok: true as const,
    summary: {
      openReports: complaints.length,
      stalePendingCount: staleCount,
      blockedUsersCount: blockedUsers.length,
      updatedAt: now.toISOString(),
    },
    complaints,
    stale: {
      thresholdHours: ADMIN_STALE_PENDING_HOURS,
      count: staleCount,
      oldestCreatedAt: staleOldest?.createdAt ? staleOldest.createdAt.toISOString() : null,
    },
    blockedUsers,
  };
};

const formatAdminPanelStatsText = async (now = new Date()) => {
  const stats = await getAdminPanelStats({ now, periodPreset: 'today' });
  const updatedAt = new Date(stats.updatedAt).toLocaleString('ru-RU', { hour12: false });

  return [
    'Админ-панель',
    `Новых пользователей: ${stats.overview.newUsers}`,
    `Активных пользователей: ${stats.overview.activeUsers}`,
    `Заявок на проверке: ${stats.applications.pendingCount}`,
    `Апрув заявок: ${stats.overview.approvalRate}%`,
    `Баллы: +${stats.overview.pointsIssued} / -${stats.overview.pointsSpent}`,
    `Бонус +${stats.overview.welcomeBonusAmount}: ${stats.overview.welcomeBonusGranted}/${stats.overview.welcomeBonusLimit}`,
    `Обновлено: ${updatedAt}`,
  ].join('\n');
};

const updateReferralProgress = async (
  tx: Prisma.TransactionClient,
  payload: { userId: string; delta: number }
) => {
  if (!payload.delta) return;
  const referral = await tx.referral.findUnique({
    where: { referredUserId: payload.userId },
    select: { id: true, referrerId: true, referredUserId: true, completedOrders: true },
  });
  if (!referral) return;

  const nextCount = Math.max(0, referral.completedOrders + payload.delta);
  if (nextCount === referral.completedOrders) return;

  await tx.referral.update({
    where: { id: referral.id },
    data: { completedOrders: nextCount },
  });

  if (payload.delta < 0) return;

  for (const milestone of REFERRAL_MILESTONES) {
    if (milestone.orders <= 0) continue;
    if (nextCount < milestone.orders) continue;
    await awardReferralMilestone(tx, referral, milestone);
  }
};

const getDailyBonusWindow = async (tx: Prisma.TransactionClient, userId: string) => {
  const lastEntry = await tx.ledgerEntry.findFirst({
    where: { userId, reason: DAILY_BONUS_REASON },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const lastSpinAt = lastEntry?.createdAt ?? null;
  const nextAvailableAt = getNextDailyBonusAt(lastSpinAt);
  const available = isDailyBonusAvailable(lastSpinAt);
  return { available, lastSpinAt, nextAvailableAt };
};

const calculateDailyBonusStreak = async (tx: Prisma.TransactionClient, userId: string) => {
  const entries = await tx.ledgerEntry.findMany({
    where: { userId, reason: DAILY_BONUS_REASON },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { createdAt: true },
  });
  return calculateDailyBonusStreakFromDates(entries.map((entry) => entry.createdAt));
};

const parseMessageLink = (value: string) => {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith('t.me') && !host.endsWith('telegram.me')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (parts[0] === 'c') {
      if (parts.length < 3) return null;
      const internalId = parts[1];
      const messageId = Number(parts[2]);
      if (!/^\d+$/.test(internalId)) return null;
      if (!Number.isInteger(messageId) || messageId <= 0) return null;
      return { chatId: `-100${internalId}`, messageId };
    }
    const username = parts[0];
    const messageId = Number(parts[1]);
    if (!Number.isInteger(messageId) || messageId <= 0) return null;
    return { username, messageId };
  } catch {
    return null;
  }
};

const parseVkPostLink = (value: string) => {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (host !== 'vk.com' && host !== 'www.vk.com' && host !== 'm.vk.com') return null;
    const path = url.pathname.replace(/^\/+/, '');
    const match = path.match(/^wall(-?\d+)_(\d+)$/i);
    if (!match) return null;
    const ownerKey = match[1] ?? '';
    const postId = Number(match[2] ?? '');
    if (!ownerKey || !Number.isInteger(postId) || postId <= 0) return null;
    return { wall: path.toLowerCase(), ownerKey, postId };
  } catch {
    return null;
  }
};

const parseVkGroupOwnerKey = (value: string) => {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (host !== 'vk.com' && host !== 'www.vk.com' && host !== 'm.vk.com') return null;
    const slug = url.pathname
      .replace(/^\/+/, '')
      .split('/')[0]
      ?.trim()
      .toLowerCase();
    if (!slug) return null;

    const communityMatch = slug.match(/^(public|club|event)(\d+)$/i);
    if (communityMatch?.[2]) return `-${communityMatch[2]}`;

    const userMatch = slug.match(/^id(\d+)$/i);
    if (userMatch?.[1]) return userMatch[1];

    const wallMatch = slug.match(/^wall(-?\d+)_\d+$/i);
    if (wallMatch?.[1]) return wallMatch[1];

    return null;
  } catch {
    return null;
  }
};

const buildTelegramSwitchUrl = (code: string) => {
  const fallback = `https://t.me/JoinRush_bot?startapp=${TG_LINK_CODE_PREFIX}${encodeURIComponent(code)}`;
  try {
    const parsed = new URL(config.tgMiniAppUrl || fallback);
    parsed.searchParams.set('startapp', `${TG_LINK_CODE_PREFIX}${code}`);
    return parsed.toString();
  } catch {
    return fallback;
  }
};

const buildVkSwitchUrl = (code: string) => {
  const fallback = `https://vk.com/app54453849?jr_link_code=${encodeURIComponent(code)}`;
  try {
    const parsed = new URL(config.vkMiniAppUrl || fallback);
    parsed.searchParams.set('jr_link_code', code);
    const hashRaw = parsed.hash.replace(/^#/, '');
    if (!hashRaw) {
      parsed.hash = `jr_link_code=${encodeURIComponent(code)}`;
    } else {
      const [hashPath, hashQuery = ''] = hashRaw.split('?');
      const hashParams = new URLSearchParams(hashQuery || hashPath);
      hashParams.set('jr_link_code', code);
      if (hashQuery) {
        parsed.hash = `#${hashPath}?${hashParams.toString()}`;
      } else {
        parsed.hash = `#${hashParams.toString()}`;
      }
    }
    return parsed.toString();
  } catch {
    return fallback;
  }
};

const resolveChatIdentity = (chat?: { username?: string; id?: number }) => {
  const username = chat?.username?.trim() ?? '';
  const chatId = typeof chat?.id === 'number' ? String(chat.id) : '';
  return { username, chatId };
};

const findGroupByChat = async (chat?: { username?: string; id?: number }) => {
  const { username, chatId } = resolveChatIdentity(chat);
  if (username) {
    return await prisma.group.findFirst({ where: { username, platform: 'TELEGRAM' } });
  }
  if (chatId) {
    return await prisma.group.findFirst({ where: { telegramChatId: chatId, platform: 'TELEGRAM' } });
  }
  return null;
};

const getToken = (authHeader?: string) => {
  if (!authHeader) return '';
  const [type, token] = authHeader.split(' ');
  if (type?.toLowerCase() !== 'bearer') return '';
  return token ?? '';
};

const getOptionalUser = async (request: FastifyRequest) => {
  const authHeader =
    typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
  const bearer = getToken(authHeader);
  if (bearer) {
    try {
      const payload = await verifySession(bearer);
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) return null;
      const ensured = await ensureLegacyStats(user);
      const resolved = await resolveUserBlockState(prisma, ensured);
      if (resolved.blocked) return null;
      return resolved.user;
    } catch {
      return null;
    }
  }

  const initData = request.headers['x-init-data'];
  if (typeof initData !== 'string' || !initData.trim()) return null;

  try {
    const identity = resolveMiniAppAuthIdentity(initData);
    const { user } = await ensureIdentityUser(prisma, identity);
    const ensured = await ensureLegacyStats(user);
    const resolved = await resolveUserBlockState(prisma, ensured);
    if (resolved.blocked) return null;
    return resolved.user;
  } catch {
    return null;
  }
};

const creditUserForCampaign = async (
  tx: Prisma.TransactionClient,
  payload: { userId: string; campaign: { id: string; rewardPoints: number }; reason: string }
) => {
  const user = await tx.user.findUnique({ where: { id: payload.userId } });
  if (!user) throw new ApiError('user not found', 404);

  const resolved = await resolveUserBlockState(tx, user);
  if (resolved.blocked) {
    throw new ApiError('user_blocked', 423, { blocked: resolved.blocked });
  }

  const bonusRate = getRankByTotal(resolved.user.totalEarned).bonusRate;
  const payout = calculatePayoutWithBonus(payload.campaign.rewardPoints, bonusRate);

  await tx.user.update({
    where: { id: resolved.user.id },
    data: {
      balance: { increment: payout },
      totalEarned: { increment: payout },
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: resolved.user.id,
      type: 'EARN',
      amount: payout,
      reason: payload.reason,
      campaignId: payload.campaign.id,
    },
  });

  await updateReferralProgress(tx, { userId: resolved.user.id, delta: 1 });

  return payout;
};

const applyUnsubscribePenalty = async (
  tx: Prisma.TransactionClient,
  payload: { userId: string; campaignId: string }
) => {
  const [user, earnedEntry] = await Promise.all([
    tx.user.findUnique({
      where: { id: payload.userId },
      select: { balance: true, totalEarned: true },
    }),
    tx.ledgerEntry.findFirst({
      where: { userId: payload.userId, campaignId: payload.campaignId, type: 'EARN' },
      orderBy: { createdAt: 'desc' },
      select: { amount: true },
    }),
  ]);

  if (!user || !earnedEntry) return null;

  const earnedAmount = Math.max(0, Math.abs(earnedEntry.amount));
  if (earnedAmount === 0) return null;

  const penaltyResult = calculateUnsubscribePenalty({
    currentBalance: user.balance,
    currentTotalEarned: user.totalEarned,
    earnedAmount,
    multiplier: 2,
  });
  if (penaltyResult.appliedPenalty <= 0) return null;

  await tx.user.update({
    where: { id: payload.userId },
    data: {
      balance: penaltyResult.nextBalance,
      totalEarned: penaltyResult.nextTotalEarned,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: payload.userId,
      type: 'ADJUST',
      amount: -penaltyResult.appliedPenalty,
      reason: 'Отписка от группы',
      campaignId: payload.campaignId,
    },
  });

  await updateReferralProgress(tx, { userId: payload.userId, delta: -1 });

  return penaltyResult.appliedPenalty;
};

const ensureLegacyStats = async (user: User) => {
  const data: Prisma.UserUpdateInput = {};

  if (user.balance === 0) {
    const hasLedger = await prisma.ledgerEntry.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!hasLedger) data.balance = 30;
  }

  if (user.totalEarned === 0) {
    const aggregate = await prisma.ledgerEntry.aggregate({
      where: { userId: user.id, type: { in: ['EARN', 'ADJUST'] } },
      _sum: { amount: true },
    });
    const total = Math.max(0, aggregate._sum.amount ?? 0);
    if (total > 0) data.totalEarned = total;
  }

  if (!user.referralCode) {
    const code = await createUniqueReferralCode(prisma);
    data.referralCode = code;
  }

  const ensuredUser =
    Object.keys(data).length === 0 ? user : await prisma.user.update({ where: { id: user.id }, data });

  const legacyPlatform = resolveUserLegacyPlatform(ensuredUser.telegramId);
  const legacyExternalId =
    legacyPlatform === 'VK' ? ensuredUser.telegramId.replace(/^vk:/, '') : ensuredUser.telegramId;
  await prisma.userIdentity.upsert({
    where: {
      userId_platform: {
        userId: ensuredUser.id,
        platform: legacyPlatform,
      },
    },
    update: {
      externalId: legacyExternalId,
      username: ensuredUser.username,
      firstName: ensuredUser.firstName,
      lastName: ensuredUser.lastName,
      photoUrl: ensuredUser.photoUrl,
    },
    create: {
      userId: ensuredUser.id,
      platform: legacyPlatform,
      externalId: legacyExternalId,
      username: ensuredUser.username,
      firstName: ensuredUser.firstName,
      lastName: ensuredUser.lastName,
      photoUrl: ensuredUser.photoUrl,
    },
  });

  return ensuredUser;
};

const syncGroupAdminsForUser = async (user: User) => {
  const telegramId = await resolveTelegramNumericId(prisma, user);
  if (telegramId === null) return;

  const candidates = await prisma.group.findMany({
    where: {
      platform: 'TELEGRAM',
      OR: [{ username: { not: null } }, { telegramChatId: { not: null } }],
      admins: { none: { userId: user.id } },
    },
    select: { id: true, username: true, telegramChatId: true, ownerId: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  for (const group of candidates) {
    const chatId = group.username ?? group.telegramChatId ?? '';
    if (!chatId) continue;
    if (group.ownerId === user.id) {
      await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        update: {},
        create: { groupId: group.id, userId: user.id },
      });
      continue;
    }
    try {
      const status = await getChatMemberStatus(config.botToken, chatId, telegramId);
      if (!isAdminMemberStatus(status)) continue;
      await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        update: {},
        create: { groupId: group.id, userId: user.id },
      });
    } catch {
      // ignore lookup errors to keep response fast
    }
  }
};

const requireUser = async (request: FastifyRequest) => {
  const authHeader =
    typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
  const bearer = getToken(authHeader);
  if (bearer) {
    const payload = await verifySession(bearer);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new Error('user not found');
    const ensured = await ensureLegacyStats(user);
    const resolved = await resolveUserBlockState(prisma, ensured);
    if (resolved.blocked) {
      throw new ApiError('user_blocked', 423, { blocked: resolved.blocked });
    }
    return resolved.user;
  }

  const initData = request.headers['x-init-data'];
  if (typeof initData === 'string') {
    const identity = resolveMiniAppAuthIdentity(initData);
    const { user } = await ensureIdentityUser(prisma, identity);

    const ensured = await ensureLegacyStats(user);
    const resolved = await resolveUserBlockState(prisma, ensured);
    if (resolved.blocked) {
      throw new ApiError('user_blocked', 423, { blocked: resolved.blocked });
    }
    return resolved.user;
  }

  throw new Error('unauthorized');
};

const requireAdminUser = async (request: FastifyRequest) => {
  await ensureDefaultBotPanelAccess();
  const user = await requireUser(request);
  const telegramIdentity = await prisma.userIdentity.findUnique({
    where: {
      userId_platform: {
        userId: user.id,
        platform: 'TELEGRAM',
      },
    },
    select: { externalId: true },
  });
  const allowed = await hasBotPanelAccess({
    telegramId: telegramIdentity?.externalId ?? '',
    username: user.username ?? undefined,
  });
  if (!allowed) {
    throw new ApiError('forbidden', 403);
  }
  return user;
};

const sendRouteError = (reply: FastifyReply, error: unknown, fallbackStatus = 400) => {
  const normalized = normalizeApiError(error, fallbackStatus);
  const body: Record<string, unknown> = {
    ok: false,
    error: toPublicErrorMessage(normalized.message),
  };
  if (normalized.message === 'user_blocked') {
    const blocked = normalized.details?.blocked;
    if (blocked && typeof blocked === 'object') {
      body.blocked = blocked;
    }
  }
  return reply.code(normalized.status).send(body);
};

const isRetryableWebhookError = (error: unknown) => {
  const status = Number((error as { status?: unknown } | null)?.status);
  if (Number.isFinite(status) && status >= 500) return true;

  const code = String((error as { code?: unknown } | null)?.code ?? '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'P1001', 'P1002'].includes(code)) {
    return true;
  }

  const message = String((error as { message?: unknown } | null)?.message ?? '').toLowerCase();
  if (
    message.includes('timeout') ||
    message.includes('connect') ||
    message.includes('connection') ||
    message.includes('database is unreachable')
  ) {
    return true;
  }

  return false;
};

const isUserBlockedError = (error: unknown) => {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  return message === 'user_blocked';
};

export const registerRoutes = (app: FastifyInstance) => {
  app.get('/health', async () => ({ ok: true }));
  void ensureDefaultBotPanelAccess().catch((error) => {
    app.log.error({ err: error }, 'failed to seed default bot panel access');
  });

  app.post('/telegram/webhook', async (request, reply) => {
    const secret = config.botWebhookSecret;
    const header = request.headers['x-telegram-bot-api-secret-token'];
    if (secret && header !== secret) {
      return reply.code(401).send({ ok: false });
    }

    const update = request.body as TelegramUpdate;
    const reaction = update.message_reaction;
    const reactionCount = update.message_reaction_count;
    if (reaction || reactionCount) {
      if (reactionCount?.chat) {
        const totalCount = Array.isArray(reactionCount.reactions)
          ? reactionCount.reactions.reduce(
              (sum, item) => sum + (Number.isFinite(item.total_count) ? item.total_count : 0),
              0
            )
          : 0;
        request.log.info(
          {
            kind: 'message_reaction_count',
            chatType: reactionCount.chat.type,
            chat: reactionCount.chat.username ?? reactionCount.chat.id,
            messageId: reactionCount.message_id,
            totalCount,
          },
          'telegram reaction update'
        );
      }
      if (reaction?.chat) {
        request.log.info(
          {
            kind: 'message_reaction',
            chatType: reaction.chat.type,
            chat: reaction.chat.username ?? reaction.chat.id,
            messageId: reaction.message_id,
            hasUser: Boolean(reaction.user),
          },
          'telegram reaction update'
        );
      }
    }
    try {
      const upsertUser = async (user: {
        id: number;
        username?: string;
        first_name?: string;
        last_name?: string;
        photo_url?: string;
      }) => {
        const created = await prisma.user.upsert({
          where: { telegramId: String(user.id) },
          update: {
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            photoUrl: user.photo_url,
          },
          create: {
            telegramId: String(user.id),
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            photoUrl: user.photo_url,
            balance: 30,
            totalEarned: 0,
            rating: 0,
          },
        });
        return ensureLegacyStats(created);
      };

      const result = await handleBotWebhookUpdate(update, {
        upsertUser,
        upsertGroup: async ({ ownerId, chat }) => {
          const usernameRaw = chat.username?.trim() ?? '';
          const username = usernameRaw ? usernameRaw.replace(/^@/, '') : '';
          const chatId = Number.isFinite(chat.id) ? String(chat.id) : '';
          if (!username && !chatId) return;

          const existing = username
            ? await prisma.group.findUnique({ where: { username } })
            : chatId
              ? await prisma.group.findUnique({ where: { telegramChatId: chatId } })
              : null;

          let inviteLink = '';
          if (username) {
            inviteLink = `https://t.me/${username}`;
          } else if (chatId) {
            try {
              inviteLink = await exportChatInviteLink(config.botToken, chatId);
            } catch {
              // fallback to internal link for members if invite export fails
              inviteLink = chatId.startsWith('-100')
                ? `https://t.me/c/${chatId.slice(4)}`
                : '';
            }
          }

          if (existing) {
            await prisma.group.update({
              where: { id: existing.id },
              data: {
                title: chat.title ?? existing.title,
                inviteLink: inviteLink || existing.inviteLink,
                username: username || existing.username,
                telegramChatId: chatId || existing.telegramChatId,
              },
            });
            await prisma.groupAdmin.upsert({
              where: { groupId_userId: { groupId: existing.id, userId: ownerId } },
              update: {},
              create: { groupId: existing.id, userId: ownerId },
            });
            return;
          }

          const created = await prisma.group.create({
            data: {
              ownerId,
              title: chat.title ?? (username || 'Группа'),
              username: username || null,
              telegramChatId: chatId || null,
              inviteLink: inviteLink || '',
              description: null,
              category: null,
            },
          });

          await prisma.groupAdmin.create({
            data: { groupId: created.id, userId: ownerId },
          });
        },
        handleReaction: async ({ chat, user, messageId }) => {
          const group = await findGroupByChat(chat);
          if (!group) return;
          const campaign = await prisma.campaign.findFirst({
            where: {
              groupId: group.id,
              actionType: 'REACTION',
              targetMessageId: messageId,
              status: 'ACTIVE',
              remainingBudget: { gt: 0 },
            },
          });
          if (!campaign) return;

          const applicant = await upsertUser(user);
          const applicantState = await resolveUserBlockState(prisma, applicant);
          if (applicantState.blocked) return;

          const application = await prisma.application.findUnique({
            where: {
              campaignId_applicantId: {
                campaignId: campaign.id,
                applicantId: applicantState.user.id,
              },
            },
          });
          if (!application || application.status !== 'PENDING') return;

          try {
            await prisma.$transaction(async (tx) => {
              const freshCampaign = await tx.campaign.findUnique({ where: { id: campaign.id } });
              if (!freshCampaign || freshCampaign.status !== 'ACTIVE') return;
              if (freshCampaign.remainingBudget < freshCampaign.rewardPoints) return;

              await tx.application.update({
                where: { id: application.id },
                data: { status: 'APPROVED', reviewedAt: new Date() },
              });

              await tx.campaign.update({
                where: { id: freshCampaign.id },
                data: {
                  remainingBudget: { decrement: freshCampaign.rewardPoints },
                  status:
                    freshCampaign.remainingBudget - freshCampaign.rewardPoints <= 0
                      ? 'COMPLETED'
                      : freshCampaign.status,
                },
              });

              await creditUserForCampaign(tx, {
                userId: applicantState.user.id,
                campaign: freshCampaign,
                reason: 'Реакция на пост',
              });
            });
          } catch (error) {
            if (isUserBlockedError(error)) return;
            throw error;
          }
        },
        handleReactionCount: async ({ chat, messageId, totalCount }) => {
          const group = await findGroupByChat(chat);
          if (!group) return;

          const campaigns = await prisma.campaign.findMany({
            where: {
              groupId: group.id,
              actionType: 'REACTION',
              targetMessageId: messageId,
              status: 'ACTIVE',
              remainingBudget: { gt: 0 },
            },
            orderBy: { createdAt: 'asc' },
          });
          if (campaigns.length === 0) return;

          for (const campaign of campaigns) {
            try {
              await prisma.$transaction(async (tx) => {
                const freshCampaign = await tx.campaign.findUnique({ where: { id: campaign.id } });
                if (!freshCampaign || freshCampaign.status !== 'ACTIVE') return;

              const lastCount = freshCampaign.reactionCount;
              await tx.campaign.update({
                where: { id: freshCampaign.id },
                data: { reactionCount: totalCount },
              });

              if (totalCount <= 0) return;

              const maxByBudget = Math.floor(
                freshCampaign.remainingBudget / freshCampaign.rewardPoints
              );
              if (maxByBudget <= 0) return;

              const effectiveLast =
                lastCount === null || lastCount === undefined ? totalCount - 1 : lastCount;
              const delta = totalCount - effectiveLast;
              if (delta <= 0) return;

              const maxApprove = Math.min(delta, maxByBudget);
              const pending = await tx.application.findMany({
                where: {
                  campaignId: freshCampaign.id,
                  status: 'PENDING',
                  reactionBaseline: { not: null, lt: totalCount },
                },
                orderBy: [{ reactionBaseline: 'desc' }, { createdAt: 'desc' }],
                take: maxApprove,
              });
              let toApprove = pending;
              if (toApprove.length < maxApprove) {
                const remaining = maxApprove - toApprove.length;
                const pendingUnknown = await tx.application.findMany({
                  where: {
                    campaignId: freshCampaign.id,
                    status: 'PENDING',
                    reactionBaseline: null,
                  },
                  orderBy: { createdAt: 'desc' },
                  take: remaining,
                });
                toApprove = toApprove.concat(pendingUnknown);
              }
              if (toApprove.length === 0) return;

              const applicantRows = await tx.user.findMany({
                where: { id: { in: toApprove.map((item) => item.applicantId) } },
              });
              const applicantById = new Map(applicantRows.map((item) => [item.id, item]));
              const eligibleApplications: typeof toApprove = [];
              for (const application of toApprove) {
                const applicant = applicantById.get(application.applicantId);
                if (!applicant) continue;
                const resolved = await resolveUserBlockState(tx, applicant);
                if (resolved.blocked) continue;
                eligibleApplications.push(application);
              }

              const approveCount = Math.min(maxApprove, eligibleApplications.length);
              if (approveCount <= 0) return;
              toApprove = eligibleApplications.slice(0, approveCount);
              const now = new Date();

              await tx.application.updateMany({
                where: { id: { in: toApprove.map((item) => item.id) } },
                data: { status: 'APPROVED', reviewedAt: now },
              });

              const spend = freshCampaign.rewardPoints * approveCount;
              const newRemaining = freshCampaign.remainingBudget - spend;

              await tx.campaign.update({
                where: { id: freshCampaign.id },
                data: {
                  remainingBudget: { decrement: spend },
                  status: newRemaining <= 0 ? 'COMPLETED' : freshCampaign.status,
                },
              });

                for (const application of toApprove) {
                  await creditUserForCampaign(tx, {
                    userId: application.applicantId,
                    campaign: freshCampaign,
                    reason: 'Реакция на пост',
                  });
                }
              });
            } catch (error) {
              if (isUserBlockedError(error)) continue;
              throw error;
            }
          }
        },
        handleChatMember: async ({ chat, user, status }) => {
          if (user.is_bot) return;
          const isJoinStatus =
            status === 'member' || status === 'administrator' || status === 'creator';
          const isLeaveStatus = status === 'left' || status === 'kicked';
          if (!isJoinStatus && !isLeaveStatus) return;

          const group = await findGroupByChat(chat);
          if (!group) return;

          const applicant = await upsertUser(user);
          const applicantState = await resolveUserBlockState(prisma, applicant);
          if (applicantState.blocked) return;

          if (isJoinStatus) {
            const application = await prisma.application.findFirst({
              where: {
                applicantId: applicantState.user.id,
                status: 'PENDING',
                campaign: {
                  groupId: group.id,
                  actionType: 'SUBSCRIBE',
                  status: 'ACTIVE',
                  remainingBudget: { gt: 0 },
                },
              },
              orderBy: { createdAt: 'desc' },
            });
            if (!application) return;

            try {
              await prisma.$transaction(async (tx) => {
                const freshCampaign = await tx.campaign.findUnique({
                  where: { id: application.campaignId },
                });
                if (!freshCampaign || freshCampaign.status !== 'ACTIVE') return;
                if (freshCampaign.remainingBudget < freshCampaign.rewardPoints) return;

                await tx.application.update({
                  where: { id: application.id },
                  data: { status: 'APPROVED', reviewedAt: new Date() },
                });

                await tx.campaign.update({
                  where: { id: freshCampaign.id },
                  data: {
                    remainingBudget: { decrement: freshCampaign.rewardPoints },
                    status:
                      freshCampaign.remainingBudget - freshCampaign.rewardPoints <= 0
                        ? 'COMPLETED'
                        : freshCampaign.status,
                  },
                });

                await creditUserForCampaign(tx, {
                  userId: applicantState.user.id,
                  campaign: freshCampaign,
                  reason: 'Вступление в группу',
                });
              });
            } catch (error) {
              if (isUserBlockedError(error)) return;
              throw error;
            }
            return;
          }

          if (isLeaveStatus) {
            const application = await prisma.application.findFirst({
              where: {
                applicantId: applicantState.user.id,
                status: 'APPROVED',
                campaign: {
                  groupId: group.id,
                  actionType: 'SUBSCRIBE',
                },
              },
              orderBy: { reviewedAt: 'desc' },
            });
            if (!application) return;

            await prisma.$transaction(async (tx) => {
              const freshApplication = await tx.application.findUnique({
                where: { id: application.id },
              });
              if (!freshApplication || freshApplication.status !== 'APPROVED') return;

              await tx.application.update({
                where: { id: application.id },
                data: { status: 'REVOKED', reviewedAt: new Date() },
              });

              await applyUnsubscribePenalty(tx, {
                userId: applicantState.user.id,
                campaignId: application.campaignId,
              });
            });
          }
        },
        handleStartPayload: async ({ chatId, user, startParam }) => {
          const referred = await upsertUser(user);
          if (referred.firstAuthAt) return;
          const linked = await prisma.$transaction(async (tx) => {
            return await linkReferralByCode(tx, {
              referredUserId: referred.id,
              referralCode: startParam,
              requireNoFirstAuth: true,
            });
          });
          if (linked?.referredBonus) {
            try {
              await sendMessage(
                config.botToken,
                String(chatId),
                `Вас пригласили! Вы получили +${linked.referredBonus.amount} баллов.`
              );
            } catch {
              // ignore notification errors
            }
          }
        },
        handlePrivateMessage: async ({ chatId, user, text, command }) => {
          const normalizedText = text.trim().toLowerCase();
          const isPanelRequest =
            BOT_PANEL_ALLOWED_COMMANDS.has(command) || BOT_PANEL_ALLOWED_TEXTS.has(normalizedText);
          if (!isPanelRequest) return;

          try {
            await ensureDefaultBotPanelAccess();
            const allowed = await hasBotPanelAccess({
              telegramId: user.id,
              username: user.username,
            });
            if (!allowed) {
              await sendMessage(config.botToken, String(chatId), 'У вас нет доступа к админ-панели.');
              return;
            }

            const statsText = await formatAdminPanelStatsText();
            await sendMessage(config.botToken, String(chatId), statsText);
          } catch (error) {
            request.log.error({ err: error, userId: user.id }, 'failed to process admin panel request');
            try {
              await sendMessage(
                config.botToken,
                String(chatId),
                'Не удалось загрузить админ-панель. Попробуйте позже.'
              );
            } catch {
              // ignore follow-up delivery errors
            }
          }
        },
      });
      return reply.send(result);
    } catch (error) {
      request.log.error(
        {
          err: error,
          retryable: isRetryableWebhookError(error),
        },
        'telegram webhook processing failed'
      );

      if (isRetryableWebhookError(error)) {
        return reply.code(500).send({ ok: false, error: 'webhook_retryable_error' });
      }

      return reply.code(200).send({ ok: false, error: 'webhook_non_retryable_error' });
    }
  });

  app.post('/platform/switch-link', async (request, reply) => {
    const parsed = platformSwitchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

    try {
      const user = await requireUser(request);
      const currentPlatform = resolveRequestPlatform(request, user);
      if (parsed.data.targetPlatform === currentPlatform) {
        return reply.code(400).send({ ok: false, error: 'already on target platform' });
      }

      const now = new Date();
      const ttlSec = Math.max(30, Math.floor(config.platformLinkCodeTtlSec || 300));
      const expiresAt = new Date(now.getTime() + ttlSec * 1000);

      const code = await prisma.$transaction(async (tx) => {
        const generated = await createUniquePlatformLinkCode(tx);
        await tx.platformLinkCode.create({
          data: {
            code: generated,
            sourceUserId: user.id,
            targetPlatform: parsed.data.targetPlatform,
            expiresAt,
          },
        });
        return generated;
      });

      const url =
        parsed.data.targetPlatform === 'TELEGRAM'
          ? buildTelegramSwitchUrl(code)
          : buildVkSwitchUrl(code);

      return {
        ok: true,
        url,
        code,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post('/auth/verify', async (request, reply) => {
    const parsed = authBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

    try {
      const identity = resolveMiniAppAuthIdentity(parsed.data.initData);
      const rawStartParam =
        typeof identity.startParam === 'string' ? identity.startParam.trim() : '';
      const startLinkCode = rawStartParam.startsWith(TG_LINK_CODE_PREFIX)
        ? normalizePlatformLinkCode(rawStartParam.slice(TG_LINK_CODE_PREFIX.length))
        : '';
      const bodyLinkCode = parsed.data.linkCode ? normalizePlatformLinkCode(parsed.data.linkCode) : '';
      const linkCode = bodyLinkCode || (isPlatformLinkCode(startLinkCode) ? startLinkCode : '');
      if (bodyLinkCode && !isPlatformLinkCode(bodyLinkCode)) {
        return reply.code(400).send({ ok: false, error: 'invalid link code' });
      }
      const referralCandidate =
        rawStartParam && !startLinkCode ? normalizeReferralCode(rawStartParam) : '';
      const startParam =
        referralCandidate && isValidReferralCode(referralCandidate) ? referralCandidate : '';
      const now = new Date();

      const result = await prisma.$transaction(async (tx) => {
        let { user: current, isFirstAuth } = await ensureIdentityUser(tx, identity, now);
        let referralBonus: { amount: number; reason: string } | null = null;

        if (linkCode) {
          const link = await consumePlatformLinkCode(tx, {
            code: linkCode,
            targetPlatform: identity.platform,
            now,
          });
          if (link.sourceUserId !== current.id) {
            current = await mergeUsersWithTelegramMaster(tx, {
              userAId: link.sourceUserId,
              userBId: current.id,
            });
            await upsertUserIdentity(tx, { userId: current.id, identity });
            isFirstAuth = false;
          }
        }

        if (!current.referralCode) {
          current = await tx.user.update({
            where: { id: current.id },
            data: { referralCode: await createUniqueReferralCode(tx) },
          });
        }

        if (isFirstAuth) {
          current = await grantFirstLoginWelcomeBonusIfEligible(tx, current);
        }

        if (isFirstAuth && startParam) {
          const linked = await linkReferralByCode(tx, {
            referredUserId: current.id,
            referralCode: startParam,
          });
          if (linked?.referredBonus) {
            referralBonus = linked.referredBonus;
          }
        }

        return { user: current, referralBonus };
      });

      const ensuredUser = await ensureLegacyStats(result.user);

      let token = '';
      if (config.appSecret) {
        token = await signSession({
          sub: ensuredUser.id,
          tid: ensuredUser.telegramId,
          username: ensuredUser.username ?? undefined,
        });
      }

      return {
        ok: true,
        user: ensuredUser,
        balance: ensuredUser.balance,
        token,
        referralBonus: result.referralBonus,
      };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.get('/me', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const [groups, campaigns, applications] = await Promise.all([
        prisma.group.count({
          where: {
            platform: runtimePlatform,
            OR: [{ ownerId: user.id }, { admins: { some: { userId: user.id } } }],
          },
        }),
        prisma.campaign.count({ where: { ownerId: user.id, platform: runtimePlatform } }),
        prisma.application.count({
          where: { applicantId: user.id, campaign: { platform: runtimePlatform } },
        }),
      ]);
      return {
        ok: true,
        user,
        runtimePlatform,
        balance: user.balance,
        stats: { groups, campaigns, applications },
        capabilities: getRuntimeCapabilities(),
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/admin/panel', async (request, reply) => {
    try {
      const parsedQuery = adminPanelQuerySchema.safeParse(request.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(400).send({ ok: false, error: 'invalid query' });
      }
      const periodPreset = parsedQuery.data.period ?? 'today';
      await requireAdminUser(request);
      const stats = await getAdminPanelStats({ periodPreset });
      return { ok: true, allowed: true, stats };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/admin/moderation', async (request, reply) => {
    try {
      await requireAdminUser(request);
      return await getAdminModerationSnapshot();
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post<{ Params: { campaignId: string } }>('/admin/moderation/campaigns/:campaignId/action', async (request, reply) => {
    try {
      await requireAdminUser(request);
      const parsed = adminModerationActionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'invalid body' });
      }

      const campaignId = request.params.campaignId;
      const now = new Date();
      const result = await prisma.$transaction(async (tx) => {
        const campaign = await tx.campaign.findUnique({
          where: { id: campaignId },
          include: { owner: true },
        });
        if (!campaign) {
          throw new ApiError('campaign not found', 404);
        }

        let fineApplied = 0;
        let userBlocked = false;
        let blockedUntil: string | null = null;
        let campaignDeleted = false;
        let clearedReports = 0;

        if (typeof parsed.data.finePoints === 'number' && parsed.data.finePoints > 0) {
          const owner = await tx.user.findUnique({
            where: { id: campaign.ownerId },
            select: { id: true, balance: true, totalEarned: true },
          });
          if (!owner) throw new ApiError('user not found', 404);

          fineApplied = calculateAdminFineApplied({
            requestedFine: parsed.data.finePoints,
            balance: owner.balance,
            totalEarned: owner.totalEarned,
          });

          if (fineApplied > 0) {
            await tx.user.update({
              where: { id: owner.id },
              data: {
                balance: { decrement: fineApplied },
                totalEarned: { decrement: fineApplied },
              },
            });
            await tx.ledgerEntry.create({
              data: {
                userId: owner.id,
                type: 'ADJUST',
                amount: -fineApplied,
                reason: parsed.data.fineReason ?? 'Админ штраф по жалобе',
                campaignId: campaign.id,
              },
            });
          }
        }

        if (parsed.data.blockMode && parsed.data.blockMode !== 'none') {
          const nextBlockedUntil = resolveAdminBlockUntil({
            mode: parsed.data.blockMode,
            blockDays: parsed.data.blockDays,
            now,
          });
          const updatedOwner = await tx.user.update({
            where: { id: campaign.ownerId },
            data: {
              isBlocked: true,
              blockedAt: now,
              blockedUntil: nextBlockedUntil,
              blockReason: parsed.data.blockReason ?? 'Блокировка админом по жалобе',
            },
            select: { isBlocked: true, blockedUntil: true },
          });
          userBlocked = updatedOwner.isBlocked;
          blockedUntil = updatedOwner.blockedUntil ? updatedOwner.blockedUntil.toISOString() : null;
        }

        if (parsed.data.deleteCampaign) {
          await tx.application.deleteMany({ where: { campaignId: campaign.id } });
          await tx.hiddenCampaign.deleteMany({ where: { campaignId: campaign.id } });
          await tx.ledgerEntry.updateMany({
            where: { campaignId: campaign.id },
            data: { campaignId: null },
          });
          const reportsResult = await tx.campaignReport.deleteMany({ where: { campaignId: campaign.id } });
          clearedReports = reportsResult.count;
          await tx.campaign.delete({ where: { id: campaign.id } });
          campaignDeleted = true;
        } else {
          const reportsResult = await tx.campaignReport.deleteMany({ where: { campaignId: campaign.id } });
          clearedReports = reportsResult.count;
        }

        return {
          campaignDeleted,
          fineApplied,
          userBlocked,
          blockedUntil,
          clearedReports,
        };
      });

      return { ok: true, result };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post('/admin/moderation/stale/cleanup', async (request, reply) => {
    try {
      await requireAdminUser(request);
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - ADMIN_STALE_PENDING_MS);
      const cleaned = await prisma.application.updateMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: staleThreshold },
        },
        data: {
          status: 'REJECTED',
          reviewedAt: now,
        },
      });
      return { ok: true, cleaned: cleaned.count, thresholdHours: ADMIN_STALE_PENDING_HOURS };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post<{ Params: { userId: string } }>('/admin/moderation/users/:userId/unblock', async (request, reply) => {
    try {
      await requireAdminUser(request);
      const userId = request.params.userId;
      const existing = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!existing) {
        return reply.code(404).send({ ok: false, error: 'user not found' });
      }
      const updated = await clearUserBlock(prisma, userId);
      return { ok: true, user: { id: updated.id, isBlocked: updated.isBlocked } };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/referrals/me', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const code = await ensureReferralCodeForUser(prisma, {
        userId: user.id,
        current: user.referralCode ?? null,
      });

      let link = '';
      if (config.botToken) {
        try {
          const bot = await getBotInfo(config.botToken);
          if (bot?.username) {
            link = `https://t.me/${bot.username}?start=${code}`;
          }
        } catch {
          // ignore bot lookup errors
        }
      }

      const [invited, rewards] = await Promise.all([
        prisma.referral.count({ where: { referrerId: user.id } }),
        prisma.referralReward.aggregate({
          where: { side: 'REFERRER', referral: { referrerId: user.id } },
          _sum: { amount: true },
        }),
      ]);

      return {
        ok: true,
        code,
        link,
        stats: {
          invited,
          earned: Math.max(0, rewards._sum.amount ?? 0),
        },
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/referrals/list', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const referrals = await prisma.referral.findMany({
        where: { referrerId: user.id },
        include: {
          referredUser: true,
          rewards: { where: { side: 'REFERRER' } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      const result = referrals.map((referral) => ({
        id: referral.id,
        createdAt: referral.createdAt.toISOString(),
        completedOrders: referral.completedOrders,
        referredUser: {
          id: referral.referredUser.id,
          username: referral.referredUser.username,
          firstName: referral.referredUser.firstName,
          lastName: referral.referredUser.lastName,
          photoUrl: referral.referredUser.photoUrl,
        },
        earned: referral.rewards.reduce((sum, item) => sum + item.amount, 0),
      }));

      return { ok: true, referrals: result };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/daily-bonus/status', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const [window, streak] = await Promise.all([
        getDailyBonusWindow(prisma, user.id),
        calculateDailyBonusStreak(prisma, user.id),
      ]);
      return {
        ok: true,
        available: window.available,
        lastSpinAt: window.lastSpinAt ? window.lastSpinAt.toISOString() : null,
        nextAvailableAt: window.nextAvailableAt ? window.nextAvailableAt.toISOString() : null,
        cooldownMs: DAILY_BONUS_COOLDOWN_MS,
        streak,
      };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.post('/daily-bonus/spin', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const result = await prisma.$transaction(async (tx) => {
        const window = await getDailyBonusWindow(tx, user.id);
        if (!window.available) {
          const cooldownError = new Error('cooldown') as Error & {
            status?: number;
            window?: { lastSpinAt: Date | null; nextAvailableAt: Date | null };
          };
          cooldownError.status = 429;
          cooldownError.window = {
            lastSpinAt: window.lastSpinAt,
            nextAvailableAt: window.nextAvailableAt,
          };
          throw cooldownError;
        }

        const reward = pickDailyBonus();
        const spinAt = new Date();

        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: {
            balance: { increment: reward.value },
            totalEarned: { increment: reward.value },
          },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: user.id,
            type: 'EARN',
            amount: reward.value,
            reason: DAILY_BONUS_REASON,
            createdAt: spinAt,
          },
        });

        const nextAvailableAt = getNextDailyBonusAt(spinAt) ?? new Date(spinAt.getTime());
        const streak = await calculateDailyBonusStreak(tx, user.id);
        return { reward, updatedUser, spinAt, nextAvailableAt, streak };
      });

      return {
        ok: true,
        reward: result.reward,
        balance: result.updatedUser.balance,
        totalEarned: result.updatedUser.totalEarned,
        lastSpinAt: result.spinAt.toISOString(),
        nextAvailableAt: result.nextAvailableAt.toISOString(),
        cooldownMs: DAILY_BONUS_COOLDOWN_MS,
        streak: result.streak,
      };
    } catch (error) {
      const normalized = normalizeApiError(error, 401);
      if (normalized.status === 429) {
        const raw = error as { window?: { lastSpinAt?: Date | null; nextAvailableAt?: Date | null } };
        return reply.code(429).send({
          ok: false,
          error: 'Бонус еще не доступен.',
          lastSpinAt: raw.window?.lastSpinAt
            ? raw.window.lastSpinAt.toISOString()
            : null,
          nextAvailableAt: raw.window?.nextAvailableAt
            ? raw.window.nextAvailableAt.toISOString()
            : null,
          cooldownMs: DAILY_BONUS_COOLDOWN_MS,
        });
      }
      return sendRouteError(reply, normalized, 401);
    }
  });

  app.get('/groups/my', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      if (runtimePlatform === 'TELEGRAM') {
        await syncGroupAdminsForUser(user);
      }
      const groups = await prisma.group.findMany({
        where: {
          platform: runtimePlatform,
          OR: [{ ownerId: user.id }, { admins: { some: { userId: user.id } } }],
        },
        orderBy: { createdAt: 'desc' },
      });
      return { ok: true, groups };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.post('/groups', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const parsed = groupCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

      if (runtimePlatform === 'VK') {
        ensureVkGroupAddEnabled();

        const resolved = await resolveVkGroupForCreate(parsed.data.inviteLink);
        if (!resolved) {
          throw new ApiError('vk_group_link_invalid', 400);
        }

        if (parsed.data.title && parsed.data.title.length < 3) {
          throw new ApiError('group_title_too_short', 400);
        }

        const resolvedTitle = (parsed.data.title || resolved.name || '').trim();
        if (!resolvedTitle) {
          throw new ApiError('vk_group_title_missing', 400);
        }
        const inviteLinkCandidates = buildVkInviteLinkCandidates(
          resolved.groupId,
          resolved.screenName
        );

        let group = await prisma.group.findFirst({
          where: {
            ownerId: user.id,
            platform: 'VK',
            inviteLink: { in: inviteLinkCandidates },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (group) {
          group = await prisma.group.update({
            where: { id: group.id },
            data: {
              title: resolvedTitle,
              inviteLink: resolved.canonicalInviteLink,
              description: parsed.data.description,
              category: parsed.data.category,
              platform: 'VK',
            },
          });
        } else {
          group = await prisma.group.create({
            data: {
              ownerId: user.id,
              title: resolvedTitle,
              inviteLink: resolved.canonicalInviteLink,
              description: parsed.data.description,
              category: parsed.data.category,
              platform: 'VK',
            },
          });
        }

        await prisma.groupAdmin.upsert({
          where: { groupId_userId: { groupId: group.id, userId: user.id } },
          update: {},
          create: { groupId: group.id, userId: user.id },
        });

        return { ok: true, group };
      }

      const resolvedUsername = extractUsername(parsed.data.username ?? parsed.data.inviteLink);
      if (!resolvedUsername) {
        return reply.code(400).send({
          ok: false,
          error: 'Укажите публичный @username (например, @my_channel).',
        });
      }

      if (!parsed.data.title || parsed.data.title.length < 3) {
        return reply.code(400).send({
          ok: false,
          error: 'Название проекта должно быть не короче 3 символов.',
        });
      }

      await ensureBotIsAdmin(config.botToken, resolvedUsername);

      const telegramId = await resolveTelegramNumericId(prisma, user);
      if (telegramId === null) {
        return reply.code(400).send({ ok: false, error: TG_IDENTITY_REQUIRED_MESSAGE });
      }
      const memberStatus = await getChatMemberStatus(
        config.botToken,
        resolvedUsername,
        telegramId
      );
      if (!isAdminMemberStatus(memberStatus)) {
        return reply
          .code(403)
          .send({ ok: false, error: 'Вы должны быть администратором канала/группы.' });
      }

      const cleanUsername = resolvedUsername.replace(/^@/, '');
      const group = await prisma.group.upsert({
        where: { username: cleanUsername },
        update: {
          title: parsed.data.title,
          inviteLink: parsed.data.inviteLink,
          description: parsed.data.description,
          category: parsed.data.category,
          platform: 'TELEGRAM',
        },
        create: {
          ownerId: user.id,
          title: parsed.data.title,
          username: cleanUsername,
          inviteLink: parsed.data.inviteLink,
          description: parsed.data.description,
          category: parsed.data.category,
          platform: 'TELEGRAM',
        },
      });

      await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        update: {},
        create: { groupId: group.id, userId: user.id },
      });

      return { ok: true, group };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post('/groups/import-vk-admin', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      if (runtimePlatform !== 'VK') {
        return reply.code(409).send({
          ok: false,
          error: 'Импорт VK-сообществ доступен только в VK mini-app.',
        });
      }

      const parsed = vkGroupsImportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'invalid body' });
      }

      const vkUserToken = parsed.data.vkUserToken.trim();
      if (!vkUserToken) {
        return reply.code(400).send({ ok: false, error: 'vk_user_token_invalid' });
      }

      ensureVkGroupAddEnabled();

      const vkExternalId = await resolveVkExternalId(prisma, user);
      if (!vkExternalId) {
        return reply.code(400).send({ ok: false, error: VK_IDENTITY_REQUIRED_MESSAGE });
      }

      let vkUserId: number | null = null;
      try {
        vkUserId = await resolveVkUserIdByToken(vkUserToken);
      } catch (error) {
        const normalized = normalizeApiError(error, 400);
        if (normalized.message === 'vk_user_token_invalid') {
          return reply.code(400).send({ ok: false, error: 'vk_user_token_invalid' });
        }
        return reply.code(503).send({ ok: false, error: 'vk_verify_unavailable' });
      }
      if (!vkUserId) {
        return reply.code(400).send({ ok: false, error: 'vk_user_token_invalid' });
      }
      if (String(vkUserId) !== vkExternalId) {
        return reply.code(403).send({ ok: false, error: 'vk_identity_mismatch' });
      }

      let importedGroups: Awaited<ReturnType<typeof fetchVkAdminGroups>> = [];
      try {
        importedGroups = await fetchVkAdminGroups(vkUserToken, {
          roles: ['admin', 'editor', 'moder'],
        });
      } catch (error) {
        const normalized = normalizeApiError(error, 400);
        if (normalized.message === 'vk_user_token_invalid') {
          return reply.code(400).send({ ok: false, error: 'vk_user_token_invalid' });
        }
        return reply.code(503).send({ ok: false, error: 'vk_verify_unavailable' });
      }

      let imported = 0;
      let updated = 0;
      let skipped = 0;

      await prisma.$transaction(async (tx) => {
        for (const vkGroup of importedGroups) {
          const inviteLinkCandidates = buildVkInviteLinkCandidates(
            vkGroup.groupId,
            vkGroup.screenName
          );
          const existing = await tx.group.findFirst({
            where: {
              ownerId: user.id,
              platform: 'VK',
              inviteLink: { in: inviteLinkCandidates },
            },
            orderBy: { createdAt: 'desc' },
          });

          let groupId: string;
          if (!existing) {
            const created = await tx.group.create({
              data: {
                ownerId: user.id,
                title: vkGroup.name,
                inviteLink: vkGroup.canonicalInviteLink,
                platform: 'VK',
              },
            });
            imported += 1;
            groupId = created.id;
          } else {
            const titleChanged = existing.title.trim() !== vkGroup.name;
            if (titleChanged || existing.inviteLink !== vkGroup.canonicalInviteLink) {
              await tx.group.update({
                where: { id: existing.id },
                data: {
                  title: vkGroup.name,
                  inviteLink: vkGroup.canonicalInviteLink,
                  platform: 'VK',
                },
              });
              updated += 1;
            } else {
              skipped += 1;
            }
            groupId = existing.id;
          }

          await tx.groupAdmin.upsert({
            where: { groupId_userId: { groupId, userId: user.id } },
            update: {},
            create: { groupId, userId: user.id },
          });
        }
      });

      const groups = await prisma.group.findMany({
        where: {
          platform: 'VK',
          OR: [{ ownerId: user.id }, { admins: { some: { userId: user.id } } }],
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        ok: true,
        imported,
        updated,
        skipped,
        groups,
        syncedAt: new Date().toISOString(),
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/campaigns', async (request, reply) => {
    const parsed = campaignQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid query' });

    const { category, limit, actionType } = parsed.data;
    const viewer = await getOptionalUser(request);
    const runtimePlatform = resolveRequestPlatform(request, viewer ?? undefined);
    const campaigns = await prisma.campaign.findMany({
      where: {
        platform: runtimePlatform,
        status: 'ACTIVE',
        remainingBudget: { gt: 0 },
        ownerId: viewer ? { not: viewer.id } : undefined,
        hiddenByUsers: viewer
          ? {
              none: { userId: viewer.id },
            }
          : undefined,
        group: category ? { category } : undefined,
        actionType: actionType
          ? actionType === 'subscribe'
            ? 'SUBSCRIBE'
            : 'REACTION'
          : undefined,
      },
      include: {
        group: true,
        owner: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit ?? 30,
    });

    const filtered = campaigns.filter((item) => item.remainingBudget >= item.rewardPoints);
    return { ok: true, campaigns: filtered };
  });

  app.get('/campaigns/my', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const campaigns = await prisma.campaign.findMany({
        where: { ownerId: user.id, platform: runtimePlatform },
        include: { group: true },
        orderBy: { createdAt: 'desc' },
      });
      return { ok: true, campaigns };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/hide', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const campaignId = request.params.id;
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true },
      });
      if (!campaign) return reply.code(404).send({ ok: false, error: 'campaign not found' });

      await prisma.hiddenCampaign.upsert({
        where: {
          userId_campaignId: {
            userId: user.id,
            campaignId,
          },
        },
        update: {
          createdAt: new Date(),
        },
        create: {
          userId: user.id,
          campaignId,
        },
      });

      return { ok: true, hidden: true };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/report', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const parsed = campaignReportSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

      const campaignId = request.params.id;
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, ownerId: true },
      });
      if (!campaign) return reply.code(404).send({ ok: false, error: 'campaign not found' });
      if (campaign.ownerId === user.id) {
        return reply.code(400).send({ ok: false, error: 'cannot report own campaign' });
      }

      const reportedAt = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.campaignReport.upsert({
          where: {
            campaignId_reporterId: {
              campaignId,
              reporterId: user.id,
            },
          },
          update: {
            reason: parsed.data.reason,
            reportedAt,
          },
          create: {
            campaignId,
            reporterId: user.id,
            reason: parsed.data.reason,
            reportedAt,
          },
        });
        await tx.hiddenCampaign.upsert({
          where: {
            userId_campaignId: {
              userId: user.id,
              campaignId,
            },
          },
          update: {
            createdAt: reportedAt,
          },
          create: {
            userId: user.id,
            campaignId,
          },
        });
      });

      return { ok: true, reported: true, hidden: true };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post('/campaigns', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const parsed = campaignCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

      if (parsed.data.totalBudget < parsed.data.rewardPoints) {
        return reply.code(400).send({ ok: false, error: 'budget too small' });
      }

      const group = await prisma.group.findUnique({
        where: { id: parsed.data.groupId },
        include: { admins: { where: { userId: user.id }, select: { userId: true } } },
      });
      if (!group || group.platform !== runtimePlatform) {
        return reply.code(404).send({ ok: false, error: 'group not found' });
      }

      let isGroupAdmin = group.ownerId === user.id || (group.admins?.length ?? 0) > 0;
      if (runtimePlatform === 'TELEGRAM') {
        const groupChatId = group.username ?? group.telegramChatId ?? '';
        if (!isGroupAdmin && groupChatId) {
          const telegramId = await resolveTelegramNumericId(prisma, user);
          if (telegramId !== null) {
            try {
              const status = await getChatMemberStatus(config.botToken, groupChatId, telegramId);
              if (isAdminMemberStatus(status)) {
                await prisma.groupAdmin.upsert({
                  where: { groupId_userId: { groupId: group.id, userId: user.id } },
                  update: {},
                  create: { groupId: group.id, userId: user.id },
                });
                isGroupAdmin = true;
              }
            } catch {
              // ignore
            }
          }
        }
      }
      if (!isGroupAdmin) {
        return reply.code(403).send({ ok: false, error: 'not admin' });
      }

      if (runtimePlatform === 'VK' && parsed.data.actionType === 'subscribe') {
        ensureVkSubscribeAutoEnabled();
      }

      let targetMessageId: number | null = null;
      if (parsed.data.actionType === 'reaction') {
        if (!parsed.data.targetMessageLink) {
          return reply.code(400).send({
            ok: false,
            error:
              runtimePlatform === 'VK'
                ? 'Для VK-реакций нужна ссылка на пост вида https://vk.com/wall-1_1.'
                : 'Для реакций нужна ссылка на пост (формат https://t.me/username/123 или https://t.me/c/123456/789).',
          });
        }
        if (runtimePlatform === 'VK') {
          const parsedLink = parseVkPostLink(parsed.data.targetMessageLink);
          if (!parsedLink) {
            return reply.code(400).send({
              ok: false,
              error: 'Ссылка на пост VK некорректна. Нужен формат https://vk.com/wall-1_1.',
            });
          }
          const groupOwnerKey = parseVkGroupOwnerKey(group.inviteLink);
          if (groupOwnerKey && parsedLink.ownerKey !== groupOwnerKey) {
            return reply.code(400).send({
              ok: false,
              error: 'Ссылка на пост должна быть из выбранного VK-сообщества.',
            });
          }
          targetMessageId = parsedLink.postId;
        } else {
          const parsedLink = parseMessageLink(parsed.data.targetMessageLink);
          if (!parsedLink) {
            return reply.code(400).send({
              ok: false,
              error:
                'Ссылка на пост некорректна. Нужен формат https://t.me/username/123 или https://t.me/c/123456/789.',
            });
          }
          const groupUsername = group.username?.trim();
          const groupChatId = group.telegramChatId?.trim();
          if (parsedLink.username) {
            if (!groupUsername) {
              return reply.code(400).send({
                ok: false,
                error: 'У группы нет публичного @username для проверки реакций.',
              });
            }
            if (parsedLink.username.toLowerCase() !== groupUsername.toLowerCase()) {
              return reply.code(400).send({
                ok: false,
                error: 'Ссылка на пост должна быть из выбранной группы/канала.',
              });
            }
          }
          if (parsedLink.chatId) {
            if (!groupChatId) {
              return reply.code(400).send({
                ok: false,
                error: 'У группы нет данных для приватной ссылки. Добавьте бота в группу заново.',
              });
            }
            if (parsedLink.chatId !== groupChatId) {
              return reply.code(400).send({
                ok: false,
                error: 'Ссылка на пост должна быть из выбранной группы/канала.',
              });
            }
          }
          if (!parsedLink.username && !parsedLink.chatId) {
            return reply.code(400).send({
              ok: false,
              error:
                'Ссылка на пост некорректна. Нужен формат https://t.me/username/123 или https://t.me/c/123456/789.',
            });
          }
          targetMessageId = parsedLink.messageId;
        }
      }

      const campaign = await prisma.$transaction(async (tx) => {
        const fresh = await tx.user.findUnique({ where: { id: user.id } });
        if (!fresh || fresh.balance < parsed.data.totalBudget) {
          throw new Error('insufficient_balance');
        }

        await tx.user.update({
          where: { id: user.id },
          data: { balance: { decrement: parsed.data.totalBudget } },
        });

        const created = await tx.campaign.create({
          data: {
            groupId: parsed.data.groupId,
            ownerId: user.id,
            actionType: parsed.data.actionType === 'subscribe' ? 'SUBSCRIBE' : 'REACTION',
            targetMessageId,
            platform: runtimePlatform,
            rewardPoints: parsed.data.rewardPoints,
            totalBudget: parsed.data.totalBudget,
            remainingBudget: parsed.data.totalBudget,
            status: 'ACTIVE',
          },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: user.id,
            type: 'SPEND',
            amount: -parsed.data.totalBudget,
            reason: 'Бюджет кампании',
            campaignId: created.id,
          },
        });

        return created;
      });

      const balance = await prisma.user.findUnique({ where: { id: user.id } });
      return { ok: true, campaign, balance: balance?.balance ?? user.balance };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/apply', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const campaignId = request.params.id;
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: { group: true },
      });
      if (!campaign) return reply.code(404).send({ ok: false, error: 'campaign not found' });
      if (campaign.platform !== runtimePlatform) {
        return reply.code(404).send({ ok: false, error: 'campaign not found' });
      }
      if (campaign.ownerId === user.id) {
        return reply.code(400).send({ ok: false, error: 'cannot apply own campaign' });
      }
      const isHidden = await prisma.hiddenCampaign.findUnique({
        where: { userId_campaignId: { userId: user.id, campaignId } },
        select: { campaignId: true },
      });
      if (isHidden) {
        return reply.code(409).send({ ok: false, error: 'Задание скрыто. Обновите список.' });
      }
      if (campaign.status !== 'ACTIVE' || campaign.remainingBudget < campaign.rewardPoints) {
        return reply
          .code(409)
          .send({ ok: false, error: 'Задание приостановлено или бюджет исчерпан.' });
      }

      let existing = await prisma.application.findUnique({
        where: { campaignId_applicantId: { campaignId, applicantId: user.id } },
      });
      const existingStatus = existing?.status;
      if (existing?.status === 'APPROVED') {
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        const verification = buildApplicationVerification(existing, campaign);
        return {
          ok: true,
          application: attachApplicationVerification(existing, campaign, { verification }),
          balance: updatedUser?.balance ?? user.balance,
          verification,
        };
      }
      if (existing?.status === 'REJECTED') {
        return reply.code(400).send({ ok: false, error: 'Заявка отклонена.' });
      }
      if (existing?.status === 'REVOKED') {
        const data: Prisma.ApplicationUpdateInput = {
          status: 'PENDING',
          reviewedAt: null,
          verificationChecks: 0,
          lastVerificationAt: null,
        };
        if (campaign.actionType === 'REACTION') {
          data.reactionBaseline = campaign.reactionCount ?? null;
        }
        existing = await prisma.application.update({ where: { id: existing.id }, data });
      }

      if (runtimePlatform === 'VK' && campaign.actionType === 'SUBSCRIBE') {
        const vkExternalId = await resolveVkExternalId(prisma, user);
        if (!vkExternalId) {
          return reply.code(400).send({ ok: false, error: VK_IDENTITY_REQUIRED_MESSAGE });
        }

        ensureVkSubscribeAutoEnabled();

        if (!existing) {
          existing = await prisma.application.create({
            data: {
              campaignId,
              applicantId: user.id,
              status: 'PENDING',
            },
          });
        }

        const retryState = getVkRetryStateForApplication(existing, new Date());
        const hasChecks = existing.verificationChecks > 0;
        if (existingStatus === 'PENDING' && hasChecks && retryState.onCooldown) {
          const verification = buildVkSubscribeVerification(existing, {
            now: new Date(),
            state: 'PENDING_RETRY',
          });
          return {
            ok: true,
            application: attachApplicationVerification(existing, campaign, { verification }),
            verification,
          };
        }

        const verifyStartedAt = Date.now();
        const membership = await resolveVkSubscribeMembership({
          inviteLink: campaign.group.inviteLink,
          externalUserId: vkExternalId,
        });
        const verifyDurationMs = Date.now() - verifyStartedAt;

        if (membership.result === 'UNAVAILABLE') {
          logVkVerifyMetrics(request, {
            result: membership.result,
            durationMs: verifyDurationMs,
            autoApproved: false,
          });
          return reply.code(503).send({ ok: false, error: 'vk_verify_unavailable' });
        }

        if (membership.result === 'MEMBER') {
          const approvedAt = new Date();
          const result = await prisma.$transaction(async (tx) => {
            const freshCampaign = await tx.campaign.findUnique({ where: { id: campaign.id } });
            if (!freshCampaign || freshCampaign.status !== 'ACTIVE') throw new Error('campaign paused');
            if (freshCampaign.remainingBudget < freshCampaign.rewardPoints) throw new Error('budget empty');

            const freshApplication = await tx.application.findUnique({
              where: { campaignId_applicantId: { campaignId, applicantId: user.id } },
            });

            if (freshApplication?.status === 'APPROVED') {
              return {
                application: freshApplication,
                campaign: freshCampaign,
                alreadyApproved: true,
              };
            }

            const application = freshApplication
              ? await tx.application.update({
                  where: { id: freshApplication.id },
                  data: {
                    status: 'APPROVED',
                    reviewedAt: approvedAt,
                    lastVerificationAt: approvedAt,
                    verificationChecks: { increment: 1 },
                  },
                })
              : await tx.application.create({
                  data: {
                    campaignId,
                    applicantId: user.id,
                    status: 'APPROVED',
                    reviewedAt: approvedAt,
                    verificationChecks: 1,
                    lastVerificationAt: approvedAt,
                  },
                });

            const updatedCampaign = await tx.campaign.update({
              where: { id: freshCampaign.id },
              data: {
                remainingBudget: { decrement: freshCampaign.rewardPoints },
                status:
                  freshCampaign.remainingBudget - freshCampaign.rewardPoints <= 0
                    ? 'COMPLETED'
                    : freshCampaign.status,
              },
            });

            await creditUserForCampaign(tx, {
              userId: user.id,
              campaign: freshCampaign,
              reason: 'Вступление в группу',
            });

            return { application, campaign: updatedCampaign, alreadyApproved: false };
          });

          const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
          const verification = buildVkSubscribeVerification(result.application, {
            now: new Date(),
            state: 'APPROVED',
          });
          logVkVerifyMetrics(request, {
            result: membership.result,
            durationMs: verifyDurationMs,
            autoApproved: true,
          });
          return {
            ok: true,
            application: attachApplicationVerification(result.application, campaign, { verification }),
            campaign: result.campaign,
            balance: updatedUser?.balance ?? user.balance,
            verification,
          };
        }

        const pendingAt = new Date();
        const pendingApplication = await prisma.application.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            reviewedAt: null,
            lastVerificationAt: pendingAt,
            verificationChecks: { increment: 1 },
          },
        });

        const verification = buildVkSubscribeVerification(pendingApplication, {
          now: pendingAt,
          state: 'PENDING_RETRY',
        });
        logVkVerifyMetrics(request, {
          result: membership.result,
          durationMs: verifyDurationMs,
          autoApproved: false,
        });
        return {
          ok: true,
          application: attachApplicationVerification(pendingApplication, campaign, { verification }),
          verification,
        };
      }

      if (runtimePlatform === 'VK') {
        if (existing) {
          const verification = buildApplicationVerification(existing, campaign);
          return {
            ok: true,
            application: attachApplicationVerification(existing, campaign, { verification }),
            verification,
          };
        }
        const application = await prisma.application.create({
          data: {
            campaignId,
            applicantId: user.id,
            reactionBaseline: campaign.actionType === 'REACTION' ? campaign.reactionCount ?? null : null,
          },
        });
        const verification = buildApplicationVerification(application, campaign);
        return {
          ok: true,
          application: attachApplicationVerification(application, campaign, { verification }),
          verification,
        };
      }

      if (campaign.actionType === 'REACTION') {
        if (existing) {
          const verification = buildApplicationVerification(existing, campaign);
          return {
            ok: true,
            application: attachApplicationVerification(existing, campaign, { verification }),
            verification,
          };
        }
        const application = await prisma.application.create({
          data: {
            campaignId,
            applicantId: user.id,
            reactionBaseline: campaign.reactionCount ?? null,
          },
        });
        const verification = buildApplicationVerification(application, campaign);
        return {
          ok: true,
          application: attachApplicationVerification(application, campaign, { verification }),
          verification,
        };
      }

      const chatId = campaign.group.username ?? campaign.group.telegramChatId ?? '';
      if (!chatId) {
        return reply
          .code(400)
          .send({ ok: false, error: 'У группы нет данных для проверки вступления.' });
      }

      const telegramId = await resolveTelegramNumericId(prisma, user);
      if (telegramId === null) {
        return reply.code(400).send({ ok: false, error: TG_IDENTITY_REQUIRED_MESSAGE });
      }

      const status = await getChatMemberStatus(config.botToken, chatId, telegramId);
      if (!isActiveMemberStatus(status)) {
        if (existing) {
          const verification = buildApplicationVerification(existing, campaign);
          return {
            ok: true,
            application: attachApplicationVerification(existing, campaign, { verification }),
            verification,
          };
        }
        const application = await prisma.application.create({
          data: {
            campaignId,
            applicantId: user.id,
          },
        });
        const verification = buildApplicationVerification(application, campaign);
        return {
          ok: true,
          application: attachApplicationVerification(application, campaign, { verification }),
          verification,
        };
      }

      const result = await prisma.$transaction(async (tx) => {
        const freshCampaign = await tx.campaign.findUnique({ where: { id: campaign.id } });
        if (!freshCampaign || freshCampaign.status !== 'ACTIVE') throw new Error('campaign paused');
        if (freshCampaign.remainingBudget < freshCampaign.rewardPoints) throw new Error('budget empty');

        const application = existing
          ? await tx.application.update({
              where: { id: existing.id },
              data: { status: 'APPROVED', reviewedAt: new Date() },
            })
          : await tx.application.create({
              data: {
                campaignId,
                applicantId: user.id,
                status: 'APPROVED',
                reviewedAt: new Date(),
              },
            });

        const updatedCampaign = await tx.campaign.update({
          where: { id: freshCampaign.id },
          data: {
            remainingBudget: { decrement: freshCampaign.rewardPoints },
            status:
              freshCampaign.remainingBudget - freshCampaign.rewardPoints <= 0
                ? 'COMPLETED'
                : freshCampaign.status,
          },
        });

        await creditUserForCampaign(tx, {
          userId: user.id,
          campaign: freshCampaign,
          reason: freshCampaign.actionType === 'REACTION' ? 'Реакция на пост' : 'Вступление в группу',
        });

        return { application, campaign: updatedCampaign };
      });

      const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
      const verification = buildApplicationVerification(result.application, campaign);
      return {
        ok: true,
        application: attachApplicationVerification(result.application, campaign, { verification }),
        campaign: result.campaign,
        balance: updatedUser?.balance ?? user.balance,
        verification,
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/applications/my', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const applications = await prisma.application.findMany({
        where: {
          applicantId: user.id,
          campaign: {
            platform: runtimePlatform,
            hiddenByUsers: {
              none: {
                userId: user.id,
              },
            },
          },
        },
        include: { campaign: { include: { group: true, owner: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const now = new Date();
      return {
        ok: true,
        applications: applications.map((application) =>
          attachApplicationVerification(application, application.campaign, { now })
        ),
      };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.get('/applications/incoming', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const applications = await prisma.application.findMany({
        where: {
          campaign: {
            ownerId: user.id,
            platform: runtimePlatform,
            NOT: { platform: 'VK', actionType: 'SUBSCRIBE' },
          },
          status: 'PENDING',
        },
        include: {
          applicant: true,
          campaign: { include: { group: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      const now = new Date();
      return {
        ok: true,
        applications: applications.map((application) =>
          attachApplicationVerification(application, application.campaign, { now })
        ),
      };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.post<{ Params: { id: string } }>('/applications/:id/recheck', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const applicationId = request.params.id;

      const application = await prisma.application.findUnique({
        where: { id: applicationId },
        include: {
          campaign: {
            include: {
              group: true,
            },
          },
        },
      });

      if (!application) {
        return reply.code(404).send({ ok: false, error: 'application not found' });
      }
      if (application.applicantId !== user.id) {
        return reply.code(403).send({ ok: false, error: 'not owner' });
      }
      if (application.campaign.platform !== runtimePlatform) {
        return reply.code(404).send({ ok: false, error: 'application not found' });
      }
      if (runtimePlatform !== 'VK' || application.campaign.actionType !== 'SUBSCRIBE') {
        return reply.code(409).send({ ok: false, error: 'vk_recheck_not_supported' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ ok: false, error: 'already reviewed' });
      }

      const vkExternalId = await resolveVkExternalId(prisma, user);
      if (!vkExternalId) {
        return reply.code(400).send({ ok: false, error: VK_IDENTITY_REQUIRED_MESSAGE });
      }

      ensureVkSubscribeAutoEnabled();

      const cooldown = getVkRetryStateForApplication(application, new Date());
      if (cooldown.onCooldown) {
        return reply.code(429).send({
          ok: false,
          error: 'vk_verify_retry_cooldown',
          retryAfterSec: cooldown.retryAfterSec,
          nextRetryAt: cooldown.nextRetryAt.toISOString(),
        });
      }

      const startedAt = Date.now();
      const membership = await resolveVkSubscribeMembership({
        inviteLink: application.campaign.group.inviteLink,
        externalUserId: vkExternalId,
      });
      const durationMs = Date.now() - startedAt;

      if (membership.result === 'UNAVAILABLE') {
        logVkVerifyMetrics(request, {
          result: membership.result,
          durationMs,
          autoApproved: false,
        });
        return reply.code(503).send({ ok: false, error: 'vk_verify_unavailable' });
      }

      if (membership.result === 'MEMBER') {
        const approvedAt = new Date();
        const result = await prisma.$transaction(async (tx) => {
          const freshApplication = await tx.application.findUnique({
            where: { id: applicationId },
            include: { campaign: true },
          });
          if (!freshApplication) throw new Error('application not found');
          if (freshApplication.status === 'APPROVED') {
            return {
              application: freshApplication,
              campaign: freshApplication.campaign,
              alreadyApproved: true,
            };
          }
          if (freshApplication.status !== 'PENDING') throw new Error('already reviewed');

          const freshCampaign = await tx.campaign.findUnique({
            where: { id: freshApplication.campaignId },
          });
          if (!freshCampaign || freshCampaign.status !== 'ACTIVE') throw new Error('campaign paused');
          if (freshCampaign.remainingBudget < freshCampaign.rewardPoints) throw new Error('budget empty');

          const approvedApplication = await tx.application.update({
            where: { id: freshApplication.id },
            data: {
              status: 'APPROVED',
              reviewedAt: approvedAt,
              lastVerificationAt: approvedAt,
              verificationChecks: { increment: 1 },
            },
          });

          const updatedCampaign = await tx.campaign.update({
            where: { id: freshCampaign.id },
            data: {
              remainingBudget: { decrement: freshCampaign.rewardPoints },
              status:
                freshCampaign.remainingBudget - freshCampaign.rewardPoints <= 0
                  ? 'COMPLETED'
                  : freshCampaign.status,
            },
          });

          await creditUserForCampaign(tx, {
            userId: freshApplication.applicantId,
            campaign: freshCampaign,
            reason: 'Вступление в группу',
          });

          return {
            application: approvedApplication,
            campaign: updatedCampaign,
            alreadyApproved: false,
          };
        });

        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { balance: true } });
        const verification = buildVkSubscribeVerification(result.application, {
          now: new Date(),
          state: 'APPROVED',
        });
        logVkVerifyMetrics(request, {
          result: membership.result,
          durationMs,
          autoApproved: true,
        });
        return {
          ok: true,
          application: attachApplicationVerification(result.application, result.campaign, { verification }),
          campaign: result.campaign,
          balance: balance?.balance ?? user.balance,
          verification,
        };
      }

      const pendingAt = new Date();
      const updatedApplication = await prisma.application.update({
        where: { id: application.id },
        data: {
          status: 'PENDING',
          reviewedAt: null,
          lastVerificationAt: pendingAt,
          verificationChecks: { increment: 1 },
        },
      });
      const verification = buildVkSubscribeVerification(updatedApplication, {
        now: pendingAt,
        state: 'PENDING_RETRY',
      });
      logVkVerifyMetrics(request, {
        result: membership.result,
        durationMs,
        autoApproved: false,
      });
      return {
        ok: true,
        application: attachApplicationVerification(updatedApplication, application.campaign, {
          verification,
        }),
        verification,
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post<{ Params: { id: string } }>('/applications/:id/approve', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const applicationId = request.params.id;

      const application = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { campaign: true },
      });
      if (!application) return reply.code(404).send({ ok: false, error: 'application not found' });
      if (application.campaign.ownerId !== user.id) {
        return reply.code(403).send({ ok: false, error: 'not owner' });
      }
      if (application.campaign.platform !== runtimePlatform) {
        return reply.code(404).send({ ok: false, error: 'application not found' });
      }
      if (application.campaign.platform === 'VK' && application.campaign.actionType === 'SUBSCRIBE') {
        return reply.code(409).send({ ok: false, error: 'vk_subscribe_auto_only' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ ok: false, error: 'already reviewed' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const campaign = await tx.campaign.findUnique({ where: { id: application.campaignId } });
        if (!campaign || campaign.status !== 'ACTIVE') throw new Error('campaign paused');
        if (campaign.remainingBudget < campaign.rewardPoints) throw new Error('budget empty');

        await tx.application.update({
          where: { id: applicationId },
          data: { status: 'APPROVED', reviewedAt: new Date() },
        });

        const updatedCampaign = await tx.campaign.update({
          where: { id: campaign.id },
          data: {
            remainingBudget: { decrement: campaign.rewardPoints },
            status:
              campaign.remainingBudget - campaign.rewardPoints <= 0 ? 'COMPLETED' : campaign.status,
          },
        });

        await creditUserForCampaign(tx, {
          userId: application.applicantId,
          campaign,
          reason: campaign.actionType === 'REACTION' ? 'Реакция на пост' : 'Вступление в группу',
        });

        return updatedCampaign;
      });

      return { ok: true, campaign: result };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post<{ Params: { id: string } }>('/applications/:id/reject', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const runtimePlatform = resolveRequestPlatform(request, user);
      const applicationId = request.params.id;

      const application = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { campaign: true },
      });
      if (!application) return reply.code(404).send({ ok: false, error: 'application not found' });
      if (application.campaign.ownerId !== user.id) {
        return reply.code(403).send({ ok: false, error: 'not owner' });
      }
      if (application.campaign.platform !== runtimePlatform) {
        return reply.code(404).send({ ok: false, error: 'application not found' });
      }
      if (application.campaign.platform === 'VK' && application.campaign.actionType === 'SUBSCRIBE') {
        return reply.code(409).send({ ok: false, error: 'vk_subscribe_auto_only' });
      }

      const updated = await prisma.application.update({
        where: { id: applicationId },
        data: { status: 'REJECTED', reviewedAt: new Date() },
      });

      return { ok: true, application: updated };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });
};
