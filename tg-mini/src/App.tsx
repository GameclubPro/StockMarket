import { useEffect, useMemo, useState } from 'react';
import { createOffer, fetchOffers, fetchTasks, respondToOffer, verifyInitData } from './api';
import { getInitDataRaw, getUserLabel, initTelegram, isTelegram } from './telegram';

type Offer = {
  id: string;
  platform: 'TELEGRAM' | 'YOUTUBE' | 'TIKTOK' | 'INSTAGRAM' | 'X';
  action: 'SUBSCRIBE' | 'SUBSCRIBE_LIKE' | 'LIKE_COMMENT';
  ratio: 'ONE_ONE' | 'ONE_TWO' | 'TWO_ONE';
  link: string;
  note: string;
  createdAt: string;
  user?: {
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
};

type Task = {
  id: string;
  slug: string;
  title: string;
  description: string;
  points: number;
  completed: boolean;
};

type TabId = 'market' | 'create' | 'tasks';

type OfferForm = {
  platform: Offer['platform'];
  action: Offer['action'];
  ratio: Offer['ratio'];
  link: string;
  note: string;
};

const defaultForm: OfferForm = {
  platform: 'TELEGRAM',
  action: 'SUBSCRIBE',
  ratio: 'ONE_ONE',
  link: '',
  note: '',
};

const tabs: Array<{ id: TabId; label: string; hint: string }> = [
  { id: 'market', label: 'Биржа', hint: 'Предложения' },
  { id: 'create', label: 'Создать', hint: 'Новый оффер' },
  { id: 'tasks', label: 'Задания', hint: 'Баллы' },
];

const platformLabels: Record<Offer['platform'], string> = {
  TELEGRAM: 'Telegram',
  YOUTUBE: 'YouTube',
  TIKTOK: 'TikTok',
  INSTAGRAM: 'Instagram',
  X: 'X',
};

const actionLabels: Record<Offer['action'], string> = {
  SUBSCRIBE: 'Подписка',
  SUBSCRIBE_LIKE: 'Подписка + лайк',
  LIKE_COMMENT: 'Лайк + комментарий',
};

const ratioLabels: Record<Offer['ratio'], string> = {
  ONE_ONE: '1:1',
  ONE_TWO: '1:2',
  TWO_ONE: '2:1',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('market');
  const [offers, setOffers] = useState<Offer[]>([]);
  const [form, setForm] = useState<OfferForm>(defaultForm);
  const [filter, setFilter] = useState<'Все' | Offer['platform']>('Все');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [points, setPoints] = useState(0);
  const [message, setMessage] = useState('');
  const [authState, setAuthState] = useState<'idle' | 'verifying' | 'ok' | 'error'>('idle');

  const [userLabel, setUserLabel] = useState(() => getUserLabel());

  const level = useMemo(() => Math.max(1, Math.floor(points / 500) + 1), [points]);
  const nextLevelAt = level * 500;
  const progress = Math.min(100, Math.round((points / nextLevelAt) * 100));

  const loadOffers = async (platform?: Offer['platform']) => {
    try {
      const data = await fetchOffers(platform);
      setOffers(data.offers ?? []);
    } catch {
      setMessage('Не удалось загрузить офферы.');
    }
  };

  const loadTasks = async () => {
    try {
      const data = await fetchTasks();
      setTasks(data.tasks ?? []);
      setPoints(data.points ?? 0);
    } catch {
      setMessage('Не удалось загрузить задания.');
    }
  };

  useEffect(() => {
    initTelegram();
    setUserLabel(getUserLabel());

    const initDataRaw = getInitDataRaw();
    if (!initDataRaw) return;

    setAuthState('verifying');
    verifyInitData(initDataRaw)
      .then(() => {
        setAuthState('ok');
        loadTasks();
      })
      .catch(() => setAuthState('error'));
  }, []);

  useEffect(() => {
    loadOffers();
  }, []);

  const visibleOffers = offers.filter((offer) => (filter === 'Все' ? true : offer.platform === filter));

  const handleCreate = async () => {
    if (!form.link.trim()) return;
    try {
      await createOffer({
        platform: form.platform,
        action: form.action,
        ratio: form.ratio,
        link: form.link.trim(),
        note: form.note.trim(),
      });
      setForm(defaultForm);
      setActiveTab('market');
      await loadOffers(filter === 'Все' ? undefined : filter);
      await loadTasks();
      setMessage('Оффер опубликован.');
    } catch {
      setMessage('Не удалось создать оффер.');
    }
  };

  const handleRespond = async (id: string) => {
    try {
      await respondToOffer(id);
      await loadTasks();
      setMessage('Отклик отправлен.');
    } catch {
      setMessage('Не удалось откликнуться.');
    }
  };

  const taskCta = (task: Task) => {
    if (task.completed) return null;
    if (task.slug === 'first_offer') return { label: 'Создать', tab: 'create' as const };
    if (task.slug === 'first_response') return { label: 'Перейти', tab: 'market' as const };
    return null;
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Mini App · Биржа подписок</p>
          <h1>Биржа взаимных подписок</h1>
          <p className="subhead">Живые офферы, задания и баллы за активность.</p>
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
          <p>Баллы</p>
          <strong>{points}</strong>
          <span>Уровень {level}</span>
        </div>
        <div className="stat">
          <p>До следующего уровня</p>
          <strong>{Math.max(0, nextLevelAt - points)}</strong>
          <span>Прогресс {progress}%</span>
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
              <h2>Свежие предложения</h2>
              <p>Реальные офферы из базы данных.</p>
            </div>
            <div className="filters">
              {(['Все', 'TELEGRAM', 'YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'X'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={filter === item ? 'filter active' : 'filter'}
                  onClick={() => {
                    setFilter(item);
                    if (item === 'Все') loadOffers();
                    else loadOffers(item);
                  }}
                >
                  {item === 'Все' ? 'Все' : platformLabels[item]}
                </button>
              ))}
            </div>
          </div>

          <div className="offers">
            {visibleOffers.map((offer) => (
              <article key={offer.id} className="card offer">
                <div className="offer-head">
                  <div>
                    <h3>{actionLabels[offer.action]} · {ratioLabels[offer.ratio]}</h3>
                    <p>{platformLabels[offer.platform]} · {new Date(offer.createdAt).toLocaleString('ru-RU')}</p>
                  </div>
                </div>
                <p className="offer-note">{offer.note}</p>
                <div className="offer-meta">
                  <span>Автор: {offer.user?.username ? `@${offer.user.username}` : offer.user?.firstName ?? '—'}</span>
                  <a href={offer.link} target="_blank" rel="noreferrer">Ссылка</a>
                </div>
                <div className="offer-actions">
                  <button className="primary" type="button" onClick={() => handleRespond(offer.id)}>
                    Откликнуться
                  </button>
                </div>
              </article>
            ))}
            {!visibleOffers.length && <p className="empty">Пока нет офферов. Создай первый.</p>}
          </div>
        </section>
      )}

      {activeTab === 'create' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Создать оффер</h2>
              <p>Собери условия обмена, которые устроят обе стороны.</p>
            </div>
          </div>
          <form
            className="card form"
            onSubmit={(event) => {
              event.preventDefault();
              handleCreate();
            }}
          >
            <label>
              Платформа
              <select
                value={form.platform}
                onChange={(event) => setForm((prev) => ({ ...prev, platform: event.target.value as Offer['platform'] }))}
              >
                {(['TELEGRAM', 'YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'X'] as const).map((item) => (
                  <option key={item} value={item}>{platformLabels[item]}</option>
                ))}
              </select>
            </label>
            <label>
              Действие
              <select
                value={form.action}
                onChange={(event) => setForm((prev) => ({ ...prev, action: event.target.value as Offer['action'] }))}
              >
                {(['SUBSCRIBE', 'SUBSCRIBE_LIKE', 'LIKE_COMMENT'] as const).map((item) => (
                  <option key={item} value={item}>{actionLabels[item]}</option>
                ))}
              </select>
            </label>
            <label>
              Обмен
              <select
                value={form.ratio}
                onChange={(event) => setForm((prev) => ({ ...prev, ratio: event.target.value as Offer['ratio'] }))}
              >
                {(['ONE_ONE', 'ONE_TWO', 'TWO_ONE'] as const).map((item) => (
                  <option key={item} value={item}>{ratioLabels[item]}</option>
                ))}
              </select>
            </label>
            <label>
              Ссылка на профиль
              <input
                type="url"
                placeholder="https://t.me/your_channel"
                value={form.link}
                onChange={(event) => setForm((prev) => ({ ...prev, link: event.target.value }))}
                required
              />
            </label>
            <label className="full">
              Комментарий
              <textarea
                rows={4}
                placeholder="Укажи условия, сроки и формат взаимного обмена."
                value={form.note}
                onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
              />
            </label>
            <div className="form-actions">
              <button className="primary" type="submit">Разместить</button>
              <button className="ghost" type="button" onClick={() => setForm(defaultForm)}>Очистить</button>
            </div>
          </form>
        </section>
      )}

      {activeTab === 'tasks' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Задания</h2>
              <p>Выполняй действия и получай баллы.</p>
            </div>
          </div>
          <div className="offers">
            {tasks.map((task) => (
              <article key={task.id} className="card offer">
                <div className="offer-head">
                  <div>
                    <h3>{task.title}</h3>
                    <p>{task.description}</p>
                  </div>
                  <span className="pill verified">+{task.points}</span>
                </div>
                <div className="offer-actions">
                  {task.completed ? (
                    <button className="ghost" type="button" disabled>Готово</button>
                  ) : (
                    (() => {
                      const cta = taskCta(task);
                      if (!cta) return null;
                      return (
                        <button
                          className="primary"
                          type="button"
                          onClick={() => setActiveTab(cta.tab)}
                        >
                          {cta.label}
                        </button>
                      );
                    })()
                  )}
                </div>
              </article>
            ))}
            {!tasks.length && <p className="empty">Нет доступных заданий.</p>}
          </div>
        </section>
      )}

      <footer className="footer">
        <p>Среда: {isTelegram() ? 'Telegram' : 'Браузер (preview)'}</p>
        <p>{message || 'Готово к работе'}</p>
      </footer>
    </div>
  );
}
