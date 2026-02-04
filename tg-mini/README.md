# Telegram Mini App — Биржа продвижения

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
- Если API на другом домене, задай `VITE_API_BASE` (например `https://api.play-team.ru`).
