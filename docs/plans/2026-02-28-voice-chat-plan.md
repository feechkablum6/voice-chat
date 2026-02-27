# Voice Chat App — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Self-hosted голосовой чат с комнатами на 5 человек, WebRTC mesh + Node.js сигнальный сервер.

**Architecture:** Node.js сервер раздаёт статику через Express и координирует WebRTC-подключения через WebSocket (ws). Клиенты устанавливают прямые peer-to-peer аудиосоединения через WebRTC. Комнаты хранятся в памяти сервера.

**Tech Stack:** Node.js, Express, ws (WebSocket), Vanilla HTML/CSS/JS, WebRTC API

---

### Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `server.js` (заглушка)
- Create: `public/index.html` (заглушка)

**Step 1: Инициализировать проект**

```bash
cd /home/akashi/projects/discord
pnpm init
```

**Step 2: Установить зависимости**

```bash
pnpm add express ws
```

**Step 3: Создать минимальный сервер**

```javascript
// server.js
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

**Step 4: Создать заглушку HTML**

```html
<!-- public/index.html -->
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Chat</title>
</head>
<body>
  <h1>Voice Chat</h1>
</body>
</html>
```

**Step 5: Проверить что сервер запускается**

Run: `node server.js &` затем `curl -s http://localhost:3000 | head -5`
Expected: HTML-ответ с "Voice Chat"
Затем: убить процесс

**Step 6: Добавить start script в package.json**

В `package.json` секция scripts:
```json
"scripts": {
  "start": "node server.js"
}
```

**Step 7: Инициализировать git и коммит**

```bash
git init
echo "node_modules/" > .gitignore
git add package.json pnpm-lock.yaml server.js public/index.html .gitignore
git commit -m "init: project setup with Express server"
```

---

### Task 2: WebSocket Signaling Server

**Files:**
- Modify: `server.js`

**Step 1: Добавить WebSocket сервер и хранилище комнат**

Добавить в `server.js` после создания HTTP сервера:

```javascript
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ server });

// State
const rooms = new Map(); // roomName -> Map(id -> {ws, username})
let nextId = 1;

// Default room
rooms.set('General', new Map());

function broadcastRoomUpdate() {
  const roomList = [];
  for (const [name, members] of rooms) {
    roomList.push({
      name,
      users: Array.from(members.values()).map(m => ({ id: m.id, username: m.username })),
      count: members.size,
    });
  }
  const msg = JSON.stringify({ type: 'room-update', rooms: roomList });
  for (const [, members] of rooms) {
    for (const [, member] of members) {
      member.ws.send(msg);
    }
  }
  // Also send to unjoined clients
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  const id = nextId++;
  let currentRoom = null;
  let username = null;

  // Send initial room list
  const roomList = [];
  for (const [name, members] of rooms) {
    roomList.push({
      name,
      users: Array.from(members.values()).map(m => ({ id: m.id, username: m.username })),
      count: members.size,
    });
  }
  ws.send(JSON.stringify({ type: 'room-update', rooms: roomList }));
  ws.send(JSON.stringify({ type: 'your-id', id }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create-room': {
        const name = msg.name?.trim();
        if (!name || rooms.has(name)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room exists or invalid name' }));
          return;
        }
        rooms.set(name, new Map());
        broadcastRoomUpdate();
        break;
      }

      case 'join': {
        const room = rooms.get(msg.room);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        if (room.size >= 5) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full (5/5)' }));
          return;
        }

        // Leave current room first
        if (currentRoom) {
          const oldRoom = rooms.get(currentRoom);
          if (oldRoom) {
            oldRoom.delete(id);
            // Notify others in old room
            for (const [memberId, member] of oldRoom) {
              member.ws.send(JSON.stringify({ type: 'peer-left', id }));
            }
          }
        }

        username = msg.username;
        currentRoom = msg.room;
        room.set(id, { ws, id, username });

        // Tell new user about existing peers
        const existingPeers = [];
        for (const [memberId, member] of room) {
          if (memberId !== id) {
            existingPeers.push({ id: memberId, username: member.username });
          }
        }
        ws.send(JSON.stringify({ type: 'joined', room: currentRoom, peers: existingPeers }));

        // Tell existing peers about new user
        for (const [memberId, member] of room) {
          if (memberId !== id) {
            member.ws.send(JSON.stringify({ type: 'peer-joined', id, username }));
          }
        }

        broadcastRoomUpdate();
        break;
      }

      case 'leave': {
        if (currentRoom) {
          const room = rooms.get(currentRoom);
          if (room) {
            room.delete(id);
            for (const [, member] of room) {
              member.ws.send(JSON.stringify({ type: 'peer-left', id }));
            }
          }
          currentRoom = null;
          broadcastRoomUpdate();
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        // Forward to target peer
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const target = room.get(msg.to);
        if (target) {
          target.ws.send(JSON.stringify({ ...msg, from: id }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.delete(id);
        for (const [, member] of room) {
          member.ws.send(JSON.stringify({ type: 'peer-left', id }));
        }
      }
      broadcastRoomUpdate();
    }
  });
});
```

**Step 2: Проверить что сервер запускается без ошибок**

Run: `node -c server.js` (syntax check)
Expected: No errors

**Step 3: Коммит**

```bash
git add server.js
git commit -m "feat: add WebSocket signaling server with room management"
```

---

### Task 3: HTML Layout

**Files:**
- Rewrite: `public/index.html`

**Step 1: Написать полный HTML**

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Chat</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <!-- Lobby Screen -->
  <div id="lobby" class="screen active">
    <div class="lobby-container">
      <h1 class="logo">Voice Chat</h1>
      <div class="join-form">
        <input type="text" id="username-input" placeholder="Твоё имя..." maxlength="20" autocomplete="off">
      </div>
      <div class="rooms-section">
        <div class="rooms-header">
          <h2>Комнаты</h2>
          <button id="create-room-btn" class="btn-icon" title="Создать комнату">+</button>
        </div>
        <div id="room-list" class="room-list"></div>
      </div>
    </div>
  </div>

  <!-- Room Screen -->
  <div id="room" class="screen">
    <div class="room-layout">
      <!-- Sidebar -->
      <div class="sidebar">
        <h1 class="logo-small">Voice Chat</h1>
        <div class="sidebar-rooms" id="sidebar-room-list"></div>
      </div>

      <!-- Main area -->
      <div class="main-area">
        <div class="room-header">
          <span class="room-icon">🔊</span>
          <h2 id="room-name"></h2>
          <span id="room-count" class="room-count"></span>
        </div>
        <div id="participants" class="participants"></div>
        <div class="controls">
          <button id="mute-btn" class="control-btn" title="Mute/Unmute">
            <svg id="mic-icon" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            <svg id="mic-off-icon" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="display:none">
              <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
            </svg>
          </button>
          <button id="leave-btn" class="control-btn leave" title="Отключиться">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Create Room Modal -->
  <div id="create-room-modal" class="modal">
    <div class="modal-content">
      <h3>Новая комната</h3>
      <input type="text" id="room-name-input" placeholder="Название комнаты..." maxlength="30" autocomplete="off">
      <div class="modal-actions">
        <button id="modal-cancel" class="btn secondary">Отмена</button>
        <button id="modal-create" class="btn primary">Создать</button>
      </div>
    </div>
  </div>

  <!-- Error Toast -->
  <div id="toast" class="toast"></div>

  <script src="app.js"></script>
</body>
</html>
```

**Step 2: Коммит**

```bash
git add public/index.html
git commit -m "feat: add HTML layout with lobby, room, and modal screens"
```

---

### Task 4: CSS Styling (Dark Theme)

**Files:**
- Create: `public/style.css`

**Step 1: Написать полный CSS**

Тёмная тема в стиле Discord. Цветовая палитра: `#1e1f22` (фон), `#2b2d31` (карточки), `#313338` (поверхности), `#5865f2` (акцент/blurple), `#b5bac1` (текст), `#f2f3f5` (яркий текст). Шрифт — system-ui.

CSS файл должен содержать:
- CSS custom properties для цветов
- Reset базовый
- Стили для `.screen`, `.active` (переключение экранов)
- Lobby: центрированный контейнер, карточки комнат с hover-эффектом
- Room: layout с sidebar (200px) + main area
- Participants: grid из круглых аватарок с буквой имени, пульсирующая обводка при говорении (`.speaking`)
- Controls: панель внизу с круглыми кнопками, красная для disconnect
- Modal: overlay + центрированное окно
- Toast: фиксированная позиция внизу, анимация появления
- Адаптивность для мобильных (sidebar скрыт)

**Step 2: Коммит**

```bash
git add public/style.css
git commit -m "feat: add dark theme CSS styling"
```

---

### Task 5: Client-Side JavaScript — WebSocket + Room Logic

**Files:**
- Create: `public/app.js`

**Step 1: Написать WebSocket-подключение и управление комнатами**

Модуль `app.js` — всё в одном файле. Структура:

1. **DOM-элементы** — получить все нужные элементы по id
2. **State** — `myId`, `username`, `currentRoom`, `peers` (Map id -> {username, pc, stream})
3. **WebSocket** — подключение, reconnect с backoff, обработчик сообщений
4. **Room UI** — рендер списка комнат (lobby и sidebar), обработчики кликов
5. **Modal** — создание комнаты
6. **Toast** — показ ошибок

На этом шаге WebRTC ещё НЕ реализуем — только навигация по комнатам и WebSocket.

**Step 2: Проверить что lobby загружается и комнаты отображаются**

Run: `node server.js` и открыть `http://localhost:3000`
Expected: Видим lobby с комнатой "General", можно ввести имя и кликнуть на комнату

**Step 3: Коммит**

```bash
git add public/app.js
git commit -m "feat: add client WebSocket connection and room navigation"
```

---

### Task 6: Client-Side JavaScript — WebRTC Audio

**Files:**
- Modify: `public/app.js`

**Step 1: Добавить WebRTC логику**

Добавить в `app.js`:

1. **getUserMedia** — запрос микрофона при входе в комнату
2. **createPeerConnection(peerId)** — создание RTCPeerConnection, добавление локального аудио-трека, обработка remote track (создание `<audio>` элемента), отправка ICE кандидатов через WS
3. **Обработка `peer-joined`** — создать PC, создать offer, отправить через WS
4. **Обработка `offer`** — создать PC, установить remote description, создать answer, отправить
5. **Обработка `answer`** — установить remote description
6. **Обработка `ice-candidate`** — добавить ICE кандидат
7. **Обработка `peer-left`** — закрыть PC, удалить `<audio>`, удалить из peers
8. **Mute** — toggle `track.enabled` на локальном аудио-треке
9. **Leave** — закрыть все PC, остановить локальный stream, отправить `leave`
10. **Voice activity detection** — `AudioContext` + `AnalyserNode` для определения говорящего, добавление/удаление класса `.speaking` на аватарке

ICE servers: `[{ urls: 'stun:stun.l.google.com:19302' }]`

**Step 2: Полный функциональный тест**

Run: `node server.js`
1. Открыть 2 вкладки на `http://localhost:3000`
2. В обеих ввести имя, зайти в General
3. Проверить что голос передаётся между вкладками
4. Проверить mute/unmute
5. Проверить выход из комнаты

**Step 3: Коммит**

```bash
git add public/app.js
git commit -m "feat: add WebRTC audio with voice activity detection"
```

---

### Task 7: Polish and Edge Cases

**Files:**
- Modify: `public/app.js`
- Modify: `server.js`

**Step 1: Добавить обработку ошибок**

- Если `getUserMedia` отклонён — показать toast, разрешить подключение без микрофона (listen-only)
- WebSocket reconnect с backoff (1s, 2s, 4s, max 30s)
- Обработка закрытия/ошибок RTCPeerConnection — удаление peer из UI

**Step 2: Добавить удаление пустых комнат**

В `server.js` — при `leave`/`close`, если в не-дефолтной комнате 0 участников, удалить её. "General" не удаляется.

**Step 3: Финальный тест**

Те же проверки что в Task 6, плюс:
- Отказать в доступе к микрофону — проверить что toast показывается
- Закрыть вкладку резко — проверить что peer пропадает у остальных
- Создать новую комнату, зайти, выйти — проверить что комната удалилась

**Step 4: Коммит**

```bash
git add server.js public/app.js
git commit -m "feat: add error handling, reconnection, and room cleanup"
```
