import { readTextFromClipboard } from '@telegram-apps/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyCampaign,
  createCampaign,
  fetchCampaigns,
  fetchMyApplications,
  fetchMyCampaigns,
  fetchMyGroups,
  type ApplicationDto,
  type CampaignDto,
  type GroupDto,
  verifyInitData,
} from './api';
import { getInitDataRaw, getUserLabel, getUserPhotoUrl, initTelegram } from './telegram';

export default function App() {
  const [userLabel, setUserLabel] = useState(() => getUserLabel());
  const [userPhoto, setUserPhoto] = useState(() => getUserPhotoUrl());
  const [points, setPoints] = useState(30);
  const [pointsToday] = useState(0);
  const [rating, setRating] = useState(0);
  const [activeTab, setActiveTab] = useState<'home' | 'promo' | 'tasks' | 'settings'>('home');
  const [taskTypeFilter, setTaskTypeFilter] = useState<'subscribe' | 'reaction'>('subscribe');
  const [taskListFilter, setTaskListFilter] = useState<'hot' | 'new' | 'history'>('new');
  const [myTasksTab, setMyTasksTab] = useState<'place' | 'mine'>('place');
  const [taskLink, setTaskLink] = useState('');
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
  const [linkHint, setLinkHint] = useState('');
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
  const taskLinkInputRef = useRef<HTMLInputElement | null>(null);
  const linkPickerRef = useRef<HTMLDivElement | null>(null);
  const applicationsByCampaign = useMemo(() => {
    const map = new Map<string, ApplicationDto>();
    applications.forEach((application) => {
      map.set(application.campaign.id, application);
    });
    return map;
  }, [applications]);
  const platformFeeRate = 0.3;
  const calculatePayout = useCallback(
    (value: number) => {
      const payout = Math.round(value * (1 - platformFeeRate));
      return Math.max(1, Math.min(value, payout));
    },
    [platformFeeRate]
  );
  const totalBudget = useMemo(() => taskPrice * taskCount, [taskPrice, taskCount]);
  const payoutPreview = useMemo(() => calculatePayout(taskPrice), [calculatePayout, taskPrice]);
  const activeCampaigns = useMemo(() => {
    return campaigns.filter((campaign) => {
      const status = applicationsByCampaign.get(campaign.id)?.status;
      return status !== 'APPROVED';
    });
  }, [applicationsByCampaign, campaigns]);
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
        if (typeof data.user?.rating === 'number') setRating(data.user.rating);
      } catch {
        // Keep default zeros on auth failure.
      }
    };

    void loadProfile();
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
    } catch {
      setMyGroups([]);
      setMyGroupsError('Не удалось загрузить список групп.');
    } finally {
      setMyGroupsLoaded(true);
      setMyGroupsLoading(false);
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    setCampaignsError('');
    setCampaignsLoading(true);

    try {
      const data = await fetchCampaigns();
      if (data.ok && Array.isArray(data.campaigns)) {
        setCampaigns(data.campaigns);
      } else {
        setCampaigns([]);
        setCampaignsError('Не удалось загрузить задания.');
      }
    } catch {
      setCampaigns([]);
      setCampaignsError('Не удалось загрузить задания.');
    } finally {
      setCampaignsLoading(false);
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

  const loadMyApplications = useCallback(async () => {
    setApplicationsError('');
    setApplicationsLoading(true);

    try {
      const data = await fetchMyApplications();
      if (data.ok && Array.isArray(data.applications)) {
        setApplications(data.applications);
      } else {
        setApplications([]);
        setApplicationsError('Не удалось загрузить статусы.');
      }
    } catch {
      setApplications([]);
      setApplicationsError('Не удалось загрузить статусы.');
    } finally {
      setApplicationsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    if (activeTab !== 'tasks') return;
    void loadMyApplications();
  }, [activeTab, loadMyApplications]);

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
    setTaskLink(group.inviteLink);
    setSelectedGroupId(group.id);
    setSelectedGroupTitle(group.title);
    setLinkPickerOpen(false);
    setLinkHint('');
    requestAnimationFrame(() => {
      taskLinkInputRef.current?.focus();
      taskLinkInputRef.current?.select();
    });
  };

  const handlePasteLink = async () => {
    setLinkHint('');
    setSelectedGroupId('');
    setSelectedGroupTitle('');
    let text = '';

    const readViaNavigator = async () => {
      if (!window.isSecureContext) return '';
      if (!navigator.clipboard?.readText) return '';
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    };

    try {
      if (readTextFromClipboard.isAvailable()) {
        const value = await readTextFromClipboard();
        if (typeof value === 'string') text = value;
      } else {
        text = await readViaNavigator();
      }
    } catch {
      text = await readViaNavigator();
    }

    if (text) {
      setTaskLink(text.trim());
      setLinkPickerOpen(false);
      requestAnimationFrame(() => {
        taskLinkInputRef.current?.focus();
        taskLinkInputRef.current?.select();
      });
      return;
    }

    requestAnimationFrame(() => {
      taskLinkInputRef.current?.focus();
      taskLinkInputRef.current?.select();
    });

    setLinkHint(
      window.isSecureContext
        ? 'Не удалось прочитать буфер обмена. Нажмите на поле и вставьте вручную.'
        : 'Буфер обмена доступен только по HTTPS/localhost или в Telegram.'
    );
  };

  const getGroupSecondaryLabel = (group: GroupDto) => {
    const username = group.username?.trim();
    if (username) return username.startsWith('@') ? username : `@${username}`;
    return group.inviteLink;
  };

  const resolveGroupId = () => {
    if (selectedGroupId) return selectedGroupId;
    const raw = taskLink.trim();
    if (!raw) return '';
    const normalized = raw
      .replace(/^https?:\/\//i, '')
      .replace(/^t\.me\//i, '')
      .replace(/^telegram\.me\//i, '')
      .replace(/^@/, '')
      .split('/')[0]
      .toLowerCase();
    const match = myGroups.find((group) => {
      const username = group.username?.trim().toLowerCase();
      if (username && username === normalized) return true;
      return group.inviteLink.trim().toLowerCase() === raw.toLowerCase();
    });
    return match?.id ?? '';
  };

  const openCampaignLink = (campaign: CampaignDto) => {
    const username = campaign.group.username?.trim();
    const url =
      campaign.actionType === 'REACTION' && campaign.targetMessageId && username
        ? `https://t.me/${username}/${campaign.targetMessageId}`
        : campaign.group.inviteLink;
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const formatDate = (value?: string | null) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('ru-RU');
  };

  const handleCreateCampaign = async () => {
    setCreateError('');
    const groupId = resolveGroupId();
    if (!taskLink.trim()) {
      setCreateError('Укажите ссылку на группу.');
      return;
    }
    if (!groupId) {
      setCreateError('Сначала добавьте бота в группу и выберите ее из списка.');
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
    if (points < totalBudget) {
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
      setTaskLink('');
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


  return (
    <div className="screen">
      <div className="content">
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
                    <span className="accent">{points >= 0 ? `+ ${points}` : `${points}`}</span>
                    <span>Балл</span>
                  </div>
                  <div className="stat-title">
                    {pointsToday >= 0 ? `+${pointsToday}` : pointsToday} сегодня
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
                    <span className="gold">{rating.toFixed(1)}</span>
                  </div>
                  <div className="stat-title">Рейтинг {rating.toFixed(1)}</div>
                </div>
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
            <div className="page-header">
              <div className="page-title">Мои задания</div>
              <button className="icon-button" type="button" aria-label="Обновить">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M21 12a9 9 0 11-2.6-6.4" />
                  <path d="M21 3v7h-7" />
                </svg>
              </button>
            </div>
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
                  <label className="field">
                    <span>Ссылка на группу</span>
                    <input
                      type="text"
                      placeholder="https://t.me/... или @username"
                      ref={taskLinkInputRef}
                      value={taskLink}
                      onChange={(event) => {
                        const value = event.target.value;
                        setTaskLink(value);
                        setSelectedGroupId('');
                        setSelectedGroupTitle('');
                        setLinkHint('');
                        if (!myGroupsLoaded) return;
                        const normalized = value
                          .replace(/^https?:\/\//i, '')
                          .replace(/^t\.me\//i, '')
                          .replace(/^telegram\.me\//i, '')
                          .replace(/^@/, '')
                          .split('/')[0]
                          .toLowerCase();
                        const match = myGroups.find((group) => {
                          const username = group.username?.trim().toLowerCase();
                          if (username && username === normalized) return true;
                          return group.inviteLink.trim().toLowerCase() === value.trim().toLowerCase();
                        });
                        if (match) {
                          setSelectedGroupId(match.id);
                          setSelectedGroupTitle(match.title);
                        }
                      }}
                    />
                  </label>
                  {selectedGroupTitle && (
                    <div className="link-hint">Выбрано: {selectedGroupTitle}</div>
                  )}
                  {taskType === 'reaction' && (
                    <label className="field">
                      <span>Ссылка на пост</span>
                      <input
                        type="text"
                        placeholder="https://t.me/username/123"
                        value={reactionLink}
                        onChange={(event) => setReactionLink(event.target.value)}
                      />
                      <div className="range-hint">Ссылка должна быть из выбранной группы.</div>
                    </label>
                  )}
                  <div className="link-tools">
                    <button
                      className={`link-tool ${linkPickerOpen ? 'active' : ''}`}
                      type="button"
                      aria-expanded={linkPickerOpen}
                      aria-controls="quick-link-picker"
                      onClick={() => {
                        setLinkHint('');
                        setLinkPickerOpen((prev) => !prev);
                      }}
                    >
                      Быстрый выбор
                    </button>
                    <button
                      className="link-tool secondary"
                      type="button"
                      onClick={() => void handlePasteLink()}
                    >
                      Вставить из буфера
                    </button>
                  </div>
                  {linkHint && <div className="link-hint">{linkHint}</div>}
                  {linkPickerOpen && (
                    <div className="link-picker" id="quick-link-picker" ref={linkPickerRef}>
                      <div className="link-picker-head">
                        <span className="link-picker-title">Мои проекты</span>
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
                        myGroups.map((group) => (
                          <button
                            className="link-option"
                            key={group.id}
                            type="button"
                            onClick={() => handleQuickLinkSelect(group)}
                          >
                            <span className="link-option-title">{group.title}</span>
                            <span className="link-option-handle">{getGroupSecondaryLabel(group)}</span>
                          </button>
                        ))}

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
                      Ставка {taskPrice} баллов · Исполнитель получит {payoutPreview} баллов
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
                  <div className="balance-pill">Баланс: {points}</div>
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
                    const payout = calculatePayout(campaign.rewardPoints);
                    return (
                      <div className="task-card" key={campaign.id}>
                        <div className="task-card-head">
                          <div className="task-avatar">
                            <span>{campaign.group.title?.[0] ?? 'Г'}</span>
                          </div>
                          <div className="task-info">
                            <div className="task-title">{campaign.group.title}</div>
                            <div className="task-handle">
                              {getGroupSecondaryLabel(campaign.group)}
                            </div>
                          </div>
                          <div className="task-actions">
                            <button
                              className="open-button"
                              type="button"
                              onClick={() => openCampaignLink(campaign)}
                            >
                              Открыть
                            </button>
                          </div>
                        </div>
                        <div className="task-meta">
                          <span className="badge">Ставка: {campaign.rewardPoints}</span>
                          <span className="muted">Исполнитель: {payout}</span>
                          <span className="muted">
                            Тип: {campaign.actionType === 'SUBSCRIBE' ? 'Подписка' : 'Реакция'}
                          </span>
                          <span className="muted">Осталось: {campaign.remainingBudget}</span>
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
            <div className="page-header">
              <div className="page-title">Задания</div>
              <button
                className="icon-button"
                type="button"
                aria-label="Обновить"
                onClick={() => {
                  void loadCampaigns();
                  if (activeTab === 'tasks') void loadMyApplications();
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M21 12a9 9 0 11-2.6-6.4" />
                  <path d="M21 3v7h-7" />
                </svg>
              </button>
            </div>
            <div className="segment filters">
              <div className="filter-toggle" role="tablist" aria-label="Тип задания">
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
              </div>
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
                    const statusLabel =
                      status === 'APPROVED'
                        ? 'Получено'
                        : status === 'PENDING'
                          ? campaign.actionType === 'SUBSCRIBE'
                            ? 'Ожидает вступления'
                            : 'Ожидает реакции'
                          : status === 'REJECTED'
                            ? 'Отклонено'
                            : '';
                    const actionLabel =
                      status === 'APPROVED'
                        ? 'Получено'
                        : status === 'PENDING'
                          ? 'Ожидание'
                          : 'Получить';
                    const disabled =
                      status === 'APPROVED' ||
                      status === 'PENDING' ||
                      actionLoadingId === campaign.id;
                    const payout = calculatePayout(campaign.rewardPoints);
                    return (
                      <div className="task-card" key={campaign.id}>
                        <div className="task-card-head">
                          <div className="task-avatar">
                            <span>{campaign.group.title?.[0] ?? 'Г'}</span>
                          </div>
                          <div className="task-info">
                            <div className="task-title">{campaign.group.title}</div>
                            <div className="task-handle">
                              {getGroupSecondaryLabel(campaign.group)}
                            </div>
                          </div>
                          <div className="task-actions">
                            <button
                              className="open-button"
                              type="button"
                              onClick={() => openCampaignLink(campaign)}
                            >
                              Открыть
                            </button>
                            <button
                              className="open-button secondary"
                              type="button"
                              onClick={() => void handleApplyCampaign(campaign.id)}
                              disabled={disabled}
                            >
                              {actionLabel}
                            </button>
                          </div>
                        </div>
                        <div className="task-meta">
                          <span className="badge">+{payout} балл</span>
                          <span className="muted">Ставка {campaign.rewardPoints}</span>
                          <span className="muted">Проверка: бот</span>
                          {statusLabel && (
                            <span className={`status-badge ${status?.toLowerCase()}`}>
                              {statusLabel}
                            </span>
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
                    const payout = calculatePayout(campaign.rewardPoints);
                    const doneAt = formatDate(application.reviewedAt ?? application.createdAt);
                    return (
                      <div className="task-card" key={application.id}>
                        <div className="task-card-head">
                          <div className="task-avatar">
                            <span>{campaign.group.title?.[0] ?? 'Г'}</span>
                          </div>
                          <div className="task-info">
                            <div className="task-title">{campaign.group.title}</div>
                            <div className="task-handle">
                              {getGroupSecondaryLabel(campaign.group)}
                            </div>
                          </div>
                          <div className="task-actions">
                            <button
                              className="open-button"
                              type="button"
                              onClick={() => openCampaignLink(campaign)}
                            >
                              Открыть
                            </button>
                          </div>
                        </div>
                        <div className="task-meta">
                          <span className="badge">+{payout} балл</span>
                          <span className="muted">
                            Тип: {campaign.actionType === 'SUBSCRIBE' ? 'Подписка' : 'Реакция'}
                          </span>
                          {doneAt && <span className="muted">Дата: {doneAt}</span>}
                          <span className="status-badge approved">Выполнено</span>
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
