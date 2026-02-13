import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  hideBackButton,
  mountBackButton,
  onBackButtonClick,
  showBackButton,
} from '@telegram-apps/sdk';
import {
  ApiRequestError,
  applyCampaign,
  cleanupStaleApplications,
  createCampaign,
  fetchAdminModeration,
  fetchAdminPanelStats,
  fetchCampaigns,
  fetchDailyBonusStatus,
  fetchReferralStats,
  fetchReferralList,
  fetchMe,
  fetchMyApplications,
  fetchMyCampaigns,
  fetchMyGroups,
  hideCampaign,
  moderateCampaign,
  reportCampaign,
  spinDailyBonus,
  unblockUser,
  type AdminModerationActionPayload,
  type AdminModerationSnapshot,
  type ApplicationDto,
  type AdminPanelStats,
  type BlockedPayload,
  type CampaignDto,
  type CampaignReportReason,
  type DailyBonusStatus,
  type GroupDto,
  type ReferralBonus,
  type ReferralListItem,
  type ReferralStats,
  verifyInitData,
} from './api';
import { getInitDataRaw, getUserLabel, getUserPhotoUrl, initTelegram } from './telegram';

const PLATFORM_FEE_RATE = 0.3;
const RANKS = [
  { level: 0, minTotal: 0, title: 'Новичок', bonusRate: 0 },
  { level: 1, minTotal: 100, title: 'Бронза', bonusRate: 0.05 },
  { level: 2, minTotal: 300, title: 'Серебро', bonusRate: 0.1 },
  { level: 3, minTotal: 1000, title: 'Золото', bonusRate: 0.15 },
  { level: 4, minTotal: 3000, title: 'Платина', bonusRate: 0.2 },
  { level: 5, minTotal: 5000, title: 'Алмаз', bonusRate: 0.3 },
];
const MAX_BONUS_RATE = RANKS[RANKS.length - 1].bonusRate;
const MIN_TASK_PRICE = 10;
const MAX_TASK_PRICE = 50;
const MAX_TOTAL_BUDGET = 1_000_000;
const DAILY_BONUS_FALLBACK_MS = 24 * 60 * 60 * 1000;
const DAILY_WHEEL_SEGMENTS = [
  { label: '+10', value: 10, weight: 2 },
  { label: '+10', value: 10, weight: 2 },
  { label: '+20', value: 20, weight: 2 },
  { label: '+50', value: 50, weight: 1 },
  { label: '+15', value: 15, weight: 3 },
  { label: '+50', value: 50, weight: 1 },
  { label: '+10', value: 10, weight: 3 },
  { label: '+100', value: 100, weight: 1 },
];
const DAILY_WHEEL_SLICE = 360 / DAILY_WHEEL_SEGMENTS.length;
const DAILY_WHEEL_BASE_ROTATION = -DAILY_WHEEL_SLICE / 2;
const DAILY_WHEEL_SPIN_TURNS = 8;
const DAILY_WHEEL_SPIN_MS = 3800;
const DAILY_WHEEL_CELEBRATE_MS = 1400;
const DAILY_WHEEL_LAUNCH_END = 0.16;
const DAILY_WHEEL_BRAKE_START = 0.54;
const DAILY_WHEEL_BRAKE_DECAY = 0.18;
const DAILY_WHEEL_STOP_INSET_RATIO = 0.24;
const DAILY_WHEEL_SETTLE_MS = 340;
const DAILY_WHEEL_SETTLE_OVERSHOOT_MIN = 1.2;
const DAILY_WHEEL_SETTLE_OVERSHOOT_MAX = 2.1;
const DAILY_WHEEL_SETTLE_REBOUND_MIN = 0.35;
const DAILY_WHEEL_SETTLE_REBOUND_MAX = 0.85;
const DAILY_WHEEL_TOTAL_WEIGHT = DAILY_WHEEL_SEGMENTS.reduce(
  (sum, segment) => sum + segment.weight,
  0
);
const DAILY_WHEEL_AVERAGE_REWARD =
  DAILY_WHEEL_SEGMENTS.reduce((sum, segment) => sum + segment.value * segment.weight, 0) /
  DAILY_WHEEL_TOTAL_WEIGHT;
const DAILY_WHEEL_VALUE_CHANCES = Array.from(
  DAILY_WHEEL_SEGMENTS.reduce((map, segment) => {
    map.set(segment.value, (map.get(segment.value) ?? 0) + segment.weight);
    return map;
  }, new Map<number, number>())
)
  .map(([value, weight]) => ({
    value,
    label: `+${value}`,
    chance: (weight / DAILY_WHEEL_TOTAL_WEIGHT) * 100,
  }))
  .sort((a, b) => b.value - a.value);
const REFERRAL_STEPS = [
  { label: 'Вход', orders: 0, reward: 10 },
  { label: '5 заказов', orders: 5, reward: 30 },
  { label: '15 заказов', orders: 15, reward: 60 },
  { label: '30 заказов', orders: 30, reward: 100 },
];

const getRankTier = (totalEarned: number) => {
  let current = RANKS[0];
  for (const rank of RANKS) {
    if (totalEarned >= rank.minTotal) current = rank;
  }
  return current;
};

const calculateBasePayout = (value: number) => {
  const payout = Math.round(value * (1 - PLATFORM_FEE_RATE));
  return Math.max(1, Math.min(value, payout));
};

const calculatePayoutWithBonus = (value: number, bonusRate: number) => {
  const base = calculateBasePayout(value);
  const bonus = Math.round(base * bonusRate);
  return Math.max(1, Math.min(value, base + bonus));
};

const BOT_SETUP_CHANNEL_URL = 'https://t.me/JoinRush_bot?startchannel=setup';
const BOT_SETUP_GROUP_URL =
  'https://t.me/JoinRush_bot?startgroup&admin=invite_users+restrict_members+delete_messages+pin_messages+manage_chat+manage_topics';
const TOP_UP_MANAGER_USERNAME = 'Nitchim';
const TOP_UP_PACKAGES = [
  { points: 500, priceRub: 100 },
  { points: 1000, priceRub: 190 },
  { points: 2500, priceRub: 450 },
  { points: 5000, priceRub: 800 },
] as const;
type TopUpPackage = (typeof TOP_UP_PACKAGES)[number];
const formatPointsLabel = (value: number) => {
  const abs = Math.abs(value);
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'баллов';
  const mod10 = abs % 10;
  if (mod10 === 1) return 'балл';
  if (mod10 >= 2 && mod10 <= 4) return 'балла';
  return 'баллов';
};
const formatSigned = (value: number) => (value > 0 ? `+${value}` : `${value}`);
const formatNumberRu = (value: number) =>
  Math.max(0, Math.floor(value)).toLocaleString('ru-RU');
const formatNounRu = (value: number, one: string, two: string, many: string) => {
  const abs = Math.abs(Math.floor(value));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = abs % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return two;
  return many;
};
const formatActionsCountRu = (value: number) =>
  `${formatNumberRu(value)} ${formatNounRu(value, 'действие', 'действия', 'действий')}`;
const formatDateTimeRu = (value: string) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'н/д';
  return new Date(parsed).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};
const formatDateRu = (value: string) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'н/д';
  return new Date(parsed).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
  });
};
const formatPercentRu = (value: number, digits = 1) => {
  if (!Number.isFinite(value)) return '0%';
  const normalized = Number(value.toFixed(digits));
  if (Number.isInteger(normalized)) return `${normalized}%`;
  return `${normalized.toFixed(digits)}%`;
};
const formatSignedPercentRu = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'н/д';
  const normalized = Number(value.toFixed(1));
  if (normalized > 0) return `+${normalized}%`;
  if (normalized < 0) return `${normalized}%`;
  return '0%';
};
type AdminPeriodPreset = 'today' | '7d' | '30d';
const ADMIN_PERIOD_OPTIONS: Array<{ id: AdminPeriodPreset; label: string }> = [
  { id: 'today', label: 'Сегодня' },
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
];
type AdminSectionId = 'overview' | 'campaigns' | 'applications' | 'economy' | 'risks';
const ADMIN_SECTION_OPTIONS: Array<{ id: AdminSectionId; label: string }> = [
  { id: 'overview', label: 'Обзор' },
  { id: 'campaigns', label: 'Кампании' },
  { id: 'applications', label: 'Заявки' },
  { id: 'economy', label: 'Экономика' },
  { id: 'risks', label: 'Риски' },
];
type AdminModerationBlockMode = 'none' | 'temporary' | 'permanent';
type AdminModerationFormState = {
  deleteCampaign: boolean;
  fineEnabled: boolean;
  finePoints: string;
  fineReason: string;
  blockMode: AdminModerationBlockMode;
  blockDays: string;
  blockReason: string;
};
const createAdminModerationForm = (): AdminModerationFormState => ({
  deleteCampaign: false,
  fineEnabled: false,
  finePoints: '',
  fineReason: '',
  blockMode: 'none',
  blockDays: '7',
  blockReason: '',
});
type PromoWizardStepId = 'project' | 'reactionLink' | 'budget' | 'review';
type ReactionLinkValidationState = 'empty' | 'invalid' | 'foreign_project' | 'valid';
type ParsedReactionPostLink = {
  scope: 'username' | 'chat';
  projectKey: string;
  messageId: number;
};
const getTrendDirectionLabel = (direction: 'up' | 'down' | 'flat') => {
  if (direction === 'up') return 'Рост';
  if (direction === 'down') return 'Падение';
  return 'Без изменений';
};
const getTrendDirectionSign = (direction: 'up' | 'down' | 'flat') => {
  if (direction === 'up') return '▲';
  if (direction === 'down') return '▼';
  return '•';
};
const getAlertToneClass = (level: 'info' | 'warning' | 'critical') => {
  if (level === 'critical') return 'critical';
  if (level === 'warning') return 'warning';
  return 'info';
};
const formatCampaignTypeRu = (value: 'SUBSCRIBE' | 'REACTION') =>
  value === 'REACTION' ? 'Реакции' : 'Подписки';
const formatCampaignStatusRu = (value: 'ACTIVE' | 'PAUSED' | 'COMPLETED') => {
  if (value === 'ACTIVE') return 'Активна';
  if (value === 'PAUSED') return 'Пауза';
  return 'Завершена';
};
const formatApplicationStatusRu = (value: 'APPROVED' | 'REJECTED') =>
  value === 'APPROVED' ? 'Одобрено' : 'Отклонено';
const getHealthTone = (score: number) => {
  if (score >= 90) return 'good';
  if (score >= 75) return 'warn';
  return 'critical';
};

const getBlockedPayloadFromError = (error: unknown): BlockedPayload | null => {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.status !== 423) return null;
  const payload = error.payload as
    | {
        error?: unknown;
        blocked?: unknown;
      }
    | null;
  if (!payload || payload.error !== 'user_blocked') return null;
  if (!payload.blocked || typeof payload.blocked !== 'object') return null;
  const blocked = payload.blocked as {
    reason?: unknown;
    blockedUntil?: unknown;
    isPermanent?: unknown;
  };
  return {
    reason: typeof blocked.reason === 'string' ? blocked.reason : null,
    blockedUntil: typeof blocked.blockedUntil === 'string' ? blocked.blockedUntil : null,
    isPermanent: Boolean(blocked.isPermanent),
  };
};

const copyTextToClipboard = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error('Не удалось скопировать ссылку.');
  }
};

const formatCountdown = (ms: number) => {
  if (!Number.isFinite(ms) || ms <= 0) return 'сейчас';
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}д ${remHours}ч`;
  }
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${seconds}с`;
  return `${seconds}с`;
};

const getTodayStamp = () => new Date().toISOString().slice(0, 10);

const readPointsToday = (key: string) => {
  if (!key) return 0;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { date?: string; value?: number } | null;
    if (!parsed || parsed.date !== getTodayStamp()) return 0;
    return typeof parsed.value === 'number' ? parsed.value : 0;
  } catch {
    return 0;
  }
};

const writePointsToday = (key: string, value: number) => {
  if (!key) return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        date: getTodayStamp(),
        value,
      })
    );
  } catch {
    // ignore
  }
};

const getWheelTargetRotation = (currentRotation: number, index: number, sectorOffset = 0) => {
  const normalizedCurrent = ((currentRotation % 360) + 360) % 360;
  const targetAngle =
    ((DAILY_WHEEL_BASE_ROTATION - index * DAILY_WHEEL_SLICE + sectorOffset) % 360 + 360) % 360;
  const delta =
    DAILY_WHEEL_SPIN_TURNS * 360 + ((targetAngle - normalizedCurrent + 360) % 360);
  return currentRotation + delta;
};

const resolveWheelRewardIndex = (rawIndex: number, rewardValue: number) => {
  const clamped = Math.max(
    0,
    Math.min(DAILY_WHEEL_SEGMENTS.length - 1, Math.round(Number.isFinite(rawIndex) ? rawIndex : 0))
  );
  if (rewardValue <= 0) return clamped;
  if (DAILY_WHEEL_SEGMENTS[clamped]?.value === rewardValue) return clamped;
  const valueMatchedIndex = DAILY_WHEEL_SEGMENTS.findIndex((segment) => segment.value === rewardValue);
  return valueMatchedIndex >= 0 ? valueMatchedIndex : clamped;
};

const getWheelNaturalProgress = (rawProgress: number) => {
  const progress = Math.min(1, Math.max(0, rawProgress));
  const launchArea = DAILY_WHEEL_LAUNCH_END / 2;
  const cruiseArea = Math.max(0, DAILY_WHEEL_BRAKE_START - DAILY_WHEEL_LAUNCH_END);
  const brakeAreaTotal =
    DAILY_WHEEL_BRAKE_DECAY *
    (1 - Math.exp(-(1 - DAILY_WHEEL_BRAKE_START) / DAILY_WHEEL_BRAKE_DECAY));
  const totalArea = launchArea + cruiseArea + brakeAreaTotal;

  if (progress <= DAILY_WHEEL_LAUNCH_END) {
    const launchAreaNow = (progress * progress) / (2 * DAILY_WHEEL_LAUNCH_END);
    return launchAreaNow / totalArea;
  }

  if (progress <= DAILY_WHEEL_BRAKE_START) {
    const cruiseAreaNow = progress - DAILY_WHEEL_LAUNCH_END;
    return (launchArea + cruiseAreaNow) / totalArea;
  }

  const brakeElapsed = progress - DAILY_WHEEL_BRAKE_START;
  const brakeAreaNow = DAILY_WHEEL_BRAKE_DECAY * (1 - Math.exp(-brakeElapsed / DAILY_WHEEL_BRAKE_DECAY));
  return Math.min(1, (launchArea + cruiseArea + brakeAreaNow) / totalArea);
};

const getRandomUnit = () => {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] / 0xffffffff;
  }
  return Math.random();
};

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

const easeOutCubic = (value: number) => 1 - (1 - value) ** 3;

const easeInOutCubic = (value: number) =>
  value < 0.5 ? 4 * value * value * value : 1 - ((-2 * value + 2) ** 3) / 2;

const getWheelStopOffset = () => {
  const halfSlice = DAILY_WHEEL_SLICE / 2;
  const inset = DAILY_WHEEL_SLICE * DAILY_WHEEL_STOP_INSET_RATIO;
  const maxOffset = Math.max(halfSlice * 0.28, halfSlice - inset);
  return (getRandomUnit() * 2 - 1) * maxOffset;
};

const parseFiniteNumber = (value: unknown) => {
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : null;
};

const normalizeUsername = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/^@+/, '') : '';

const normalizeTelegramChatId = (value: unknown) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^-100\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `-100${trimmed}`;
  return '';
};

const parseReactionPostLink = (rawLink: string): ParsedReactionPostLink | null => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawLink);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:') return null;
  const host = parsedUrl.hostname.toLowerCase();
  if (host !== 't.me' && host !== 'www.t.me' && host !== 'telegram.me' && host !== 'www.telegram.me') {
    return null;
  }
  const parts = parsedUrl.pathname
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0].toLowerCase() === 'c') {
    if (parts.length < 3) return null;
    const internalId = parts[1];
    const messageId = parts[2];
    if (!/^\d+$/.test(internalId) || !/^\d+$/.test(messageId)) return null;
    const normalizedChatId = normalizeTelegramChatId(internalId);
    if (!normalizedChatId) return null;
    return {
      scope: 'chat',
      projectKey: normalizedChatId,
      messageId: Number(messageId),
    };
  }
  const username = normalizeUsername(parts[0]).toLowerCase();
  const messageId = parts[1];
  if (!/^[a-z0-9_]{3,64}$/i.test(username) || !/^\d+$/.test(messageId)) return null;
  return {
    scope: 'username',
    projectKey: username,
    messageId: Number(messageId),
  };
};

const isDevVisualAdminEnabled = () => {
  if (!import.meta.env.DEV) return false;
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('jrVisualAdmin') === '1';
  } catch {
    return false;
  }
};

const extractUsernameFromInitData = (rawInitData: string) => {
  if (!rawInitData) return '';
  try {
    const params = new URLSearchParams(rawInitData);
    const userRaw = params.get('user');
    if (!userRaw) return '';
    const parsed = JSON.parse(userRaw) as { username?: unknown } | null;
    return normalizeUsername(parsed?.username);
  } catch {
    return '';
  }
};

const extractUsernameFromTelegramUnsafe = () => {
  try {
    const username = (window as any)?.Telegram?.WebApp?.initDataUnsafe?.user?.username;
    return normalizeUsername(username);
  } catch {
    return '';
  }
};

const isPrivilegedAdminUsername = (username: string) =>
  username.toLowerCase() === TOP_UP_MANAGER_USERNAME.toLowerCase();

type TaskActionSheetMode = 'actions' | 'report';
const TASK_REPORT_REASON_OPTIONS: Array<{
  reason: CampaignReportReason;
  label: string;
}> = [
  { reason: 'SPAM_SCAM', label: 'Спам или скам' },
  { reason: 'FAKE_TASK', label: 'Фейковое/обманчивое задание' },
  { reason: 'BROKEN_LINK', label: 'Ссылка не работает' },
  { reason: 'PROHIBITED_CONTENT', label: 'Запрещенный контент' },
  { reason: 'OTHER', label: 'Другое' },
];

const TaskAvatar = ({
  group,
  getAvatarUrl,
}: {
  group: GroupDto;
  getAvatarUrl: (group: GroupDto) => string;
}) => {
  const avatarUrl = getAvatarUrl(group);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [avatarUrl]);

  const hasPhoto = Boolean(avatarUrl) && !broken;
  return (
    <div className={`task-avatar ${hasPhoto ? 'has-photo' : ''}`}>
      {hasPhoto ? (
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : null}
      <span>{group.title?.[0] ?? 'Г'}</span>
    </div>
  );
};

export default function App() {
  const [userLabel, setUserLabel] = useState(() => getUserLabel());
  const [userPhoto, setUserPhoto] = useState(() => getUserPhotoUrl());
  const [points, setPoints] = useState(30);
  const [pointsToday, setPointsToday] = useState(0);
  const [totalEarned, setTotalEarned] = useState(0);
  const [userId, setUserId] = useState('');
  const [tgUsername, setTgUsername] = useState('');
  const [activeTab, setActiveTab] = useState<
    'home' | 'promo' | 'tasks' | 'wheel' | 'referrals' | 'admin'
  >('home');
  const [dailyBonusStatus, setDailyBonusStatus] = useState<DailyBonusStatus>({
    available: false,
    lastSpinAt: null,
    nextAvailableAt: null,
    cooldownMs: DAILY_BONUS_FALLBACK_MS,
    streak: 0,
  });
  const [dailyBonusLoading, setDailyBonusLoading] = useState(false);
  const [dailyBonusError, setDailyBonusError] = useState('');
  const [dailyBonusInfoOpen, setDailyBonusInfoOpen] = useState(false);
  const [referralInfoOpen, setReferralInfoOpen] = useState(false);
  const [topUpModalOpen, setTopUpModalOpen] = useState(false);
  const [referralStats, setReferralStats] = useState<ReferralStats | null>(null);
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralError, setReferralError] = useState('');
  const [referralList, setReferralList] = useState<ReferralListItem[]>([]);
  const [referralListLoading, setReferralListLoading] = useState(false);
  const [referralListError, setReferralListError] = useState('');
  const [adminPanelAllowed, setAdminPanelAllowed] = useState(false);
  const [adminPanelLoading, setAdminPanelLoading] = useState(false);
  const [adminPanelError, setAdminPanelError] = useState('');
  const [adminPanelStats, setAdminPanelStats] = useState<AdminPanelStats | null>(null);
  const [adminPeriod, setAdminPeriod] = useState<AdminPeriodPreset>('today');
  const [adminSection, setAdminSection] = useState<AdminSectionId>('overview');
  const [adminModerationSnapshot, setAdminModerationSnapshot] =
    useState<AdminModerationSnapshot | null>(null);
  const [adminModerationLoading, setAdminModerationLoading] = useState(false);
  const [adminModerationError, setAdminModerationError] = useState('');
  const [adminModerationForms, setAdminModerationForms] = useState<
    Record<string, AdminModerationFormState>
  >({});
  const [adminModerationActionId, setAdminModerationActionId] = useState('');
  const [adminStaleCleanupLoading, setAdminStaleCleanupLoading] = useState(false);
  const [adminUnblockUserId, setAdminUnblockUserId] = useState('');
  const [blockedState, setBlockedState] = useState<BlockedPayload | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [welcomeBonus, setWelcomeBonus] = useState<ReferralBonus | null>(null);
  const [wheelRotation, setWheelRotation] = useState(DAILY_WHEEL_BASE_ROTATION);
  const [wheelSpinning, setWheelSpinning] = useState(false);
  const [wheelSpinPhase, setWheelSpinPhase] = useState<
    'idle' | 'launch' | 'cruise' | 'brake' | 'celebrate'
  >('idle');
  const [wheelWinningIndex, setWheelWinningIndex] = useState<number | null>(null);
  const [wheelCelebrating, setWheelCelebrating] = useState(false);
  const [wheelRewardBurst, setWheelRewardBurst] = useState(false);
  const [wheelRewardModalOpen, setWheelRewardModalOpen] = useState(false);
  const [wheelResult, setWheelResult] = useState<{ label: string; value: number } | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [taskTypeFilter, setTaskTypeFilter] = useState<'subscribe' | 'reaction'>('subscribe');
  const [taskListFilter, setTaskListFilter] = useState<'hot' | 'new' | 'history'>('new');
  const [myTasksTab, setMyTasksTab] = useState<'place' | 'mine'>('place');
  const [promoWizardOpen, setPromoWizardOpen] = useState(false);
  const [promoWizardStep, setPromoWizardStep] = useState<PromoWizardStepId>('project');
  const [taskType, setTaskType] = useState<'subscribe' | 'reaction'>('subscribe');
  const [reactionLink, setReactionLink] = useState('');
  const [taskPriceInput, setTaskPriceInput] = useState('10');
  const [taskCount, setTaskCount] = useState(1);
  const [createError, setCreateError] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionLoadingId, setActionLoadingId] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedGroupTitle, setSelectedGroupTitle] = useState('');
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [myGroups, setMyGroups] = useState<GroupDto[]>([]);
  const [myGroupsLoaded, setMyGroupsLoaded] = useState(false);
  const [myGroupsLoading, setMyGroupsLoading] = useState(false);
  const [myGroupsError, setMyGroupsError] = useState('');
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState('');
  const [myCampaigns, setMyCampaigns] = useState<CampaignDto[]>([]);
  const [myCampaignsLoading, setMyCampaignsLoading] = useState(false);
  const [myCampaignsError, setMyCampaignsError] = useState('');
  const [applications, setApplications] = useState<ApplicationDto[]>([]);
  const [applicationsLoading, setApplicationsLoading] = useState(false);
  const [applicationsError, setApplicationsError] = useState('');
  const [applicationsFetched, setApplicationsFetched] = useState(false);
  const [hiddenCampaignIds, setHiddenCampaignIds] = useState<string[]>([]);
  const [leavingIds, setLeavingIds] = useState<string[]>([]);
  const [acknowledgedIds, setAcknowledgedIds] = useState<string[]>([]);
  const [taskActionSheetCampaign, setTaskActionSheetCampaign] = useState<CampaignDto | null>(null);
  const [taskActionSheetMode, setTaskActionSheetMode] = useState<TaskActionSheetMode>('actions');
  const [taskActionSheetLoading, setTaskActionSheetLoading] = useState(false);
  const [taskActionSheetError, setTaskActionSheetError] = useState('');
  const resumeRefreshAtRef = useRef(0);
  const applicationsRequestedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const linkPickerRef = useRef<HTMLDivElement | null>(null);
  const balanceValueRef = useRef<HTMLSpanElement | null>(null);
  const historyTabRef = useRef<HTMLButtonElement | null>(null);
  const taskCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const taskBadgeRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const acknowledgedKeyRef = useRef('');
  const pointsTodayKeyRef = useRef('');
  const animatingOutRef = useRef<Set<string>>(new Set());
  const wheelRotationRef = useRef(DAILY_WHEEL_BASE_ROTATION);
  const wheelRotorRef = useRef<HTMLDivElement | null>(null);
  const spinFrameRef = useRef<number | null>(null);
  const spinPhaseCruiseTimeoutRef = useRef<number | null>(null);
  const spinPhaseBrakeTimeoutRef = useRef<number | null>(null);
  const wheelCelebrateTimeoutRef = useRef<number | null>(null);
  const wheelRewardBurstTimeoutRef = useRef<number | null>(null);
  const wheelRewardRevealTimeoutRef = useRef<number | null>(null);
  const inviteCopyTimeoutRef = useRef<number | null>(null);
  const welcomeTimeoutRef = useRef<number | null>(null);
  const applicationsByCampaign = useMemo(() => {
    const map = new Map<string, ApplicationDto>();
    applications.forEach((application) => {
      map.set(application.campaign.id, application);
    });
    return map;
  }, [applications]);
  const rankTier = useMemo(() => getRankTier(totalEarned), [totalEarned]);
  const bonusPercent = Math.round(rankTier.bonusRate * 100);
  const nextRank = useMemo(() => {
    const index = RANKS.findIndex((rank) => rank.level === rankTier.level);
    if (index < 0 || index >= RANKS.length - 1) return null;
    return RANKS[index + 1];
  }, [rankTier.level]);
  const progressLabel = nextRank
    ? `До Повышения: ${Math.max(0, nextRank.minTotal - totalEarned)} баллов`
    : 'До Повышения: максимум';
  const progressValue = useMemo(() => {
    if (!nextRank) return 1;
    const span = Math.max(1, nextRank.minTotal - rankTier.minTotal);
    const progress = (totalEarned - rankTier.minTotal) / span;
    return Math.min(1, Math.max(0, progress));
  }, [nextRank, rankTier.minTotal, totalEarned]);
  const calculatePayout = useCallback(
    (value: number) => calculatePayoutWithBonus(value, rankTier.bonusRate),
    [rankTier.bonusRate]
  );
  const bumpPointsToday = useCallback((delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    setPointsToday((prev) => {
      const key = pointsTodayKeyRef.current;
      const base = key ? readPointsToday(key) : prev;
      const next = Math.max(0, base + delta);
      if (key) writePointsToday(key, next);
      return next;
    });
  }, []);
  const activeCampaignIds = useMemo(
    () => new Set(campaigns.map((campaign) => campaign.id)),
    [campaigns]
  );
  const hiddenCampaignIdsSet = useMemo(() => new Set(hiddenCampaignIds), [hiddenCampaignIds]);
  const pendingPayoutTotal = useMemo(() => {
    const acknowledged = new Set(acknowledgedIds);
    return applications.reduce((sum, application) => {
      if (application.status !== 'APPROVED') return sum;
      if (!activeCampaignIds.has(application.campaign.id)) return sum;
      if (acknowledged.has(application.campaign.id)) return sum;
      return sum + calculatePayout(application.campaign.rewardPoints);
    }, 0);
  }, [applications, acknowledgedIds, calculatePayout, activeCampaignIds]);
  const displayPoints = useMemo(
    () => Math.max(0, points - pendingPayoutTotal),
    [points, pendingPayoutTotal]
  );
  const nextAvailableAtMs = useMemo(() => {
    if (!dailyBonusStatus.nextAvailableAt) return null;
    const parsed = Date.parse(dailyBonusStatus.nextAvailableAt);
    return Number.isNaN(parsed) ? null : parsed;
  }, [dailyBonusStatus.nextAvailableAt]);
  const timeLeftMs = useMemo(() => {
    if (!nextAvailableAtMs) return 0;
    return Math.max(0, nextAvailableAtMs - clockNow);
  }, [nextAvailableAtMs, clockNow]);
  const dailyBonusAvailable = !nextAvailableAtMs || timeLeftMs <= 0;
  const dailyBonusTimerLabel = dailyBonusLoading
    ? 'Проверяем доступность...'
    : dailyBonusAvailable
      ? 'Доступно сейчас'
      : `Доступно через ${formatCountdown(timeLeftMs)}`;
  const wheelTimerValue = dailyBonusLoading
    ? 'проверяем...'
    : dailyBonusAvailable
      ? 'сейчас'
      : formatCountdown(timeLeftMs);
  const wheelTimerPrefix = dailyBonusAvailable
    ? 'Следующая попытка:'
    : 'Следующая попытка через:';
  const dailyStreak = Math.max(0, dailyBonusStatus.streak ?? 0);
  const nextSpinClockLabel = useMemo(() => {
    if (dailyBonusAvailable || !nextAvailableAtMs) return 'сейчас';
    return new Date(nextAvailableAtMs).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [dailyBonusAvailable, nextAvailableAtMs]);
  const homeDailyBonusLabel = dailyBonusAvailable
    ? 'Готово к прокрутке'
    : `${dailyBonusTimerLabel} · ${nextSpinClockLabel}`;
  const referralMaxRewardPerFriend = useMemo(
    () => REFERRAL_STEPS.reduce((sum, step) => sum + step.reward, 0),
    []
  );
  const referralInvitedCount = referralStats?.stats.invited ?? 0;
  const referralEarnedTotal = referralStats?.stats.earned ?? 0;
  const referralAveragePerFriend =
    referralInvitedCount > 0 ? Math.round(referralEarnedTotal / referralInvitedCount) : 0;
  const referralPotentialTotal = referralInvitedCount * referralMaxRewardPerFriend;
  const referralPotentialProgress =
    referralPotentialTotal > 0
      ? Math.min(100, Math.round((referralEarnedTotal / referralPotentialTotal) * 100))
      : 0;
  const referralBestOrders = useMemo(
    () =>
      referralList.reduce((max, item) => {
        if (!Number.isFinite(item.completedOrders)) return max;
        return Math.max(max, Math.max(0, item.completedOrders));
      }, 0),
    [referralList]
  );
  const referralHasInvites = referralInvitedCount > 0 || referralList.length > 0;
  const referralLink = referralStats?.link ?? '';
  const referralLinkAvailable = Boolean(referralLink);
  const referralShareHint = inviteCopied
    ? 'Ссылка скопирована. Отправьте её другу в чат.'
    : referralLinkAvailable
      ? 'Откроем Telegram и отправим приглашение.'
      : 'Ссылка станет доступна после входа в Telegram Mini App.';
  const adminOverview = adminPanelStats?.overview ?? null;
  const adminPeriodMeta = adminPanelStats?.period ?? null;
  const adminBonusProgress = useMemo(() => {
    if (!adminPanelStats) return 0;
    const granted = adminPanelStats.overview?.welcomeBonusGranted ?? adminPanelStats.bonusGranted;
    const limit = adminPanelStats.overview?.welcomeBonusLimit ?? adminPanelStats.bonusLimit;
    if (limit <= 0) return 0;
    const progress = (granted / limit) * 100;
    return Math.max(0, Math.min(100, Math.round(progress)));
  }, [adminPanelStats]);
  const adminUpdatedAtLabel = useMemo(() => {
    if (!adminPanelStats?.updatedAt) return 'н/д';
    const value = adminPanelStats.period?.updatedAt ?? adminPanelStats.updatedAt;
    return formatDateTimeRu(value);
  }, [adminPanelStats]);
  const adminPeriodRangeLabel = useMemo(() => {
    if (!adminPeriodMeta) return '';
    return `${formatDateRu(adminPeriodMeta.from)} — ${formatDateRu(adminPeriodMeta.to)}`;
  }, [adminPeriodMeta]);
  const normalizeTaskPrice = useCallback((value: number) => {
    const rounded = Math.round(value);
    return Math.min(MAX_TASK_PRICE, Math.max(MIN_TASK_PRICE, rounded));
  }, []);
  const parsedTaskPrice = useMemo(() => {
    if (!taskPriceInput.trim()) return null;
    const parsed = Number(taskPriceInput);
    return Number.isFinite(parsed) ? parsed : null;
  }, [taskPriceInput]);
  const adjustTaskPrice = useCallback(
    (delta: number) => {
      const basePrice = parsedTaskPrice ?? MIN_TASK_PRICE;
      setTaskPriceInput(String(normalizeTaskPrice(basePrice + delta)));
    },
    [parsedTaskPrice, normalizeTaskPrice]
  );
  const taskPriceValue = parsedTaskPrice ?? 0;
  const balanceAffordableCount = useMemo(() => {
    if (!Number.isFinite(taskPriceValue) || taskPriceValue <= 0) return 0;
    return Math.max(0, Math.floor(displayPoints / taskPriceValue));
  }, [displayPoints, taskPriceValue]);
  const budgetAffordableCount = useMemo(() => {
    if (!Number.isFinite(taskPriceValue) || taskPriceValue <= 0) return 0;
    return Math.max(0, Math.floor(MAX_TOTAL_BUDGET / taskPriceValue));
  }, [taskPriceValue]);
  const maxAffordableCount = useMemo(() => {
    if (!Number.isFinite(taskPriceValue) || taskPriceValue <= 0) return 1;
    return Math.max(1, Math.min(balanceAffordableCount, budgetAffordableCount));
  }, [balanceAffordableCount, budgetAffordableCount, taskPriceValue]);
  const totalBudget = useMemo(() => taskPriceValue * taskCount, [taskPriceValue, taskCount]);
  const affordableCountHint = useMemo(() => {
    if (!Number.isFinite(taskPriceValue) || taskPriceValue <= 0) {
      return 'Укажите цену за действие.';
    }
    if (balanceAffordableCount <= 0) {
      return 'На балансе пока недостаточно для 1 действия.';
    }
    if (balanceAffordableCount < budgetAffordableCount) {
      return `По балансу доступно до ${formatActionsCountRu(balanceAffordableCount)}.`;
    }
    return `Лимит по бюджету: до ${formatActionsCountRu(budgetAffordableCount)}.`;
  }, [balanceAffordableCount, budgetAffordableCount, taskPriceValue]);
  const minPayoutPreview = useMemo(() => {
    if (!parsedTaskPrice || parsedTaskPrice <= 0) return 0;
    return calculateBasePayout(parsedTaskPrice);
  }, [parsedTaskPrice]);
  const maxPayoutPreview = useMemo(
    () =>
      parsedTaskPrice && parsedTaskPrice > 0
        ? calculatePayoutWithBonus(parsedTaskPrice, MAX_BONUS_RATE)
        : 0,
    [parsedTaskPrice]
  );
  const selectedProjectLabel = selectedGroupTitle || 'Проект не выбран';
  const selectedGroupEntity = useMemo(
    () => myGroups.find((group) => group.id === selectedGroupId) ?? null,
    [myGroups, selectedGroupId]
  );
  const reactionLinkTrimmed = reactionLink.trim();
  const reactionLinkValidation = useMemo<{ state: ReactionLinkValidationState; label: string; hint: string }>(
    () => {
      if (taskType !== 'reaction') {
        return {
          state: 'valid',
          label: 'OK',
          hint: 'Для подписки ссылка на пост не требуется.',
        };
      }
      if (!reactionLinkTrimmed) {
        return {
          state: 'empty',
          label: 'Добавьте ссылку',
          hint: 'Добавьте ссылку на пост, чтобы перейти к бюджету.',
        };
      }
      const parsedLink = parseReactionPostLink(reactionLinkTrimmed);
      if (!parsedLink) {
        return {
          state: 'invalid',
          label: 'Неверный формат',
          hint: 'Используйте ссылку вида https://t.me/username/123 или https://t.me/c/123456/789.',
        };
      }
      const projectUsername = normalizeUsername(selectedGroupEntity?.username).toLowerCase();
      const projectChatId = normalizeTelegramChatId(selectedGroupEntity?.telegramChatId);
      if (parsedLink.scope === 'username' && projectUsername && parsedLink.projectKey !== projectUsername) {
        return {
          state: 'foreign_project',
          label: 'Не из выбранного проекта',
          hint: 'Ссылка ведет на другой проект. Выберите нужный проект или замените ссылку.',
        };
      }
      if (parsedLink.scope === 'chat' && projectChatId && parsedLink.projectKey !== projectChatId) {
        return {
          state: 'foreign_project',
          label: 'Не из выбранного проекта',
          hint: 'Ссылка ведет на другой проект. Выберите нужный проект или замените ссылку.',
        };
      }
      return {
        state: 'valid',
        label: 'OK',
        hint:
          parsedLink.scope === 'chat' && !projectChatId
            ? 'OK. Формат корректен, принадлежность поста проверим при запуске.'
            : 'OK. Ссылка подходит для выбранного проекта.',
      };
    },
    [reactionLinkTrimmed, selectedGroupEntity, taskType]
  );
  const isProjectSelected = Boolean(selectedGroupId);
  const createCtaState = useMemo(() => {
    if (!selectedGroupId) return { blocked: true, label: 'Выберите проект' };
    if (taskType === 'reaction' && reactionLinkValidation.state !== 'valid') {
      return { blocked: true, label: 'Проверьте ссылку' };
    }
    if (parsedTaskPrice === null || !Number.isFinite(parsedTaskPrice)) {
      return { blocked: true, label: 'Проверьте цену' };
    }
    if (parsedTaskPrice < MIN_TASK_PRICE || parsedTaskPrice > MAX_TASK_PRICE) {
      return { blocked: true, label: 'Проверьте цену' };
    }
    if (!Number.isFinite(taskCount) || taskCount < 1 || taskCount > maxAffordableCount) {
      return { blocked: true, label: 'Проверьте объем' };
    }
    if (totalBudget > MAX_TOTAL_BUDGET) {
      return { blocked: true, label: 'Сократите бюджет' };
    }
    if (displayPoints < totalBudget) {
      return { blocked: true, label: 'Пополните баланс' };
    }
    return { blocked: false, label: 'Создать' };
  }, [
    displayPoints,
    maxAffordableCount,
    parsedTaskPrice,
    reactionLinkValidation.state,
    selectedGroupId,
    taskCount,
    taskType,
    totalBudget,
  ]);
  const hasReactionLink = taskType === 'subscribe' || reactionLinkValidation.state === 'valid';
  const isTaskPriceValid =
    parsedTaskPrice !== null &&
    Number.isFinite(parsedTaskPrice) &&
    parsedTaskPrice >= MIN_TASK_PRICE &&
    parsedTaskPrice <= MAX_TASK_PRICE;
  const isTaskCountValid =
    Number.isFinite(taskCount) && taskCount >= 1 && taskCount <= maxAffordableCount;
  const canProceedBudget = isTaskPriceValid && isTaskCountValid && totalBudget <= MAX_TOTAL_BUDGET;
  const formatSummaryLabel =
    taskType === 'subscribe'
      ? 'Подписка'
      : hasReactionLink
        ? 'Реакция · ссылка подтверждена'
        : 'Реакция · ссылка требует проверки';
  const remainingPointsAfterLaunch = Math.max(0, displayPoints - totalBudget);
  const budgetSummaryLabel = `${formatNumberRu(taskPriceValue)} ${formatPointsLabel(taskPriceValue)} × ${formatActionsCountRu(taskCount)} = ${formatNumberRu(totalBudget)} ${formatPointsLabel(totalBudget)}`;
  const promoWizardSteps = useMemo<
    Array<{ id: PromoWizardStepId; label: string; shortLabel: string }>
  >(
    () =>
      taskType === 'reaction'
        ? [
            { id: 'project', label: 'Проект', shortLabel: 'Проект' },
            { id: 'reactionLink', label: 'Ссылка на пост', shortLabel: 'Пост' },
            { id: 'budget', label: 'Бюджет и объем', shortLabel: 'Бюджет' },
            { id: 'review', label: 'Проверка и запуск', shortLabel: 'Запуск' },
          ]
        : [
            { id: 'project', label: 'Проект', shortLabel: 'Проект' },
            { id: 'budget', label: 'Бюджет и объем', shortLabel: 'Бюджет' },
            { id: 'review', label: 'Проверка и запуск', shortLabel: 'Запуск' },
          ],
    [taskType]
  );
  const promoWizardStepIndex = Math.max(
    0,
    promoWizardSteps.findIndex((item) => item.id === promoWizardStep)
  );
  const promoWizardStepTotal = promoWizardSteps.length;
  const promoWizardCurrentStep = promoWizardSteps[promoWizardStepIndex] ?? promoWizardSteps[0];
  const promoWizardCanGoBack = promoWizardStepIndex > 0;
  const promoWizardCanGoNext = useMemo(() => {
    if (promoWizardCurrentStep.id === 'project') return isProjectSelected;
    if (promoWizardCurrentStep.id === 'reactionLink') return reactionLinkValidation.state === 'valid';
    if (promoWizardCurrentStep.id === 'budget') return canProceedBudget;
    return !createCtaState.blocked;
  }, [
    canProceedBudget,
    createCtaState.blocked,
    isProjectSelected,
    promoWizardCurrentStep.id,
    reactionLinkValidation.state,
  ]);
  const promoWizardPrimaryLabel = useMemo(() => {
    if (promoWizardCurrentStep.id === 'review') {
      if (createLoading) return 'Создание…';
      if (!createCtaState.blocked) return 'Запустить кампанию';
      return createCtaState.label;
    }
    return 'Далее';
  }, [createCtaState.blocked, createCtaState.label, createLoading, promoWizardCurrentStep.id]);
  const promoWizardPrimaryDisabled =
    createLoading ||
    (promoWizardCurrentStep.id === 'review'
      ? createCtaState.blocked && createCtaState.label !== 'Пополните баланс'
      : !promoWizardCanGoNext);
  const promoWizardSecondaryLabel = promoWizardCanGoBack ? 'Назад' : 'Закрыть';
  const rangeProgress = useMemo(() => {
    const min = 1;
    const max = maxAffordableCount;
    if (max <= min) return '100%';
    const pct = ((taskCount - min) / (max - min)) * 100;
    const clamped = Math.min(100, Math.max(0, pct));
    return `${clamped}%`;
  }, [taskCount, maxAffordableCount]);
  const activeCampaigns = useMemo(() => {
    const acknowledgedSet = new Set(acknowledgedIds);
    return campaigns.filter((campaign) => {
      if (hiddenCampaignIdsSet.has(campaign.id)) return false;
      const status = applicationsByCampaign.get(campaign.id)?.status;
      if (status === 'APPROVED' && acknowledgedSet.has(campaign.id)) return false;
      if (status === 'REJECTED') return false;
      if (userId && campaign.owner?.id && campaign.owner.id === userId) return false;
      return true;
    });
  }, [applicationsByCampaign, campaigns, userId, acknowledgedIds, hiddenCampaignIdsSet]);
  const visibleCampaigns = useMemo(() => {
    const type = taskTypeFilter === 'subscribe' ? 'SUBSCRIBE' : 'REACTION';
    const base = activeCampaigns.filter((campaign) => campaign.actionType === type);
    if (taskListFilter === 'history') return [];
    if (taskListFilter === 'hot') {
      return [...base].sort((a, b) => b.rewardPoints - a.rewardPoints);
    }
    return [...base].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [activeCampaigns, taskListFilter, taskTypeFilter]);
  const taskTypeCampaigns = useMemo(() => {
    const type = taskTypeFilter === 'subscribe' ? 'SUBSCRIBE' : 'REACTION';
    return activeCampaigns.filter((campaign) => campaign.actionType === type);
  }, [activeCampaigns, taskTypeFilter]);
  const historyApplications = useMemo(() => {
    const type = taskTypeFilter === 'subscribe' ? 'SUBSCRIBE' : 'REACTION';
    return applications
      .filter(
        (application) =>
          application.status === 'APPROVED' &&
          application.campaign.actionType === type &&
          !hiddenCampaignIdsSet.has(application.campaign.id)
      )
      .sort(
        (a, b) =>
          new Date(b.reviewedAt ?? b.createdAt).getTime() -
          new Date(a.reviewedAt ?? a.createdAt).getTime()
      );
  }, [applications, taskTypeFilter, hiddenCampaignIdsSet]);
  const taskStatusCounters = useMemo(() => {
    return taskTypeCampaigns.reduce(
      (acc, campaign) => {
        const status = applicationsByCampaign.get(campaign.id)?.status;
        if (status === 'PENDING') acc.pending += 1;
        if (status === 'APPROVED') acc.ready += 1;
        return acc;
      },
      { pending: 0, ready: 0 }
    );
  }, [applicationsByCampaign, taskTypeCampaigns]);
  const taskHintText = useMemo(() => {
    if (taskListFilter === 'history') {
      return `Подтверждено: ${historyApplications.length}. Журнал начислений и завершённых заданий.`;
    }
    if (taskStatusCounters.ready > 0) {
      return `К выдаче: ${taskStatusCounters.ready}. Подтвердите задания с галочкой.`;
    }
    if (taskStatusCounters.pending > 0) {
      return `На проверке: ${taskStatusCounters.pending}. Новые задания можно брать параллельно.`;
    }
    return 'Нажмите «Получить», выполните задание в Telegram и вернитесь за наградой.';
  }, [historyApplications.length, taskListFilter, taskStatusCounters.pending, taskStatusCounters.ready]);

  const initialLetter = useMemo(() => {
    const trimmed = userLabel.trim();
    return trimmed ? trimmed[0].toUpperCase() : 'A';
  }, [userLabel]);

  useLayoutEffect(() => {
    initTelegram();
  }, []);

  useEffect(() => {
    setUserLabel(getUserLabel());
    setUserPhoto(getUserPhotoUrl());
    const initData = getInitDataRaw();
    const username =
      extractUsernameFromInitData(initData) || extractUsernameFromTelegramUnsafe();
    setTgUsername(username);

    const loadProfile = async () => {
      if (!initData) return;

      try {
        const data = await verifyInitData(initData);
        if (typeof data.balance === 'number') setPoints(data.balance);
        if (typeof data.user?.totalEarned === 'number') setTotalEarned(data.user.totalEarned);
        if (typeof data.user?.id === 'string') setUserId(data.user.id);
        if (data.referralBonus?.amount && data.referralBonus.amount > 0 && data.user?.id) {
          const key = `jr:referralWelcomeSeen:${data.user.id}`;
          const seen = localStorage.getItem(key);
          if (!seen) {
            setWelcomeBonus({
              amount: data.referralBonus.amount,
              reason: data.referralBonus.reason,
            });
            localStorage.setItem(key, '1');
          }
        }
      } catch {
        // Keep default zeros on auth failure.
      }
    };

    void loadProfile();
  }, []);

  useEffect(() => {
    if (adminPanelAllowed) return;
    if (isDevVisualAdminEnabled()) {
      setAdminPanelAllowed(true);
      return;
    }
    if (!tgUsername) return;
    if (tgUsername.toLowerCase() !== TOP_UP_MANAGER_USERNAME.toLowerCase()) return;
    setAdminPanelAllowed(true);
  }, [adminPanelAllowed, tgUsername]);

  useEffect(() => {
    wheelRotationRef.current = wheelRotation;
  }, [wheelRotation]);

  useEffect(() => {
    const rotorNode = wheelRotorRef.current;
    if (!rotorNode || wheelSpinning) return;
    rotorNode.style.transform = `rotate(${wheelRotation}deg)`;
  }, [wheelRotation, wheelSpinning, activeTab]);

  useEffect(() => {
    if (!dailyBonusStatus.nextAvailableAt) return;
    const interval = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [dailyBonusStatus.nextAvailableAt]);

  useEffect(() => {
    return () => {
      if (spinFrameRef.current) {
        window.cancelAnimationFrame(spinFrameRef.current);
        spinFrameRef.current = null;
      }
      if (spinPhaseCruiseTimeoutRef.current) {
        window.clearTimeout(spinPhaseCruiseTimeoutRef.current);
      }
      if (spinPhaseBrakeTimeoutRef.current) {
        window.clearTimeout(spinPhaseBrakeTimeoutRef.current);
      }
      if (wheelCelebrateTimeoutRef.current) {
        window.clearTimeout(wheelCelebrateTimeoutRef.current);
      }
      if (wheelRewardBurstTimeoutRef.current) {
        window.clearTimeout(wheelRewardBurstTimeoutRef.current);
      }
      if (wheelRewardRevealTimeoutRef.current) {
        window.clearTimeout(wheelRewardRevealTimeoutRef.current);
      }
      if (inviteCopyTimeoutRef.current) {
        window.clearTimeout(inviteCopyTimeoutRef.current);
      }
      if (welcomeTimeoutRef.current) {
        window.clearTimeout(welcomeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!welcomeBonus) return;
    if (welcomeTimeoutRef.current) {
      window.clearTimeout(welcomeTimeoutRef.current);
    }
    welcomeTimeoutRef.current = window.setTimeout(() => {
      setWelcomeBonus(null);
    }, 5000);
  }, [welcomeBonus]);

  useEffect(() => {
    if (activeTab === 'wheel') return;
    if (wheelRewardBurstTimeoutRef.current) {
      window.clearTimeout(wheelRewardBurstTimeoutRef.current);
      wheelRewardBurstTimeoutRef.current = null;
    }
    if (wheelRewardRevealTimeoutRef.current) {
      window.clearTimeout(wheelRewardRevealTimeoutRef.current);
      wheelRewardRevealTimeoutRef.current = null;
    }
    setWheelRewardBurst(false);
    setWheelRewardModalOpen(false);
    setWheelResult(null);
  }, [activeTab]);

  useEffect(() => {
    if (!Number.isFinite(taskCount)) return;
    if (taskCount > maxAffordableCount) {
      setTaskCount(maxAffordableCount);
    }
  }, [taskCount, maxAffordableCount]);

  useEffect(() => {
    if (!userId) return;
    setHiddenCampaignIds([]);
    setTaskActionSheetCampaign(null);
    setTaskActionSheetMode('actions');
    setTaskActionSheetError('');
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const key = `jr:acknowledgedApprovals:${userId}`;
    acknowledgedKeyRef.current = key;
    let stored: string[] = [];
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          stored = parsed.filter((item) => typeof item === 'string');
        }
      }
    } catch {
      stored = [];
    }
    setAcknowledgedIds(stored);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const key = `jr:pointsToday:${userId}`;
    pointsTodayKeyRef.current = key;
    setPointsToday(readPointsToday(key));
  }, [userId]);

  const handleBlockedApiError = useCallback((error: unknown) => {
    const blocked = getBlockedPayloadFromError(error);
    if (!blocked) return false;
    setBlockedState(blocked);
    return true;
  }, []);

  const loadMyGroups = useCallback(async () => {
    setMyGroupsError('');
    setMyGroupsLoading(true);

    try {
      const data = await fetchMyGroups();
      if (data.ok && Array.isArray(data.groups)) {
        setMyGroups(data.groups);
      } else {
        setMyGroups([]);
        setMyGroupsError('Не удалось загрузить список групп.');
      }
    } catch (error) {
      if (handleBlockedApiError(error)) return;
      setMyGroups([]);
      setMyGroupsError('Не удалось загрузить список групп.');
    } finally {
      setMyGroupsLoaded(true);
      setMyGroupsLoading(false);
    }
  }, [handleBlockedApiError]);

  const loadCampaigns = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setCampaignsError('');
      setCampaignsLoading(true);
    }

    try {
      const data = await fetchCampaigns();
      if (data.ok && Array.isArray(data.campaigns)) {
        setCampaigns(data.campaigns);
      } else {
        if (!silent) {
          setCampaigns([]);
          setCampaignsError('Не удалось загрузить задания.');
        }
      }
    } catch {
      if (!silent) {
        setCampaigns([]);
        setCampaignsError('Не удалось загрузить задания.');
      }
    } finally {
      if (!silent) {
        setCampaignsLoading(false);
      }
    }
  }, []);

  const loadMyCampaigns = useCallback(async () => {
    setMyCampaignsError('');
    setMyCampaignsLoading(true);

    try {
      const data = await fetchMyCampaigns();
      if (data.ok && Array.isArray(data.campaigns)) {
        setMyCampaigns(data.campaigns);
      } else {
        setMyCampaigns([]);
        setMyCampaignsError('Не удалось загрузить ваши кампании.');
      }
    } catch (error) {
      if (handleBlockedApiError(error)) return;
      setMyCampaigns([]);
      setMyCampaignsError('Не удалось загрузить ваши кампании.');
    } finally {
      setMyCampaignsLoading(false);
    }
  }, [handleBlockedApiError]);

  const loadMyApplications = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setApplicationsError('');
      setApplicationsLoading(true);
    }

    try {
      const data = await fetchMyApplications();
      if (data.ok && Array.isArray(data.applications)) {
        setApplications(data.applications);
        setApplicationsFetched(true);
      } else {
        if (!silent) {
          setApplications([]);
          setApplicationsError('Не удалось загрузить статусы.');
        }
      }
    } catch (error) {
      if (handleBlockedApiError(error)) return;
      if (!silent) {
        setApplications([]);
        setApplicationsError('Не удалось загрузить статусы.');
      }
    } finally {
      if (!silent) {
        setApplicationsLoading(false);
      }
    }
  }, [handleBlockedApiError]);

  const loadMe = useCallback(async () => {
    try {
      const data = await fetchMe();
      if (data.ok) {
        setBlockedState(null);
        if (typeof data.balance === 'number') setPoints(data.balance);
        if (typeof data.user?.totalEarned === 'number') setTotalEarned(data.user.totalEarned);
        if (typeof data.user?.id === 'string') setUserId(data.user.id);
      }
    } catch (error) {
      if (handleBlockedApiError(error)) return;
    }
  }, [handleBlockedApiError]);

  const loadAdminPanel = useCallback(async (options?: { silent?: boolean; period?: AdminPeriodPreset }) => {
    const silent = options?.silent ?? false;
    const period = options?.period ?? adminPeriod;
    setAdminPanelLoading(true);
    if (!silent) setAdminPanelError('');
    try {
      const data = await fetchAdminPanelStats(period);
      if (!data?.allowed || !data.stats) {
        setAdminPanelAllowed((current) =>
          current && isPrivilegedAdminUsername(tgUsername) ? current : false
        );
        setAdminPanelStats(null);
        return;
      }
      setAdminPanelAllowed(true);
      setAdminPanelStats(data.stats);
    } catch (error: any) {
      if (handleBlockedApiError(error)) return;
      if (!silent) setAdminPanelError(error?.message ?? 'Не удалось загрузить админ-статистику.');
    } finally {
      setAdminPanelLoading(false);
    }
  }, [adminPeriod, handleBlockedApiError, tgUsername]);

  const loadAdminModeration = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setAdminModerationError('');
    }
    setAdminModerationLoading(true);
    try {
      const data = await fetchAdminModeration();
      if (!data) {
        setAdminModerationSnapshot(null);
        setAdminPanelAllowed((current) =>
          current && isPrivilegedAdminUsername(tgUsername) ? current : false
        );
        return;
      }
      setAdminPanelAllowed(true);
      setAdminModerationSnapshot(data);
      setAdminModerationForms((current) => {
        const next = { ...current };
        for (const complaint of data.complaints) {
          if (!next[complaint.campaignId]) {
            next[complaint.campaignId] = createAdminModerationForm();
          }
        }
        return next;
      });
    } catch (error: any) {
      if (handleBlockedApiError(error)) return;
      if (!silent) {
        setAdminModerationError(error?.message ?? 'Не удалось загрузить модерацию.');
      }
    } finally {
      setAdminModerationLoading(false);
    }
  }, [handleBlockedApiError, tgUsername]);

  const loadDailyBonusStatus = useCallback(async () => {
    setDailyBonusError('');
    setDailyBonusLoading(true);
    try {
      const data = await fetchDailyBonusStatus();
      setDailyBonusStatus({
        available: Boolean(data.available),
        lastSpinAt: data.lastSpinAt ?? null,
        nextAvailableAt: data.nextAvailableAt ?? null,
        cooldownMs: data.cooldownMs ?? DAILY_BONUS_FALLBACK_MS,
        streak: typeof data.streak === 'number' ? data.streak : 0,
      });
    } catch (error: any) {
      if (handleBlockedApiError(error)) return;
      setDailyBonusError(error?.message ?? 'Не удалось загрузить бонус.');
    } finally {
      setDailyBonusLoading(false);
    }
  }, [handleBlockedApiError]);

  const loadReferralStats = useCallback(async () => {
    setReferralError('');
    setReferralLoading(true);
    try {
      const data = await fetchReferralStats();
      if (data.ok) {
        setReferralStats(data);
        setInviteCopied(false);
      } else {
        setReferralStats(null);
        setReferralError('Не удалось загрузить реферальные данные.');
      }
    } catch (error: any) {
      if (handleBlockedApiError(error)) return;
      setReferralStats(null);
      setReferralError(error?.message ?? 'Не удалось загрузить реферальные данные.');
    } finally {
      setReferralLoading(false);
    }
  }, [handleBlockedApiError]);

  const loadReferralList = useCallback(async () => {
    setReferralListError('');
    setReferralListLoading(true);
    try {
      const data = await fetchReferralList();
      if (data.ok && Array.isArray(data.referrals)) {
        setReferralList(data.referrals);
      } else {
        setReferralList([]);
        setReferralListError('Не удалось загрузить список приглашённых.');
      }
    } catch (error: any) {
      if (handleBlockedApiError(error)) return;
      setReferralList([]);
      setReferralListError(error?.message ?? 'Не удалось загрузить список приглашённых.');
    } finally {
      setReferralListLoading(false);
    }
  }, [handleBlockedApiError]);

  const hideCampaignLocally = useCallback((campaignId: string) => {
    setHiddenCampaignIds((prev) => (prev.includes(campaignId) ? prev : [...prev, campaignId]));
    setCampaigns((prev) => prev.filter((item) => item.id !== campaignId));
    setApplications((prev) => prev.filter((item) => item.campaign.id !== campaignId));
    setLeavingIds((prev) => prev.filter((item) => item !== campaignId));
    setAcknowledgedIds((prev) => {
      if (!prev.includes(campaignId)) return prev;
      const next = prev.filter((item) => item !== campaignId);
      if (acknowledgedKeyRef.current) {
        try {
          localStorage.setItem(acknowledgedKeyRef.current, JSON.stringify(next));
        } catch {
          // ignore localStorage write errors
        }
      }
      return next;
    });
  }, []);

  const refreshTaskListsSilently = useCallback(async () => {
    await Promise.allSettled([loadCampaigns({ silent: true }), loadMyApplications({ silent: true })]);
  }, [loadCampaigns, loadMyApplications]);

  const openTaskActionSheet = useCallback((campaign: CampaignDto) => {
    setTaskActionSheetCampaign(campaign);
    setTaskActionSheetMode('actions');
    setTaskActionSheetError('');
  }, []);

  const closeTaskActionSheet = useCallback(() => {
    if (taskActionSheetLoading) return;
    setTaskActionSheetCampaign(null);
    setTaskActionSheetMode('actions');
    setTaskActionSheetError('');
  }, [taskActionSheetLoading]);

  const handleHideTaskCampaign = useCallback(async () => {
    if (!taskActionSheetCampaign || taskActionSheetLoading) return;
    setTaskActionSheetError('');
    setTaskActionSheetLoading(true);
    try {
      const data = await hideCampaign(taskActionSheetCampaign.id);
      if (!data.ok) {
        throw new Error('Не удалось скрыть задание.');
      }
      hideCampaignLocally(taskActionSheetCampaign.id);
      setTaskActionSheetCampaign(null);
      setTaskActionSheetMode('actions');
      void refreshTaskListsSilently();
    } catch (error: any) {
      if (handleBlockedApiError(error)) return;
      setTaskActionSheetError(error?.message ?? 'Не удалось скрыть задание.');
    } finally {
      setTaskActionSheetLoading(false);
    }
  }, [taskActionSheetCampaign, taskActionSheetLoading, hideCampaignLocally, refreshTaskListsSilently, handleBlockedApiError]);

  const handleReportTaskCampaign = useCallback(
    async (reason: CampaignReportReason) => {
      if (!taskActionSheetCampaign || taskActionSheetLoading) return;
      setTaskActionSheetError('');
      setTaskActionSheetLoading(true);
      try {
        const data = await reportCampaign(taskActionSheetCampaign.id, reason);
        if (!data.ok) {
          throw new Error('Не удалось отправить жалобу.');
        }
        hideCampaignLocally(taskActionSheetCampaign.id);
        setTaskActionSheetCampaign(null);
        setTaskActionSheetMode('actions');
        void refreshTaskListsSilently();
      } catch (error: any) {
        if (handleBlockedApiError(error)) return;
        setTaskActionSheetError(error?.message ?? 'Не удалось отправить жалобу.');
      } finally {
        setTaskActionSheetLoading(false);
      }
    },
    [taskActionSheetCampaign, taskActionSheetLoading, hideCampaignLocally, refreshTaskListsSilently, handleBlockedApiError]
  );

  const setAdminModerationFormValue = useCallback(
    (campaignId: string, updater: (current: AdminModerationFormState) => AdminModerationFormState) => {
      setAdminModerationForms((current) => {
        const prev = current[campaignId] ?? createAdminModerationForm();
        return {
          ...current,
          [campaignId]: updater(prev),
        };
      });
    },
    []
  );

  const handleAdminModerateCampaign = useCallback(
    async (campaignId: string) => {
      const form = adminModerationForms[campaignId] ?? createAdminModerationForm();
      const payload: AdminModerationActionPayload = {};

      if (form.deleteCampaign) {
        payload.deleteCampaign = true;
      }

      if (form.fineEnabled) {
        const finePoints = Number(form.finePoints);
        if (!Number.isFinite(finePoints) || finePoints <= 0) {
          setAdminModerationError('Введите корректный размер штрафа.');
          return;
        }
        payload.finePoints = Math.floor(finePoints);
        if (form.fineReason.trim()) {
          payload.fineReason = form.fineReason.trim();
        }
      }

      payload.blockMode = form.blockMode;
      if (form.blockMode === 'temporary') {
        const blockDays = Number(form.blockDays);
        if (!Number.isFinite(blockDays) || blockDays <= 0) {
          setAdminModerationError('Укажите срок блокировки в днях.');
          return;
        }
        payload.blockDays = Math.floor(blockDays);
      }
      if (form.blockMode !== 'none' && form.blockReason.trim()) {
        payload.blockReason = form.blockReason.trim();
      }

      if (!payload.deleteCampaign && !payload.finePoints && payload.blockMode === 'none') {
        setAdminModerationError('Выберите хотя бы одно действие.');
        return;
      }

      setAdminModerationError('');
      setAdminModerationActionId(campaignId);
      try {
        const data = await moderateCampaign(campaignId, payload);
        if (!data.ok) {
          throw new Error('Не удалось применить модерацию.');
        }
        setAdminModerationForms((current) => ({
          ...current,
          [campaignId]: createAdminModerationForm(),
        }));
        await loadAdminModeration({ silent: true });
      } catch (error: any) {
        if (handleBlockedApiError(error)) return;
        setAdminModerationError(error?.message ?? 'Не удалось применить модерацию.');
      } finally {
        setAdminModerationActionId('');
      }
    },
    [adminModerationForms, handleBlockedApiError, loadAdminModeration]
  );

  const handleAdminCleanupStale = useCallback(async () => {
    setAdminModerationError('');
    setAdminStaleCleanupLoading(true);
    try {
      const data = await cleanupStaleApplications();
      if (!data.ok) {
        throw new Error('Не удалось очистить зависшие заявки.');
      }
      await loadAdminModeration({ silent: true });
    } catch (error: any) {
      if (handleBlockedApiError(error)) return;
      setAdminModerationError(error?.message ?? 'Не удалось очистить зависшие заявки.');
    } finally {
      setAdminStaleCleanupLoading(false);
    }
  }, [handleBlockedApiError, loadAdminModeration]);

  const handleAdminUnblockUser = useCallback(
    async (targetUserId: string) => {
      setAdminModerationError('');
      setAdminUnblockUserId(targetUserId);
      try {
        const data = await unblockUser(targetUserId);
        if (!data.ok) {
          throw new Error('Не удалось снять блокировку.');
        }
        await loadAdminModeration({ silent: true });
      } catch (error: any) {
        if (handleBlockedApiError(error)) return;
        setAdminModerationError(error?.message ?? 'Не удалось снять блокировку.');
      } finally {
        setAdminUnblockUserId('');
      }
    },
    [handleBlockedApiError, loadAdminModeration]
  );

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    if (!userId) return;
    void loadDailyBonusStatus();
  }, [userId, loadDailyBonusStatus]);

  useEffect(() => {
    if (!userId) return;
    void loadReferralStats();
  }, [userId, loadReferralStats]);

  useEffect(() => {
    if (!userId) return;
    void loadMe();
  }, [userId, loadMe]);

  useEffect(() => {
    if (!userId) return;
    void loadAdminPanel({ silent: true, period: adminPeriod });
  }, [userId, loadAdminPanel, adminPeriod]);

  useEffect(() => {
    if (!userId) return;
    void loadAdminModeration({ silent: true });
  }, [userId, loadAdminModeration]);

  useEffect(() => {
    if (activeTab !== 'referrals') return;
    if (!userId) return;
    void loadReferralStats();
    void loadReferralList();
  }, [activeTab, userId, loadReferralStats, loadReferralList]);

  useEffect(() => {
    if (activeTab !== 'wheel') return;
    if (!userId) return;
    void loadDailyBonusStatus();
  }, [activeTab, userId, loadDailyBonusStatus]);

  useEffect(() => {
    if (activeTab !== 'admin') return;
    if (!userId) return;
    void loadAdminPanel({ period: adminPeriod });
  }, [activeTab, userId, loadAdminPanel, adminPeriod]);

  useEffect(() => {
    if (activeTab !== 'admin') return;
    if (!userId) return;
    void loadAdminModeration();
  }, [activeTab, userId, loadAdminModeration]);

  useEffect(() => {
    if (activeTab !== 'admin') return;
    if (adminPanelLoading) return;
    if (adminPanelAllowed) return;
    setActiveTab('home');
  }, [activeTab, adminPanelAllowed, adminPanelLoading]);

  useEffect(() => {
    if (activeTab === 'tasks') return;
    if (!taskActionSheetCampaign) return;
    setTaskActionSheetCampaign(null);
    setTaskActionSheetMode('actions');
    setTaskActionSheetError('');
  }, [activeTab, taskActionSheetCampaign]);

  useEffect(() => {
    if (activeTab === 'wheel') return;
    if (!dailyBonusInfoOpen) return;
    setDailyBonusInfoOpen(false);
  }, [activeTab, dailyBonusInfoOpen]);

  useEffect(() => {
    if (!dailyBonusInfoOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDailyBonusInfoOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [dailyBonusInfoOpen]);

  useEffect(() => {
    if (!referralInfoOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setReferralInfoOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [referralInfoOpen]);

  useEffect(() => {
    if (!taskActionSheetCampaign) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (taskActionSheetLoading) return;
      setTaskActionSheetCampaign(null);
      setTaskActionSheetMode('actions');
      setTaskActionSheetError('');
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [taskActionSheetCampaign, taskActionSheetLoading]);

  useEffect(() => {
    let detachBackHandler: VoidFunction | undefined;

    try {
      if (mountBackButton.isAvailable?.()) {
        mountBackButton();
      }
    } catch {
      // noop
    }

    if (activeTab === 'wheel' || activeTab === 'referrals') {
      try {
        if (onBackButtonClick.isAvailable?.()) {
          detachBackHandler = onBackButtonClick(() => {
            if (activeTab === 'wheel') {
              setActiveTab('home');
              return;
            }
            if (activeTab === 'referrals') {
              if (referralInfoOpen) {
                setReferralInfoOpen(false);
                return;
              }
              setActiveTab('home');
            }
          });
        }
      } catch {
        // noop
      }

      try {
        if (showBackButton.isAvailable?.()) {
          showBackButton();
        }
      } catch {
        // noop
      }
    } else {
      try {
        if (hideBackButton.isAvailable?.()) {
          hideBackButton();
        }
      } catch {
        // noop
      }
    }

    return () => {
      try {
        detachBackHandler?.();
      } catch {
        // noop
      }
    };
  }, [activeTab, referralInfoOpen]);

  useEffect(() => {
    if (activeTab === 'referrals') return;
    if (!referralInfoOpen) return;
    setReferralInfoOpen(false);
  }, [activeTab, referralInfoOpen]);

  useEffect(() => {
    if (!topUpModalOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTopUpModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [topUpModalOpen]);

  useEffect(() => {
    if (!promoWizardOpen) {
      if (linkPickerOpen) setLinkPickerOpen(false);
      return;
    }
    if (promoWizardSteps.some((step) => step.id === promoWizardStep)) return;
    setPromoWizardStep(promoWizardSteps[0]?.id ?? 'project');
  }, [linkPickerOpen, promoWizardOpen, promoWizardStep, promoWizardSteps]);

  useEffect(() => {
    if (!promoWizardOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !createLoading) {
        setPromoWizardOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [promoWizardOpen, createLoading]);

  useEffect(() => {
    if (applicationsRequestedRef.current) return;
    applicationsRequestedRef.current = true;
    void loadMyApplications({ silent: true });
  }, [loadMyApplications]);

  useEffect(() => {
    if (activeTab !== 'tasks') return;
    void loadMyApplications({ silent: applicationsFetched });
  }, [activeTab, loadMyApplications, applicationsFetched]);

  const refreshTasksOnResume = useCallback(() => {
    const now = Date.now();
    if (now - resumeRefreshAtRef.current < 1200) return;
    resumeRefreshAtRef.current = now;
    const restoreScrollTop = (target: HTMLDivElement | null, top: number) => {
      if (!target) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const max = target.scrollHeight - target.clientHeight;
          target.scrollTop = Math.max(0, Math.min(top, max));
        });
      });
    };
    const scrollTop = contentRef.current?.scrollTop ?? 0;
    void (async () => {
      await Promise.allSettled([
        loadCampaigns({ silent: true }),
        loadMyApplications({ silent: true }),
        loadMe(),
        loadAdminPanel({ silent: true }),
        loadAdminModeration({ silent: true }),
      ]);
      restoreScrollTop(contentRef.current, scrollTop);
    })();
  }, [loadCampaigns, loadMyApplications, loadMe, loadAdminPanel, loadAdminModeration]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshTasksOnResume();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    const handlePageShow = () => {
      if (document.visibilityState === 'visible') refreshTasksOnResume();
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [refreshTasksOnResume]);

  useEffect(() => {
    if (activeTab !== 'promo') return;
    if (myTasksTab === 'mine') void loadMyCampaigns();
  }, [activeTab, loadMyCampaigns, myTasksTab]);

  useEffect(() => {
    if (!promoWizardOpen) return;
    if (activeTab !== 'promo' || myTasksTab !== 'place') {
      setPromoWizardOpen(false);
      setLinkPickerOpen(false);
    }
  }, [activeTab, myTasksTab, promoWizardOpen]);

  useEffect(() => {
    setActionError('');
  }, [activeTab, myTasksTab]);

  useEffect(() => {
    if (!promoWizardOpen || !linkPickerOpen) return;
    if (myGroupsLoaded || myGroupsLoading) return;
    void loadMyGroups();
  }, [linkPickerOpen, loadMyGroups, myGroupsLoaded, myGroupsLoading, promoWizardOpen]);

  useEffect(() => {
    if (!promoWizardOpen || !linkPickerOpen) return;
    const raf = requestAnimationFrame(() => {
      linkPickerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [linkPickerOpen, promoWizardOpen]);

  const handleQuickLinkSelect = (group: GroupDto) => {
    setSelectedGroupId(group.id);
    setSelectedGroupTitle(group.title);
    setLinkPickerOpen(false);
  };

  const getGroupSecondaryLabel = (group: GroupDto) => {
    const username = group.username?.trim();
    if (username) return username.startsWith('@') ? username : `@${username}`;
    if (group.inviteLink) return group.inviteLink;
    if (group.telegramChatId) return `ID ${group.telegramChatId}`;
    return '';
  };

  const getGroupAvatarUrl = (group: GroupDto) => {
    const username = group.username?.trim();
    if (!username) return '';
    const clean = username.startsWith('@') ? username.slice(1) : username;
    if (!clean) return '';
    return `https://t.me/i/userpic/320/${clean}.jpg`;
  };

  const getTaskStatusMeta = (status?: ApplicationDto['status']) => {
    if (status === 'APPROVED') {
      return {
        label: 'К выплате',
        className: 'approved',
        actionLabel: 'Открыть',
        shouldApplyBeforeOpen: false,
      };
    }
    if (status === 'PENDING') {
      return {
        label: 'На проверке',
        className: 'pending',
        actionLabel: 'Открыть',
        shouldApplyBeforeOpen: false,
      };
    }
    if (status === 'REVOKED') {
      return {
        label: 'Нужно заново',
        className: 'neutral',
        actionLabel: 'Получить',
        shouldApplyBeforeOpen: true,
      };
    }
    if (status === 'REJECTED') {
      return {
        label: 'Отклонено',
        className: 'rejected',
        actionLabel: 'Открыть',
        shouldApplyBeforeOpen: false,
      };
    }
    return {
      label: 'Не начато',
      className: 'neutral',
      actionLabel: 'Получить',
      shouldApplyBeforeOpen: true,
    };
  };

  const getOwnerCampaignStatusMeta = (campaign: CampaignDto) => {
    const budgetLabel = `Остаток ${campaign.remainingBudget} ${formatPointsLabel(
      campaign.remainingBudget
    )}`;

    if (
      campaign.status === 'COMPLETED' ||
      campaign.remainingBudget <= 0 ||
      campaign.remainingBudget < campaign.rewardPoints
    ) {
      return {
        label: 'Завершена',
        className: 'approved',
        budgetLabel,
      };
    }

    if (campaign.status === 'PAUSED') {
      return {
        label: 'Пауза',
        className: 'pending',
        budgetLabel,
      };
    }

    return {
      label: 'Активна',
      className: 'neutral',
      budgetLabel,
    };
  };

  const getReferralUserLabel = (user?: ReferralListItem['referredUser']) => {
    if (!user) return 'Пользователь';
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    if (fullName) return fullName;
    if (user.username) return user.username.startsWith('@') ? user.username : `@${user.username}`;
    return 'Пользователь';
  };

  const getReferralCreatedLabel = (createdAt?: string) => {
    const parsed = Date.parse(createdAt ?? '');
    if (!Number.isFinite(parsed)) return 'дата не указана';
    return new Date(parsed).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  const getReferralProgressPercent = (orders: number) => {
    if (!Number.isFinite(orders)) return '0%';
    const value = Math.max(0, Math.min(orders, 30));
    return `${Math.round((value / 30) * 100)}%`;
  };

  const getReferralNextStep = (orders: number) => {
    const value = Math.max(0, Math.floor(orders));
    return REFERRAL_STEPS.find((step) => step.orders > value) ?? null;
  };

  const resolveGroupId = () => {
    return selectedGroupId;
  };

  const getPrivateMessageLink = (group: GroupDto, messageId: number) => {
    const chatId = group.telegramChatId?.trim() ?? '';
    if (!chatId || !chatId.startsWith('-100')) return '';
    const internalId = chatId.slice(4);
    if (!internalId) return '';
    return `https://t.me/c/${internalId}/${messageId}`;
  };

  const openCampaignLink = (campaign: CampaignDto) => {
    const username = campaign.group.username?.trim();
    const targetId = campaign.targetMessageId ?? null;
    let url = campaign.group.inviteLink;
    if (campaign.actionType === 'REACTION' && targetId) {
      if (username) {
        url = `https://t.me/${username}/${targetId}`;
      } else {
        const privateLink = getPrivateMessageLink(campaign.group, targetId);
        if (privateLink) url = privateLink;
      }
    }
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openChannelSetup = () => {
    window.open(BOT_SETUP_CHANNEL_URL, '_blank', 'noopener,noreferrer');
  };

  const openGroupSetup = () => {
    window.open(BOT_SETUP_GROUP_URL, '_blank', 'noopener,noreferrer');
  };

  const openPromoWizard = (type: 'subscribe' | 'reaction') => {
    setTaskType(type);
    setCreateError('');
    setLinkPickerOpen(false);
    setPromoWizardStep('project');
    setPromoWizardOpen(true);
  };

  const closePromoWizard = () => {
    if (createLoading) return;
    setPromoWizardOpen(false);
    setLinkPickerOpen(false);
  };

  const handlePromoWizardBack = () => {
    if (!promoWizardCanGoBack) {
      closePromoWizard();
      return;
    }
    setCreateError('');
    setLinkPickerOpen(false);
    setPromoWizardStep((current) => {
      const currentIndex = promoWizardSteps.findIndex((step) => step.id === current);
      if (currentIndex <= 0) return current;
      return promoWizardSteps[currentIndex - 1]?.id ?? current;
    });
  };

  const handlePromoWizardNext = () => {
    if (!promoWizardCanGoNext || promoWizardCurrentStep.id === 'review') return;
    setCreateError('');
    setPromoWizardStep((current) => {
      const currentIndex = promoWizardSteps.findIndex((step) => step.id === current);
      if (currentIndex < 0 || currentIndex >= promoWizardSteps.length - 1) return current;
      return promoWizardSteps[currentIndex + 1]?.id ?? current;
    });
  };

  const registerTaskCardRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) {
      taskCardRefs.current.set(id, node);
      return;
    }
    taskCardRefs.current.delete(id);
  }, []);

  const registerTaskBadgeRef = useCallback((id: string, node: HTMLSpanElement | null) => {
    if (node) {
      taskBadgeRefs.current.set(id, node);
      return;
    }
    taskBadgeRefs.current.delete(id);
  }, []);

  const animateFlyout = useCallback(
    (
      source: HTMLElement,
      target: HTMLElement,
      className: string,
      scale: number,
      durationMs: number,
      textOverride?: string,
      replaceClasses?: boolean
    ) => {
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const clone = source.cloneNode(true) as HTMLElement;

      clone.classList.remove('is-leaving');
      if (textOverride !== undefined) {
        clone.textContent = textOverride;
        clone.className = replaceClasses ? className : `${clone.className} ${className}`;
      } else {
        clone.classList.add(className);
      }
      clone.style.position = 'fixed';
      clone.style.left = `${sourceRect.left}px`;
      clone.style.top = `${sourceRect.top}px`;
      clone.style.width = `${sourceRect.width}px`;
      clone.style.height = `${sourceRect.height}px`;
      clone.style.margin = '0';
      clone.style.zIndex = '9999';
      clone.style.pointerEvents = 'none';
      clone.style.opacity = '1';

      document.body.appendChild(clone);

      const dx = targetRect.left + targetRect.width / 2 - (sourceRect.left + sourceRect.width / 2);
      const dy =
        targetRect.top + targetRect.height / 2 - (sourceRect.top + sourceRect.height / 2);
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const curve = Math.min(180, length * 0.35);
      const dip = Math.min(140, Math.max(60, length * 0.3));
      const midX = dx * 0.25 + nx * curve * 0.35;
      const midY = dy * 0.15 + dip;
      const mid2X = dx * 0.7 - nx * curve * 0.15;
      const mid2Y = dy * 0.7 - dip * 0.12;
      const midScale = 1 - (1 - scale) * 0.35;
      const mid2Scale = 1 - (1 - scale) * 0.7;

      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      if (reduceMotion || !clone.animate) {
        clone.remove();
        return Promise.resolve(false);
      }

      const animation = clone.animate(
        [
          { transform: 'translate(0px, 0px) scale(1)', opacity: 1, offset: 0 },
          {
            transform: `translate(${midX}px, ${midY}px) scale(${midScale})`,
            opacity: 0.82,
            offset: 0.38,
          },
          {
            transform: `translate(${mid2X}px, ${mid2Y}px) scale(${mid2Scale})`,
            opacity: 0.68,
            offset: 0.74,
          },
          {
            transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
            opacity: 0,
            offset: 1,
          },
        ],
        {
          duration: durationMs,
          easing: 'cubic-bezier(0.18, 0.84, 0.22, 1)',
          fill: 'forwards',
        }
      );

      return animation.finished
        .catch(() => null)
        .finally(() => {
          clone.remove();
        })
        .then(() => true);
    },
    []
  );

  const triggerCompletionAnimation = useCallback(
    (campaignId: string, scoreText: string) => {
      const card = taskCardRefs.current.get(campaignId);
      const badge = taskBadgeRefs.current.get(campaignId);
      const historyTab = historyTabRef.current;
      const balanceValue = balanceValueRef.current;
      const finish = () => {
        animatingOutRef.current.delete(campaignId);
        setLeavingIds((prev) => prev.filter((item) => item !== campaignId));
        setAcknowledgedIds((prev) => {
          if (prev.includes(campaignId)) return prev;
          const next = [...prev, campaignId];
          if (acknowledgedKeyRef.current) {
            try {
              localStorage.setItem(acknowledgedKeyRef.current, JSON.stringify(next));
            } catch {
              // ignore
            }
          }
          return next;
        });
      };

      if (!card || !badge || !historyTab || !balanceValue) {
        window.setTimeout(finish, 200);
        return;
      }

      setLeavingIds((prev) => (prev.includes(campaignId) ? prev : [...prev, campaignId]));

      const cardDuration = 2400;
      const badgeDuration = 2000;
      const cardAnim = animateFlyout(card, historyTab, 'flyout-card', 0.2, cardDuration);
      const badgeAnim = animateFlyout(
        badge,
        balanceValue,
        'flyout-score',
        0.4,
        badgeDuration,
        scoreText,
        true
      );

      Promise.allSettled([cardAnim, badgeAnim]).then(() => {
        balanceValue.classList.remove('balance-pulse');
        void balanceValue.offsetWidth;
        balanceValue.classList.add('balance-pulse');
        window.setTimeout(() => balanceValue.classList.remove('balance-pulse'), 750);
        finish();
      });
    },
    [animateFlyout]
  );

  const ProfileCard = () => (
    <section className="profile-card">
      <div className="profile-head">
        <div className="avatar-ring">
          <div className="avatar">
            {userPhoto ? (
              <img src={userPhoto} alt={userLabel} />
            ) : (
              <span>{initialLetter}</span>
            )}
          </div>
        </div>
        <div className="identity">
          <div className="user-name">{userLabel}</div>
          <div className="identity-actions">
            <button className="sub" type="button" onClick={openTopUpModal}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3.5" y="6.5" width="17" height="11" rx="2.6" />
                <path d="M16 12h.01" />
                <path d="M7 9.5h3.5" />
              </svg>
              <span>Пополнить баланс</span>
            </button>
          </div>
        </div>
      </div>
      <div className="stats">
        <div className="stat divider">
          <div className="stat-main">
            <span className="stat-chip" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="7.5" />
                <path d="M9.4 12h5.2" />
                <path d="M12 9.4v5.2" />
              </svg>
            </span>
            <span className="accent">{displayPoints}</span>
            <span>{formatPointsLabel(displayPoints)}</span>
          </div>
          <div className="stat-title">
            {formatSigned(pointsToday)} {formatPointsLabel(pointsToday)} сегодня
          </div>
        </div>
        <div className="stat">
          <div className="stat-main">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path
                d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.3L12 17.8 6.4 20.3l1.1-6.3L3 9.6l6.2-.9L12 3z"
                stroke="currentColor"
              />
            </svg>
            <span className="gold">{rankTier.title}</span>
          </div>
          <div className="stat-title">Ранг · бонус +{bonusPercent}%</div>
        </div>
      </div>
      <div className="rank-progress">
        <div className="rank-progress-bar" aria-hidden="true">
          <span style={{ width: `${progressValue * 100}%` }} />
        </div>
        <div className="rank-progress-text">{progressLabel}</div>
      </div>
    </section>
  );

  const BalanceHeader = () => (
    <div className="balance-header balance-header-info balance-header-modern">
      <div className="balance-header-metrics">
        <div className="metric-card compact metric-card-info metric-card-balance">
          <div className="metric-headline-row">
            <span className="metric-label-top">Баланс</span>
            <button
              className="metric-inline-action"
              type="button"
              aria-label="Пополнить баланс"
              onClick={openTopUpModal}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          </div>
          <div className="metric-main-inline">
            <span className="metric-value" ref={balanceValueRef}>
              {displayPoints}
            </span>
            <span className="metric-unit">{formatPointsLabel(displayPoints)}</span>
          </div>
          <div className="metric-footnote">
            {formatSigned(pointsToday)} {formatPointsLabel(pointsToday)} сегодня
          </div>
        </div>
        <div className="metric-card compact metric-card-info metric-card-rank">
          <div className="metric-headline-row">
            <span className="metric-label-top">Ранг</span>
            <span className="metric-rank-chip">+{bonusPercent}%</span>
          </div>
          <div className="metric-main-inline">
            <span className="metric-value">{rankTier.title}</span>
          </div>
          <div className="metric-progress-mini" aria-hidden="true">
            <span style={{ width: `${Math.round(progressValue * 100)}%` }} />
          </div>
          <div className="metric-footnote">{progressLabel}</div>
        </div>
      </div>
    </div>
  );

  const handleCreateCampaign = async () => {
    setCreateError('');
    const groupId = resolveGroupId();
    if (!groupId) {
      setCreateError('Сначала подключите канал/группу и выберите ее из списка.');
      return false;
    }
    if (parsedTaskPrice === null) {
      setCreateError('Укажите цену за действие.');
      return false;
    }
    if (!Number.isFinite(parsedTaskPrice) || parsedTaskPrice < MIN_TASK_PRICE) {
      setCreateError(`Цена за действие должна быть не меньше ${MIN_TASK_PRICE} баллов.`);
      return false;
    }
    if (parsedTaskPrice > MAX_TASK_PRICE) {
      setCreateError(`Цена за действие должна быть не больше ${MAX_TASK_PRICE} баллов.`);
      return false;
    }
    if (!Number.isFinite(taskCount) || taskCount < 1) {
      setCreateError('Количество действий должно быть не меньше 1.');
      return false;
    }
    if (taskType === 'reaction') {
      if (reactionLinkValidation.state === 'empty') {
        setCreateError('Укажите ссылку на пост для реакции.');
        return false;
      }
      if (reactionLinkValidation.state === 'invalid') {
        setCreateError('Проверьте формат ссылки на пост.');
        return false;
      }
      if (reactionLinkValidation.state === 'foreign_project') {
        setCreateError('Ссылка должна вести на пост из выбранного проекта.');
        return false;
      }
    }
    if (totalBudget > MAX_TOTAL_BUDGET) {
      setCreateError(
        `Бюджет слишком большой. Максимум ${MAX_TOTAL_BUDGET.toLocaleString('ru-RU')} баллов.`
      );
      return false;
    }
    if (displayPoints < totalBudget) {
      setCreateError('Недостаточно баллов для размещения.');
      return false;
    }

    setCreateLoading(true);
    try {
      const data = await createCampaign({
        groupId,
        actionType: taskType,
        rewardPoints: Math.round(parsedTaskPrice),
        totalBudget: Math.round(totalBudget),
        targetMessageLink: taskType === 'reaction' ? reactionLink.trim() : undefined,
      });
      if (typeof data.balance === 'number') {
        setPoints(data.balance);
      }
      setReactionLink('');
      setSelectedGroupId('');
      setSelectedGroupTitle('');
      await loadCampaigns();
      await loadMyCampaigns();
      return true;
    } catch (error: any) {
      if (handleBlockedApiError(error)) return false;
      setCreateError(error?.message ?? 'Не удалось создать кампанию.');
      return false;
    } finally {
      setCreateLoading(false);
    }
  };

  const handlePromoWizardPrimary = async () => {
    if (promoWizardCurrentStep.id === 'review') {
      if (createCtaState.blocked) {
        if (createCtaState.label === 'Пополните баланс') {
          setPromoWizardOpen(false);
          setLinkPickerOpen(false);
          openTopUpModal();
        }
        return;
      }
      const created = await handleCreateCampaign();
      if (created) {
        setPromoWizardOpen(false);
        setLinkPickerOpen(false);
      }
      return;
    }
    handlePromoWizardNext();
  };

  const handleApplyCampaign = async (campaignId: string) => {
    setActionError('');
    setActionLoadingId(campaignId);
    try {
      const data = await applyCampaign(campaignId);
      if (!data.ok) {
        throw new Error('Не удалось получить задание.');
      }
      if (typeof data.balance === 'number') {
        setPoints(data.balance);
      }
      await loadCampaigns();
      await loadMyApplications();
      return true;
    } catch (error: any) {
      if (handleBlockedApiError(error)) return false;
      setActionError(error?.message ?? 'Не удалось отправить задание.');
      return false;
    } finally {
      setActionLoadingId('');
    }
  };

  const handleOpenCampaign = async (campaign: CampaignDto, status?: ApplicationDto['status']) => {
    const statusMeta = getTaskStatusMeta(status);
    if (statusMeta.shouldApplyBeforeOpen) {
      if (actionLoadingId === campaign.id) return;
      const applied = await handleApplyCampaign(campaign.id);
      if (!applied) return;
    }
    openCampaignLink(campaign);
  };

  const handleConfirmReward = (campaignId: string, scoreValue: number) => {
    if (animatingOutRef.current.has(campaignId)) return;
    animatingOutRef.current.add(campaignId);
    triggerCompletionAnimation(campaignId, String(scoreValue));
  };

  const handleClaimWheelReward = () => {
    setWheelRewardModalOpen(false);
    setWheelRewardBurst(false);
    setWheelResult(null);
  };

  const handleSpinDailyBonus = async () => {
    if (wheelSpinning || dailyBonusLoading) return;
    if (!dailyBonusAvailable) return;

    setDailyBonusError('');
    setWheelRewardModalOpen(false);
    setWheelRewardBurst(false);
    setWheelResult(null);
    setWheelSpinning(true);
    setWheelSpinPhase('launch');
    setWheelCelebrating(false);
    setWheelWinningIndex(null);
    if (spinFrameRef.current) {
      window.cancelAnimationFrame(spinFrameRef.current);
      spinFrameRef.current = null;
    }
    if (spinPhaseCruiseTimeoutRef.current) {
      window.clearTimeout(spinPhaseCruiseTimeoutRef.current);
      spinPhaseCruiseTimeoutRef.current = null;
    }
    if (spinPhaseBrakeTimeoutRef.current) {
      window.clearTimeout(spinPhaseBrakeTimeoutRef.current);
      spinPhaseBrakeTimeoutRef.current = null;
    }
    if (wheelCelebrateTimeoutRef.current) {
      window.clearTimeout(wheelCelebrateTimeoutRef.current);
      wheelCelebrateTimeoutRef.current = null;
    }
    if (wheelRewardBurstTimeoutRef.current) {
      window.clearTimeout(wheelRewardBurstTimeoutRef.current);
      wheelRewardBurstTimeoutRef.current = null;
    }
    if (wheelRewardRevealTimeoutRef.current) {
      window.clearTimeout(wheelRewardRevealTimeoutRef.current);
      wheelRewardRevealTimeoutRef.current = null;
    }

    try {
      const pointsBeforeSpin = points;
      const data = await spinDailyBonus();
      if (typeof data.balance === 'number') setPoints(data.balance);
      if (typeof data.totalEarned === 'number') setTotalEarned(data.totalEarned);

      setDailyBonusStatus({
        available: false,
        lastSpinAt: data.lastSpinAt ?? null,
        nextAvailableAt: data.nextAvailableAt ?? null,
        cooldownMs: data.cooldownMs ?? DAILY_BONUS_FALLBACK_MS,
        streak:
          typeof data.streak === 'number' ? data.streak : dailyBonusStatus.streak ?? 0,
      });

      const nextBalance = parseFiniteNumber(data.balance);
      const balanceReward =
        nextBalance === null
          ? null
          : Math.max(0, Math.round(nextBalance - Math.round(pointsBeforeSpin)));
      const rawRewardValue = parseFiniteNumber(data.reward?.value);
      const rewardValueFromPayload = rawRewardValue === null ? null : Math.max(0, Math.round(rawRewardValue));
      const rewardValue =
        balanceReward !== null && balanceReward > 0
          ? balanceReward
          : rewardValueFromPayload ??
            DAILY_WHEEL_SEGMENTS[0]?.value ??
            0;
      const rewardLabel = `+${rewardValue}`;
      const rewardIndexRaw = parseFiniteNumber(data.reward?.index) ?? 0;
      const rewardIndex = resolveWheelRewardIndex(rewardIndexRaw, rewardValue);
      if (rewardValue > 0) bumpPointsToday(rewardValue);
      const startRotation = wheelRotationRef.current;
      const stopOffset = getWheelStopOffset();
      const nextRotation = getWheelTargetRotation(startRotation, rewardIndex, stopOffset);
      const totalDistance = Math.max(DAILY_WHEEL_SLICE * 2, nextRotation - startRotation);
      setWheelWinningIndex(rewardIndex);
      setWheelSpinPhase('launch');

      const result = { label: rewardLabel, value: rewardValue };
      const finishSpin = () => {
        if (spinPhaseCruiseTimeoutRef.current) {
          window.clearTimeout(spinPhaseCruiseTimeoutRef.current);
          spinPhaseCruiseTimeoutRef.current = null;
        }
        if (spinPhaseBrakeTimeoutRef.current) {
          window.clearTimeout(spinPhaseBrakeTimeoutRef.current);
          spinPhaseBrakeTimeoutRef.current = null;
        }
        setWheelRotation(nextRotation);
        setWheelSpinning(false);
        setWheelSpinPhase('celebrate');
        setWheelCelebrating(true);
        setWheelRewardBurst(true);
        setWheelResult(result);
        if (wheelRewardBurstTimeoutRef.current) {
          window.clearTimeout(wheelRewardBurstTimeoutRef.current);
        }
        wheelRewardBurstTimeoutRef.current = window.setTimeout(() => {
          setWheelRewardBurst(false);
          wheelRewardBurstTimeoutRef.current = null;
        }, 980);
        if (wheelRewardRevealTimeoutRef.current) {
          window.clearTimeout(wheelRewardRevealTimeoutRef.current);
        }
        wheelRewardRevealTimeoutRef.current = window.setTimeout(() => {
          setWheelRewardModalOpen(true);
          wheelRewardRevealTimeoutRef.current = null;
        }, 340);
        wheelCelebrateTimeoutRef.current = window.setTimeout(() => {
          setWheelCelebrating(false);
          setWheelSpinPhase('idle');
          wheelCelebrateTimeoutRef.current = null;
        }, DAILY_WHEEL_CELEBRATE_MS);
      };

      const rotorNode = wheelRotorRef.current;
      if (!rotorNode) {
        setWheelRotation(nextRotation);
        finishSpin();
        return;
      }

      rotorNode.style.transform = `rotate(${startRotation}deg)`;

      spinPhaseCruiseTimeoutRef.current = window.setTimeout(() => {
        setWheelSpinPhase('cruise');
        spinPhaseCruiseTimeoutRef.current = null;
      }, Math.round(DAILY_WHEEL_SPIN_MS * DAILY_WHEEL_LAUNCH_END));
      spinPhaseBrakeTimeoutRef.current = window.setTimeout(() => {
        setWheelSpinPhase('brake');
        spinPhaseBrakeTimeoutRef.current = null;
      }, Math.round(DAILY_WHEEL_SPIN_MS * DAILY_WHEEL_BRAKE_START));

      const runSettle = () => {
        const settleFrom = wheelRotationRef.current;
        const overshoot = lerp(
          DAILY_WHEEL_SETTLE_OVERSHOOT_MIN,
          DAILY_WHEEL_SETTLE_OVERSHOOT_MAX,
          getRandomUnit()
        );
        const rebound = lerp(
          DAILY_WHEEL_SETTLE_REBOUND_MIN,
          DAILY_WHEEL_SETTLE_REBOUND_MAX,
          getRandomUnit()
        );
        const overshootRotation = nextRotation + overshoot;
        const reboundRotation = nextRotation - rebound;
        const settleStartedAt = performance.now();

        const settleTick = (frameNow: number) => {
          const rawProgress = Math.min(
            1,
            Math.max(0, (frameNow - settleStartedAt) / DAILY_WHEEL_SETTLE_MS)
          );

          let rotation = nextRotation;
          if (rawProgress < 0.52) {
            const segmentProgress = easeOutCubic(rawProgress / 0.52);
            rotation = lerp(settleFrom, overshootRotation, segmentProgress);
          } else if (rawProgress < 0.82) {
            const segmentProgress = easeInOutCubic((rawProgress - 0.52) / 0.3);
            rotation = lerp(overshootRotation, reboundRotation, segmentProgress);
          } else {
            const segmentProgress = easeOutCubic((rawProgress - 0.82) / 0.18);
            rotation = lerp(reboundRotation, nextRotation, segmentProgress);
          }

          wheelRotationRef.current = rotation;
          rotorNode.style.transform = `rotate(${rotation}deg)`;

          if (rawProgress < 1) {
            spinFrameRef.current = window.requestAnimationFrame(settleTick);
            return;
          }

          spinFrameRef.current = null;
          setWheelRotation(nextRotation);
          finishSpin();
        };

        spinFrameRef.current = window.requestAnimationFrame(settleTick);
      };

      const spinStartedAt = performance.now();
      const spinTick = (frameNow: number) => {
        const elapsed = frameNow - spinStartedAt;
        const rawProgress = Math.min(1, Math.max(0, elapsed / DAILY_WHEEL_SPIN_MS));
        const easedProgress = getWheelNaturalProgress(rawProgress);
        const rotation = startRotation + totalDistance * easedProgress;

        wheelRotationRef.current = rotation;
        rotorNode.style.transform = `rotate(${rotation}deg)`;

        if (rawProgress < 1) {
          spinFrameRef.current = window.requestAnimationFrame(spinTick);
          return;
        }

        spinFrameRef.current = null;
        runSettle();
      };

      spinFrameRef.current = window.requestAnimationFrame(spinTick);
    } catch (error: any) {
      if (spinFrameRef.current) {
        window.cancelAnimationFrame(spinFrameRef.current);
        spinFrameRef.current = null;
      }
      if (spinPhaseCruiseTimeoutRef.current) {
        window.clearTimeout(spinPhaseCruiseTimeoutRef.current);
        spinPhaseCruiseTimeoutRef.current = null;
      }
      if (spinPhaseBrakeTimeoutRef.current) {
        window.clearTimeout(spinPhaseBrakeTimeoutRef.current);
        spinPhaseBrakeTimeoutRef.current = null;
      }
      if (wheelRewardBurstTimeoutRef.current) {
        window.clearTimeout(wheelRewardBurstTimeoutRef.current);
        wheelRewardBurstTimeoutRef.current = null;
      }
      if (wheelRewardRevealTimeoutRef.current) {
        window.clearTimeout(wheelRewardRevealTimeoutRef.current);
        wheelRewardRevealTimeoutRef.current = null;
      }
      setWheelSpinning(false);
      setWheelSpinPhase('idle');
      setWheelCelebrating(false);
      setWheelRewardBurst(false);
      setWheelRewardModalOpen(false);
      if (handleBlockedApiError(error)) return;
      setDailyBonusError(error?.message ?? 'Не удалось получить бонус.');
    }
  };

  const markInviteCopied = () => {
    setInviteCopied(true);
    if (inviteCopyTimeoutRef.current) {
      window.clearTimeout(inviteCopyTimeoutRef.current);
    }
    inviteCopyTimeoutRef.current = window.setTimeout(() => {
      setInviteCopied(false);
    }, 2000);
  };

  const handleCopyInviteLink = async () => {
    if (!referralLink) return;
    setReferralError('');
    try {
      await copyTextToClipboard(referralLink);
      markInviteCopied();
    } catch (error: any) {
      setReferralError(error?.message ?? 'Не удалось скопировать ссылку.');
    }
  };

  const handleShareInvite = async () => {
    if (!referralLink) return;
    const text = 'Присоединяйся и получай бонусы за задания!';
    const shareText = `${text}\n${referralLink}`;
    const shareUrl = `https://t.me/share/url?text=${encodeURIComponent(shareText)}`;
    const tg = (window as any)?.Telegram?.WebApp;

    setInviteCopied(false);
    setReferralError('');

    const fallbackCopy = async () => {
      await copyTextToClipboard(referralLink);
      markInviteCopied();
    };

    try {
      if (typeof tg?.openTelegramLink === 'function') {
        tg.openTelegramLink(shareUrl);
        return;
      }

      if (typeof navigator.share === 'function') {
        await navigator.share({
          title: 'Приглашение',
          text,
          url: referralLink,
        });
        return;
      }

      const popup = window.open(shareUrl, '_blank', 'noopener,noreferrer');
      if (!popup) {
        await fallbackCopy();
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      try {
        await fallbackCopy();
      } catch (copyError: any) {
        setReferralError(copyError?.message ?? error?.message ?? 'Не удалось поделиться ссылкой.');
      }
    }
  };

  const openTopUpModal = () => setTopUpModalOpen(true);
  const closeTopUpModal = () => setTopUpModalOpen(false);

  const openTelegramContact = (url: string) => {
    const tg = (window as any)?.Telegram?.WebApp;
    try {
      if (typeof tg?.openTelegramLink === 'function') {
        tg.openTelegramLink(url);
        return;
      }
    } catch {
      // fallback below
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleTopUpPackageSelect = (topUpPackage: TopUpPackage) => {
    const text = `Здравствуйте! Хочу приобрести ${topUpPackage.points} ${formatPointsLabel(
      topUpPackage.points
    )} за ${topUpPackage.priceRub} рублей.`;
    const url = `https://t.me/${TOP_UP_MANAGER_USERNAME}?text=${encodeURIComponent(text)}`;
    setTopUpModalOpen(false);
    openTelegramContact(url);
  };
  const handleAdminPeriodSelect = (nextPeriod: AdminPeriodPreset) => {
    if (nextPeriod === adminPeriod) return;
    setAdminPeriod(nextPeriod);
  };
  const handleAdminSectionSelect = (nextSection: AdminSectionId) => {
    if (nextSection === adminSection) return;
    setAdminSection(nextSection);
  };
  const adminModerationSummary = adminModerationSnapshot?.summary ?? null;
  const adminModerationComplaints = adminModerationSnapshot?.complaints ?? [];
  const adminModerationStale = adminModerationSnapshot?.stale ?? null;
  const adminModerationBlockedUsers = adminModerationSnapshot?.blockedUsers ?? [];
  const blockedUntilLabel = useMemo(() => {
    if (!blockedState?.blockedUntil) return 'Бессрочно';
    return formatDateTimeRu(blockedState.blockedUntil);
  }, [blockedState?.blockedUntil]);
  const adminSummaryNewUsers = adminOverview?.newUsers ?? adminPanelStats?.newUsersToday ?? 0;
  const adminSummaryTotalUsers = adminOverview?.totalUsers ?? adminPanelStats?.totalUsers ?? 0;
  const adminSummaryActiveUsers = adminOverview?.activeUsers ?? 0;
  const adminSummaryPendingApplications =
    adminOverview?.pendingApplications ?? adminPanelStats?.applications?.pendingCount ?? 0;
  const adminSummaryApprovalRate = useMemo(() => {
    if (typeof adminOverview?.approvalRate === 'number') return adminOverview.approvalRate;
    const approved = adminOverview?.approvedApplications ?? 0;
    const rejected = adminOverview?.rejectedApplications ?? 0;
    const total = approved + rejected;
    if (total <= 0) return 0;
    return Number(((approved / total) * 100).toFixed(1));
  }, [adminOverview]);
  const adminSummaryPointsIssued = adminOverview?.pointsIssued ?? adminPanelStats?.economy?.issuedPoints ?? 0;
  const adminSummaryPointsSpent = adminOverview?.pointsSpent ?? adminPanelStats?.economy?.spentPoints ?? 0;
  const adminSummaryPointsNet = adminOverview?.pointsNet ?? adminSummaryPointsIssued - adminSummaryPointsSpent;
  const adminSummaryBonusGranted =
    adminOverview?.welcomeBonusGranted ?? adminPanelStats?.bonusGranted ?? 0;
  const adminSummaryBonusAmount =
    adminOverview?.welcomeBonusAmount ?? adminPanelStats?.bonusAmount ?? 100;
  const adminSummaryBonusLimit = adminOverview?.welcomeBonusLimit ?? adminPanelStats?.bonusLimit ?? 0;
  const adminSummaryBonusRemaining =
    adminOverview?.welcomeBonusRemaining ?? adminPanelStats?.bonusRemaining ?? 0;
  const adminSummaryReviewed = adminOverview?.reviewedApplications ?? 0;
  const adminTrends = (adminPanelStats?.trends ?? null) as any;
  const adminCampaigns = adminPanelStats?.campaigns ?? null;
  const adminApplications = adminPanelStats?.applications ?? null;
  const adminEconomy = adminPanelStats?.economy ?? null;
  const adminReferrals = adminPanelStats?.referrals ?? null;
  const adminRisks = (adminPanelStats?.risks ?? null) as any;
  const adminAlerts = adminPanelStats?.alerts ?? [];
  const adminHealth = useMemo(() => {
    let score = 100;
    if (adminSummaryBonusRemaining <= 5) score -= 16;
    if (adminSummaryPendingApplications >= 20) score -= 12;
    if ((adminApplications?.stalePendingCount ?? 0) >= 8) score -= 12;
    if (adminSummaryApprovalRate < 55) score -= 14;
    else if (adminSummaryApprovalRate < 65) score -= 8;
    if ((adminCampaigns?.lowBudgetCount ?? 0) >= 10) score -= 8;
    if ((adminRisks?.highRejectOwners?.length ?? 0) > 0) score -= 10;
    if ((adminRisks?.suspiciousApplicants?.length ?? 0) > 0) score -= 10;
    const criticalCount = adminAlerts.filter((item) => item.level === 'critical').length;
    const warningCount = adminAlerts.filter((item) => item.level === 'warning').length;
    score -= Math.min(16, criticalCount * 8 + warningCount * 4);
    const normalized = Math.max(0, Math.min(100, Math.round(score)));
    const tone = getHealthTone(normalized);
    const label =
      tone === 'good' ? 'Сервис стабилен' : tone === 'warn' ? 'Нужен контроль' : 'Требует вмешательства';
    return { score: normalized, tone, label };
  }, [
    adminAlerts,
    adminApplications?.stalePendingCount,
    adminCampaigns?.lowBudgetCount,
    adminRisks?.highRejectOwners?.length,
    adminRisks?.suspiciousApplicants?.length,
    adminSummaryApprovalRate,
    adminSummaryBonusRemaining,
    adminSummaryPendingApplications,
  ]);
  const adminPriorityActions = useMemo(() => {
    const actions: Array<{
      id: string;
      title: string;
      subtitle: string;
      section: AdminSectionId;
      tone: 'good' | 'warn' | 'critical';
    }> = [];

    if ((adminApplications?.stalePendingCount ?? 0) > 0) {
      actions.push({
        id: 'stale',
        title: `Разобрать зависшие заявки: ${formatNumberRu(adminApplications?.stalePendingCount ?? 0)}`,
        subtitle: 'Откройте модуль заявок и снимите backlog старше 24ч.',
        section: 'applications',
        tone: (adminApplications?.stalePendingCount ?? 0) >= 8 ? 'critical' : 'warn',
      });
    }
    if ((adminCampaigns?.lowBudgetCount ?? 0) > 0) {
      actions.push({
        id: 'budget',
        title: `Проверить кампании с низким бюджетом: ${formatNumberRu(adminCampaigns?.lowBudgetCount ?? 0)}`,
        subtitle: 'Откройте модуль кампаний и найдите задачи с риском остановки.',
        section: 'campaigns',
        tone: (adminCampaigns?.lowBudgetCount ?? 0) >= 10 ? 'warn' : 'good',
      });
    }
    if ((adminRisks?.suspiciousApplicants?.length ?? 0) > 0) {
      actions.push({
        id: 'suspicious',
        title: `Проверить подозрительных аппликантов: ${formatNumberRu(
          adminRisks?.suspiciousApplicants?.length ?? 0
        )}`,
        subtitle: 'Откройте риски и проверьте низкий approve rate.',
        section: 'risks',
        tone: 'critical',
      });
    }
    if ((adminRisks?.highRejectOwners?.length ?? 0) > 0) {
      actions.push({
        id: 'owners',
        title: `Проверить owners с высоким reject rate: ${formatNumberRu(
          adminRisks?.highRejectOwners?.length ?? 0
        )}`,
        subtitle: 'Откройте риски и сравните причины отклонений.',
        section: 'risks',
        tone: 'warn',
      });
    }
    if (adminSummaryPointsNet < 0) {
      actions.push({
        id: 'economy',
        title: 'Проверьте отрицательный net по баллам',
        subtitle: 'Откройте экономику и оцените причины перерасхода.',
        section: 'economy',
        tone: 'warn',
      });
    }
    if (actions.length === 0) {
      actions.push({
        id: 'stable',
        title: 'Критичных задач не обнаружено',
        subtitle: 'Проверьте обзор и держите периодический мониторинг.',
        section: 'overview',
        tone: 'good',
      });
    }
    return actions.slice(0, 3);
  }, [
    adminApplications?.stalePendingCount,
    adminCampaigns?.lowBudgetCount,
    adminRisks?.highRejectOwners?.length,
    adminRisks?.suspiciousApplicants?.length,
    adminSummaryPointsNet,
  ]);
  const contentClassName = [
    'content',
    activeTab === 'home' ? 'home-content' : '',
    activeTab === 'promo' ? 'promo-content' : '',
    activeTab === 'tasks' ? 'tasks-content' : '',
    activeTab === 'wheel' ? 'wheel-content' : '',
    activeTab === 'referrals' ? 'referrals-content' : '',
    activeTab === 'admin' ? 'admin-content' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (blockedState) {
    return (
      <div className="content blocked-content">
        <section className="blocked-screen">
          <div className="blocked-chip">Доступ ограничен</div>
          <h1 className="blocked-title">Аккаунт заблокирован</h1>
          <p className="blocked-sub">
            {blockedState.reason?.trim() || 'Обратитесь к администратору для разблокировки.'}
          </p>
          <div className="blocked-meta">
            <span>Срок блокировки</span>
            <strong>{blockedUntilLabel}</strong>
          </div>
          <button
            className="blocked-refresh-button"
            type="button"
            onClick={() => {
              void loadMe();
            }}
          >
            Обновить статус
          </button>
        </section>
      </div>
    );
  }

  return (
    <>
      <div className={contentClassName} ref={contentRef}>
        {welcomeBonus && (
          <div className="welcome-banner">
            <div className="welcome-text">
              Вас пригласили! Вы получили <strong>+{welcomeBonus.amount}</strong> баллов.
            </div>
            <button
              className="welcome-close"
              type="button"
              onClick={() => setWelcomeBonus(null)}
              aria-label="Скрыть уведомление"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M6 6l12 12" />
                <path d="M18 6l-12 12" />
              </svg>
            </button>
          </div>
        )}
        {activeTab === 'home' && (
          <>
            <ProfileCard />
            <section className={`daily-bonus-card ${dailyBonusAvailable ? 'ready' : ''}`}>
              <div className="daily-bonus-top">
                <div className="daily-bonus-copy">
                  <div className="daily-bonus-kicker">
                    <span className="daily-bonus-kicker-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M8.5 4.5h7l-1 4.1H9.6L8.5 4.5z" />
                        <path d="M6.5 8.6h11l-1.5 8.8H8z" />
                        <path d="M10 12.2h4" />
                      </svg>
                    </span>
                    <span>Бонус дня</span>
                  </div>
                  <div className="daily-bonus-title">Ежедневный бонус</div>
                  <div className="daily-bonus-sub">
                    Крути колесо раз в <strong>24 часа</strong>
                  </div>
                </div>
                <div className="daily-bonus-top-side">
                  <div
                    className={`daily-bonus-preview-wrap ${dailyBonusAvailable ? 'ready' : ''}`}
                    aria-hidden="true"
                  >
                    <span className="daily-bonus-preview-aura" />
                    <span className="daily-bonus-preview-shell" />
                    <span className="daily-bonus-preview-lights" />
                    <span className="daily-bonus-preview-orbit" />
                    <span className="daily-bonus-preview-ratchet" />
                    <span className="daily-bonus-preview-sheen" />
                    <div className="daily-bonus-preview">
                      <span className="daily-bonus-preview-facet" />
                      <span className="daily-bonus-preview-cap" />
                    </div>
                  </div>
                </div>
              </div>
              <button
                className="daily-bonus-cta"
                type="button"
                onClick={() => setActiveTab('wheel')}
                disabled={dailyBonusLoading}
              >
                <span className="cta-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                    <circle cx="12" cy="12" r="6.5" />
                    <path d="M12 5.5v3.2" />
                    <path d="M18.5 12h-3.2" />
                    <path d="M12 18.5v-3.2" />
                    <path d="M5.5 12h3.2" />
                  </svg>
                </span>
                <span>{dailyBonusAvailable ? 'Крутить сейчас' : 'Открыть колесо'}</span>
              </button>
              <div className={`daily-bonus-timer ${dailyBonusAvailable ? 'ready' : ''}`}>
                {homeDailyBonusLabel}
              </div>
              {dailyBonusError && <div className="daily-bonus-error">{dailyBonusError}</div>}
            </section>
            <section className="invite-card invite-card-compact">
              <div className="invite-compact-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M5 9h14v10H5z" />
                  <path d="M12 9v10" />
                  <path d="M5 13h14" />
                  <path d="M12 9c-2.1 0-3.8-.8-3.8-2.3S9.8 4 12 6.4C14.2 4 15.8 5 15.8 6.7S14.1 9 12 9z" />
                </svg>
              </div>
              <div className="invite-info">
                <div className="invite-title">Реферальная система</div>
                {referralLoading && <div className="invite-sub">Загрузка…</div>}
                {!referralLoading && referralError && (
                  <div className="invite-sub invite-sub-error">Статистика временно недоступна</div>
                )}
                {!referralLoading && !referralError && referralStats && (
                  <div className="invite-sub">
                    Приглашено {referralStats.stats.invited} • +{referralStats.stats.earned} баллов
                  </div>
                )}
                {!referralLoading && !referralError && !referralStats && (
                  <div className="invite-sub">
                    До {referralMaxRewardPerFriend} баллов за приглашённого
                  </div>
                )}
              </div>
              <button
                className="invite-button"
                type="button"
                onClick={() => setActiveTab('referrals')}
              >
                <span>Открыть</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                  <path d="M8 12h8" />
                  <path d="M12.5 7.8L16.7 12l-4.2 4.2" />
                </svg>
              </button>
            </section>
          </>
        )}

        {activeTab === 'wheel' && (
          <>
            <section className="wheel-card">
              <div className="wheel-head">
                <div className="wheel-head-main">
                  <div className="wheel-head-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="4" y="10" width="16" height="10" rx="2" />
                      <path d="M12 10v10" />
                      <path d="M4 14h16" />
                      <path d="M12 10c-1.5 0-3.5-.5-3.5-2.5S10 4 12 6.5c2-2.5 3.5-1.5 3.5 1S13.5 10 12 10z" />
                    </svg>
                  </div>
                  <div className="wheel-head-copy">
                    <div className="wheel-title">Ежедневный бонус</div>
                    <div className="wheel-sub">
                      Крути <strong>колесо</strong> и получай баллы каждый день.
                    </div>
                  </div>
                </div>
                <div className="wheel-head-side">
                  <div
                    className={`wheel-head-status ${
                      dailyBonusLoading ? 'loading' : dailyBonusAvailable ? 'ready' : 'locked'
                    }`}
                  >
                    <span className="wheel-head-status-dot" aria-hidden="true" />
                    <span>
                      {dailyBonusLoading
                        ? 'Обновляем'
                        : dailyBonusAvailable
                          ? 'Можно крутить'
                        : `Через ${wheelTimerValue}`}
                    </span>
                  </div>
                </div>
                <div className="wheel-head-meta">
                  <div className="wheel-head-chip">
                    <span className="wheel-head-chip-label">Серия</span>
                    <strong className="wheel-head-chip-value">{dailyStreak} дн.</strong>
                  </div>
                  <div className="wheel-head-chip">
                    <span className="wheel-head-chip-label">
                      {dailyBonusLoading ? 'Статус' : dailyBonusAvailable ? 'Прокрутка' : 'Откроется'}
                    </span>
                    <strong className="wheel-head-chip-value">
                      {dailyBonusLoading ? 'проверяем…' : dailyBonusAvailable ? 'сейчас' : nextSpinClockLabel}
                    </strong>
                  </div>
                </div>
                <button
                  className={`daily-bonus-info-button wheel-info-button wheel-head-meta-button ${
                    dailyBonusInfoOpen ? 'active' : ''
                  }`}
                  type="button"
                  onClick={() => setDailyBonusInfoOpen((prev) => !prev)}
                  aria-label={dailyBonusInfoOpen ? 'Скрыть детали бонуса' : 'Показать детали бонуса'}
                  aria-expanded={dailyBonusInfoOpen}
                  aria-controls="wheel-info-popover"
                >
                  i
                </button>
              </div>
              <div className="wheel-rules">
                <div className="wheel-rule-row">
                  <span className="wheel-rule-clock" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                      <circle cx="12" cy="12" r="8" />
                      <path d="M12 8v5l3 2" />
                    </svg>
                  </span>
                  <span>
                    <strong>1 прокрутка</strong> раз в <strong>24 часа</strong>
                  </span>
                </div>
                <div className="wheel-reward-row">
                  <span className="wheel-reward-dot" aria-hidden="true" />
                  <span className="wheel-reward-label">Награды</span>
                  <div className="wheel-reward-list">
                    {DAILY_WHEEL_VALUE_CHANCES.map((entry) => (
                      <span
                        key={`wheel-reward-chip-${entry.value}`}
                        className={`wheel-reward-chip ${
                          entry.value >= 100
                            ? 'jackpot'
                            : entry.value >= 50
                              ? 'high'
                              : entry.value >= 20
                                ? 'mid'
                                : 'base'
                        }`}
                      >
                        {entry.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className={`wheel-info-layer ${dailyBonusInfoOpen ? 'open' : ''}`}>
                <button
                  className="wheel-info-backdrop"
                  type="button"
                  onClick={() => setDailyBonusInfoOpen(false)}
                  aria-label="Закрыть детали бонуса"
                  tabIndex={dailyBonusInfoOpen ? 0 : -1}
                />
                <div
                  id="wheel-info-popover"
                  className="daily-bonus-info-popover wheel-info-popover"
                  role="dialog"
                  aria-hidden={!dailyBonusInfoOpen}
                >
                  <div className="daily-bonus-info-main">
                    <div className="daily-bonus-info-item">
                      <span>Серия</span>
                      <strong>{dailyStreak} дн.</strong>
                    </div>
                    <div className="daily-bonus-info-item">
                      <span>Средний бонус</span>
                      <strong>~{Math.round(DAILY_WHEEL_AVERAGE_REWARD)}</strong>
                    </div>
                  </div>
                  <div className="daily-bonus-info-label">Шансы выпадения</div>
                  <div className="daily-bonus-info-chances">
                    {DAILY_WHEEL_VALUE_CHANCES.map((entry) => (
                      <div className="daily-bonus-info-chance" key={`wheel-chance-${entry.value}`}>
                        <span className="daily-bonus-info-reward">{entry.label}</span>
                        <div className="daily-bonus-info-track">
                          <span style={{ width: `${entry.chance}%` }} />
                        </div>
                        <span className="daily-bonus-info-value">{entry.chance.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="wheel-wrapper">
                <div
                  ref={wheelRotorRef}
                  className={`wheel-rotor phase-${wheelSpinPhase} ${wheelSpinning ? 'spinning' : ''} ${
                    wheelCelebrating ? 'celebrate' : ''
                  }`}
                >
                  <div className="wheel-shell" aria-hidden="true" />
                  <div className="wheel-orbit" aria-hidden="true" />
                  <div className="wheel-ratchet" aria-hidden="true" />
                  <div className="wheel">
                    <div className="wheel-facet-disk" aria-hidden="true" />
                    {DAILY_WHEEL_SEGMENTS.map((segment, index) => {
                      const angle = index * DAILY_WHEEL_SLICE + DAILY_WHEEL_SLICE / 2;
                      return (
                        <div
                          key={`${segment.label}-${index}`}
                          className={`wheel-segment ${
                            wheelWinningIndex === index && wheelCelebrating ? 'winner' : ''
                          }`}
                          style={{ transform: `rotate(${angle}deg)` }}
                        >
                          <span className="wheel-value" style={{ transform: `rotate(${-angle}deg)` }}>
                            {segment.value}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="wheel-center" aria-hidden="true">
                    <span className="wheel-center-star">★</span>
                  </div>
                </div>
                <div
                  className={`wheel-pointer-assembly ${wheelSpinning ? 'spinning' : ''} ${
                    wheelCelebrating ? 'celebrate' : ''
                  }`}
                  aria-hidden="true"
                >
                  <div className="wheel-pointer-base" />
                  <div className="wheel-pointer" />
                </div>
                {wheelResult && wheelRewardBurst && (
                  <div
                    className={`wheel-reward-burst-chip ${
                      wheelResult.value >= 100 ? 'jackpot' : ''
                    }`}
                    aria-hidden="true"
                  >
                    <span className="wheel-reward-burst-badge">
                      {wheelResult.value >= 100 ? 'Джекпот' : 'Награда'}
                    </span>
                    <strong>{wheelResult.label}</strong>
                  </div>
                )}
              </div>
              <button
                className="wheel-cta"
                type="button"
                onClick={handleSpinDailyBonus}
                disabled={wheelSpinning || dailyBonusLoading || !dailyBonusAvailable || wheelRewardModalOpen}
              >
                {wheelSpinning ? 'Крутим...' : 'Крутить'}
              </button>
              <div className={`wheel-timer ${dailyBonusAvailable ? 'ready' : ''}`}>
                <span>{wheelTimerPrefix}</span> <strong>{wheelTimerValue}</strong>
              </div>
              {dailyBonusError && <div className="wheel-error">{dailyBonusError}</div>}
            </section>
          </>
        )}

        {activeTab === 'referrals' && (
          <>
            <section className="referral-hero">
              <div className="referral-hero-top">
                <div className="referral-hero-kicker">Реферальная программа</div>
                <button
                  className={`referral-info-button ${referralInfoOpen ? 'active' : ''}`}
                  type="button"
                  onClick={() => setReferralInfoOpen((prev) => !prev)}
                  aria-label={
                    referralInfoOpen
                      ? 'Скрыть детали реферальной программы'
                      : 'Показать детали реферальной программы'
                  }
                  aria-expanded={referralInfoOpen}
                  aria-controls="referral-info-popover"
                >
                  i
                </button>
              </div>
              <div className="referral-hero-copy">
                <div className="referral-hero-title">Приглашайте друзей и получайте баллы</div>
                <div className="referral-hero-sub">
                  До {referralMaxRewardPerFriend} {formatPointsLabel(referralMaxRewardPerFriend)} за одного
                  приглашённого.
                </div>
              </div>

              {referralLoading && <div className="referral-status">Загрузка…</div>}
              {!referralLoading && (
                <>
                  <div className="referral-stats-grid referral-stats-grid-compact">
                    <div className="referral-stat">
                      <div className="referral-stat-label">Приглашено</div>
                      <div className="referral-stat-value">{referralInvitedCount}</div>
                    </div>
                    <div className="referral-stat">
                      <div className="referral-stat-label">Заработано</div>
                      <div className="referral-stat-value">{referralEarnedTotal}</div>
                      <div className="referral-stat-sub">{formatPointsLabel(referralEarnedTotal)}</div>
                    </div>
                  </div>

                  <div className="referral-goal-block">
                    <div className="referral-goal-head">
                      <span>Освоено потенциала</span>
                      <strong>{referralPotentialProgress}%</strong>
                    </div>
                    <div className="referral-goal-track" aria-hidden="true">
                      <span style={{ width: `${referralPotentialProgress}%` }} />
                    </div>
                    <div className="referral-goal-sub">
                      {referralInvitedCount > 0
                        ? `${referralEarnedTotal} из ${referralPotentialTotal} ${formatPointsLabel(referralPotentialTotal)}`
                        : 'Появится после первого приглашённого'}
                    </div>
                  </div>

                  <div className="referral-link-block">
                    <div className="referral-link-head">
                      <div className="referral-link-label">Ваша ссылка</div>
                      <button
                        className="referral-copy-link"
                        type="button"
                        onClick={handleCopyInviteLink}
                        disabled={!referralLinkAvailable}
                      >
                        {!referralLinkAvailable
                          ? 'Недоступно'
                          : inviteCopied
                            ? 'Скопировано'
                            : 'Копировать'}
                      </button>
                    </div>
                    <div className={`referral-link ${referralLinkAvailable ? '' : 'muted'}`}>
                      {referralLink || 'Ссылка появится после входа в Telegram Mini App'}
                    </div>
                    <div className="referral-code">
                      Код: {referralStats?.code || 'недоступен'}
                    </div>
                  </div>
                </>
              )}

              {referralError && <div className="referral-status error">{referralError}</div>}

              <button
                className="referral-share"
                type="button"
                onClick={handleShareInvite}
                disabled={!referralLinkAvailable}
              >
                {referralLinkAvailable ? 'Пригласить друга' : 'Ссылка недоступна'}
              </button>
              <div className="referral-share-sub">{referralShareHint}</div>
            </section>

            <section className="referral-list">
              <div className="referral-list-head">
                <div className="section-title">Ваши приглашённые</div>
                {!referralListLoading && !referralListError && referralList.length > 0 && (
                  <div className="referral-list-count">{referralList.length}</div>
                )}
              </div>
              {referralListLoading && <div className="referral-status">Загрузка…</div>}
              {!referralListLoading && referralListError && (
                <div className="referral-status error">{referralListError}</div>
              )}
              {!referralListLoading && !referralListError && referralList.length === 0 && (
                <div className="referral-empty-state">
                  <div className="referral-empty-title">Пока нет приглашённых</div>
                  <div className="referral-empty-sub">
                    Отправьте приглашение в личный чат, канал или группу.
                  </div>
                  <div className="referral-empty-note">Используйте кнопку «Пригласить друга» выше.</div>
                </div>
              )}
              {!referralListLoading &&
                !referralListError &&
                referralList.map((item) => {
                  const completedOrders = Math.max(0, Math.floor(item.completedOrders));
                  const nextStep = getReferralNextStep(item.completedOrders);
                  const toNext = nextStep
                    ? Math.max(0, nextStep.orders - completedOrders)
                    : 0;
                  return (
                    <div className="referral-item" key={item.id}>
                      <div className="referral-item-head">
                        <div className="referral-avatar">
                          <span>{getReferralUserLabel(item.referredUser)[0]}</span>
                        </div>
                        <div className="referral-item-info">
                          <div className="referral-item-name">
                            {getReferralUserLabel(item.referredUser)}
                          </div>
                        </div>
                        <div className="referral-item-earned">+{item.earned}</div>
                      </div>
                      <div className="referral-item-meta">
                        <div className="referral-item-progress-main">Прогресс {Math.min(30, completedOrders)}/30</div>
                        <div className={`referral-item-next ${nextStep ? '' : 'done'}`}>
                          {nextStep ? `До «${nextStep.label}»: ${toNext}` : 'Все этапы пройдены'}
                        </div>
                      </div>
                      <div className="referral-progress">
                        <div
                          className="referral-progress-bar"
                          style={{ width: getReferralProgressPercent(completedOrders) }}
                        />
                      </div>
                      <div className="referral-item-date">
                        В программе с {getReferralCreatedLabel(item.createdAt)}
                      </div>
                    </div>
                  );
                })}
            </section>

            <div className={`referral-info-screen-layer ${referralInfoOpen ? 'open' : ''}`}>
              <button
                className="referral-info-screen-backdrop"
                type="button"
                onClick={() => setReferralInfoOpen(false)}
                aria-label="Закрыть детали реферальной программы"
                tabIndex={referralInfoOpen ? 0 : -1}
              />
              <div
                id="referral-info-popover"
                className="referral-info-popover"
                role="dialog"
                aria-hidden={!referralInfoOpen}
              >
                <div className="referral-info-main">
                  <div className="referral-info-item">
                    <span>Средний доход с приглашённого</span>
                    <strong>
                      {referralInvitedCount > 0
                        ? `${referralAveragePerFriend} ${formatPointsLabel(referralAveragePerFriend)}`
                        : 'Нет данных'}
                    </strong>
                  </div>
                  <div className="referral-info-item">
                    <span>Освоено потенциала</span>
                    <strong>{referralPotentialProgress}%</strong>
                  </div>
                </div>
                <div className="referral-info-track" aria-hidden="true">
                  <span style={{ width: `${referralPotentialProgress}%` }} />
                </div>
                <div className="referral-info-sub">
                  {referralInvitedCount > 0
                    ? `${referralEarnedTotal} из ${referralPotentialTotal} ${formatPointsLabel(referralPotentialTotal)}`
                    : 'Пригласите первого друга, чтобы открыть прогресс'}
                </div>
                <div className="referral-info-label">Этапы начислений за одного приглашённого</div>
                <div className="referral-info-steps">
                  {REFERRAL_STEPS.map((step, index) => (
                    <div
                      className={`referral-info-step ${
                        referralHasInvites && step.orders <= referralBestOrders ? 'active' : ''
                      }`}
                      key={`referral-info-${step.label}`}
                    >
                      <span>
                        {index + 1}. {step.label}
                      </span>
                      <strong>+{step.reward}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === 'admin' && adminPanelAllowed && (
          <>
            <div className="page-header admin-header">
              <button
                className="icon-button"
                type="button"
                onClick={() => setActiveTab('home')}
                aria-label="Назад"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <div className="page-title admin-page-title">Модерация</div>
              <button
                className="admin-refresh-button admin-refresh-inline"
                type="button"
                onClick={() => {
                  void loadAdminModeration();
                }}
                disabled={adminModerationLoading}
              >
                {adminModerationLoading ? '...' : 'Обновить'}
              </button>
            </div>

            <section className="admin-section-card admin-moderation-summary">
              {adminModerationLoading && <div className="admin-panel-status">Загрузка модерации…</div>}
              {!adminModerationLoading && adminModerationError && (
                <div className="admin-panel-status error">{adminModerationError}</div>
              )}
              {!adminModerationLoading && !adminModerationError && adminModerationSummary && (
                <div className="admin-mini-grid">
                  <div className="admin-mini-item">
                    <span>Открытые жалобы</span>
                    <strong>{formatNumberRu(adminModerationSummary.openReports)}</strong>
                  </div>
                  <div className="admin-mini-item">
                    <span>Зависшие заявки</span>
                    <strong>{formatNumberRu(adminModerationSummary.stalePendingCount)}</strong>
                  </div>
                  <div className="admin-mini-item">
                    <span>Заблокированные</span>
                    <strong>{formatNumberRu(adminModerationSummary.blockedUsersCount)}</strong>
                  </div>
                  <div className="admin-mini-item">
                    <span>Обновлено</span>
                    <strong>{formatDateTimeRu(adminModerationSummary.updatedAt)}</strong>
                  </div>
                </div>
              )}
              {!adminModerationLoading &&
                !adminModerationError &&
                !adminModerationSummary && (
                  <div className="admin-panel-status">Данные модерации недоступны.</div>
                )}
            </section>

            {!adminModerationLoading && !adminModerationError && (
              <>
                <section className="admin-section-card">
                  <div className="admin-section-head">
                    <div className="admin-section-title">Жалобы</div>
                    <div className="admin-section-sub">Удаление, штраф, блокировка</div>
                  </div>
                  {adminModerationComplaints.length === 0 && (
                    <div className="admin-empty">Открытых жалоб нет.</div>
                  )}
                  {adminModerationComplaints.map((complaint) => {
                    const form = adminModerationForms[complaint.campaignId] ?? createAdminModerationForm();
                    return (
                      <div className="admin-moderation-card" key={complaint.campaignId}>
                        <div className="admin-moderation-head">
                          <div className="admin-entity-title">{complaint.campaign.groupTitle}</div>
                          <div className="admin-entity-sub">
                            {formatCampaignTypeRu(complaint.campaign.actionType)} • {formatDateTimeRu(complaint.lastReportedAt)}
                          </div>
                        </div>
                        <div className="admin-mini-grid admin-moderation-stats">
                          <div className="admin-mini-item">
                            <span>Жалоб</span>
                            <strong>{formatNumberRu(complaint.reportCount)}</strong>
                          </div>
                          <div className="admin-mini-item">
                            <span>Причина</span>
                            <strong>{complaint.topReasonLabel}</strong>
                          </div>
                        </div>
                        <div className="admin-entity-sub">
                          Владелец: {complaint.owner.label}
                          {complaint.owner.isBlocked ? ' • заблокирован' : ''}
                        </div>
                        {complaint.sampleReporters.length > 0 && (
                          <div className="admin-entity-sub">
                            Репортеры: {complaint.sampleReporters.join(', ')}
                          </div>
                        )}

                        <label className="admin-form-toggle">
                          <input
                            type="checkbox"
                            checked={form.deleteCampaign}
                            onChange={(event) =>
                              setAdminModerationFormValue(complaint.campaignId, (current) => ({
                                ...current,
                                deleteCampaign: event.target.checked,
                              }))
                            }
                          />
                          <span>Удалить кампанию глобально</span>
                        </label>

                        <label className="admin-form-toggle">
                          <input
                            type="checkbox"
                            checked={form.fineEnabled}
                            onChange={(event) =>
                              setAdminModerationFormValue(complaint.campaignId, (current) => ({
                                ...current,
                                fineEnabled: event.target.checked,
                              }))
                            }
                          />
                          <span>Штраф владельцу</span>
                        </label>
                        {form.fineEnabled && (
                          <div className="admin-form-grid">
                            <input
                              className="admin-form-input"
                              type="number"
                              min={1}
                              placeholder="Баллы штрафа"
                              value={form.finePoints}
                              onChange={(event) =>
                                setAdminModerationFormValue(complaint.campaignId, (current) => ({
                                  ...current,
                                  finePoints: event.target.value,
                                }))
                              }
                            />
                            <input
                              className="admin-form-input"
                              type="text"
                              placeholder="Причина штрафа"
                              value={form.fineReason}
                              onChange={(event) =>
                                setAdminModerationFormValue(complaint.campaignId, (current) => ({
                                  ...current,
                                  fineReason: event.target.value,
                                }))
                              }
                            />
                          </div>
                        )}

                        <div className="admin-form-grid">
                          <select
                            className="admin-form-input"
                            value={form.blockMode}
                            onChange={(event) =>
                              setAdminModerationFormValue(complaint.campaignId, (current) => ({
                                ...current,
                                blockMode: event.target.value as AdminModerationBlockMode,
                              }))
                            }
                          >
                            <option value="none">Без блокировки</option>
                            <option value="temporary">Временный блок</option>
                            <option value="permanent">Постоянный блок</option>
                          </select>
                          {form.blockMode === 'temporary' && (
                            <input
                              className="admin-form-input"
                              type="number"
                              min={1}
                              placeholder="Дней блокировки"
                              value={form.blockDays}
                              onChange={(event) =>
                                setAdminModerationFormValue(complaint.campaignId, (current) => ({
                                  ...current,
                                  blockDays: event.target.value,
                                }))
                              }
                            />
                          )}
                        </div>
                        {form.blockMode !== 'none' && (
                          <input
                            className="admin-form-input"
                            type="text"
                            placeholder="Причина блокировки"
                            value={form.blockReason}
                            onChange={(event) =>
                              setAdminModerationFormValue(complaint.campaignId, (current) => ({
                                ...current,
                                blockReason: event.target.value,
                              }))
                            }
                          />
                        )}

                        <button
                          className="admin-refresh-button"
                          type="button"
                          disabled={adminModerationActionId === complaint.campaignId}
                          onClick={() => {
                            void handleAdminModerateCampaign(complaint.campaignId);
                          }}
                        >
                          {adminModerationActionId === complaint.campaignId ? 'Применяем…' : 'Применить'}
                        </button>
                      </div>
                    );
                  })}
                </section>

                <section className="admin-section-card">
                  <div className="admin-section-head">
                    <div className="admin-section-title">Зависшие заявки</div>
                    <div className="admin-section-sub">
                      Pending старше {formatNumberRu(adminModerationStale?.thresholdHours ?? 24)} часов
                    </div>
                  </div>
                  <div className="admin-mini-grid">
                    <div className="admin-mini-item">
                      <span>Количество</span>
                      <strong>{formatNumberRu(adminModerationStale?.count ?? 0)}</strong>
                    </div>
                    <div className="admin-mini-item">
                      <span>Самая старая</span>
                      <strong>
                        {adminModerationStale?.oldestCreatedAt
                          ? formatDateTimeRu(adminModerationStale.oldestCreatedAt)
                          : 'нет'}
                      </strong>
                    </div>
                  </div>
                  <button
                    className="admin-refresh-button"
                    type="button"
                    disabled={adminStaleCleanupLoading || (adminModerationStale?.count ?? 0) <= 0}
                    onClick={() => {
                      void handleAdminCleanupStale();
                    }}
                  >
                    {adminStaleCleanupLoading ? 'Очищаем…' : 'Очистить зависшие'}
                  </button>
                </section>

                <section className="admin-section-card">
                  <div className="admin-section-head">
                    <div className="admin-section-title">Заблокированные пользователи</div>
                  </div>
                  {adminModerationBlockedUsers.length === 0 && (
                    <div className="admin-empty">Сейчас блокировок нет.</div>
                  )}
                  {adminModerationBlockedUsers.length > 0 && (
                    <div className="admin-entity-list">
                      {adminModerationBlockedUsers.map((item) => (
                        <div className="admin-moderation-user" key={item.id}>
                          <div className="admin-entity-main">
                            <div className="admin-entity-title">{item.label}</div>
                            <div className="admin-entity-sub">
                              {item.blockReason || 'Причина не указана'} • до{' '}
                              {item.blockedUntil ? formatDateTimeRu(item.blockedUntil) : 'бессрочно'}
                            </div>
                          </div>
                          <button
                            className="admin-inline-button"
                            type="button"
                            disabled={adminUnblockUserId === item.id}
                            onClick={() => {
                              void handleAdminUnblockUser(item.id);
                            }}
                          >
                            {adminUnblockUserId === item.id ? '...' : 'Разблокировать'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}

            {false && (
              <>
            <div className="page-header admin-header">
              <button
                className="icon-button"
                type="button"
                onClick={() => setActiveTab('home')}
                aria-label="Назад"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <div className="page-title admin-page-title">Админ-панель</div>
              <div className="header-spacer" aria-hidden="true" />
            </div>

            <section className="admin-panel-card admin-overview-card">
              <div className="admin-panel-head">
                <div className="admin-panel-kicker">Control center</div>
                <div className="admin-panel-title">Управление сервисом</div>
                <div className="admin-panel-sub">
                  {adminPeriodRangeLabel || 'Выберите период и обновите данные'}
                </div>
              </div>

              <div className="admin-period-switch" role="tablist" aria-label="Выбор периода">
                {ADMIN_PERIOD_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    className={`admin-period-button ${adminPeriod === option.id ? 'active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={adminPeriod === option.id}
                    onClick={() => handleAdminPeriodSelect(option.id)}
                    disabled={adminPanelLoading}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              {adminPanelLoading && <div className="admin-panel-status">Загрузка статистики…</div>}
              {!adminPanelLoading && adminPanelError && (
                <div className="admin-panel-status error">{adminPanelError}</div>
              )}

              {!adminPanelLoading && !adminPanelError && adminPanelStats && (
                <>
                  <div className="admin-panel-grid admin-overview-grid">
                    <div className="admin-stat-card">
                      <span className="admin-stat-label">Новые пользователи</span>
                      <strong className="admin-stat-value">
                        {formatNumberRu(adminSummaryNewUsers)}
                      </strong>
                    </div>
                    <div className="admin-stat-card">
                      <span className="admin-stat-label">Активные пользователи</span>
                      <strong className="admin-stat-value">
                        {formatNumberRu(adminSummaryActiveUsers)}
                      </strong>
                    </div>
                    <div className="admin-stat-card">
                      <span className="admin-stat-label">Всего пользователей</span>
                      <strong className="admin-stat-value">
                        {formatNumberRu(adminSummaryTotalUsers)}
                      </strong>
                    </div>
                    <div className="admin-stat-card">
                      <span className="admin-stat-label">Pending заявок</span>
                      <strong className="admin-stat-value">
                        {formatNumberRu(adminSummaryPendingApplications)}
                      </strong>
                    </div>
                    <div className="admin-stat-card">
                      <span className="admin-stat-label">Апрув за период</span>
                      <strong className="admin-stat-value">
                        {formatPercentRu(adminSummaryApprovalRate)}
                      </strong>
                      <span className="admin-stat-sub">
                        Reviewed: {formatNumberRu(adminSummaryReviewed)}
                      </span>
                    </div>
                    <div className="admin-stat-card">
                      <span className="admin-stat-label">Баллы (net)</span>
                      <strong className="admin-stat-value accent">
                        {formatSigned(adminSummaryPointsNet)}
                      </strong>
                      <span className="admin-stat-sub">
                        +{formatNumberRu(adminSummaryPointsIssued)} / -{formatNumberRu(adminSummaryPointsSpent)}
                      </span>
                    </div>
                  </div>

                  <div className={`admin-health-card ${adminHealth.tone}`}>
                    <div className="admin-health-head">
                      <span>Индекс состояния сервиса</span>
                      <strong>{adminHealth.score}/100</strong>
                    </div>
                    <div className="admin-health-sub">{adminHealth.label}</div>
                  </div>

                  <div className="admin-progress">
                    <div className="admin-progress-track" aria-hidden="true">
                      <span style={{ width: `${adminBonusProgress}%` }} />
                    </div>
                    <div className="admin-progress-meta">
                      Бонус +{formatNumberRu(adminSummaryBonusAmount)} выдан:{' '}
                      <strong>{formatNumberRu(adminSummaryBonusGranted)}</strong> из{' '}
                      <strong>{formatNumberRu(adminSummaryBonusLimit)}</strong> • осталось{' '}
                      <strong>{formatNumberRu(adminSummaryBonusRemaining)}</strong> ({adminBonusProgress}%)
                    </div>
                  </div>

                  <div className="admin-panel-foot">
                    <span>Обновлено • период: {adminPeriod}</span>
                    <strong>{adminUpdatedAtLabel}</strong>
                  </div>
                </>
              )}
              {!adminPanelLoading && !adminPanelError && !adminPanelStats && (
                <div className="admin-panel-status">
                  Нет данных за период. Нажмите «Обновить», чтобы загрузить аналитику.
                </div>
              )}

              <button
                className="admin-refresh-button"
                type="button"
                onClick={() => {
                  void loadAdminPanel({ period: adminPeriod });
                }}
                disabled={adminPanelLoading}
              >
                {adminPanelLoading ? 'Обновляем…' : 'Обновить'}
              </button>
            </section>

            {!adminPanelLoading && !adminPanelError && adminPanelStats && (
              <>
                <section className="admin-section-card admin-actions-card">
                  <div className="admin-section-head">
                    <div className="admin-section-title">Приоритеты сейчас</div>
                    <div className="admin-section-sub">Выберите действие и перейдите в нужный модуль</div>
                  </div>
                  <div className="admin-action-list">
                    {adminPriorityActions.map((action) => (
                      <button
                        key={action.id}
                        className={`admin-action-item ${action.tone}`}
                        type="button"
                        onClick={() => handleAdminSectionSelect(action.section)}
                      >
                        <strong>{action.title}</strong>
                        <span>{action.subtitle}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <div className="admin-module-switch" role="tablist" aria-label="Разделы админки">
                  {ADMIN_SECTION_OPTIONS.map((section) => (
                    <button
                      key={section.id}
                      className={`admin-module-button ${adminSection === section.id ? 'active' : ''}`}
                      type="button"
                      role="tab"
                      aria-selected={adminSection === section.id}
                      onClick={() => handleAdminSectionSelect(section.id)}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>

                {adminSection === 'overview' && (
                  <section className="admin-section-card">
                    <div className="admin-section-head">
                      <div className="admin-section-title">Обзор по рискам и динамике</div>
                      <div className="admin-section-sub">Ключевые сигналы по всей системе на одном экране</div>
                    </div>
                    <div className="admin-mini-grid">
                      <div className="admin-mini-item">
                        <span>Кампании с низким бюджетом</span>
                        <strong>{formatNumberRu(adminCampaigns?.lowBudgetCount ?? 0)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Зависшие заявки &gt;24ч</span>
                        <strong>{formatNumberRu(adminApplications?.stalePendingCount ?? 0)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Net баллов за период</span>
                        <strong>{formatSigned(adminSummaryPointsNet)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Подозрительные аппликанты</span>
                        <strong>{formatNumberRu(adminRisks?.suspiciousApplicants?.length ?? 0)}</strong>
                      </div>
                    </div>

                    {adminTrends && (
                      <div className="admin-trend-grid">
                        <div className={`admin-trend-card ${adminTrends.newUsers.direction}`}>
                          <div className="admin-trend-label">Новые пользователи</div>
                          <div className="admin-trend-value">
                            {getTrendDirectionSign(adminTrends.newUsers.direction)}{' '}
                            {formatSignedPercentRu(adminTrends.newUsers.deltaPct)}
                          </div>
                          <div className="admin-trend-sub">
                            {getTrendDirectionLabel(adminTrends.newUsers.direction)} к прошлому периоду
                          </div>
                        </div>
                        <div className={`admin-trend-card ${adminTrends.pointsIssued.direction}`}>
                          <div className="admin-trend-label">Эмиссия баллов</div>
                          <div className="admin-trend-value">
                            {getTrendDirectionSign(adminTrends.pointsIssued.direction)}{' '}
                            {formatSignedPercentRu(adminTrends.pointsIssued.deltaPct)}
                          </div>
                          <div className="admin-trend-sub">
                            {getTrendDirectionLabel(adminTrends.pointsIssued.direction)} к прошлому периоду
                          </div>
                        </div>
                        <div className={`admin-trend-card ${adminTrends.reviewedApplications.direction}`}>
                          <div className="admin-trend-label">Проверки заявок</div>
                          <div className="admin-trend-value">
                            {getTrendDirectionSign(adminTrends.reviewedApplications.direction)}{' '}
                            {formatSignedPercentRu(adminTrends.reviewedApplications.deltaPct)}
                          </div>
                          <div className="admin-trend-sub">
                            {getTrendDirectionLabel(adminTrends.reviewedApplications.direction)} к прошлому периоду
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="admin-alert-list">
                      {adminAlerts.slice(0, 3).map((alert, index) => (
                        <div className={`admin-alert ${getAlertToneClass(alert.level)}`} key={`overview-alert-${index}`}>
                          <strong>{alert.level.toUpperCase()}</strong>
                          <span>{alert.message}</span>
                        </div>
                      ))}
                    </div>

                    {(adminReferrals?.topReferrers?.length ?? 0) > 0 && (
                      <div className="admin-risk-block">
                        <div className="admin-split-title">Топ рефереры за период</div>
                        <div className="admin-entity-list compact">
                          {adminReferrals?.topReferrers.map((item) => (
                            <div className="admin-entity-row compact" key={item.userId}>
                              <div className="admin-entity-main">
                                <div className="admin-entity-title">{item.userLabel}</div>
                                <div className="admin-entity-sub">
                                  Инвайтов: {formatNumberRu(item.invited)}
                                </div>
                              </div>
                              <div className="admin-entity-meta">
                                <strong>{formatNumberRu(item.rewards)}</strong>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {adminSection === 'campaigns' && (
                  <section className="admin-section-card">
                    <div className="admin-section-head">
                      <div className="admin-section-title">Кампании</div>
                      <div className="admin-section-sub">Фокус на бюджет и конверсию</div>
                    </div>
                    <div className="admin-mini-grid">
                      <div className="admin-mini-item">
                        <span>Создано за период</span>
                        <strong>{formatNumberRu(adminCampaigns?.createdInPeriod ?? 0)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Активные / Пауза / Завершены</span>
                        <strong>
                          {formatNumberRu(adminCampaigns?.activeCount ?? 0)} /{' '}
                          {formatNumberRu(adminCampaigns?.pausedCount ?? 0)} /{' '}
                          {formatNumberRu(adminCampaigns?.completedCount ?? 0)}
                        </strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Бюджет на исходе</span>
                        <strong>{formatNumberRu(adminCampaigns?.lowBudgetCount ?? 0)}</strong>
                      </div>
                    </div>
                    {(adminCampaigns?.topCampaigns?.length ?? 0) > 0 ? (
                      <div className="admin-entity-list">
                        {adminCampaigns?.topCampaigns.map((campaign) => (
                          <div className="admin-entity-row" key={campaign.id}>
                            <div className="admin-entity-main">
                              <div className="admin-entity-title">{campaign.groupTitle}</div>
                              <div className="admin-entity-sub">
                                {campaign.ownerLabel} • {formatCampaignTypeRu(campaign.actionType)} •{' '}
                                {formatCampaignStatusRu(campaign.status)}
                              </div>
                            </div>
                            <div className="admin-entity-meta">
                              <strong>{formatNumberRu(campaign.spentBudget)}</strong>
                              <span>
                                из {formatNumberRu(campaign.totalBudget)} • апрув{' '}
                                {formatPercentRu(campaign.approvalRate)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="admin-empty">Нет данных по кампаниям за выбранный период.</div>
                    )}
                  </section>
                )}

                {adminSection === 'applications' && (
                  <section className="admin-section-card">
                    <div className="admin-section-head">
                      <div className="admin-section-title">Заявки</div>
                      <div className="admin-section-sub">Очередь, скорость проверки и последние решения</div>
                    </div>
                    <div className="admin-mini-grid">
                      <div className="admin-mini-item">
                        <span>Pending / Stale &gt;24ч</span>
                        <strong>
                          {formatNumberRu(adminApplications?.pendingCount ?? 0)} /{' '}
                          {formatNumberRu(adminApplications?.stalePendingCount ?? 0)}
                        </strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Проверено за период</span>
                        <strong>{formatNumberRu(adminApplications?.reviewedInPeriod ?? 0)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Среднее время проверки</span>
                        <strong>{formatNumberRu(adminApplications?.avgReviewMinutes ?? 0)} мин</strong>
                      </div>
                    </div>
                    <div className="admin-split-grid">
                      <div className="admin-split-block">
                        <div className="admin-split-title">Старые pending</div>
                        {(adminApplications?.recentPending?.length ?? 0) > 0 ? (
                          <div className="admin-entity-list compact">
                            {adminApplications?.recentPending.map((item) => (
                              <div className="admin-entity-row compact" key={item.id}>
                                <div className="admin-entity-main">
                                  <div className="admin-entity-title">{item.campaignLabel}</div>
                                  <div className="admin-entity-sub">
                                    {item.applicantLabel} • {item.ownerLabel}
                                  </div>
                                </div>
                                <div className="admin-entity-meta">
                                  <span>{formatDateTimeRu(item.createdAt)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="admin-empty">Очередь пустая.</div>
                        )}
                      </div>
                      <div className="admin-split-block">
                        <div className="admin-split-title">Последние решения</div>
                        {(adminApplications?.recentReviewed?.length ?? 0) > 0 ? (
                          <div className="admin-entity-list compact">
                            {adminApplications?.recentReviewed.map((item) => (
                              <div className="admin-entity-row compact" key={item.id}>
                                <div className="admin-entity-main">
                                  <div className="admin-entity-title">
                                    {item.campaignLabel} • {formatApplicationStatusRu(item.status)}
                                  </div>
                                  <div className="admin-entity-sub">{item.applicantLabel}</div>
                                </div>
                                <div className="admin-entity-meta">
                                  <span>{formatDateTimeRu(item.reviewedAt)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="admin-empty">Нет проверок за выбранный период.</div>
                        )}
                      </div>
                    </div>
                  </section>
                )}

                {adminSection === 'economy' && (
                  <section className="admin-section-card">
                    <div className="admin-section-head">
                      <div className="admin-section-title">Экономика</div>
                      <div className="admin-section-sub">Движение баллов и крупные операции</div>
                    </div>
                    <div className="admin-mini-grid">
                      <div className="admin-mini-item">
                        <span>Начислено</span>
                        <strong>+{formatNumberRu(adminEconomy?.issuedPoints ?? 0)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Списано</span>
                        <strong>-{formatNumberRu(adminEconomy?.spentPoints ?? 0)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Итог периода</span>
                        <strong>{formatSigned(adminEconomy?.netPoints ?? 0)}</strong>
                      </div>
                    </div>
                    <div className="admin-split-grid">
                      <div className="admin-split-block">
                        <div className="admin-split-title">Топ начислений</div>
                        {(adminEconomy?.topCredits?.length ?? 0) > 0 ? (
                          <div className="admin-entity-list compact">
                            {adminEconomy?.topCredits.map((item) => (
                              <div className="admin-entity-row compact" key={item.id}>
                                <div className="admin-entity-main">
                                  <div className="admin-entity-title">{item.userLabel}</div>
                                  <div className="admin-entity-sub">{item.reason}</div>
                                </div>
                                <div className="admin-entity-meta">
                                  <strong>+{formatNumberRu(item.amount)}</strong>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="admin-empty">Нет начислений.</div>
                        )}
                      </div>
                      <div className="admin-split-block">
                        <div className="admin-split-title">Топ списаний</div>
                        {(adminEconomy?.topDebits?.length ?? 0) > 0 ? (
                          <div className="admin-entity-list compact">
                            {adminEconomy?.topDebits.map((item) => (
                              <div className="admin-entity-row compact" key={item.id}>
                                <div className="admin-entity-main">
                                  <div className="admin-entity-title">{item.userLabel}</div>
                                  <div className="admin-entity-sub">{item.reason}</div>
                                </div>
                                <div className="admin-entity-meta">
                                  <strong>-{formatNumberRu(item.amount)}</strong>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="admin-empty">Нет списаний.</div>
                        )}
                      </div>
                    </div>
                  </section>
                )}

                {adminSection === 'risks' && (
                  <section className="admin-section-card">
                    <div className="admin-section-head">
                      <div className="admin-section-title">Рефералка и риски</div>
                      <div className="admin-section-sub">Лидеры приглашений и сигналы качества</div>
                    </div>
                    <div className="admin-mini-grid">
                      <div className="admin-mini-item">
                        <span>Инвайтов за период</span>
                        <strong>{formatNumberRu(adminReferrals?.invitedInPeriod ?? 0)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Выплаты по рефералке</span>
                        <strong>{formatNumberRu(adminReferrals?.rewardsInPeriod ?? 0)}</strong>
                      </div>
                      <div className="admin-mini-item">
                        <span>Подозрительных аппликантов</span>
                        <strong>{formatNumberRu(adminRisks?.suspiciousApplicants?.length ?? 0)}</strong>
                      </div>
                    </div>

                    {(adminReferrals?.topReferrers?.length ?? 0) > 0 && (
                      <div className="admin-entity-list">
                        {adminReferrals?.topReferrers.map((item) => (
                          <div className="admin-entity-row compact" key={item.userId}>
                            <div className="admin-entity-main">
                              <div className="admin-entity-title">{item.userLabel}</div>
                              <div className="admin-entity-sub">Инвайтов: {formatNumberRu(item.invited)}</div>
                            </div>
                            <div className="admin-entity-meta">
                              <strong>{formatNumberRu(item.rewards)}</strong>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="admin-alert-list">
                      {adminAlerts.map((alert, index) => (
                        <div className={`admin-alert ${getAlertToneClass(alert.level)}`} key={`risk-alert-${index}`}>
                          <strong>{alert.level.toUpperCase()}</strong>
                          <span>{alert.message}</span>
                        </div>
                      ))}
                    </div>

                    {adminRisks?.reports && (
                      <div className="admin-risk-block">
                        <div className="admin-split-title">Жалобы по заданиям</div>
                        <div className="admin-mini-grid admin-reports-grid">
                          <div className="admin-mini-item">
                            <span>Жалоб за период</span>
                            <strong>{formatNumberRu(adminRisks.reports.totalInPeriod)}</strong>
                          </div>
                          <div className="admin-mini-item">
                            <span>Последних жалоб</span>
                            <strong>{formatNumberRu(adminRisks.reports.recent.length)}</strong>
                          </div>
                        </div>
                        {(adminRisks.reports.byReason?.length ?? 0) > 0 && (
                          <div className="admin-entity-list compact">
                            {adminRisks.reports.byReason.map((item: any) => (
                              <div className="admin-entity-row compact" key={`report-reason-${item.reason}`}>
                                <div className="admin-entity-main">
                                  <div className="admin-entity-title">{item.reasonLabel}</div>
                                </div>
                                <div className="admin-entity-meta">
                                  <strong>{formatNumberRu(item.count)}</strong>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {(adminRisks.reports.recent?.length ?? 0) > 0 ? (
                          <div className="admin-entity-list compact">
                            {adminRisks.reports.recent.map((item: any) => (
                              <div className="admin-entity-row compact" key={item.id}>
                                <div className="admin-entity-main">
                                  <div className="admin-entity-title">{item.groupTitle}</div>
                                  <div className="admin-entity-sub">
                                    {item.reasonLabel} • {item.reporterLabel}
                                  </div>
                                </div>
                                <div className="admin-entity-meta">
                                  <span>{formatDateTimeRu(item.createdAt)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="admin-empty">Жалоб за выбранный период нет.</div>
                        )}
                      </div>
                    )}

                    {(adminRisks?.highRejectOwners?.length ?? 0) > 0 && (
                      <div className="admin-risk-block">
                        <div className="admin-split-title">Высокий reject rate владельцев</div>
                        <div className="admin-entity-list compact">
                          {adminRisks?.highRejectOwners.map((item: any) => (
                            <div className="admin-entity-row compact" key={item.userId}>
                              <div className="admin-entity-main">
                                <div className="admin-entity-title">{item.ownerLabel}</div>
                                <div className="admin-entity-sub">
                                  Reject: {formatNumberRu(item.rejected)} / {formatNumberRu(item.reviewed)}
                                </div>
                              </div>
                              <div className="admin-entity-meta">
                                <strong>{formatPercentRu(item.rejectRate)}</strong>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
              </>
            )}
          </>
        )}

        {activeTab === 'promo' && (
          <>
            <BalanceHeader />
            <div className="segment center promo-mode-switch">
              <button
                className={`segment-button promo-mode-button ${myTasksTab === 'place' ? 'active' : ''}`}
                type="button"
                onClick={() => setMyTasksTab('place')}
              >
                <span className="promo-mode-title">Разместить</span>
                <span className="promo-mode-meta">новая кампания</span>
              </button>
              <button
                className={`segment-button promo-mode-button ${myTasksTab === 'mine' ? 'active' : ''}`}
                type="button"
                onClick={() => setMyTasksTab('mine')}
              >
                <span className="promo-mode-title">Мои размещенные</span>
                <span className="promo-mode-meta">{myCampaigns.length} кампаний</span>
              </button>
            </div>

            {myTasksTab === 'place' && (
              <div className="promo-entry-shell">
                <div className="promo-entry-head">
                  <h3 className="promo-entry-title">Что продвигаем?</h3>
                  <p className="promo-entry-sub">
                    Выберите формат и настройте кампанию за пару шагов.
                  </p>
                </div>
                <div className="promo-type-grid">
                  <button
                    className={`promo-type-card ${taskType === 'subscribe' ? 'active' : ''}`}
                    type="button"
                    onClick={() => openPromoWizard('subscribe')}
                  >
                    <span className="promo-type-head">
                      <span className="promo-type-icon" aria-hidden="true">
                        +
                      </span>
                      <span className="promo-type-chip">Рост базы</span>
                    </span>
                    <span className="promo-type-title">Подписка</span>
                    <span className="promo-type-meta">Продвижение вступлений в канал или группу</span>
                    <span className="promo-type-cta">Запустить</span>
                  </button>
                  <button
                    className={`promo-type-card ${taskType === 'reaction' ? 'active' : ''}`}
                    type="button"
                    onClick={() => openPromoWizard('reaction')}
                  >
                    <span className="promo-type-head">
                      <span className="promo-type-icon" aria-hidden="true">
                        ★
                      </span>
                      <span className="promo-type-chip">Вовлечение</span>
                    </span>
                    <span className="promo-type-title">Реакции</span>
                    <span className="promo-type-meta">Продвижение поста по ссылке из вашего проекта</span>
                    <span className="promo-type-cta">Запустить</span>
                  </button>
                </div>
                <div className="promo-entry-footer">
                  <div className="promo-entry-hint">
                    {isProjectSelected
                      ? `Выбран проект: ${selectedProjectLabel}`
                      : 'Проект выбирается на первом шаге запуска'}
                  </div>
                </div>
              </div>
            )}

            {myTasksTab === 'mine' && (
              <div className="promo-mine-shell">
                <div className="promo-mine-overview">
                  <div className="promo-mine-stat">
                    <span>Кампаний</span>
                    <strong>{myCampaigns.length}</strong>
                  </div>
                  <div className="promo-mine-stat">
                    <span>Загрузка</span>
                    <strong>{myCampaignsLoading ? 'Да' : 'Нет'}</strong>
                  </div>
                </div>
              <div className="task-list promo-mine-list">
                {myCampaignsLoading && <div className="task-form-placeholder">Загрузка…</div>}
                {!myCampaignsLoading && myCampaignsError && (
                  <div className="task-form-placeholder error">{myCampaignsError}</div>
                )}
                {!myCampaignsLoading && !myCampaignsError && myCampaigns.length === 0 && (
                  <div className="task-form-placeholder">Пока нет размещенных кампаний.</div>
                )}
                {!myCampaignsLoading &&
                  !myCampaignsError &&
                  myCampaigns.map((campaign) => {
                    const badgeLabel = `${campaign.rewardPoints} ${formatPointsLabel(
                      campaign.rewardPoints
                    )}`;
                    const ownerStatus = getOwnerCampaignStatusMeta(campaign);
                    return (
                      <div className="task-card promo-mine-card" key={campaign.id}>
                        <div className="task-card-head">
                          <TaskAvatar group={campaign.group} getAvatarUrl={getGroupAvatarUrl} />
                          <div className="task-info">
                            <div className="task-title-row">
                              <div className="task-title">{campaign.group.title}</div>
                              <span className="badge sticker">{badgeLabel}</span>
                            </div>
                            <div className="task-handle">
                              {getGroupSecondaryLabel(campaign.group)}
                            </div>
                            <div className="task-meta">
                              <span className={`status-badge compact ${ownerStatus.className}`}>
                                {ownerStatus.label}
                              </span>
                              <span className="status-badge neutral compact">
                                {ownerStatus.budgetLabel}
                              </span>
                            </div>
                          </div>
                          <div className="task-actions">
                            <button
                              className="open-button icon"
                              type="button"
                              onClick={() => openCampaignLink(campaign)}
                              aria-label="Открыть"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                                <path d="M9 5h10v10" />
                                <path d="M19 5l-9 9" />
                                <path d="M5 19h10" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                </div>
            )}

          </>
        )}

        {activeTab === 'tasks' && (
          <>
            <BalanceHeader />
            <section className="tasks-toolbar">
              <div className={`segment filters ${taskTypeFilter}`}>
                <span className="filter-toggle-indicator" aria-hidden="true" />
                <button
                  className={`filter-toggle-button ${
                    taskTypeFilter === 'subscribe' ? 'active' : ''
                  }`}
                  type="button"
                  role="tab"
                  aria-selected={taskTypeFilter === 'subscribe'}
                  onClick={() => setTaskTypeFilter('subscribe')}
                >
                  Подписки
                </button>
                <button
                  className={`filter-toggle-button ${
                    taskTypeFilter === 'reaction' ? 'active' : ''
                  }`}
                  type="button"
                  role="tab"
                  aria-selected={taskTypeFilter === 'reaction'}
                  onClick={() => setTaskTypeFilter('reaction')}
                >
                  Реакции
                </button>
                <div className="filter-divider" />
                <div className="filter-row bottom" role="tablist" aria-label="Фильтр списка">
                  <button
                    className={`filter-chip ${taskListFilter === 'hot' ? 'active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={taskListFilter === 'hot'}
                    onClick={() => setTaskListFilter('hot')}
                  >
                    Топ
                  </button>
                  <button
                    className={`filter-chip ${taskListFilter === 'new' ? 'active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={taskListFilter === 'new'}
                    onClick={() => setTaskListFilter('new')}
                  >
                    Новые
                  </button>
                  <button
                    className={`filter-chip ${taskListFilter === 'history' ? 'active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={taskListFilter === 'history'}
                    onClick={() => setTaskListFilter('history')}
                    ref={historyTabRef}
                  >
                    История
                  </button>
                </div>
              </div>
            </section>
            <div className={`tasks-overview ${taskListFilter === 'history' ? 'history' : ''}`}>
              <div className="tasks-overview-row">
                <div className="tasks-overview-item">
                  <span className="tasks-overview-value">
                    {taskListFilter === 'history' ? historyApplications.length : visibleCampaigns.length}
                  </span>
                  <span className="tasks-overview-label">
                    {taskListFilter === 'history' ? 'в истории' : 'доступно'}
                  </span>
                </div>
                <div className="tasks-overview-item">
                  <span className="tasks-overview-value">
                    {taskListFilter === 'history' ? taskTypeCampaigns.length : taskStatusCounters.pending}
                  </span>
                  <span className="tasks-overview-label">
                    {taskListFilter === 'history' ? 'активно' : 'на проверке'}
                  </span>
                </div>
                <div className="tasks-overview-item">
                  <span className="tasks-overview-value">
                    {taskListFilter === 'history' ? taskStatusCounters.pending : taskStatusCounters.ready}
                  </span>
                  <span className="tasks-overview-label">
                    {taskListFilter === 'history' ? 'на проверке' : 'готово'}
                  </span>
                </div>
              </div>
              <div className="tasks-overview-hint">{taskHintText}</div>
            </div>
            {taskListFilter !== 'history' && (
              <div className="task-list">
                {actionError && <div className="form-status error">{actionError}</div>}
                {applicationsError && <div className="form-status error">{applicationsError}</div>}
                {applicationsLoading && (
                  <div className="task-form-placeholder subtle">Обновляем статусы…</div>
                )}
                {campaignsLoading && (
                  <div className="task-skeleton-list" aria-hidden="true">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <div className="task-card task-card-skeleton" key={`task-skeleton-${index}`}>
                        <div className="task-card-head">
                          <div className="task-card-main">
                            <div className="task-avatar task-avatar-skeleton" />
                            <div className="task-info">
                              <div className="task-skeleton-line task-skeleton-line-title" />
                              <div className="task-skeleton-line task-skeleton-line-handle" />
                            </div>
                          </div>
                          <div className="task-meta task-meta-skeleton">
                            <div className="task-meta-stack">
                              <div className="task-skeleton-pill" />
                              <div className="task-skeleton-pill short" />
                            </div>
                            <div className="task-skeleton-icon" />
                          </div>
                        </div>
                        <div className="task-actions task-actions-row">
                          <div className="task-skeleton-button" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {!campaignsLoading && campaignsError && (
                  <div className="task-form-placeholder error">{campaignsError}</div>
                )}
                {!campaignsLoading && !campaignsError && visibleCampaigns.length === 0 && (
                  <div className="task-form-placeholder task-empty-state">
                    Сейчас нет заданий в этом фильтре. Переключите вкладку или зайдите позже.
                  </div>
                )}
                {!campaignsLoading &&
                  !campaignsError &&
                  visibleCampaigns.map((campaign) => {
                    const application = applicationsByCampaign.get(campaign.id);
                    const status = application?.status;
                    const statusMeta = getTaskStatusMeta(status);
                    const payout = calculatePayout(campaign.rewardPoints);
                    const badgeLabel = `+${payout} ${formatPointsLabel(payout)}`;
                    const readyToClaim = status === 'APPROVED' && !acknowledgedIds.includes(campaign.id);
                    return (
                      <div
                        className={`task-card task-card-live ${readyToClaim ? 'task-card-claimable' : ''} ${
                          leavingIds.includes(campaign.id) ? 'is-leaving' : ''
                        }`}
                        key={campaign.id}
                        ref={(node) => registerTaskCardRef(campaign.id, node)}
                      >
                        <div className="task-card-head">
                          <div className="task-card-main">
                            <TaskAvatar group={campaign.group} getAvatarUrl={getGroupAvatarUrl} />
                            <div className="task-info">
                              <div className="task-title-row">
                                <div className="task-title">{campaign.group.title}</div>
                              </div>
                              <div className="task-handle">
                                {getGroupSecondaryLabel(campaign.group)}
                              </div>
                            </div>
                          </div>
                          <div className="task-meta">
                            <div className="task-meta-stack">
                              <span
                                className="badge sticker task-reward-badge"
                                ref={(node) => registerTaskBadgeRef(campaign.id, node)}
                              >
                                {badgeLabel}
                              </span>
                              <span className={`status-badge compact task-status-chip ${statusMeta.className}`}>
                                {statusMeta.label}
                              </span>
                            </div>
                            <button
                              className="task-more-button"
                              type="button"
                              aria-label="Действия по заданию"
                              onClick={() => openTaskActionSheet(campaign)}
                              disabled={taskActionSheetLoading}
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="6" r="1.8" />
                                <circle cx="12" cy="12" r="1.8" />
                                <circle cx="12" cy="18" r="1.8" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <div className="task-actions task-actions-row">
                          <button
                            className={`open-button action task-primary-action ${
                              readyToClaim ? 'task-primary-action-ready' : ''
                            }`}
                            type="button"
                            onClick={() => void handleOpenCampaign(campaign, status)}
                            aria-label={statusMeta.actionLabel}
                            disabled={actionLoadingId === campaign.id}
                          >
                            <span>{actionLoadingId === campaign.id ? 'Ждите' : statusMeta.actionLabel}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                              <path d="M9 5h10v10" />
                              <path d="M19 5l-9 9" />
                              <path d="M5 19h10" />
                            </svg>
                          </button>
                          {readyToClaim && (
                            <button
                              className="open-button confirm task-confirm-action"
                              type="button"
                              onClick={() => handleConfirmReward(campaign.id, payout)}
                              aria-label="Подтвердить и получить"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M5 13l4 4L19 7" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
            {taskListFilter === 'history' && (
              <div className="task-list">
                {applicationsLoading && (
                  <div className="task-form-placeholder">Обновляем историю…</div>
                )}
                {applicationsError && <div className="form-status error">{applicationsError}</div>}
                {!applicationsLoading && historyApplications.length === 0 && (
                  <div className="task-form-placeholder">Пока нет выполненных заданий.</div>
                )}
                {!applicationsLoading &&
                  historyApplications.map((application) => {
                    const campaign = application.campaign;
                    const badgeLabel = `+${calculatePayout(campaign.rewardPoints)} ${formatPointsLabel(
                      calculatePayout(campaign.rewardPoints)
                    )}`;
                    return (
                      <div className="task-card task-card-history" key={application.id}>
                        <div className="task-card-head">
                          <div className="task-card-main">
                            <TaskAvatar group={campaign.group} getAvatarUrl={getGroupAvatarUrl} />
                            <div className="task-info">
                              <div className="task-title-row">
                                <div className="task-title">{campaign.group.title}</div>
                              </div>
                              <div className="task-handle">
                                {getGroupSecondaryLabel(campaign.group)}
                              </div>
                            </div>
                          </div>
                          <div className="task-meta">
                            <div className="task-meta-stack">
                              <span className="badge sticker task-reward-badge">{badgeLabel}</span>
                              <span className="status-badge approved compact task-status-chip">Выполнено</span>
                            </div>
                            <button
                              className="task-more-button"
                              type="button"
                              aria-label="Действия по заданию"
                              onClick={() => openTaskActionSheet(campaign)}
                              disabled={taskActionSheetLoading}
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="6" r="1.8" />
                                <circle cx="12" cy="12" r="1.8" />
                                <circle cx="12" cy="18" r="1.8" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <div className="task-actions task-actions-row">
                          <button
                            className="open-button action task-secondary-action"
                            type="button"
                            onClick={() => openCampaignLink(campaign)}
                            aria-label="Открыть"
                          >
                            <span>Открыть</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                              <path d="M9 5h10v10" />
                              <path d="M19 5l-9 9" />
                              <path d="M5 19h10" />
                            </svg>
                          </button>
                        </div>
                        <div className="task-history-date">
                          {formatDateTimeRu(application.reviewedAt ?? application.createdAt)}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}
      </div>

      {promoWizardOpen && (
        <div className="promo-wizard-backdrop" onClick={closePromoWizard}>
          <div
            className="promo-wizard-modal"
            data-step={promoWizardCurrentStep.id}
            role="dialog"
            aria-modal="true"
            aria-labelledby="promo-wizard-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="promo-wizard-handle" aria-hidden="true" />
            <div className="promo-wizard-head">
              <div className="promo-wizard-copy">
                <div className="promo-wizard-title" id="promo-wizard-title">
                  {taskType === 'subscribe' ? 'Продвижение подписки' : 'Продвижение реакций'}
                </div>
                <div className="promo-wizard-sub">
                  Шаг {promoWizardStepIndex + 1} из {promoWizardStepTotal}: {promoWizardCurrentStep.label}
                </div>
              </div>
              <button
                className="promo-wizard-close"
                type="button"
                aria-label="Закрыть окно запуска"
                onClick={closePromoWizard}
                disabled={createLoading}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M6 6l12 12" />
                  <path d="M18 6l-12 12" />
                </svg>
              </button>
            </div>
            <div className="promo-wizard-progress" role="list" aria-label="Шаги запуска кампании">
              {promoWizardSteps.map((step, index) => (
                <div
                  className={`promo-wizard-progress-item ${
                    index < promoWizardStepIndex
                      ? 'done'
                      : index === promoWizardStepIndex
                        ? 'active'
                        : ''
                  }`}
                  key={step.id}
                  role="listitem"
                >
                  <span className="promo-wizard-progress-index">{index + 1}</span>
                  <span className="promo-wizard-progress-label">{step.shortLabel}</span>
                </div>
              ))}
            </div>

            {createError && <div className="form-status error promo-create-error">{createError}</div>}

            <div className="promo-wizard-body">
              <div className="promo-wizard-step-shell" key={promoWizardCurrentStep.id}>
                {promoWizardCurrentStep.id === 'project' && (
                  <>
                    <div className="promo-project-stage">
                      <button
                        className={`link-tool promo-project-picker ${linkPickerOpen ? 'active' : ''}`}
                        type="button"
                        aria-expanded={linkPickerOpen}
                        aria-controls="promo-wizard-link-picker"
                        onClick={() => {
                          setLinkPickerOpen((prev) => !prev);
                        }}
                      >
                        Выбрать проект · Мои проекты
                      </button>
                      <div className={`promo-project-chip ${isProjectSelected ? 'ready' : 'empty'}`}>
                        {selectedProjectLabel}
                      </div>
                      <div className="promo-step-summary promo-project-summary">
                        {isProjectSelected
                          ? 'Проект выбран. Можно переходить к следующему шагу.'
                          : 'Сначала выберите проект из списка «Мои проекты».'}
                      </div>
                      <div className="promo-project-actions">
                        <button className="link-tool secondary" type="button" onClick={openChannelSetup}>
                          Подключить канал
                        </button>
                        <button className="link-tool secondary" type="button" onClick={openGroupSetup}>
                          Подключить группу
                        </button>
                      </div>
                      <div className="link-hint">Бот должен быть администратором выбранного проекта.</div>
                    </div>
                    {linkPickerOpen && (
                      <div className="link-picker" id="promo-wizard-link-picker" ref={linkPickerRef}>
                        <div className="link-picker-head">
                          <span className="link-picker-title">Мои проекты</span>
                          <div className="link-picker-actions">
                            <button
                              className="link-picker-refresh"
                              type="button"
                              aria-label="Обновить список групп"
                              disabled={myGroupsLoading}
                              onClick={() => void loadMyGroups()}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                <path d="M21 12a9 9 0 11-2.6-6.4" />
                                <path d="M21 3v7h-7" />
                              </svg>
                            </button>
                            <button
                              className="link-picker-close"
                              type="button"
                              aria-label="Свернуть список"
                              onClick={() => setLinkPickerOpen(false)}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                <path d="M6 6l12 12" />
                                <path d="M18 6l-12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        {myGroupsLoading && <div className="link-picker-status">Загрузка…</div>}
                        {!myGroupsLoading && myGroupsError && (
                          <div className="link-picker-status error">{myGroupsError}</div>
                        )}
                        {!myGroupsLoading && !myGroupsError && myGroupsLoaded && myGroups.length === 0 && (
                          <div className="link-picker-status">Пока нет добавленных групп.</div>
                        )}
                        {!myGroupsLoading &&
                          !myGroupsError &&
                          myGroups.map((group) => {
                            const avatarUrl = getGroupAvatarUrl(group);
                            return (
                              <button
                                className="link-option"
                                key={group.id}
                                type="button"
                                onClick={() => handleQuickLinkSelect(group)}
                              >
                                <div className="link-option-avatar">
                                  {avatarUrl ? (
                                    <img
                                      src={avatarUrl}
                                      alt=""
                                      loading="lazy"
                                      onError={(event) => {
                                        event.currentTarget.style.display = 'none';
                                      }}
                                    />
                                  ) : null}
                                  <span>{group.title?.[0] ?? 'Г'}</span>
                                </div>
                                <div className="link-option-body">
                                  <span className="link-option-title">{group.title}</span>
                                  <span className="link-option-handle">{getGroupSecondaryLabel(group)}</span>
                                </div>
                              </button>
                            );
                          })}
                      </div>
                    )}
                  </>
                )}

                {promoWizardCurrentStep.id === 'reactionLink' && (
                  <>
                    <label className="field">
                      <span>Ссылка на пост</span>
                      <input
                        type="text"
                        placeholder="https://t.me/username/123"
                        value={reactionLink}
                        onChange={(event) => setReactionLink(event.target.value)}
                      />
                      <div className="range-hint">Пост должен быть из выбранного проекта.</div>
                    </label>
                    <div className={`promo-link-validation-chip ${reactionLinkValidation.state}`} role="status">
                      {reactionLinkValidation.label}
                    </div>
                    <div className={`promo-step-summary promo-link-summary ${reactionLinkValidation.state}`}>
                      {reactionLinkValidation.hint}
                    </div>
                  </>
                )}

                {promoWizardCurrentStep.id === 'budget' && (
                  <>
                    <label className="field">
                      <span>Цена за действие</span>
                      <div className="price-stepper" role="group" aria-label="Управление ценой за действие">
                        <div className="price-stepper-side">
                          <button
                            className="price-stepper-button"
                            type="button"
                            onClick={() => adjustTaskPrice(-1)}
                            disabled={taskPriceValue <= MIN_TASK_PRICE}
                            aria-label="Уменьшить цену на 1 балл"
                          >
                            -1
                          </button>
                        </div>
                        <output className="price-stepper-value" aria-live="polite" aria-atomic="true">
                          <span className="price-stepper-amount">{taskPriceValue}</span>
                          <span className="price-stepper-unit">баллов</span>
                        </output>
                        <div className="price-stepper-side align-end">
                          <button
                            className="price-stepper-button"
                            type="button"
                            onClick={() => adjustTaskPrice(1)}
                            disabled={taskPriceValue >= MAX_TASK_PRICE}
                            aria-label="Увеличить цену на 1 балл"
                          >
                            +1
                          </button>
                        </div>
                      </div>
                      <div className="range-hint">
                        <span>
                          Выплата исполнителю: {minPayoutPreview}–{maxPayoutPreview} {formatPointsLabel(maxPayoutPreview)}.
                        </span>
                        <span className="range-hint-secondary">{affordableCountHint}</span>
                      </div>
                    </label>

                    <label className="field">
                      <span>{taskType === 'subscribe' ? 'Количество вступлений' : 'Количество реакций'}</span>
                      <input
                        className="range-input"
                        type="range"
                        min={1}
                        max={maxAffordableCount}
                        value={taskCount}
                        style={{ '--range-progress': rangeProgress } as React.CSSProperties}
                        onChange={(event) => setTaskCount(Number(event.target.value))}
                      />
                      <div className="range-meta">
                        <span>{formatActionsCountRu(taskCount)}</span>
                        <span>
                          Списание: {formatNumberRu(totalBudget)} {formatPointsLabel(totalBudget)}
                        </span>
                      </div>
                    </label>

                    <div className="promo-budget-total">
                      <span>Итоговый бюджет</span>
                      <strong>
                        {formatNumberRu(totalBudget)} {formatPointsLabel(totalBudget)}
                      </strong>
                      <p>
                        После запуска останется {formatNumberRu(remainingPointsAfterLaunch)}{' '}
                        {formatPointsLabel(remainingPointsAfterLaunch)}.
                      </p>
                    </div>

                    <div className="promo-budget-grid">
                      <div className="promo-budget-item">
                        <span>Цена</span>
                        <strong>
                          {formatNumberRu(taskPriceValue)} {formatPointsLabel(taskPriceValue)}
                        </strong>
                      </div>
                      <div className="promo-budget-item">
                        <span>Объем</span>
                        <strong>{formatActionsCountRu(taskCount)}</strong>
                      </div>
                      <div className="promo-budget-item">
                        <span>Остаток</span>
                        <strong>
                          {formatNumberRu(remainingPointsAfterLaunch)} {formatPointsLabel(remainingPointsAfterLaunch)}
                        </strong>
                      </div>
                    </div>
                    <div className="promo-step-summary">{budgetSummaryLabel}</div>
                  </>
                )}

                {promoWizardCurrentStep.id === 'review' && (
                  <>
                    <div className="promo-review-total">
                      <span>Итог списания</span>
                      <strong>
                        {formatNumberRu(totalBudget)} {formatPointsLabel(totalBudget)}
                      </strong>
                      <p>
                        Баланс после запуска: {formatNumberRu(remainingPointsAfterLaunch)}{' '}
                        {formatPointsLabel(remainingPointsAfterLaunch)}.
                      </p>
                    </div>
                    <div className="promo-review-grid">
                      <div className="promo-review-item">
                        <span>Проект</span>
                        <strong>{selectedProjectLabel}</strong>
                      </div>
                      <div className="promo-review-item">
                        <span>Формат</span>
                        <strong>{formatSummaryLabel}</strong>
                      </div>
                      <div className="promo-review-item">
                        <span>Цена за действие</span>
                        <strong>
                          {formatNumberRu(taskPriceValue)} {formatPointsLabel(taskPriceValue)}
                        </strong>
                      </div>
                      <div className="promo-review-item">
                        <span>Объем</span>
                        <strong>{formatActionsCountRu(taskCount)}</strong>
                      </div>
                    </div>
                    {taskType === 'reaction' && reactionLinkTrimmed && (
                      <div className="promo-step-summary promo-review-link">Пост: {reactionLinkTrimmed}</div>
                    )}
                    <div className={`promo-review-status ${createCtaState.blocked ? 'warn' : ''}`}>
                      {createCtaState.blocked
                        ? createCtaState.label === 'Пополните баланс'
                          ? 'Недостаточно баллов. Пополните баланс и вернитесь к запуску.'
                          : `Требуется действие: ${createCtaState.label}.`
                        : 'Параметры проверены. Можно запускать кампанию.'}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="promo-wizard-footer">
              <button
                className="promo-wizard-secondary"
                type="button"
                onClick={handlePromoWizardBack}
                disabled={createLoading}
              >
                {promoWizardSecondaryLabel}
              </button>
              <button
                className="primary-button promo-wizard-primary"
                type="button"
                onClick={() => void handlePromoWizardPrimary()}
                disabled={promoWizardPrimaryDisabled}
              >
                {promoWizardPrimaryLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {taskActionSheetCampaign && (
        <div className="task-actionsheet-backdrop" onClick={closeTaskActionSheet}>
          <div
            className="task-actionsheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-actionsheet-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="task-actionsheet-handle" aria-hidden="true" />
            <div className="task-actionsheet-head">
              <div className="task-actionsheet-copy">
                <div className="task-actionsheet-title" id="task-actionsheet-title">
                  {taskActionSheetMode === 'report' ? 'Пожаловаться на задание' : 'Действия'}
                </div>
                <div className="task-actionsheet-sub">
                  {taskActionSheetCampaign.group.title} •{' '}
                  {getGroupSecondaryLabel(taskActionSheetCampaign.group)}
                </div>
              </div>
              <button
                className="task-actionsheet-close"
                type="button"
                aria-label="Закрыть меню действий"
                onClick={closeTaskActionSheet}
                disabled={taskActionSheetLoading}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M6 6l12 12" />
                  <path d="M18 6l-12 12" />
                </svg>
              </button>
            </div>
            {taskActionSheetError && <div className="task-actionsheet-error">{taskActionSheetError}</div>}

            {taskActionSheetMode === 'actions' && (
              <div className="task-actionsheet-list">
                <button
                  className="task-actionsheet-item"
                  type="button"
                  onClick={() => void handleHideTaskCampaign()}
                  disabled={taskActionSheetLoading}
                >
                  <span>Удалить из моего списка</span>
                </button>
                <button
                  className="task-actionsheet-item warn"
                  type="button"
                  onClick={() => {
                    setTaskActionSheetMode('report');
                    setTaskActionSheetError('');
                  }}
                  disabled={taskActionSheetLoading}
                >
                  <span>Пожаловаться</span>
                </button>
              </div>
            )}

            {taskActionSheetMode === 'report' && (
              <div className="task-report-reasons">
                {TASK_REPORT_REASON_OPTIONS.map((option) => (
                  <button
                    className="task-report-reason-button"
                    key={option.reason}
                    type="button"
                    onClick={() => void handleReportTaskCampaign(option.reason)}
                    disabled={taskActionSheetLoading}
                  >
                    <span className="task-report-reason-title">{option.label}</span>
                  </button>
                ))}
                <button
                  className="task-actionsheet-back-button"
                  type="button"
                  onClick={() => {
                    setTaskActionSheetMode('actions');
                    setTaskActionSheetError('');
                  }}
                  disabled={taskActionSheetLoading}
                >
                  Назад
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {topUpModalOpen && (
        <div className="topup-modal-backdrop" onClick={closeTopUpModal}>
          <div
            className="topup-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topup-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="topup-modal-handle" aria-hidden="true" />
            <div className="topup-modal-head">
              <div className="topup-modal-copy">
                <div className="topup-modal-title" id="topup-modal-title">
                  Пополнение баланса
                </div>
                <div className="topup-modal-sub">
                  Выберите пакет
                </div>
              </div>
              <button
                className="topup-modal-close"
                type="button"
                aria-label="Закрыть окно пополнения"
                onClick={closeTopUpModal}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                  <path d="M6 6l12 12" />
                  <path d="M18 6l-12 12" />
                </svg>
              </button>
            </div>
            <div className="topup-options" role="list">
              {TOP_UP_PACKAGES.map((topUpPackage) => (
                <button
                  key={topUpPackage.points}
                  className="topup-option-button"
                  type="button"
                  onClick={() => handleTopUpPackageSelect(topUpPackage)}
                >
                  <span className="topup-option-points">
                    {topUpPackage.points} {formatPointsLabel(topUpPackage.points)}
                  </span>
                  <span className="topup-option-price">{topUpPackage.priceRub} рублей</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'wheel' && wheelRewardModalOpen && wheelResult && (
        <div className="wheel-reward-modal-backdrop" onClick={handleClaimWheelReward}>
          <div
            className={`wheel-reward-modal ${wheelResult.value >= 100 ? 'jackpot' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="wheel-reward-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="wheel-reward-frame-lines" aria-hidden="true" />
            <div className="wheel-reward-stage" aria-hidden="true">
              <div className="wheel-reward-beam" />
              <div className="wheel-reward-halo" />
              <div className="wheel-reward-halo-inner" />
              <div className="wheel-reward-starfield">
                {Array.from({ length: 12 }).map((_, index) => (
                  <span
                    key={`wheel-reward-star-${index}`}
                    style={
                      {
                        '--reward-star-angle': `${index * 30}deg`,
                        '--reward-star-delay': `${index * 60}ms`,
                        '--reward-star-distance': `${56 + (index % 3) * 12}px`,
                      } as React.CSSProperties
                    }
                  />
                ))}
              </div>
              <div className="wheel-reward-token">
                <div className="wheel-reward-token-rim" />
                <span>{wheelResult.label}</span>
                <div className="wheel-reward-token-core" />
              </div>
            </div>
            <div className={`wheel-reward-kicker ${wheelResult.value >= 100 ? 'jackpot' : ''}`}>
              {wheelResult.value >= 100 ? 'Джекпот' : 'Выигрыш'}
            </div>
            <div className="wheel-reward-amount" id="wheel-reward-title">
              +{wheelResult.value} {formatPointsLabel(wheelResult.value)}
            </div>
            <div className="wheel-reward-meta">Баллы уже начислены</div>
            <button className="wheel-reward-claim" type="button" onClick={handleClaimWheelReward}>
              Забрать баллы
            </button>
          </div>
        </div>
      )}

      {activeTab !== 'referrals' && (
        <div className={`bottom-nav ${adminPanelAllowed ? 'has-admin' : ''}`}>
          <button
            className={`nav-item ${activeTab === 'home' || activeTab === 'wheel' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab('home')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 11l9-7 9 7" />
              <path d="M5 10v9h5v-5h4v5h5v-9" />
            </svg>
            <span>Главная</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'promo' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab('promo')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M12 20s-7-4.6-7-10a4 4 0 017-2 4 4 0 017 2c0 5.4-7 10-7 10z" />
            </svg>
            <span>Продвижение</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'tasks' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab('tasks')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="4" y="5" width="16" height="14" rx="2" />
              <path d="M8 9h8M8 13h6" />
            </svg>
            <span>Задания</span>
          </button>
          {adminPanelAllowed && (
            <button
              className={`nav-item ${activeTab === 'admin' ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveTab('admin')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M12 3l7 3v5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3z" />
                <path d="M9.4 12.2l1.8 1.8 3.4-3.4" />
              </svg>
              <span>Админ</span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
