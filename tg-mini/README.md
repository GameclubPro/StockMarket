# Telegram Mini App — Биржа Аудитории

## Быстрый старт
1. Установить зависимости:
```
npm install
```
2. Локальный запуск:
```
npm run dev
```
3. Сборка:
```
npm run build
```

## Деплой на VPS
1. Собрать:
```
npm run build
```
2. Убедиться, что nginx раздаёт `dist` и есть `try_files $uri $uri/ /index.html;`.

## Telegram + VK Mini Apps
- Нужно HTTPS и валидный SSL.
- Один и тот же фронт можно отдавать и в Telegram, и в VK Mini Apps.
- Для Telegram в проде указывать URL `https://tg.play-team.ru/`.
- Для VK в адресе запуска должны приходить `vk_user_id` и `sign` (launch params).
- `VK_APP_SECRET` можно не задавать (вход VK будет работать без проверки подписи).
- Для продакшена рекомендуется задать `VK_APP_SECRET`, чтобы включить проверку подписи VK.

### Импорт VK-сообществ: обязательные условия
1. Фронт должен быть собран с `VITE_VK_APP_ID=54453849`.
2. Запуск должен быть внутри VK mini app (`https://vk.com/app54453849`) в авторизованной VK-сессии.
3. Для импорта нужен доступ к группам: при запросе токена подтвердите разрешение.
4. Если доступ ранее отклоняли:
   - удалите разрешения приложения в настройках VK;
   - откройте mini app заново;
   - повторите импорт и подтвердите доступ.

## API
- По умолчанию фронт ждёт backend на том же домене через `/api`.
- Если API на другом домене, задай `VITE_API_URL` (или `VITE_API_BASE`), например `https://api.play-team.ru`.

## Визуальное сканирование и скриншоты (mobile fullscreen)
1. Установить Chromium для Playwright (один раз):
```
npm run playwright:install
```
2. Снять скриншоты экранов (`home`, `promo`, `tasks`, `settings`, `wheel`, `referrals`) в нужном размере:
```
npm run screenshot:design-redesign -- --width 360 --height 780 --outDir .logs/design-baseline-360
npm run screenshot:design-redesign -- --width 390 --height 844 --outDir .logs/design-baseline-390
npm run screenshot:design-redesign -- --width 430 --height 932 --outDir .logs/design-baseline-430
```
3. Запустить автоматический mobile-аудит (горизонтальный overflow + тач-таргеты):
```
npm run scan:mobile-ui -- --width 390 --height 844 --outFile .logs/mobile-scan-390.json
```
4. Сравнить baseline/after через pixel-diff:
```
npm run compare:design-redesign -- --width 360 --height 780 --baselineDir .logs/design-baseline-360 --afterDir .logs/design-after-360 --diffDir .logs/design-diff-360 --outFile .logs/design-compare-360.json
npm run compare:design-redesign -- --width 390 --height 844 --baselineDir .logs/design-baseline-390 --afterDir .logs/design-after-390 --diffDir .logs/design-diff-390 --outFile .logs/design-compare-390.json
npm run compare:design-redesign -- --width 430 --height 932 --baselineDir .logs/design-baseline-430 --afterDir .logs/design-after-430 --diffDir .logs/design-diff-430 --outFile .logs/design-compare-430.json
```

Примечания:
- По умолчанию скрипты сами поднимают локальный `vite` и используют Telegram/API моки для стабильных кадров.
- Если хотите прогонять против уже работающего окружения, добавьте `--baseUrl http://127.0.0.1:5173 --noMockApi`.
- Для `scan` можно задать нижнюю зону риска safe-area: `--safeBottomPx 16`.
- Для `compare` можно управлять порогом расхождения в процентах: `--mismatchThresholdPct 0.25`.

## Актуальный эмулятор Telegram Mini App (fullscreen, 2026)
Запуск интерактивного эмулятора:
```
npm run emulator:miniapp
```

Запуск с явной фиксацией `fullscreen` (рекомендуется):
```
npm run emulator:tg-2026-fullscreen
```

Сразу открыть экран `Продвижение` в `fullscreen`:
```
npm run emulator:tg-2026-fullscreen:promo
```

Что есть в эмуляторе:
- Реальный fullscreen-профиль Telegram Mini App по умолчанию (fullscreen lock, не fullsize).
- Профили устройств 2026: `android-2026` и `ios-2026` (`--tgProfile`).
- Живые `viewport/safe-area/fullscreen` события + bridge-совместимость (`TelegramWebviewProxy`, `window.external.notify`, `receiveEvent`).
- Ошибки fullscreen по спецификации Telegram: `UNSUPPORTED`, `ALREADY_FULLSCREEN`, `ALREADY_EXITED_FULLSCREEN`.
- Обновляемый Telegram chrome c системной строкой и fullscreen-контролами.
- Overlay-панель с текущими метриками viewport/safe-area и быстрыми действиями (`Fullscreen`, `MainButton`).

Полезные опции:
```
npm run emulator:miniapp -- --openScreen home
npm run emulator:miniapp -- --headless --noEmulatorOverlay
npm run emulator:miniapp -- --allowNonFullscreen --tgMode compact
npm run emulator:miniapp -- --tgProfile ios-2026 --tgPlatform ios
npm run emulator:miniapp -- --tgStatusBarPx 30 --tgFullscreenControlsPx 46
npm run emulator:miniapp -- --tgStatusBarPx 24 --tgFullscreenControlsPx 38   # Android fullscreen match
```
