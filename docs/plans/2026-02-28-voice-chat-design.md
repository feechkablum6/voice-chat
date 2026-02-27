# Voice Chat App — Design Document

## Summary

Self-hosted голосовой чат на 5 человек с веб-интерфейсом в стиле Discord. Запускается на локальном ПК, доступ по ссылке без авторизации.

## Requirements

- Голосовая связь до 5 человек в комнате
- Несколько комнат (как каналы в Discord)
- Без авторизации — ввод имени и вход
- Тёмная тема а-ля Discord
- Self-hosted, один процесс Node.js

## Architecture

WebRTC Mesh + Node.js сигнальный сервер.

- **Сервер:** Express (статика) + ws (WebSocket для сигналинга)
- **Клиент:** Vanilla HTML/CSS/JS, WebRTC API браузера
- Аудио идёт напрямую между браузерами (peer-to-peer)
- Сервер только координирует подключения (SDP/ICE обмен) и управляет комнатами

## File Structure

```
discord/
├── server.js           # Node.js сервер (Express + WS)
├── package.json
└── public/
    ├── index.html       # Основная страница
    ├── style.css        # Стили (тёмная тема)
    └── app.js           # Клиентская логика (WebRTC + WS)
```

## UI Screens

### Lobby
- Поле ввода имени
- Список комнат с участниками и счётчиком (макс 5)
- Кнопка создания новой комнаты

### Room
- Список участников с аватарками (первая буква имени)
- Индикатор говорящего (подсветка при голосе)
- Кнопки: mute микрофона, выйти в лобби
- Боковая панель с комнатами

## Signaling Protocol (WebSocket JSON)

- `join {room, username}` — зайти в комнату
- `leave` — выйти
- `offer {to, sdp}` — WebRTC offer
- `answer {to, sdp}` — WebRTC answer
- `ice-candidate {to, candidate}` — ICE кандидат
- `room-update {rooms}` — обновление списка комнат/участников
- `create-room {name}` — создать комнату

## Error Handling

- Микрофон недоступен — уведомление, можно слушать без микрофона
- WebRTC-соединение падает — автоматический реконнект
- WebSocket рвётся — переподключение с экспоненциальным backoff
- Комната полна (5/5) — сервер отклоняет join, клиент показывает сообщение

## Tech Stack

- Node.js + Express + ws
- Vanilla HTML/CSS/JS (без фреймворков)
- WebRTC API (встроенный в браузер)
- CSS custom properties для тёмной темы
