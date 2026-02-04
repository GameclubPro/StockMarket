import { useEffect, useMemo, useState } from 'react';
import { verifyInitData } from './api';
import { getInitDataRaw, getUserLabel, getUserPhotoUrl, initTelegram } from './telegram';

export default function App() {
  const [userLabel, setUserLabel] = useState(() => getUserLabel());
  const [userPhoto, setUserPhoto] = useState(() => getUserPhotoUrl());
  const [points, setPoints] = useState(0);
  const [pointsToday] = useState(0);
  const [rating, setRating] = useState(0);
  const [activeTab, setActiveTab] = useState<'home' | 'promo' | 'tasks' | 'settings'>('home');
  const [tasksTab, setTasksTab] = useState<'all' | 'mine'>('all');
  const [taskFilter, setTaskFilter] = useState<'subscribe' | 'reaction'>('subscribe');
  const [myTasksTab, setMyTasksTab] = useState<'place' | 'mine' | 'spend'>('place');
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [taskLink, setTaskLink] = useState('');
  const [taskType, setTaskType] = useState<'subscribe' | 'reaction'>('subscribe');

  const tasks = [
    {
      id: 't1',
      title: 'Ищу работу Ростов',
      handle: '@work_rostov',
      points: 1,
      check: 'бот',
      type: 'subscribe' as const,
      initial: 'Р',
    },
    {
      id: 't2',
      title: 'Чат мастеров маникюра',
      handle: '@beauty_subchat',
      points: 1,
      check: 'бот',
      type: 'subscribe' as const,
      initial: 'Б',
    },
    {
      id: 't3',
      title: 'Сток Fix Price Ростов',
      handle: '@fixprice_rostov',
      points: 1,
      check: 'бот',
      type: 'subscribe' as const,
      initial: 'F',
    },
    {
      id: 't4',
      title: 'Фитнес-клуб Ростов',
      handle: '@fitness_rostov',
      points: 1,
      check: 'бот',
      type: 'reaction' as const,
      initial: 'Ф',
    },
  ];

  const myTasks = [
    {
      id: 'm1',
      title: 'Канал о фрилансе',
      handle: '@freelance_daily',
      points: 2,
      check: 'бот',
      type: 'subscribe' as const,
      initial: 'F',
    },
  ];

  const visibleTasks = tasks.filter((task) => task.type === taskFilter);

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
                  <div className="sub">Уровень: Alpha</div>
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
            <div className="page-title">Продвижение</div>
            <div className="section-card">
              <div className="section-title">Биржа продвижения</div>
              <div className="section-text">Здесь появятся кампании и доступные задания.</div>
            </div>
          </>
        )}

        {activeTab === 'tasks' && (
          <>
            <div className="segment">
              <button
                className={`segment-button ${tasksTab === 'all' ? 'active' : ''}`}
                type="button"
                onClick={() => setTasksTab('all')}
              >
                Задания
              </button>
              <button
                className={`segment-button ${tasksTab === 'mine' ? 'active' : ''}`}
                type="button"
                onClick={() => setTasksTab('mine')}
              >
                Мои задания
              </button>
            </div>

            {tasksTab === 'all' && (
              <>
                <div className="page-header">
                  <div className="page-title">Задания</div>
                  <button className="icon-button" type="button" aria-label="Обновить">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M21 12a9 9 0 11-2.6-6.4" />
                      <path d="M21 3v7h-7" />
                    </svg>
                  </button>
                </div>
                <div className="segment">
                  <button
                    className={`segment-button ${taskFilter === 'subscribe' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setTaskFilter('subscribe')}
                  >
                    Подписки
                  </button>
                  <button
                    className={`segment-button ${taskFilter === 'reaction' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setTaskFilter('reaction')}
                  >
                    Реакции
                  </button>
                </div>
                <div className="task-list">
                  {visibleTasks.map((task) => (
                    <div className="task-card" key={task.id}>
                      <div className="task-card-head">
                        <div className="task-avatar">
                          <span>{task.initial}</span>
                        </div>
                        <div className="task-info">
                          <div className="task-title">{task.title}</div>
                          <div className="task-handle">{task.handle}</div>
                        </div>
                        <div className="task-actions">
                          <button className="open-button" type="button">
                            Открыть
                          </button>
                        </div>
                      </div>
                      <div className="task-meta">
                        <span className="badge">+{task.points} балл</span>
                        <span className="muted">Проверка: {task.check}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {tasksTab === 'mine' && (
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
                <div className="segment wide">
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
                  <button
                    className={`segment-button ${myTasksTab === 'spend' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setMyTasksTab('spend')}
                  >
                    Потратить баллы
                  </button>
                </div>

                {myTasksTab === 'place' && (
                  <div className="task-form-card">
                    <div className="task-form-head">
                      <div>
                        <div className="task-form-title">Разместить задание</div>
                        <div className="task-form-sub">
                          Создайте задание, чтобы привлечь подписчиков.
                        </div>
                      </div>
                      <button className="icon-button" type="button" aria-label="Меню">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <circle cx="12" cy="5" r="1.6" />
                          <circle cx="12" cy="12" r="1.6" />
                          <circle cx="12" cy="19" r="1.6" />
                        </svg>
                      </button>
                    </div>

                    {showCreateTask ? (
                      <div className="task-form-body">
                        <label className="field">
                          <span>Ссылка</span>
                          <input
                            type="url"
                            placeholder="https://t.me/..."
                            value={taskLink}
                            onChange={(event) => setTaskLink(event.target.value)}
                          />
                        </label>
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
                      </div>
                    ) : (
                      <div className="task-form-placeholder">
                        Нажмите «Создать», чтобы открыть форму.
                      </div>
                    )}

                    <div className="task-form-actions">
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => setShowCreateTask((prev) => !prev)}
                      >
                        {showCreateTask ? 'Скрыть' : 'Создать'}
                      </button>
                      <div className="balance-pill">Баланс: {points}</div>
                    </div>
                  </div>
                )}

                {myTasksTab === 'mine' && (
                  <div className="task-list">
                    {myTasks.map((task) => (
                      <div className="task-card" key={task.id}>
                        <div className="task-card-head">
                          <div className="task-avatar">
                            <span>{task.initial}</span>
                          </div>
                          <div className="task-info">
                            <div className="task-title">{task.title}</div>
                            <div className="task-handle">{task.handle}</div>
                          </div>
                          <div className="task-actions">
                            <button className="open-button" type="button">
                              Открыть
                            </button>
                          </div>
                        </div>
                        <div className="task-meta">
                          <span className="badge">+{task.points} балл</span>
                          <span className="muted">Проверка: {task.check}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {myTasksTab === 'spend' && (
                  <div className="section-card">
                    <div className="section-title">Потратить баллы</div>
                    <div className="section-text">Раздел появится позже.</div>
                  </div>
                )}
              </>
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
