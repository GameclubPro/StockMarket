import { useEffect, useMemo, useState } from 'react';
import type { ApplicationDto, CampaignDto, GroupDto } from './api';
import {
  applyCampaign,
  approveApplication,
  createCampaign,
  createGroup,
  fetchCampaigns,
  fetchIncomingApplications,
  fetchMe,
  fetchMyApplications,
  fetchMyCampaigns,
  fetchMyGroups,
  rejectApplication,
  verifyInitData,
} from './api';
import { getInitDataRaw, getUserLabel, initTelegram, isTelegram } from './telegram';

type TabId = 'market' | 'promote' | 'applications';

type GroupForm = {
  title: string;
  username: string;
  inviteLink: string;
  description: string;
  category: string;
};

type CampaignForm = {
  groupId: string;
  rewardPoints: string;
  totalBudget: string;
};

const tabs: Array<{ id: TabId; label: string; hint: string }> = [
  { id: 'market', label: 'Биржа', hint: 'Заработок' },
  { id: 'promote', label: 'Продвижение', hint: 'Ваши кампании' },
  { id: 'applications', label: 'Заявки', hint: 'Ваши действия' },
];

const statusLabels: Record<ApplicationDto['status'], string> = {
  PENDING: 'Ожидает',
  APPROVED: 'Принято',
  REJECTED: 'Отклонено',
};

const campaignStatusLabels: Record<CampaignDto['status'], string> = {
  ACTIVE: 'Активна',
  PAUSED: 'Пауза',
  COMPLETED: 'Завершена',
};

const categories = ['Все', 'Игры', 'Бизнес', 'Новости', 'Развлечения', 'IT', 'Обучение', 'Другое'];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('market');
  const [authState, setAuthState] = useState<'idle' | 'verifying' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [balance, setBalance] = useState(0);
  const [stats, setStats] = useState({ groups: 0, campaigns: 0, applications: 0 });
  const [userLabel, setUserLabel] = useState(() => getUserLabel());

  const [marketCampaigns, setMarketCampaigns] = useState<CampaignDto[]>([]);
  const [myGroups, setMyGroups] = useState<GroupDto[]>([]);
  const [myCampaigns, setMyCampaigns] = useState<CampaignDto[]>([]);
  const [myApplications, setMyApplications] = useState<ApplicationDto[]>([]);
  const [incomingApplications, setIncomingApplications] = useState<ApplicationDto[]>([]);
  const [categoryFilter, setCategoryFilter] = useState('Все');

  const [groupForm, setGroupForm] = useState<GroupForm>({
    title: '',
    username: '',
    inviteLink: '',
    description: '',
    category: '',
  });
  const [campaignForm, setCampaignForm] = useState<CampaignForm>({
    groupId: '',
    rewardPoints: '10',
    totalBudget: '100',
  });

  const level = useMemo(() => Math.max(1, Math.floor(balance / 500) + 1), [balance]);
  const nextLevelAt = level * 500;
  const progress = Math.min(100, Math.round((balance / nextLevelAt) * 100));

  const loadMe = async () => {
    const data = await fetchMe();
    setBalance(data.balance ?? 0);
    setStats(data.stats ?? { groups: 0, campaigns: 0, applications: 0 });
  };

  const loadMarket = async (category?: string) => {
    const data = await fetchCampaigns(category && category !== 'Все' ? category : undefined);
    setMarketCampaigns(data.campaigns ?? []);
  };

  const loadPromote = async () => {
    const [groupsData, campaignsData, incomingData] = await Promise.all([
      fetchMyGroups(),
      fetchMyCampaigns(),
      fetchIncomingApplications(),
    ]);
    setMyGroups(groupsData.groups ?? []);
    setMyCampaigns(campaignsData.campaigns ?? []);
    setIncomingApplications(incomingData.applications ?? []);
  };

  const loadApplications = async () => {
    const data = await fetchMyApplications();
    setMyApplications(data.applications ?? []);
  };

  const loadAll = async () => {
    try {
      await Promise.all([loadMe(), loadMarket(categoryFilter), loadPromote(), loadApplications()]);
    } catch {
      setMessage('Не удалось загрузить данные.');
    }
  };

  useEffect(() => {
    initTelegram();
    setUserLabel(getUserLabel());

    const initDataRaw = getInitDataRaw();
    if (!initDataRaw) return;

    setAuthState('verifying');
    verifyInitData(initDataRaw)
      .then((data) => {
        setAuthState('ok');
        if (data.balance !== undefined) setBalance(data.balance ?? 0);
        loadAll();
      })
      .catch(() => {
        setAuthState('error');
        setMessage('Авторизация не прошла. Открой через Telegram.');
      });
  }, []);

  useEffect(() => {
    loadMarket(categoryFilter);
  }, [categoryFilter]);

  const handleCreateGroup = async () => {
    if (!groupForm.title.trim() || !groupForm.inviteLink.trim()) return;
    try {
      await createGroup({
        title: groupForm.title.trim(),
        username: groupForm.username.trim() || undefined,
        inviteLink: groupForm.inviteLink.trim(),
        description: groupForm.description.trim() || undefined,
        category: groupForm.category.trim() || undefined,
      });
      setGroupForm({ title: '', username: '', inviteLink: '', description: '', category: '' });
      await loadPromote();
      await loadMe();
      setMessage('Группа добавлена.');
    } catch {
      setMessage('Не удалось добавить группу.');
    }
  };

  const handleCreateCampaign = async () => {
    if (!campaignForm.groupId) return;
    try {
      await createCampaign({
        groupId: campaignForm.groupId,
        rewardPoints: Number(campaignForm.rewardPoints),
        totalBudget: Number(campaignForm.totalBudget),
      });
      await loadPromote();
      await loadMe();
      setMessage('Кампания создана.');
    } catch {
      setMessage('Не удалось создать кампанию (проверь баланс).');
    }
  };

  const handleApply = async (id: string) => {
    try {
      await applyCampaign(id);
      await loadApplications();
      setMessage('Заявка отправлена.');
    } catch {
      setMessage('Не удалось отправить заявку.');
    }
  };

  const handleApprove = async (id: string) => {
    try {
      await approveApplication(id);
      await loadPromote();
      await loadMe();
      setMessage('Заявка подтверждена, баллы начислены.');
    } catch {
      setMessage('Не удалось подтвердить заявку.');
    }
  };

  const handleReject = async (id: string) => {
    try {
      await rejectApplication(id);
      await loadPromote();
      setMessage('Заявка отклонена.');
    } catch {
      setMessage('Не удалось отклонить заявку.');
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Telegram Mini App · Биржа продвижения</p>
          <h1>Биржа взаимных вступлений</h1>
          <p className="subhead">Зарабатывай баллы за вступления и продвигай свои группы.</p>
        </div>
        <div className="chip">Онлайн · {new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
      </header>

      <section className="stats">
        <div className="stat">
          <p>Пользователь</p>
          <strong>{userLabel}</strong>
          <span>Авторизация: {authState === 'ok' ? 'Ok' : authState === 'verifying' ? 'Проверка' : '—'}</span>
        </div>
        <div className="stat">
          <p>Баланс</p>
          <strong>{balance}</strong>
          <span>Уровень {level}</span>
        </div>
        <div className="stat">
          <p>Прогресс</p>
          <strong>{Math.max(0, nextLevelAt - balance)}</strong>
          <span>До уровня {level + 1} · {progress}%</span>
        </div>
      </section>

      <nav className="tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'tab active' : 'tab'}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.label}</span>
            <small>{tab.hint}</small>
          </button>
        ))}
      </nav>

      {activeTab === 'market' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Доступные кампании</h2>
              <p>Выбирай группы и зарабатывай баллы.</p>
            </div>
            <div className="filters">
              {categories.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={categoryFilter === item ? 'filter active' : 'filter'}
                  onClick={() => setCategoryFilter(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="offers">
            {marketCampaigns.map((campaign) => (
              <article key={campaign.id} className="card offer">
                <div className="offer-head">
                  <div>
                    <h3>{campaign.group.title}</h3>
                    <p>{campaign.group.category || 'Без категории'} · {new Date(campaign.createdAt).toLocaleString('ru-RU')}</p>
                  </div>
                  <span className="pill active">+{campaign.rewardPoints} баллов</span>
                </div>
                <p className="offer-note">{campaign.group.description || 'Описание группы не указано.'}</p>
                <div className="offer-meta">
                  <span>Бюджет: {campaign.remainingBudget}/{campaign.totalBudget}</span>
                  {campaign.group.username ? (
                    <a href={`https://t.me/${campaign.group.username}`} target="_blank" rel="noreferrer">@{campaign.group.username}</a>
                  ) : (
                    <a href={campaign.group.inviteLink} target="_blank" rel="noreferrer">Ссылка на группу</a>
                  )}
                </div>
                <div className="offer-actions">
                  <button className="primary" type="button" onClick={() => handleApply(campaign.id)}>
                    Отправить заявку
                  </button>
                </div>
              </article>
            ))}
            {!marketCampaigns.length && <p className="empty">Нет активных кампаний.</p>}
          </div>
        </section>
      )}

      {activeTab === 'promote' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Продвижение ваших групп</h2>
              <p>Добавляй группы и запускай кампании.</p>
            </div>
          </div>

          <div className="grid-2">
            <form
              className="card form"
              onSubmit={(event) => {
                event.preventDefault();
                handleCreateGroup();
              }}
            >
              <h3>Новая группа</h3>
              <label>
                Название группы
                <input
                  value={groupForm.title}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, title: event.target.value }))}
                  placeholder="Название"
                  required
                />
              </label>
              <label>
                Username (если есть)
                <input
                  value={groupForm.username}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, username: event.target.value }))}
                  placeholder="play_team"
                />
              </label>
              <label>
                Invite link
                <input
                  value={groupForm.inviteLink}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, inviteLink: event.target.value }))}
                  placeholder="https://t.me/+..."
                  required
                />
              </label>
              <label>
                Категория
                <input
                  value={groupForm.category}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, category: event.target.value }))}
                  placeholder="Игры, IT, Бизнес"
                />
              </label>
              <label className="full">
                Описание
                <textarea
                  rows={3}
                  value={groupForm.description}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, description: event.target.value }))}
                  placeholder="Коротко о группе"
                />
              </label>
              <div className="form-actions">
                <button className="primary" type="submit">Добавить группу</button>
              </div>
            </form>

            <form
              className="card form"
              onSubmit={(event) => {
                event.preventDefault();
                handleCreateCampaign();
              }}
            >
              <h3>Новая кампания</h3>
              <label>
                Группа
                <select
                  value={campaignForm.groupId}
                  onChange={(event) => setCampaignForm((prev) => ({ ...prev, groupId: event.target.value }))}
                >
                  <option value="">Выберите группу</option>
                  {myGroups.map((group) => (
                    <option key={group.id} value={group.id}>{group.title}</option>
                  ))}
                </select>
              </label>
              <label>
                Баллы за вступление
                <input
                  type="number"
                  min={1}
                  value={campaignForm.rewardPoints}
                  onChange={(event) => setCampaignForm((prev) => ({ ...prev, rewardPoints: event.target.value }))}
                />
              </label>
              <label>
                Общий бюджет
                <input
                  type="number"
                  min={1}
                  value={campaignForm.totalBudget}
                  onChange={(event) => setCampaignForm((prev) => ({ ...prev, totalBudget: event.target.value }))}
                />
              </label>
              <p className="helper">Баллы спишутся с твоего баланса при создании кампании.</p>
              <div className="form-actions">
                <button className="primary" type="submit">Запустить кампанию</button>
              </div>
            </form>
          </div>

          <div className="panel-head">
            <div>
              <h2>Мои кампании</h2>
              <p>Статус и остаток бюджета.</p>
            </div>
          </div>
          <div className="offers">
            {myCampaigns.map((campaign) => (
              <article key={campaign.id} className="card offer">
                <div className="offer-head">
                  <div>
                    <h3>{campaign.group.title}</h3>
                    <p>Баллы: {campaign.rewardPoints} · Остаток: {campaign.remainingBudget}</p>
                  </div>
                  <span className={`pill ${campaign.status.toLowerCase()}`}>{campaignStatusLabels[campaign.status]}</span>
                </div>
                <p className="offer-note">Бюджет: {campaign.totalBudget} · Создано {new Date(campaign.createdAt).toLocaleDateString('ru-RU')}</p>
              </article>
            ))}
            {!myCampaigns.length && <p className="empty">Кампаний пока нет.</p>}
          </div>

          <div className="panel-head">
            <div>
              <h2>Входящие заявки</h2>
              <p>Подтверди вступления и начисли баллы.</p>
            </div>
          </div>
          <div className="offers">
            {incomingApplications.map((app) => (
              <article key={app.id} className="card offer">
                <div className="offer-head">
                  <div>
                    <h3>{app.campaign.group.title}</h3>
                    <p>Заявка от {app.applicant?.username ? `@${app.applicant.username}` : app.applicant?.firstName || 'пользователь'}</p>
                  </div>
                  <span className="pill pending">Ожидает</span>
                </div>
                <div className="offer-actions">
                  <button className="primary" type="button" onClick={() => handleApprove(app.id)}>Подтвердить</button>
                  <button className="ghost" type="button" onClick={() => handleReject(app.id)}>Отклонить</button>
                </div>
              </article>
            ))}
            {!incomingApplications.length && <p className="empty">Нет входящих заявок.</p>}
          </div>
        </section>
      )}

      {activeTab === 'applications' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Мои заявки</h2>
              <p>История вступлений и начисления баллов.</p>
            </div>
          </div>
          <div className="offers">
            {myApplications.map((app) => (
              <article key={app.id} className="card offer">
                <div className="offer-head">
                  <div>
                    <h3>{app.campaign.group.title}</h3>
                    <p>Создано: {new Date(app.createdAt).toLocaleDateString('ru-RU')}</p>
                  </div>
                  <span className={`pill ${app.status.toLowerCase()}`}>{statusLabels[app.status]}</span>
                </div>
                <p className="offer-note">Награда: {app.campaign.rewardPoints} баллов</p>
              </article>
            ))}
            {!myApplications.length && <p className="empty">Заявок пока нет.</p>}
          </div>
        </section>
      )}

      <footer className="footer">
        <p>Среда: {isTelegram() ? 'Telegram' : 'Браузер (preview)'}</p>
        <p>{message || `Группы: ${stats.groups} · Кампании: ${stats.campaigns} · Заявки: ${stats.applications}`}</p>
      </footer>
    </div>
  );
}
