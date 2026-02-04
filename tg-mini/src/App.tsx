export default function App() {
  return (
    <div className="screen">
      <div className="status">
        <div>20:43</div>
        <div className="icons">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M7 17c5-5 7-7 10-10" />
            <path d="M7 7h10v10" />
          </svg>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="6" width="18" height="12" rx="2" />
            <path d="M7 10h4" />
          </svg>
          <div className="pill" />
        </div>
      </div>

      <div className="topbar">
        <button className="icon-btn" type="button" aria-label="Назад">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="title">Профиль</div>
        <button className="icon-btn" type="button" aria-label="Поиск">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </button>
      </div>

      <section className="profile-card">
        <div className="profile-head">
          <div className="avatar-ring">
            <div className="avatar">A</div>
          </div>
          <div>
            <div className="user-name">@QwertyuiooopSd</div>
            <div className="sub">Уровень: Alpha</div>
            <div className="stats">
              <div className="stat divider">
                <div className="stat-main">
                  <span className="accent">+ 823</span>
                  <span>OP</span>
                </div>
                <div className="stat-title">+122 сегодня</div>
              </div>
              <div className="stat">
                <div className="stat-main">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path
                      d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.3L12 17.8 6.4 20.3l1.1-6.3L3 9.6l6.2-.9L12 3z"
                      stroke="currentColor"
                    />
                  </svg>
                  <span className="gold">4.8</span>
                </div>
                <div className="stat-title">Рейтинг 4.8</div>
              </div>
            </div>
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
            <div className="label">Биржа взаимной подписки</div>
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

      <div className="bottom-nav">
        <div className="nav-item active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 11l9-7 9 7" />
            <path d="M5 10v9h5v-5h4v5h5v-9" />
          </svg>
          <span>Главная</span>
        </div>
        <div className="nav-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M12 20s-7-4.6-7-10a4 4 0 017-2 4 4 0 017 2c0 5.4-7 10-7 10z" />
          </svg>
          <span>Взаимка</span>
        </div>
        <div className="nav-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="4" y="5" width="16" height="14" rx="2" />
            <path d="M8 9h8M8 13h6" />
          </svg>
          <span>Задания</span>
        </div>
        <div className="nav-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="3.5" />
            <path d="M19 12a7 7 0 00-.1-1l2.1-1.6-2-3.4-2.4.9a7 7 0 00-1.7-1l-.3-2.6H9.4l-.3 2.6a7 7 0 00-1.7 1l-2.4-.9-2 3.4L5.1 11a7 7 0 000 2l-2.1 1.6 2 3.4 2.4-.9a7 7 0 001.7 1l.3 2.6h4.2l.3-2.6a7 7 0 001.7-1l2.4.9 2-3.4L18.9 13a7 7 0 00.1-1z" />
          </svg>
          <span>Настройки</span>
        </div>
      </div>
    </div>
  );
}
