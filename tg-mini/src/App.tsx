import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  applyCampaign,
  createCampaign,
  fetchAdminPanelStats,
  fetchCampaigns,
  fetchDailyBonusStatus,
  fetchReferralStats,
  fetchReferralList,
  fetchMe,
  fetchMyApplications,
  fetchMyCampaigns,
  fetchMyGroups,
  spinDailyBonus,
  type ApplicationDto,
  type AdminPanelStats,
  type CampaignDto,
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
const MAX_TASK_COUNT = 200;
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
  const [taskType, setTaskType] = useState<'subscribe' | 'reaction'>('subscribe');
  const [reactionLink, setReactionLink] = useState('');
  const [taskPriceInput, setTaskPriceInput] = useState('10');
  const [taskCount, setTaskCount] = useState(MAX_TASK_COUNT);
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
  const [leavingIds, setLeavingIds] = useState<string[]>([]);
  const [acknowledgedIds, setAcknowledgedIds] = useState<string[]>([]);
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
  const totalBudget = useMemo(() => taskPriceValue * taskCount, [taskPriceValue, taskCount]);
  const maxAffordableCount = useMemo(() => {
    if (!Number.isFinite(taskPriceValue) || taskPriceValue <= 0) return 1;
    const byBalance = Math.floor(displayPoints / taskPriceValue);
    const byBudget = Math.floor(MAX_TOTAL_BUDGET / taskPriceValue);
    return Math.max(1, Math.min(MAX_TASK_COUNT, byBalance, byBudget));
  }, [displayPoints, taskPriceValue]);
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
  const createCtaState = useMemo(() => {
    if (!selectedGroupId) return { blocked: true, label: 'Выберите проект' };
    if (taskType === 'reaction' && !reactionLink.trim()) {
      return { blocked: true, label: 'Добавьте ссылку' };
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
    reactionLink,
    selectedGroupId,
    taskCount,
    taskType,
    totalBudget,
  ]);
  const createButtonDisabled = createLoading || createCtaState.blocked;
  const createButtonLabel = createLoading ? 'Создание…' : createCtaState.label;
  const rangeProgress = useMemo(() => {
    const min = 1;
    const max = maxAffordableCount;
    if (max <= min) return '100%';
    const pct = ((taskCount - min) / (max - min)) * 100;
    const clamped = Math.min(100, Math.max(0, pct));
    return `${clamped}%`;
  }, [taskCount, maxAffordableCount]);
  const maxCountRef = useRef(maxAffordableCount);
  const activeCampaigns = useMemo(() => {
    const acknowledgedSet = new Set(acknowledgedIds);
    return campaigns.filter((campaign) => {
      const status = applicationsByCampaign.get(campaign.id)?.status;
      if (status === 'APPROVED' && acknowledgedSet.has(campaign.id)) return false;
      if (status === 'REJECTED') return false;
      if (userId && campaign.owner?.id && campaign.owner.id === userId) return false;
      return true;
    });
  }, [applicationsByCampaign, campaigns, userId, acknowledgedIds]);
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
          application.status === 'APPROVED' && application.campaign.actionType === type
      )
      .sort(
        (a, b) =>
          new Date(b.reviewedAt ?? b.createdAt).getTime() -
          new Date(a.reviewedAt ?? a.createdAt).getTime()
      );
  }, [applications, taskTypeFilter]);
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
      return `Подтверждено: ${historyApplications.length}. Здесь хранится журнал завершённых заданий.`;
    }
    if (taskStatusCounters.ready > 0) {
      return `К выдаче: ${taskStatusCounters.ready}. Подтвердите задания с галочкой, чтобы получить баллы.`;
    }
    if (taskStatusCounters.pending > 0) {
      return `На проверке: ${taskStatusCounters.pending}. Можно брать новые задания параллельно.`;
    }
    return 'Нажмите «Получить», выполните действие в Telegram и дождитесь подтверждения.';
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
    const prevMax = maxCountRef.current;
    if (taskCount > maxAffordableCount) {
      setTaskCount(maxAffordableCount);
    } else if (taskCount === prevMax && prevMax !== maxAffordableCount) {
      setTaskCount(maxAffordableCount);
    }
    maxCountRef.current = maxAffordableCount;
  }, [taskCount, maxAffordableCount]);

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
    } catch {
      setMyGroups([]);
      setMyGroupsError('Не удалось загрузить список групп.');
    } finally {
      setMyGroupsLoaded(true);
      setMyGroupsLoading(false);
    }
  }, []);

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
    } catch {
      setMyCampaigns([]);
      setMyCampaignsError('Не удалось загрузить ваши кампании.');
    } finally {
      setMyCampaignsLoading(false);
    }
  }, []);

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
    } catch {
      if (!silent) {
        setApplications([]);
        setApplicationsError('Не удалось загрузить статусы.');
      }
    } finally {
      if (!silent) {
        setApplicationsLoading(false);
      }
    }
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const data = await fetchMe();
      if (data.ok) {
        if (typeof data.balance === 'number') setPoints(data.balance);
        if (typeof data.user?.totalEarned === 'number') setTotalEarned(data.user.totalEarned);
        if (typeof data.user?.id === 'string') setUserId(data.user.id);
      }
    } catch {
      // ignore
    }
  }, []);

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
      if (!silent) setAdminPanelError(error?.message ?? 'Не удалось загрузить админ-статистику.');
    } finally {
      setAdminPanelLoading(false);
    }
  }, [adminPeriod, tgUsername]);

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
      setDailyBonusError(error?.message ?? 'Не удалось загрузить бонус.');
    } finally {
      setDailyBonusLoading(false);
    }
  }, []);

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
      setReferralStats(null);
      setReferralError(error?.message ?? 'Не удалось загрузить реферальные данные.');
    } finally {
      setReferralLoading(false);
    }
  }, []);

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
      setReferralList([]);
      setReferralListError(error?.message ?? 'Не удалось загрузить список приглашённых.');
    } finally {
      setReferralListLoading(false);
    }
  }, []);

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
    void loadAdminPanel({ silent: true, period: adminPeriod });
  }, [userId, loadAdminPanel, adminPeriod]);

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
    if (adminPanelLoading) return;
    if (adminPanelAllowed) return;
    setActiveTab('home');
  }, [activeTab, adminPanelAllowed, adminPanelLoading]);

  useEffect(() => {
    if (activeTab === 'wheel') return;
    if (!dailyBonusInfoOpen) return;
    setDailyBonusInfoOpen(false);
  }, [activeTab, dailyBonusInfoOpen]);

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
      ]);
      restoreScrollTop(contentRef.current, scrollTop);
    })();
  }, [loadCampaigns, loadMyApplications, loadMe, loadAdminPanel]);

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
    setActionError('');
  }, [activeTab, myTasksTab]);

  useEffect(() => {
    if (!linkPickerOpen) return;
    if (myGroupsLoaded || myGroupsLoading) return;
    void loadMyGroups();
  }, [linkPickerOpen, loadMyGroups, myGroupsLoaded, myGroupsLoading]);

  useEffect(() => {
    if (!linkPickerOpen) return;
    const raf = requestAnimationFrame(() => {
      linkPickerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [linkPickerOpen]);

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
    <div className="balance-header">
      <div className="balance-header-metrics">
        <div className="metric-card compact">
          <span className="metric-value" ref={balanceValueRef}>
            {displayPoints}
          </span>
          <span className="metric-unit">{formatPointsLabel(displayPoints)}</span>
          <button
            className="metric-plus"
            type="button"
            aria-label="Пополнить баланс"
            onClick={openTopUpModal}
          >
            +
          </button>
        </div>
        <div className="metric-card compact">
          <span className="metric-value">{rankTier.title}</span>
          <span className="metric-sub">+{bonusPercent}%</span>
        </div>
      </div>
    </div>
  );

  const handleCreateCampaign = async () => {
    setCreateError('');
    const groupId = resolveGroupId();
    if (!groupId) {
      setCreateError('Сначала подключите канал/группу и выберите ее из списка.');
      return;
    }
    if (parsedTaskPrice === null) {
      setCreateError('Укажите цену за действие.');
      return;
    }
    if (!Number.isFinite(parsedTaskPrice) || parsedTaskPrice < MIN_TASK_PRICE) {
      setCreateError(`Цена за действие должна быть не меньше ${MIN_TASK_PRICE} баллов.`);
      return;
    }
    if (parsedTaskPrice > MAX_TASK_PRICE) {
      setCreateError(`Цена за действие должна быть не больше ${MAX_TASK_PRICE} баллов.`);
      return;
    }
    if (!Number.isFinite(taskCount) || taskCount < 1) {
      setCreateError('Количество действий должно быть не меньше 1.');
      return;
    }
    if (taskType === 'reaction') {
      if (!reactionLink.trim()) {
        setCreateError('Укажите ссылку на пост для реакции.');
        return;
      }
    }
    if (totalBudget > MAX_TOTAL_BUDGET) {
      setCreateError(
        `Бюджет слишком большой. Максимум ${MAX_TOTAL_BUDGET.toLocaleString('ru-RU')} баллов.`
      );
      return;
    }
    if (displayPoints < totalBudget) {
      setCreateError('Недостаточно баллов для размещения.');
      return;
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
    } catch (error: any) {
      setCreateError(error?.message ?? 'Не удалось создать кампанию.');
    } finally {
      setCreateLoading(false);
    }
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
  const adminSummaryBonusLimit = adminOverview?.welcomeBonusLimit ?? adminPanelStats?.bonusLimit ?? 0;
  const adminSummaryBonusRemaining =
    adminOverview?.welcomeBonusRemaining ?? adminPanelStats?.bonusRemaining ?? 0;
  const adminSummaryReviewed = adminOverview?.reviewedApplications ?? 0;
  const adminTrends = adminPanelStats?.trends ?? null;
  const adminCampaigns = adminPanelStats?.campaigns ?? null;
  const adminApplications = adminPanelStats?.applications ?? null;
  const adminEconomy = adminPanelStats?.economy ?? null;
  const adminReferrals = adminPanelStats?.referrals ?? null;
  const adminRisks = adminPanelStats?.risks ?? null;
  const adminAlerts = adminPanelStats?.alerts ?? [];
  const contentClassName = [
    'content',
    activeTab === 'home' ? 'home-content' : '',
    activeTab === 'promo' ? 'promo-content' : '',
    activeTab === 'tasks' ? 'tasks-content' : '',
    activeTab === 'referrals' ? 'referrals-content' : '',
    activeTab === 'admin' ? 'admin-content' : '',
  ]
    .filter(Boolean)
    .join(' ');

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
            <div className="page-header bonus-header">
              <button
                className="icon-button"
                type="button"
                onClick={() => setActiveTab('home')}
                aria-label="Назад"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M6 6l12 12" />
                  <path d="M18 6l-12 12" />
                </svg>
              </button>
              <div className="page-title">Ежедневный бонус</div>
              <div className="icon-button ghost" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <circle cx="12" cy="5" r="1.2" />
                  <circle cx="12" cy="12" r="1.2" />
                  <circle cx="12" cy="19" r="1.2" />
                </svg>
              </div>
            </div>

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
                      Крути <strong>Колесо фортуны</strong> и получай баллы каждый день.
                    </div>
                  </div>
                </div>
                <button
                  className={`daily-bonus-info-button wheel-info-button ${
                    dailyBonusInfoOpen ? 'active' : ''
                  }`}
                  type="button"
                  onClick={() => setDailyBonusInfoOpen((prev) => !prev)}
                  aria-label="Показать детали бонуса"
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
              {dailyBonusInfoOpen && (
                <div className="daily-bonus-info-popover wheel-info-popover">
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
              )}
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
            <div className="page-header">
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
              <div className="page-title referral-page-title">Реферальная система</div>
              <div className="header-spacer" aria-hidden="true" />
            </div>

            <section className="referral-hero">
              <div className="referral-hero-top">
                <div className="referral-hero-kicker">Реферальная программа</div>
                <button
                  className={`referral-info-button ${referralInfoOpen ? 'active' : ''}`}
                  type="button"
                  onClick={() => setReferralInfoOpen((prev) => !prev)}
                  aria-label="Показать детали реферальной программы"
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
                    <div className="referral-stat referral-stat-wide">
                      <div className="referral-stat-label">Освоено потенциала</div>
                      <div className="referral-stat-value">{referralPotentialProgress}%</div>
                      <div className="referral-stat-sub">
                        {referralInvitedCount > 0
                          ? `${referralEarnedTotal} из ${referralPotentialTotal} ${formatPointsLabel(referralPotentialTotal)}`
                          : 'Появится после первого приглашённого'}
                      </div>
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

                  {referralInfoOpen && (
                    <div className="referral-info-popover">
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
                  )}
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
                    Скопируйте ссылку и отправьте её в личный чат или канал.
                  </div>
                  <button
                    className="referral-empty-action"
                    type="button"
                    onClick={handleCopyInviteLink}
                    disabled={!referralLinkAvailable}
                  >
                    {!referralLinkAvailable
                      ? 'Ссылка недоступна'
                      : inviteCopied
                        ? 'Ссылка скопирована'
                        : 'Скопировать ссылку'}
                  </button>
                </div>
              )}
              {!referralListLoading &&
                !referralListError &&
                referralList.map((item) => {
                  const nextStep = getReferralNextStep(item.completedOrders);
                  const toNext = nextStep
                    ? Math.max(0, nextStep.orders - Math.max(0, item.completedOrders))
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
                          <div className="referral-item-sub">
                            Заказов: {item.completedOrders}/30 • с {getReferralCreatedLabel(item.createdAt)}
                          </div>
                        </div>
                        <div className="referral-item-earned">+{item.earned}</div>
                      </div>
                      <div className="referral-item-meta">
                        <div className="referral-item-meta-label">Текущий прогресс</div>
                        <div className={`referral-item-next ${nextStep ? '' : 'done'}`}>
                          {nextStep ? `До этапа «${nextStep.label}»: ${toNext}` : 'Этапы завершены'}
                        </div>
                      </div>
                      <div className="referral-progress">
                        <div
                          className="referral-progress-bar"
                          style={{ width: getReferralProgressPercent(item.completedOrders) }}
                        />
                      </div>
                      <div className="referral-progress-scale" aria-hidden="true">
                        <span>0</span>
                        <span>30</span>
                      </div>
                      <div className="referral-milestones">
                        {REFERRAL_STEPS.map((step) => (
                          <span
                            className={`referral-milestone ${
                              item.completedOrders >= step.orders ? 'active' : ''
                            }`}
                            key={`${item.id}-${step.label}`}
                          >
                            {step.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
            </section>
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

                  <div className="admin-progress">
                    <div className="admin-progress-track" aria-hidden="true">
                      <span style={{ width: `${adminBonusProgress}%` }} />
                    </div>
                    <div className="admin-progress-meta">
                      Бонус +500 выдан: <strong>{formatNumberRu(adminSummaryBonusGranted)}</strong> из{' '}
                      <strong>{formatNumberRu(adminSummaryBonusLimit)}</strong> • осталось{' '}
                      <strong>{formatNumberRu(adminSummaryBonusRemaining)}</strong> ({adminBonusProgress}%)
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

                  <div className="admin-panel-foot">
                    <span>Обновлено • период: {adminPeriod}</span>
                    <strong>{adminUpdatedAtLabel}</strong>
                  </div>
                </>
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
                      <div className={`admin-alert ${getAlertToneClass(alert.level)}`} key={`alert-${index}`}>
                        <strong>{alert.level.toUpperCase()}</strong>
                        <span>{alert.message}</span>
                      </div>
                    ))}
                  </div>

                  {(adminRisks?.highRejectOwners?.length ?? 0) > 0 && (
                    <div className="admin-risk-block">
                      <div className="admin-split-title">Высокий reject rate владельцев</div>
                      <div className="admin-entity-list compact">
                        {adminRisks?.highRejectOwners.map((item) => (
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
              </>
            )}
          </>
        )}

        {activeTab === 'promo' && (
          <>
            <BalanceHeader />
            <div className="segment center">
              <button
                className={`segment-button ${myTasksTab === 'place' ? 'active' : ''}`}
                type="button"
                onClick={() => setMyTasksTab('place')}
              >
                Разместить
              </button>
              <button
                className={`segment-button ${myTasksTab === 'mine' ? 'active' : ''}`}
                type="button"
                onClick={() => setMyTasksTab('mine')}
              >
                Мои размещенные
              </button>
            </div>

            {myTasksTab === 'place' && (
              <div className="task-form-card">
                <div className="task-form-head">
                  <div>
                    <div className="task-form-title">Разместить задание</div>
                    <div className="task-form-sub">
                      {taskType === 'subscribe'
                        ? 'Цена и объем: запуск за минуту.'
                        : 'Ссылка на пост и цена: запуск за минуту.'}
                    </div>
                    <div className="task-form-helper">
                      {taskType === 'subscribe'
                        ? 'Проверка вступлений автоматическая.'
                        : 'Поддержка ссылок: t.me/username/123 и t.me/c/…/123.'}
                    </div>
                  </div>
                </div>

                <div className="task-form-body">
                  {taskType === 'reaction' && (
                    <label className="field">
                      <span>Ссылка на пост</span>
                      <input
                        type="text"
                        placeholder="https://t.me/username/123 или https://t.me/c/123456/789"
                        value={reactionLink}
                        onChange={(event) => setReactionLink(event.target.value)}
                      />
                      <div className="range-hint">Пост должен быть из выбранного проекта.</div>
                    </label>
                  )}
                  <div className="link-tools">
                    <button className="link-tool highlight" type="button" onClick={openChannelSetup}>
                      Подключить канал
                    </button>
                    <button className="link-tool highlight-blue" type="button" onClick={openGroupSetup}>
                      Подключить группу
                    </button>
                    <button
                      className={`link-tool ${linkPickerOpen ? 'active' : ''}`}
                      type="button"
                      aria-expanded={linkPickerOpen}
                      aria-controls="quick-link-picker"
                      onClick={() => {
                        setLinkPickerOpen((prev) => !prev);
                      }}
                    >
                      Мои проекты
                    </button>
                  </div>
                  <div className="link-hint">
                    Бот подключается как администратор.
                  </div>
                  {selectedGroupTitle && (
                    <div className="link-hint">Выбрано: {selectedGroupTitle}</div>
                  )}
                  {linkPickerOpen && (
                    <div className="link-picker" id="quick-link-picker" ref={linkPickerRef}>
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
                      {!myGroupsLoading &&
                        !myGroupsError &&
                        myGroupsLoaded &&
                        myGroups.length === 0 && (
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
                                <span className="link-option-handle">
                                  {getGroupSecondaryLabel(group)}
                                </span>
                              </div>
                            </button>
                          );
                        })}

                    </div>
                  )}
                  <div className="choice-row">
                    <button
                      className={`choice-pill ${taskType === 'subscribe' ? 'active' : ''}`}
                      type="button"
                      onClick={() => setTaskType('subscribe')}
                    >
                      Подписка
                    </button>
                    <button
                      className={`choice-pill ${taskType === 'reaction' ? 'active' : ''}`}
                      type="button"
                      onClick={() => setTaskType('reaction')}
                    >
                      Реакция
                    </button>
                  </div>
                  <label className="field">
                    <span>Цена за действие</span>
                    <div className="price-stepper" role="group" aria-label="Управление ценой за действие">
                      <div className="price-stepper-side">
                        <button
                          className="price-stepper-button"
                          type="button"
                          onClick={() => adjustTaskPrice(-10)}
                          disabled={taskPriceValue <= MIN_TASK_PRICE}
                        >
                          -10
                        </button>
                        <button
                          className="price-stepper-button"
                          type="button"
                          onClick={() => adjustTaskPrice(-1)}
                          disabled={taskPriceValue <= MIN_TASK_PRICE}
                        >
                          -1
                        </button>
                      </div>
                      <output
                        className="price-stepper-value"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        {taskPriceValue}
                      </output>
                      <div className="price-stepper-side align-end">
                        <button
                          className="price-stepper-button"
                          type="button"
                          onClick={() => adjustTaskPrice(1)}
                          disabled={taskPriceValue >= MAX_TASK_PRICE}
                        >
                          +1
                        </button>
                        <button
                          className="price-stepper-button"
                          type="button"
                          onClick={() => adjustTaskPrice(10)}
                          disabled={taskPriceValue >= MAX_TASK_PRICE}
                        >
                          +10
                        </button>
                      </div>
                    </div>
                    <div className="range-hint">
                      Выплата исполнителю: {minPayoutPreview}–{maxPayoutPreview} баллов.
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
                      <span>{taskCount} действий</span>
                      <span>Списание: {totalBudget} баллов</span>
                    </div>
                  </label>
                </div>

                <div className="task-form-actions">
                  <div className="balance-pill">
                    Баланс: {displayPoints} {formatPointsLabel(displayPoints)}
                  </div>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void handleCreateCampaign()}
                    disabled={createButtonDisabled}
                  >
                    {createButtonLabel}
                  </button>
                </div>
                {createError && <div className="form-status error">{createError}</div>}
              </div>
            )}

            {myTasksTab === 'mine' && (
              <div className="task-list">
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
                      <div className="task-card" key={campaign.id}>
                        <div className="task-card-head">
                          <div className="task-avatar">
                            <span>{campaign.group.title?.[0] ?? 'Г'}</span>
                          </div>
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
            )}

          </>
        )}

        {activeTab === 'tasks' && (
          <>
            <BalanceHeader />
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
                  <div className="task-form-placeholder">Обновляем статусы…</div>
                )}
                {campaignsLoading && <div className="task-form-placeholder">Загрузка…</div>}
                {!campaignsLoading && campaignsError && (
                  <div className="task-form-placeholder error">{campaignsError}</div>
                )}
                {!campaignsLoading && !campaignsError && visibleCampaigns.length === 0 && (
                  <div className="task-form-placeholder">Нет активных заданий.</div>
                )}
                {!campaignsLoading &&
                  !campaignsError &&
                  visibleCampaigns.map((campaign) => {
                    const application = applicationsByCampaign.get(campaign.id);
                    const status = application?.status;
                    const statusMeta = getTaskStatusMeta(status);
                    const payout = calculatePayout(campaign.rewardPoints);
                    const badgeLabel = `+${payout} ${formatPointsLabel(payout)}`;
                    return (
                      <div
                        className={`task-card ${leavingIds.includes(campaign.id) ? 'is-leaving' : ''}`}
                        key={campaign.id}
                        ref={(node) => registerTaskCardRef(campaign.id, node)}
                      >
                        <div className="task-card-head">
                          <div className="task-avatar">
                            <span>{campaign.group.title?.[0] ?? 'Г'}</span>
                          </div>
                          <div className="task-info">
                            <div className="task-title-row">
                              <div className="task-title">{campaign.group.title}</div>
                            </div>
                            <div className="task-handle">
                              {getGroupSecondaryLabel(campaign.group)}
                            </div>
                            <div className="task-meta">
                              <span
                                className="badge sticker"
                                ref={(node) => registerTaskBadgeRef(campaign.id, node)}
                              >
                                {badgeLabel}
                              </span>
                              <span className={`status-badge compact ${statusMeta.className}`}>
                                {statusMeta.label}
                              </span>
                            </div>
                          </div>
                          <div className="task-actions">
                            <button
                              className="open-button action"
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
                            {status === 'APPROVED' && !acknowledgedIds.includes(campaign.id) && (
                              <button
                                className="open-button confirm"
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
                      <div className="task-card" key={application.id}>
                        <div className="task-card-head">
                          <div className="task-avatar">
                            <span>{campaign.group.title?.[0] ?? 'Г'}</span>
                          </div>
                          <div className="task-info">
                            <div className="task-title-row">
                              <div className="task-title">{campaign.group.title}</div>
                            </div>
                            <div className="task-handle">
                              {getGroupSecondaryLabel(campaign.group)}
                            </div>
                            <div className="task-meta">
                              <span className="badge sticker">{badgeLabel}</span>
                              <span className="status-badge approved compact">Выполнено</span>
                            </div>
                          </div>
                          <div className="task-actions">
                            <button
                              className="open-button action"
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
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}
      </div>

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

      {activeTab !== 'wheel' && activeTab !== 'referrals' && (
        <div className={`bottom-nav ${adminPanelAllowed ? 'has-admin' : ''}`}>
          <button
            className={`nav-item ${activeTab === 'home' ? 'active' : ''}`}
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
