import { useEffect, useState } from 'react';
import { getUserLabel, initTelegram, isTelegram } from './telegram';

type Offer = {
  id: string;
  author: string;
  platform: 'Telegram' | 'YouTube' | 'TikTok' | 'Instagram' | 'X';
  action: 'Подписка' | 'Подписка + лайк' | 'Лайк + комментарий';
  ratio: '1:1' | '1:2' | '2:1';
  note: string;
  rating: number;
  status: 'new' | 'hot' | 'verified';
  time: string;
};

type TabId = 'market' | 'create' | 'profile';

type OfferForm = {
  platform: Offer['platform'];
  action: Offer['action'];
  ratio: Offer['ratio'];
  link: string;
  note: string;
};

const initialOffers: Offer[] = [
  {
    id: 'of-001',
    author: 'play.team',
    platform: 'Telegram',
    action: 'Подписка',
    ratio: '1:1',
    note: 'Взаимный рост каналов. Тематика: игры, киберспорт, гаджеты. Ответ в течение 24ч.',
    rating: 4.9,
    status: 'verified',
    time: '5 мин назад',
  },
  {
    id: 'of-002',
    author: 'zen.market',
    platform: 'YouTube',
    action: 'Подписка + лайк',
    ratio: '1:2',
    note: 'Подписка + лайк на последний ролик. Взаимный обмен по расписанию.',
    rating: 4.6,
    status: 'hot',
    time: '12 мин назад',
  },
  {
    id: 'of-003',
    author: 'visual.labs',
    platform: 'Instagram',
    action: 'Лайк + комментарий',
    ratio: '1:1',
    note: 'Фокус на фото/дизайн. Комментарий от 4 слов, без спама.',
    rating: 4.8,
    status: 'new',
    time: '28 мин назад',
  },
];

const defaultForm: OfferForm = {
  platform: 'Telegram',
  action: 'Подписка',
  ratio: '1:1',
  link: '',
  note: '',
};

const tabs: Array<{ id: TabId; label: string; hint: string }> = [
  { id: 'market', label: 'Лента', hint: 'Все офферы' },
  { id: 'create', label: 'Создать', hint: 'Новый обмен' },
  { id: 'profile', label: 'Профиль', hint: 'Статистика' },
];

const statusLabels: Record<Offer['status'], string> = {
  new: 'Новый',
  hot: 'Горячий',
  verified: 'Проверен',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('market');
  const [offers, setOffers] = useState<Offer[]>(initialOffers);
  const [form, setForm] = useState<OfferForm>(defaultForm);
  const [filter, setFilter] = useState<'Все' | Offer['platform']>('Все');

  const [userLabel, setUserLabel] = useState(() => getUserLabel());

  useEffect(() => {
    initTelegram();
    setUserLabel(getUserLabel());
  }, []);

  const visibleOffers = offers.filter((offer) => (filter === 'Все' ? true : offer.platform === filter));

  const handleCreate = () => {
    if (!form.link.trim()) return;
    const next: Offer = {
      id: `of-${Date.now()}`,
      author: userLabel || 'Вы',
      platform: form.platform,
      action: form.action,
      ratio: form.ratio,
      note: form.note || 'Без дополнительных условий.',
      rating: 5.0,
      status: 'new',
      time: 'только что',
    };
    setOffers((prev) => [next, ...prev]);
    setForm(defaultForm);
    setActiveTab('market');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Mini App · Биржа подписок</p>
          <h1>Биржа взаимной подписки</h1>
          <p className="subhead">Честный обмен подписками с репутацией и безопасными правилами.</p>
        </div>
        <div className="chip">Онлайн · {new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
      </header>

      <section className="stats">
        <div className="stat">
          <p>Офферов</p>
          <strong>{offers.length}</strong>
          <span>+12% за сутки</span>
        </div>
        <div className="stat">
          <p>Сделок</p>
          <strong>1 284</strong>
          <span>Рейтинг 4.8</span>
        </div>
        <div className="stat">
          <p>Ваш статус</p>
          <strong>{userLabel}</strong>
          <span>Уровень: Alpha</span>
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
              <p>Выбирай обмен по интересам и репутации.</p>
            </div>
            <div className="filters">
              {(['Все', 'Telegram', 'YouTube', 'TikTok', 'Instagram', 'X'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={filter === item ? 'filter active' : 'filter'}
                  onClick={() => setFilter(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="offers">
            {visibleOffers.map((offer) => (
              <article key={offer.id} className="card offer">
                <div className="offer-head">
                  <div>
                    <h3>{offer.action} · {offer.ratio}</h3>
                    <p>{offer.platform} · {offer.time}</p>
                  </div>
                  <span className={`pill ${offer.status}`}>{statusLabels[offer.status]}</span>
                </div>
                <p className="offer-note">{offer.note}</p>
                <div className="offer-meta">
                  <span>Автор: {offer.author}</span>
                  <span>Рейтинг: {offer.rating.toFixed(1)}</span>
                </div>
                <div className="offer-actions">
                  <button className="primary" type="button">Откликнуться</button>
                  <button className="ghost" type="button">Смотреть профиль</button>
                </div>
              </article>
            ))}
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
                {(['Telegram', 'YouTube', 'TikTok', 'Instagram', 'X'] as const).map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Действие
              <select
                value={form.action}
                onChange={(event) => setForm((prev) => ({ ...prev, action: event.target.value as Offer['action'] }))}
              >
                {(['Подписка', 'Подписка + лайк', 'Лайк + комментарий'] as const).map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Обмен
              <select
                value={form.ratio}
                onChange={(event) => setForm((prev) => ({ ...prev, ratio: event.target.value as Offer['ratio'] }))}
              >
                {(['1:1', '1:2', '2:1'] as const).map((item) => (
                  <option key={item} value={item}>{item}</option>
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

      {activeTab === 'profile' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Ваш профиль</h2>
              <p>Текущие сделки, рейтинг и лимиты.</p>
            </div>
          </div>
          <div className="profile-grid">
            <article className="card">
              <h3>Репутация</h3>
              <p className="big">4.8</p>
              <span>Выше среднего по рынку</span>
            </article>
            <article className="card">
              <h3>Активные сделки</h3>
              <p className="big">6</p>
              <span>Скорость ответа 2ч</span>
            </article>
            <article className="card">
              <h3>Лимит публикаций</h3>
              <p className="big">12/20</p>
              <span>Обновится через 3ч</span>
            </article>
          </div>

          <div className="panel-head">
            <div>
              <h2>Мои офферы</h2>
              <p>Управляй размещениями и их статусом.</p>
            </div>
          </div>
          <div className="offers">
            {offers.slice(0, 2).map((offer) => (
              <article key={offer.id} className="card offer">
                <div className="offer-head">
                  <div>
                    <h3>{offer.action} · {offer.ratio}</h3>
                    <p>{offer.platform} · {offer.time}</p>
                  </div>
                  <span className={`pill ${offer.status}`}>{statusLabels[offer.status]}</span>
                </div>
                <p className="offer-note">{offer.note}</p>
                <div className="offer-actions">
                  <button className="ghost" type="button">Редактировать</button>
                  <button className="danger" type="button">Снять</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <footer className="footer">
        <p>Мини‑апп подключён: {isTelegram() ? 'Telegram' : 'Браузер (preview)'}</p>
        <p>Поддержка: @play_team</p>
      </footer>
    </div>
  );
}
