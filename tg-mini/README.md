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

## Telegram Mini App
- Нужно HTTPS и валидный SSL.
- В проде указывать URL `https://tg.play-team.ru/`.

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
- Живые `viewport/safe-area/fullscreen` события и обновляемый Telegram chrome.
- Overlay-панель с текущими метриками viewport/safe-area и быстрыми действиями (`Fullscreen`, `MainButton`).

Полезные опции:
```
npm run emulator:miniapp -- --openScreen home
npm run emulator:miniapp -- --headless --noEmulatorOverlay
npm run emulator:miniapp -- --allowNonFullscreen --tgMode compact
```
