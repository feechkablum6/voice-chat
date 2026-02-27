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
let nextId = 1;

rooms.set('General', new Map());

function getRoomList() {
  const roomList = [];
  for (const [name, members] of rooms) {
    roomList.push({
      name,
      users: Array.from(members.values()).map(m => ({ id: m.id, username: m.username })),
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
            }
          }
        }

        username = msg.username;
        currentRoom = msg.room;
        room.set(id, { ws, id, username });

        const existingPeers = [];
        for (const [memberId, member] of room) {
          if (memberId !== id) {
            existingPeers.push({ id: memberId, username: member.username });
          }
        }
        ws.send(JSON.stringify({ type: 'joined', room: currentRoom, peers: existingPeers }));

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
            if (room.size === 0 && currentRoom !== 'General') {
              rooms.delete(currentRoom);
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
