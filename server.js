const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

// WebSocket
const wss = new WebSocketServer({ server });

// State
const rooms = new Map();
const chatHistory = new Map(); // room name -> array of messages
let nextId = 1;

rooms.set('General', new Map());
chatHistory.set('General', []);

function getRoomList() {
  const roomList = [];
  for (const [name, members] of rooms) {
    roomList.push({
      name,
      users: Array.from(members.values()).map(m => ({ id: m.id, username: m.username, avatar: m.avatar })),
      count: members.size,
    });
  }
  return roomList;
}

function broadcastRoomUpdate() {
  const msg = JSON.stringify({ type: 'room-update', rooms: getRoomList() });
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

  ws.send(JSON.stringify({ type: 'room-update', rooms: getRoomList() }));
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
          ws.send(JSON.stringify({ type: 'error', message: 'Комната уже существует или имя пустое' }));
          return;
        }
        rooms.set(name, new Map());
        chatHistory.set(name, []);
        broadcastRoomUpdate();
        break;
      }

      case 'join': {
        const room = rooms.get(msg.room);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
          return;
        }
        if (room.size >= 5) {
          ws.send(JSON.stringify({ type: 'error', message: 'Комната полна (5/5)' }));
          return;
        }

        // Leave current room first
        if (currentRoom) {
          const oldRoom = rooms.get(currentRoom);
          if (oldRoom) {
            oldRoom.delete(id);
            for (const [, member] of oldRoom) {
              member.ws.send(JSON.stringify({ type: 'peer-left', id }));
            }
            // Cleanup empty non-default rooms
            if (oldRoom.size === 0 && currentRoom !== 'General') {
              rooms.delete(currentRoom);
              chatHistory.delete(currentRoom);
            }
          }
        }

        username = msg.username;
        currentRoom = msg.room;
        room.set(id, { ws, id, username, avatar: msg.avatar || { color: '#5865f2', icon: '🐱' }, muted: false, deafened: false });

        const existingPeers = [];
        for (const [memberId, member] of room) {
          if (memberId !== id) {
            existingPeers.push({ id: memberId, username: member.username, avatar: member.avatar, muted: member.muted, deafened: member.deafened });
          }
        }
        ws.send(JSON.stringify({ type: 'joined', room: currentRoom, peers: existingPeers }));

        // Send chat history
        const history = chatHistory.get(currentRoom);
        if (history && history.length > 0) {
          ws.send(JSON.stringify({ type: 'chat-history', messages: history }));
        }

        for (const [memberId, member] of room) {
          if (memberId !== id) {
            member.ws.send(JSON.stringify({ type: 'peer-joined', id, username, avatar: msg.avatar || { color: '#5865f2', icon: '🐱' } }));
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
            if (room.size === 0 && currentRoom !== 'General') {
              rooms.delete(currentRoom);
              chatHistory.delete(currentRoom);
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
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const target = room.get(msg.to);
        if (target) {
          target.ws.send(JSON.stringify({ ...msg, from: id }));
        }
        break;
      }

      case 'user-state': {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const member = room.get(id);
        if (member) {
          member.muted = !!msg.muted;
          member.deafened = !!msg.deafened;
        }
        // Broadcast to all others in room
        for (const [memberId, m] of room) {
          if (memberId !== id) {
            m.ws.send(JSON.stringify({ type: 'user-state', id, muted: !!msg.muted, deafened: !!msg.deafened }));
          }
        }
        break;
      }

      case 'chat-message': {
        if (!currentRoom || !username) return;
        const text = msg.text?.trim();
        if (!text || text.length > 500) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const chatMsg = { type: 'chat-message', from: id, username, text, timestamp: Date.now() };
        // Save to history
        const history = chatHistory.get(currentRoom);
        if (history) {
          history.push(chatMsg);
          if (history.length > 100) history.shift();
        }
        for (const [, member] of room) {
          member.ws.send(JSON.stringify(chatMsg));
        }
        break;
      }

      case 'screen-share-start':
      case 'screen-share-stop': {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        for (const [memberId, member] of room) {
          if (memberId !== id) {
            member.ws.send(JSON.stringify({ type: msg.type, id, username }));
          }
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
        if (room.size === 0 && currentRoom !== 'General') {
          rooms.delete(currentRoom);
          chatHistory.delete(currentRoom);
        }
      }
      broadcastRoomUpdate();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Voice Chat running on http://localhost:${PORT}`);
});
