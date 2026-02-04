# Telegram Mini App — Биржа взаимной подписки

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
1. Скопировать сборку:
```
rsync -a --delete dist/ root@cv5335909:/var/www/www-root/data/www/tg.play-team.ru/
```
2. Проверить, что в nginx для домена есть `try_files $uri $uri/ /index.html;`.

## Telegram Mini App
- Нужно HTTPS и валидный SSL.
- В проде указывать URL `https://tg.play-team.ru/`.
