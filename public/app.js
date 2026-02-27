// ===== State =====
let ws = null;
let myId = null;
let username = null;
let currentRoom = null;
let localStream = null;
let isMuted = false;
const peers = new Map(); // id -> { username, pc, audioEl, analyser }
let audioContext = null;
let localAnalyser = null;
let vadInterval = null;
let reconnectDelay = 1000;
let roomsData = [];

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
const createRoomBtn = document.getElementById('create-room-btn');
const createRoomModal = document.getElementById('create-room-modal');
const roomNameInput = document.getElementById('room-name-input');
const modalCancel = document.getElementById('modal-cancel');
const modalCreate = document.getElementById('modal-create');
const toastEl = document.getElementById('toast');

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
        createPeerConnection(peer.id, peer.username, true);
      }
      break;

    case 'peer-joined':
      createPeerConnection(msg.id, msg.username, false);
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
        avatarsHTML += `<div class="room-item-avatar">${u.username[0].toUpperCase()}</div>`;
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
  const selfEl = createParticipantEl(myId, username, true);
  participantsEl.appendChild(selfEl);

  // Add peers
  for (const [id, peer] of peers) {
    const el = createParticipantEl(id, peer.username, false);
    participantsEl.appendChild(el);
  }
}

function createParticipantEl(id, name, isSelf) {
  const el = document.createElement('div');
  el.className = 'participant';
  el.id = `participant-${id}`;
  if (isSelf && isMuted) el.classList.add('muted');
  el.innerHTML = `
    <div class="participant-avatar">${name[0].toUpperCase()}</div>
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

  send({ type: 'join', room: roomName, username });
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

  showLobbyScreen();
}

// ===== WebRTC =====
async function createPeerConnection(peerId, peerUsername, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;

  let peerAnalyser = null;

  peers.set(peerId, { username: peerUsername, pc, audioEl, analyser: null });

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

// ===== Event Listeners =====
muteBtn.addEventListener('click', toggleMute);
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
connectWS();
