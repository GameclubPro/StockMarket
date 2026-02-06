import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyCampaign,
  createCampaign,
  fetchCampaigns,
  fetchMe,
  fetchMyApplications,
  fetchMyCampaigns,
  fetchMyGroups,
  type ApplicationDto,
  type CampaignDto,
  type GroupDto,
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

export default function App() {
  const [userLabel, setUserLabel] = useState(() => getUserLabel());
  const [userPhoto, setUserPhoto] = useState(() => getUserPhotoUrl());
  const [points, setPoints] = useState(30);
  const [pointsToday] = useState(0);
  const [totalEarned, setTotalEarned] = useState(0);
  const [userId, setUserId] = useState('');
  const [activeTab, setActiveTab] = useState<'home' | 'promo' | 'tasks' | 'settings'>('home');
  const [taskTypeFilter, setTaskTypeFilter] = useState<'subscribe' | 'reaction'>('subscribe');
  const [taskListFilter, setTaskListFilter] = useState<'hot' | 'new' | 'history'>('new');
  const [myTasksTab, setMyTasksTab] = useState<'place' | 'mine'>('place');
  const [taskType, setTaskType] = useState<'subscribe' | 'reaction'>('subscribe');
  const [reactionLink, setReactionLink] = useState('');
  const [taskPrice, setTaskPrice] = useState(10);
  const [taskCount, setTaskCount] = useState(10);
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
  const animatingOutRef = useRef<Set<string>>(new Set());
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
  const pendingPayoutTotal = useMemo(() => {
    const acknowledged = new Set(acknowledgedIds);
    return applications.reduce((sum, application) => {
      if (application.status !== 'APPROVED') return sum;
      if (acknowledged.has(application.campaign.id)) return sum;
      return sum + calculatePayout(application.campaign.rewardPoints);
    }, 0);
  }, [applications, acknowledgedIds, calculatePayout]);
  const displayPoints = useMemo(
    () => Math.max(0, points - pendingPayoutTotal),
    [points, pendingPayoutTotal]
  );
  const totalBudget = useMemo(() => taskPrice * taskCount, [taskPrice, taskCount]);
  const minPayoutPreview = useMemo(() => calculateBasePayout(taskPrice), [taskPrice]);
  const maxPayoutPreview = useMemo(
    () => calculatePayoutWithBonus(taskPrice, MAX_BONUS_RATE),
    [taskPrice]
  );
  const activeCampaigns = useMemo(() => {
    const acknowledgedSet = new Set(acknowledgedIds);
    return campaigns.filter((campaign) => {
      const status = applicationsByCampaign.get(campaign.id)?.status;
      if (status === 'APPROVED' && acknowledgedSet.has(campaign.id)) return false;
      if (userId && campaign.owner?.id && campaign.owner.id === userId) return false;
      return true;
    });
  }, [applicationsByCampaign, campaigns, userId, acknowledgedIds]);
  const visibleCampaigns = useMemo(() => {
    if (taskListFilter === 'history') return [];
    const type = taskTypeFilter === 'subscribe' ? 'SUBSCRIBE' : 'REACTION';
    const base = activeCampaigns.filter((campaign) => campaign.actionType === type);
    if (taskListFilter === 'hot') {
      return [...base].sort((a, b) => b.rewardPoints - a.rewardPoints);
    }
    return [...base].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [activeCampaigns, taskListFilter, taskTypeFilter]);
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

  const initialLetter = useMemo(() => {
    const trimmed = userLabel.trim();
    return trimmed ? trimmed[0].toUpperCase() : 'A';
  }, [userLabel]);

  useEffect(() => {
    initTelegram();
    setUserLabel(getUserLabel());
    setUserPhoto(getUserPhotoUrl());

    const loadProfile = async () => {
      const initData = getInitDataRaw();
      if (!initData) return;

      try {
        const data = await verifyInitData(initData);
        if (typeof data.balance === 'number') setPoints(data.balance);
        if (typeof data.user?.totalEarned === 'number') setTotalEarned(data.user.totalEarned);
        if (typeof data.user?.id === 'string') setUserId(data.user.id);
      } catch {
        // Keep default zeros on auth failure.
      }
    };

    void loadProfile();
  }, []);

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

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

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
      ]);
      restoreScrollTop(contentRef.current, scrollTop);
    })();
  }, [loadCampaigns, loadMyApplications, loadMe]);

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

  const BalanceHeader = () => (
    <div className="balance-header">
      <div className="balance-header-metrics">
        <div className="metric-card compact">
          <span className="metric-value" ref={balanceValueRef}>
            {displayPoints}
          </span>
          <span className="metric-unit">{formatPointsLabel(displayPoints)}</span>
          <button className="metric-plus" type="button" aria-label="Пополнить баланс">
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
    if (!Number.isFinite(taskPrice) || taskPrice < 1) {
      setCreateError('Цена за действие должна быть не меньше 1 балла.');
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
    if (totalBudget > 1_000_000) {
      setCreateError('Бюджет слишком большой. Максимум 1 000 000 баллов.');
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
        rewardPoints: Math.round(taskPrice),
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
      if (typeof data.balance === 'number') {
        setPoints(data.balance);
      }
      await loadCampaigns();
      await loadMyApplications();
    } catch (error: any) {
      setActionError(error?.message ?? 'Не удалось отправить задание.');
    } finally {
      setActionLoadingId('');
    }
  };

  const handleOpenCampaign = async (campaign: CampaignDto, status?: ApplicationDto['status']) => {
    if (!status && actionLoadingId !== campaign.id) {
      void handleApplyCampaign(campaign.id);
    }
    openCampaignLink(campaign);
  };

  const handleConfirmReward = (campaignId: string, scoreValue: number) => {
    if (animatingOutRef.current.has(campaignId)) return;
    animatingOutRef.current.add(campaignId);
    triggerCompletionAnimation(campaignId, String(scoreValue));
  };


  return (
    <div className="screen">
      <div className="content" ref={contentRef}>
        {activeTab === 'home' && (
          <>
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
                  <button className="sub" type="button">
                    Пополнить баланс
                  </button>
                </div>
              </div>
              <div className="stats">
                <div className="stat divider">
                  <div className="stat-main">
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

            <div className="menu">
              <button className="menu-item" type="button">
                <div className="menu-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#79f0b6" strokeWidth="1.6">
                    <path d="M3 12l18-9-6 18-3-7-9-2z" />
                  </svg>
                </div>
                <div>
                  <div className="label">Создать задание</div>
                  <div className="desc">4 861 подписчик</div>
                </div>
                <div className="chev">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </button>

              <button className="menu-item" type="button">
                <div className="menu-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#b6a9ff" strokeWidth="1.6">
                    <circle cx="9" cy="9" r="3" />
                    <circle cx="16" cy="10" r="2.5" />
                    <path d="M3 19c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5" />
                  </svg>
                </div>
                <div>
                  <div className="label">Биржа продвижения</div>
                  <div className="desc">4 861 подписчик</div>
                </div>
                <div className="chev">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </button>

              <button className="menu-item" type="button">
                <div className="menu-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#9ad8ff" strokeWidth="1.6">
                    <rect x="4" y="4" width="4" height="4" rx="1" />
                    <rect x="4" y="10" width="4" height="4" rx="1" />
                    <rect x="4" y="16" width="4" height="4" rx="1" />
                    <path d="M11 6h9M11 12h9M11 18h9" />
                  </svg>
                </div>
                <div>
                  <div className="label">Мои задания</div>
                  <div className="desc">268 активных выполнения</div>
                </div>
                <div className="chev">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </button>

              <button className="menu-item" type="button">
                <div className="menu-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#c8c8ff" strokeWidth="1.6">
                    <circle cx="12" cy="12" r="3.5" />
                    <path
                      d="M19 12a7 7 0 00-.1-1l2.1-1.6-2-3.4-2.4.9a7 7 0 00-1.7-1l-.3-2.6H9.4l-.3 2.6a7 7 0 00-1.7 1l-2.4-.9-2 3.4L5.1 11a7 7 0 000 2l-2.1 1.6 2 3.4 2.4-.9a7 7 0 001.7 1l.3 2.6h4.2l.3-2.6a7 7 0 001.7-1l2.4.9 2-3.4L18.9 13a7 7 0 00.1-1z"
                    />
                  </svg>
                </div>
                <div>
                  <div className="label">Настройки</div>
                </div>
                <div className="chev">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </button>
            </div>
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
                        ? 'Укажите цену за вступление. Нажмите "Получить", вступите — бот подтвердит автоматически.'
                        : 'Укажите ссылку на пост и цену. Сначала нажмите "Получить", затем поставьте реакцию.'}
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
                      <div className="range-hint">
                        Ссылка должна быть из выбранной группы (t.me/username/123 или t.me/c/123456/789).
                      </div>
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
                    Быстро добавит бота администратором в канал/группу.
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
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={taskPrice}
                      onChange={(event) => setTaskPrice(Number(event.target.value))}
                    />
                    <div className="range-hint">
                      Ставка {taskPrice} баллов · Исполнитель получит {minPayoutPreview}–{maxPayoutPreview}{' '}
                      баллов (зависит от ранга)
                    </div>
                  </label>
                  <label className="field">
                    <span>{taskType === 'subscribe' ? 'Количество вступлений' : 'Количество реакций'}</span>
                    <input
                      className="range-input"
                      type="range"
                      min={1}
                      max={200}
                      value={taskCount}
                      onChange={(event) => setTaskCount(Number(event.target.value))}
                    />
                    <div className="range-meta">
                      <span>{taskCount} действий</span>
                      <span>Итог списание: {totalBudget} баллов</span>
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
                    disabled={createLoading}
                  >
                    {createLoading ? 'Создание…' : 'Создать'}
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
                              <span
                                className="badge sticker"
                                ref={(node) => registerTaskBadgeRef(campaign.id, node)}
                              >
                                {badgeLabel}
                              </span>
                            </div>
                            <div className="task-handle">
                              {getGroupSecondaryLabel(campaign.group)}
                            </div>
                          </div>
                          <div className="task-actions">
                            <button
                              className="open-button icon"
                              type="button"
                              onClick={() => void handleOpenCampaign(campaign, status)}
                              aria-label={status ? 'Открыть' : 'Получить и открыть'}
                              disabled={actionLoadingId === campaign.id}
                            >
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
                            {status === 'PENDING' && (
                              <span className="status-badge pending">Ожидание</span>
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
                              <span className="badge sticker">{badgeLabel}</span>
                            </div>
                            <div className="task-handle">
                              {getGroupSecondaryLabel(campaign.group)}
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

        {activeTab === 'settings' && (
          <>
            <div className="page-title">Настройки</div>
            <div className="section-card">
              <div className="section-title">Профиль и уведомления</div>
              <div className="section-text">Настройте аккаунт, уведомления и безопасность.</div>
            </div>
          </>
        )}
      </div>

      <div className="bottom-nav">
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
        <button
          className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
          type="button"
          onClick={() => setActiveTab('settings')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="3.5" />
            <path d="M19 12a7 7 0 00-.1-1l2.1-1.6-2-3.4-2.4.9a7 7 0 00-1.7-1l-.3-2.6H9.4l-.3 2.6a7 7 0 00-1.7 1l-2.4-.9-2 3.4L5.1 11a7 7 0 000 2l-2.1 1.6 2 3.4 2.4-.9a7 7 0 001.7 1l.3 2.6h4.2l.3-2.6a7 7 0 001.7-1l2.4.9 2-3.4L18.9 13a7 7 0 00.1-1z" />
          </svg>
          <span>Настройки</span>
        </button>
      </div>
    </div>
  );
}
