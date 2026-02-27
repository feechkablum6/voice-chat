// ===== State =====
let ws = null;
let myId = null;
let username = null;
let currentRoom = null;
let localStream = null;
let isMuted = false;
let isDeafened = false;
let wasMutedBeforeDeafen = false;
const peers = new Map(); // id -> { username, avatar, pc, audioEl, analyser, muted, deafened }
let audioContext = null;
let localAnalyser = null;
let vadInterval = null;
let reconnectDelay = 1000;
let roomsData = [];

const AVATAR_COLORS = ['#5865f2','#ed4245','#3ba55c','#faa61a','#9b59b6','#e67e22','#e91e63','#1abc9c'];
const AVATAR_ICONS = ['🐱','🤖','🔥','👻','🎮','🎵','💀','🦊','🌙','⚡','🎯','🍕'];

let selectedColor = localStorage.getItem('avatar-color') || AVATAR_COLORS[0];
let selectedIcon = localStorage.getItem('avatar-icon') || AVATAR_ICONS[0];

// ===== DOM =====
const lobbyScreen = document.getElementById('lobby');
const roomScreen = document.getElementById('room');
const usernameInput = document.getElementById('username-input');
const roomListEl = document.getElementById('room-list');
const sidebarRoomListEl = document.getElementById('sidebar-room-list');
const roomNameEl = document.getElementById('room-name');
const roomCountEl = document.getElementById('room-count');
const participantsEl = document.getElementById('participants');
const muteBtn = document.getElementById('mute-btn');
const micIcon = document.getElementById('mic-icon');
const micOffIcon = document.getElementById('mic-off-icon');
const leaveBtn = document.getElementById('leave-btn');
const deafenBtn = document.getElementById('deafen-btn');
const headphonesIcon = document.getElementById('headphones-icon');
const headphonesOffIcon = document.getElementById('headphones-off-icon');
const createRoomBtn = document.getElementById('create-room-btn');
const createRoomModal = document.getElementById('create-room-modal');
const roomNameInput = document.getElementById('room-name-input');
const modalCancel = document.getElementById('modal-cancel');
const modalCreate = document.getElementById('modal-create');
const toastEl = document.getElementById('toast');
const colorPickerEl = document.getElementById('color-picker');
const iconPickerEl = document.getElementById('icon-picker');
const avatarPreviewEl = document.getElementById('avatar-preview');

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// ===== Toast =====
let toastTimeout = null;
function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3000);
}

// ===== WebSocket =====
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connectWS();
    }, reconnectDelay);
  };

  ws.onerror = () => {};
}

function send(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'your-id':
      myId = msg.id;
      break;

    case 'room-update':
      roomsData = msg.rooms;
      renderRoomList();
      renderSidebarRooms();
      if (currentRoom) {
        const room = roomsData.find(r => r.name === currentRoom);
        if (room) {
          roomCountEl.textContent = `${room.count}/5`;
        }
      }
      break;

    case 'joined':
      currentRoom = msg.room;
      showRoomScreen();
      // Connect to existing peers
      for (const peer of msg.peers) {
        createPeerConnection(peer.id, peer.username, peer.avatar, true, peer.muted, peer.deafened);
      }
      break;

    case 'peer-joined':
      createPeerConnection(msg.id, msg.username, msg.avatar, false, false, false);
      renderParticipants();
      break;

    case 'peer-left':
      removePeer(msg.id);
      renderParticipants();
      break;

    case 'offer':
      handleOffer(msg);
      break;

    case 'answer':
      handleAnswer(msg);
      break;

    case 'ice-candidate':
      handleIceCandidate(msg);
      break;

    case 'user-state': {
      const peer = peers.get(msg.id);
      if (peer) {
        peer.muted = msg.muted;
        peer.deafened = msg.deafened;
        renderParticipants();
      }
      break;
    }

    case 'error':
      showToast(msg.message, true);
      break;
  }
}

// ===== Room List Rendering =====
function renderRoomList() {
  roomListEl.innerHTML = '';
  for (const room of roomsData) {
    const el = document.createElement('div');
    el.className = 'room-item';
    const isFull = room.count >= 5;

    let avatarsHTML = '';
    if (room.users.length > 0) {
      avatarsHTML = '<div class="room-item-avatars">';
      for (const u of room.users.slice(0, 5)) {
        avatarsHTML += `<div class="room-item-avatar" style="background:${u.avatar?.color || '#5865f2'}">${u.avatar?.icon || u.username[0].toUpperCase()}</div>`;
      }
      avatarsHTML += '</div>';
    }

    el.innerHTML = `
      <div class="room-item-left">
        <span class="room-item-icon">&#x1f50a;</span>
        <span class="room-item-name">${escapeHtml(room.name)}</span>
      </div>
      <div class="room-item-users">
        ${avatarsHTML}
        <span class="room-item-count ${isFull ? 'full' : ''}">${room.count}/5</span>
      </div>
    `;
    el.addEventListener('click', () => joinRoom(room.name));
    roomListEl.appendChild(el);
  }
}

function renderSidebarRooms() {
  sidebarRoomListEl.innerHTML = '';
  for (const room of roomsData) {
    const el = document.createElement('div');
    el.className = 'sidebar-room' + (room.name === currentRoom ? ' active' : '');
    el.innerHTML = `
      <span class="sidebar-room-icon">&#x1f50a;</span>
      <span>${escapeHtml(room.name)}</span>
      <span class="sidebar-room-count">${room.count}</span>
    `;
    el.addEventListener('click', () => {
      if (room.name !== currentRoom) {
        joinRoom(room.name);
      }
    });
    sidebarRoomListEl.appendChild(el);
  }
}

// ===== Participants Rendering =====
function renderParticipants() {
  participantsEl.innerHTML = '';

  // Add self
  const selfEl = createParticipantEl(myId, username, true, { color: selectedColor, icon: selectedIcon }, null);
  participantsEl.appendChild(selfEl);

  // Add peers
  for (const [id, peer] of peers) {
    const el = createParticipantEl(id, peer.username, false, peer.avatar, { muted: peer.muted, deafened: peer.deafened });
    participantsEl.appendChild(el);
  }
}

function createParticipantEl(id, name, isSelf, avatar, peerState) {
  const el = document.createElement('div');
  el.className = 'participant';
  el.id = `participant-${id}`;

  const isMutedState = isSelf ? isMuted : peerState?.muted;
  const isDeafenedState = isSelf ? isDeafened : peerState?.deafened;

  if (isMutedState) el.classList.add('muted');
  if (isDeafenedState) el.classList.add('deafened');

  const avatarColor = avatar ? avatar.color : '#5865f2';
  const avatarIcon = avatar ? avatar.icon : name[0].toUpperCase();

  let badges = '';
  if (!isSelf) {
    if (isMutedState) badges += '<div class="status-badge mute-badge" title="Микрофон выключен"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg></div>';
    if (isDeafenedState) badges += '<div class="status-badge deafen-badge" title="Звук выключен"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2"/></svg></div>';
  }

  el.innerHTML = `
    <div class="participant-avatar" style="background: ${avatarColor}">
      ${avatarIcon}
      ${badges ? '<div class="status-badges">' + badges + '</div>' : ''}
    </div>
    <div class="participant-name">${escapeHtml(name)}</div>
    ${isSelf ? '<div class="participant-you">ты</div>' : ''}
  `;
  return el;
}

// ===== Screen Navigation =====
function showRoomScreen() {
  lobbyScreen.classList.remove('active');
  roomScreen.classList.add('active');
  roomNameEl.textContent = currentRoom;
  const room = roomsData.find(r => r.name === currentRoom);
  roomCountEl.textContent = room ? `${room.count}/5` : '';
  renderParticipants();
  renderSidebarRooms();
}

function showLobbyScreen() {
  roomScreen.classList.remove('active');
  lobbyScreen.classList.add('active');
  currentRoom = null;
  renderRoomList();
}

// ===== Join / Leave =====
async function joinRoom(roomName) {
  const name = usernameInput.value.trim();
  if (!name) {
    showToast('Введи своё имя!', true);
    usernameInput.focus();
    return;
  }
  username = name;
  localStorage.setItem('username', username);

  // Get microphone
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Микрофон недоступен — подключаешься в режиме прослушивания', true);
    localStream = null;
  }

  if (localStream) {
    setupLocalVAD();
  }

  send({ type: 'join', room: roomName, username, avatar: { color: selectedColor, icon: selectedIcon } });
}

function leaveRoom() {
  send({ type: 'leave' });

  // Cleanup all peers
  for (const [id] of peers) {
    removePeer(id);
  }

  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  // Stop VAD
  if (vadInterval) {
    clearInterval(vadInterval);
    vadInterval = null;
  }

  isMuted = false;
  muteBtn.classList.remove('muted');
  micIcon.style.display = '';
  micOffIcon.style.display = 'none';

  isDeafened = false;
  deafenBtn.classList.remove('muted');
  headphonesIcon.style.display = '';
  headphonesOffIcon.style.display = 'none';

  showLobbyScreen();
}

// ===== WebRTC =====
async function createPeerConnection(peerId, peerUsername, peerAvatar, isInitiator, peerMuted, peerDeafened) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;

  let peerAnalyser = null;

  peers.set(peerId, { username: peerUsername, avatar: peerAvatar, pc, audioEl, analyser: null, muted: peerMuted || false, deafened: peerDeafened || false });

  // Add local tracks
  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  // Handle remote stream
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    // Setup VAD for remote peer
    try {
      if (!audioContext) audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(e.streams[0]);
      peerAnalyser = audioContext.createAnalyser();
      peerAnalyser.fftSize = 512;
      source.connect(peerAnalyser);
      const peerData = peers.get(peerId);
      if (peerData) peerData.analyser = peerAnalyser;
    } catch (err) {}
  };

  // ICE candidates
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'ice-candidate', to: peerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      // Will be cleaned up by peer-left from server
    }
  };

  // Create offer if initiator
  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'offer', to: peerId, sdp: pc.localDescription });
  }

  renderParticipants();
}

async function handleOffer(msg) {
  const peer = peers.get(msg.from);
  if (!peer) return;
  await peer.pc.setRemoteDescription(msg.sdp);
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  send({ type: 'answer', to: msg.from, sdp: peer.pc.localDescription });
}

async function handleAnswer(msg) {
  const peer = peers.get(msg.from);
  if (!peer) return;
  await peer.pc.setRemoteDescription(msg.sdp);
}

async function handleIceCandidate(msg) {
  const peer = peers.get(msg.from);
  if (!peer) return;
  try {
    await peer.pc.addIceCandidate(msg.candidate);
  } catch (err) {}
}

function removePeer(id) {
  const peer = peers.get(id);
  if (peer) {
    peer.pc.close();
    if (peer.audioEl.srcObject) {
      peer.audioEl.srcObject.getTracks().forEach(t => t.stop());
    }
    peer.audioEl.remove();
    peers.delete(id);
  }
}

// ===== Voice Activity Detection =====
function setupLocalVAD() {
  if (!audioContext) audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(localStream);
  localAnalyser = audioContext.createAnalyser();
  localAnalyser.fftSize = 512;
  source.connect(localAnalyser);

  const dataArray = new Uint8Array(localAnalyser.frequencyBinCount);

  if (vadInterval) clearInterval(vadInterval);
  vadInterval = setInterval(() => {
    // Check local
    if (localAnalyser && !isMuted) {
      localAnalyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const selfEl = document.getElementById(`participant-${myId}`);
      if (selfEl) {
        const level = Math.min(avg / 50, 1);
        selfEl.style.setProperty('--audio-level', level);
        if (avg > 15) {
          selfEl.classList.add('speaking');
        } else {
          selfEl.classList.remove('speaking');
        }
      }
    }

    // Check peers
    for (const [id, peer] of peers) {
      if (peer.analyser) {
        const peerData = new Uint8Array(peer.analyser.frequencyBinCount);
        peer.analyser.getByteFrequencyData(peerData);
        const avg = peerData.reduce((a, b) => a + b, 0) / peerData.length;
        const el = document.getElementById(`participant-${id}`);
        if (el) {
          const level = Math.min(avg / 50, 1);
          el.style.setProperty('--audio-level', level);
          if (avg > 15) {
            el.classList.add('speaking');
          } else {
            el.classList.remove('speaking');
          }
        }
      }
    }
  }, 100);
}

// ===== Mute =====
function toggleMute() {
  isMuted = !isMuted;
  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      track.enabled = !isMuted;
    }
  }
  muteBtn.classList.toggle('muted', isMuted);
  micIcon.style.display = isMuted ? 'none' : '';
  micOffIcon.style.display = isMuted ? '' : 'none';

  const selfEl = document.getElementById(`participant-${myId}`);
  if (selfEl) {
    selfEl.classList.toggle('muted', isMuted);
    if (isMuted) selfEl.classList.remove('speaking');
  }

  broadcastUserState();
}

// ===== Deafen =====
function toggleDeafen() {
  isDeafened = !isDeafened;

  if (isDeafened) {
    // Save mute state, then mute
    wasMutedBeforeDeafen = isMuted;
    if (!isMuted) toggleMute();
    // Mute all incoming audio
    for (const [, peer] of peers) {
      peer.audioEl.muted = true;
    }
  } else {
    // Unmute incoming audio
    for (const [, peer] of peers) {
      peer.audioEl.muted = false;
    }
    // Restore mute state
    if (!wasMutedBeforeDeafen && isMuted) toggleMute();
  }

  deafenBtn.classList.toggle('muted', isDeafened);
  headphonesIcon.style.display = isDeafened ? 'none' : '';
  headphonesOffIcon.style.display = isDeafened ? '' : 'none';

  broadcastUserState();
}

function broadcastUserState() {
  send({ type: 'user-state', muted: isMuted, deafened: isDeafened });
}

// ===== Modal =====
function openModal() {
  createRoomModal.classList.add('active');
  roomNameInput.value = '';
  roomNameInput.focus();
}

function closeModal() {
  createRoomModal.classList.remove('active');
}

function createRoom() {
  const name = roomNameInput.value.trim();
  if (!name) return;
  send({ type: 'create-room', name });
  closeModal();
}

// ===== Helpers =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function initAvatarPicker() {
  // Colors
  for (const color of AVATAR_COLORS) {
    const el = document.createElement('div');
    el.className = 'color-option' + (color === selectedColor ? ' selected' : '');
    el.style.background = color;
    el.addEventListener('click', () => {
      selectedColor = color;
      localStorage.setItem('avatar-color', color);
      colorPickerEl.querySelectorAll('.color-option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      updateAvatarPreview();
    });
    colorPickerEl.appendChild(el);
  }

  // Icons
  for (const icon of AVATAR_ICONS) {
    const el = document.createElement('div');
    el.className = 'icon-option' + (icon === selectedIcon ? ' selected' : '');
    el.textContent = icon;
    el.addEventListener('click', () => {
      selectedIcon = icon;
      localStorage.setItem('avatar-icon', icon);
      iconPickerEl.querySelectorAll('.icon-option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      updateAvatarPreview();
    });
    iconPickerEl.appendChild(el);
  }

  updateAvatarPreview();

  const savedUsername = localStorage.getItem('username');
  if (savedUsername) usernameInput.value = savedUsername;
}

function updateAvatarPreview() {
  avatarPreviewEl.style.background = selectedColor;
  avatarPreviewEl.textContent = selectedIcon;
}

// ===== Event Listeners =====
muteBtn.addEventListener('click', toggleMute);
deafenBtn.addEventListener('click', toggleDeafen);
leaveBtn.addEventListener('click', leaveRoom);
createRoomBtn.addEventListener('click', openModal);
modalCancel.addEventListener('click', closeModal);
modalCreate.addEventListener('click', createRoom);

roomNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createRoom();
});

usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // Join first available room
    if (roomsData.length > 0) {
      joinRoom(roomsData[0].name);
    }
  }
});

createRoomModal.addEventListener('click', (e) => {
  if (e.target === createRoomModal) closeModal();
});

// ===== Init =====
initAvatarPicker();
connectWS();
