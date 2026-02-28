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
let isChatOpen = false;
let unreadCount = 0;
let screenStream = null;
const activeScreenShares = new Map(); // peerId -> { stream, videoEl, username }

const AVATAR_COLORS = ['#d4915c','#c0392b','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e84393','#6c5ce7'];
const AVATAR_ICONS = ['🐱','🐶','🐻','🦊','🐧','🦅','🦄','🐉','🐼','🐰','🦎','🐙','🐢','🦋','🐌'];

let selectedColor = localStorage.getItem('avatar-color') || AVATAR_COLORS[0];
let selectedIcon = localStorage.getItem('avatar-icon') || AVATAR_ICONS[0];

// ===== FLIP Animation Utility =====
function animateFLIP(elements, domChangeCallback) {
  // 1. FIRST: measure initial positions
  const firstRects = new Map();
  elements.forEach(el => {
    if(el && document.body.contains(el)) {
       firstRects.set(el, el.getBoundingClientRect());
    }
  });

  // 2. Perform actual DOM updates (hide grid, show focus, move video tags)
  domChangeCallback();

  // Force reflow
  requestAnimationFrame(() => {
    // 3. LAST: measure new positions
    const lastRects = new Map();
    elements.forEach(el => {
       if(el && document.body.contains(el)) {
          lastRects.set(el, el.getBoundingClientRect());
       }
    });

    // 4. INVERT
    elements.forEach(el => {
      if(!firstRects.has(el) || !lastRects.has(el)) return;
      const first = firstRects.get(el);
      const last = lastRects.get(el);

      const dx = first.left - last.left;
      const dy = first.top - last.top;
      const sw = first.width / last.width;
      const sh = first.height / last.height;

      // Disable transitions immediately to snap to first position
      el.style.transition = 'none';
      el.style.transformOrigin = 'top left';
      el.classList.add('flip-animating');
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${sw}, ${sh})`;
    });

    // 5. PLAY
    requestAnimationFrame(() => {
      elements.forEach(el => {
        if(!firstRects.has(el) || !lastRects.has(el)) return;
        el.style.transition = 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)';
        el.style.transform = 'translate(0, 0) scale(1, 1)';

        // Cleanup after transition
        setTimeout(() => {
          el.style.transition = '';
          el.style.transform = '';
          el.style.transformOrigin = '';
          el.classList.remove('flip-animating');
        }, 500);
      });
    });
  });
}

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
const chatPanel = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatBtn = document.getElementById('chat-btn');
const chatCloseBtn = document.getElementById('chat-close-btn');
const chatUnread = document.getElementById('chat-unread');
const screenBtn = document.getElementById('screen-btn');
const layoutGrid = document.getElementById('layout-grid');
const layoutFocus = document.getElementById('layout-focus');
const mainScreensContainer = document.getElementById('main-screens-container');
const sidebarContainer = document.getElementById('sidebar-container');
const contextMenu = document.getElementById('context-menu');
const ctxSwap = document.getElementById('ctx-swap');
const ctxSplit = document.getElementById('ctx-split');
const presenterBar = document.getElementById('presenter-bar');
const presenterTabs = document.getElementById('presenter-tabs');
const presenterMinimizeBtn = document.getElementById('presenter-minimize-btn');

// Layout state
let currentLayout = 'grid'; // 'grid' | 'focus'
let focusedShareId = null; // peerId whose screen is in main area
let contextMenuTargetId = null; // peerId for context menu actions

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
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    // If we were in a room, clean up and return to lobby
    if (currentRoom) {
      for (const [id] of peers) {
        removePeer(id);
      }
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      if (vadInterval) {
        clearInterval(vadInterval);
        vadInterval = null;
      }
      isMuted = false;
      isDeafened = false;
      stopScreenShare();
      activeScreenShares.clear();
      chatMessages.innerHTML = '';
      isChatOpen = false;
      chatPanel.classList.remove('open');
      unreadCount = 0;
      chatUnread.style.display = 'none';
      currentRoom = null;
      resetLayoutState();

      muteBtn.classList.remove('muted');
      micIcon.style.display = '';
      micOffIcon.style.display = 'none';
      deafenBtn.classList.remove('muted');
      headphonesIcon.style.display = '';
      headphonesOffIcon.style.display = 'none';

      showLobbyScreen();
      showToast('Соединение потеряно — переподключение…', true);
    }
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
          roomCountEl.textContent = `${room.count}/10`;
        }
      }
      break;

    case 'joined':
      // Reset chat state for new room
      chatMessages.innerHTML = '';
      unreadCount = 0;
      chatUnread.style.display = 'none';

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

    case 'chat-message':
      addChatMessage(msg);
      break;

    case 'chat-history':
      for (const m of msg.messages) {
        addChatMessage(m);
      }
      break;

    case 'screen-share-start':
      // Track will arrive via WebRTC ontrack
      break;

    case 'screen-share-stop':
      activeScreenShares.delete(msg.id);
      renderScreenShares();
      break;

    case 'profile-updated': {
      const peer = peers.get(msg.id);
      if (peer) {
        peer.username = msg.username;
        peer.avatar = msg.avatar;
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
    const el = document.createElement('button');
    el.className = 'room-item';
    el.type = 'button';
    const isFull = room.count >= 10;

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
        <span class="room-item-count ${isFull ? 'full' : ''}">${room.count}/10</span>
      </div>
    `;
    el.addEventListener('click', () => joinRoom(room.name));
    roomListEl.appendChild(el);
  }
}

function renderSidebarRooms() {
  sidebarRoomListEl.innerHTML = '';
  for (const room of roomsData) {
    const el = document.createElement('button');
    el.type = 'button';
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
  updateRoomUI();
}

function createParticipantEl(id, name, isSelf, avatar, peerState) {
  const el = document.createElement('div');
  el.className = 'participant' + (isSelf ? ' self' : '');
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

  if (isSelf) {
    const avatarEl = el.querySelector('.participant-avatar');
    avatarEl.style.cursor = 'pointer';
    avatarEl.addEventListener('click', (e) => {
      e.stopPropagation();
      showProfilePopup(avatarEl);
    });
  }

  if (!isSelf) {
    const avatarEl = el.querySelector('.participant-avatar');
    avatarEl.addEventListener('click', (e) => {
      e.stopPropagation();
      showVolumePopup(id, avatarEl);
    });
  }

  return el;
}

// ===== Screen Navigation =====
function showRoomScreen() {
  roomNameEl.textContent = currentRoom;
  const room = roomsData.find(r => r.name === currentRoom);
  roomCountEl.textContent = room ? `${room.count}/10` : '';
  renderParticipants();
  renderSidebarRooms();

  // Slide: lobby out right, room in from left
  lobbyScreen.classList.add('slide-out');
  lobbyScreen.classList.remove('active');
  roomScreen.classList.add('active');
}

function showLobbyScreen() {
  roomScreen.classList.remove('active');
  lobbyScreen.classList.remove('slide-out');
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

  // Resume AudioContext on user gesture
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume();
  }

  // Get microphone
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Микрофон недоступен — подключаешься в режиме прослушивания', true);
    localStream = null;
    isMuted = true;
    muteBtn.classList.add('muted', 'disabled');
    muteBtn.title = 'Микрофон недоступен';
    micIcon.style.display = 'none';
    micOffIcon.style.display = '';
  }

  if (localStream) {
    setupLocalVAD();
  }

  send({ type: 'join', room: roomName, username, avatar: { color: selectedColor, icon: selectedIcon } });
}

function leaveRoom() {
  closeProfilePopup();
  closeVolumePopup();
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
  muteBtn.classList.remove('muted', 'disabled');
  muteBtn.title = '';
  micIcon.style.display = '';
  micOffIcon.style.display = 'none';

  isDeafened = false;
  deafenBtn.classList.remove('muted');
  headphonesIcon.style.display = '';
  headphonesOffIcon.style.display = 'none';

  chatMessages.innerHTML = '';
  isChatOpen = false;
  chatPanel.classList.remove('open');
  unreadCount = 0;
  chatUnread.style.display = 'none';

  stopScreenShare();
  activeScreenShares.clear();
  resetLayoutState();

  showLobbyScreen();
}

// ===== WebRTC =====
async function createPeerConnection(peerId, peerUsername, peerAvatar, isInitiator, peerMuted, peerDeafened) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;

  peers.set(peerId, { username: peerUsername, avatar: peerAvatar, pc, audioEl, analyser: null, gainNode: null, muted: peerMuted || false, deafened: peerDeafened || false, locallyMuted: false });

  // Add local tracks
  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  // Add screen share track if active
  if (screenStream) {
    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      const sender = pc.addTrack(videoTrack, screenStream);
      const peerData = peers.get(peerId);
      if (peerData) peerData.screenSender = sender;
    }
  }

  // Handle remote stream
  pc.ontrack = (e) => {
    const track = e.track;
    if (track.kind === 'video') {
      // Screen share incoming
      const videoEl = document.createElement('video');
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.srcObject = new MediaStream([track]);
      activeScreenShares.set(peerId, { stream: e.streams[0], videoEl, username: peerUsername });
      track.onended = () => {
        activeScreenShares.delete(peerId);
        renderScreenShares();
      };
      renderScreenShares();
      return;
    }

    const stream = e.streams[0];
    // Create gain node for volume control
    ensureAudioContext().then(() => {
      const source = audioContext.createMediaStreamSource(stream);
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 1.0;
      source.connect(gainNode);
      const dest = audioContext.createMediaStreamDestination();
      gainNode.connect(dest);
      audioEl.srcObject = dest.stream;

      // Setup VAD analyser
      const peerAnalyser = audioContext.createAnalyser();
      peerAnalyser.fftSize = 512;
      gainNode.connect(peerAnalyser);
      const peerData = peers.get(peerId);
      if (peerData) {
        peerData.analyser = peerAnalyser;
        peerData.gainNode = gainNode;
      }
    });
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
  // Close volume popup if it's open for this peer
  if (activeVolumePopup && activeVolumePopup.dataset.peerId === String(id)) {
    closeVolumePopup();
  }
  const peer = peers.get(id);
  if (peer) {
    peer.pc.close();
    if (peer.audioEl.srcObject) {
      peer.audioEl.srcObject.getTracks().forEach(t => t.stop());
    }
    peer.audioEl.remove();
    peers.delete(id);
  }
  activeScreenShares.delete(id);
  renderScreenShares();
}

// ===== AudioContext Helper =====
async function ensureAudioContext() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  return audioContext;
}

// ===== Voice Activity Detection =====
async function setupLocalVAD() {
  await ensureAudioContext();
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
function toggleMute(skipBroadcast = false) {
  if (!localStream) {
    showToast('Микрофон недоступен', true);
    return;
  }

  if (isMuted && isDeafened) {
    // Unmuting while deafened — undeafen first (which will also unmute via its logic)
    toggleDeafen();
    return;
  }

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

  if (!skipBroadcast) broadcastUserState();
}

// ===== Deafen =====
function toggleDeafen() {
  isDeafened = !isDeafened;

  if (isDeafened) {
    // Save mute state, then mute
    wasMutedBeforeDeafen = isMuted;
    if (!isMuted) toggleMute(true);
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
    if (!wasMutedBeforeDeafen && isMuted) toggleMute(true);
  }

  deafenBtn.classList.toggle('muted', isDeafened);
  headphonesIcon.style.display = isDeafened ? 'none' : '';
  headphonesOffIcon.style.display = isDeafened ? '' : 'none';

  broadcastUserState();
}

function broadcastUserState() {
  send({ type: 'user-state', muted: isMuted, deafened: isDeafened });
}

// ===== Chat =====
function toggleChat() {
  isChatOpen = !isChatOpen;
  chatPanel.classList.toggle('open', isChatOpen);
  if (isChatOpen) {
    unreadCount = 0;
    chatUnread.style.display = 'none';
    chatInput.focus();
  }
}

function closeChat() {
  if (!isChatOpen) return;
  isChatOpen = false;
  chatPanel.classList.remove('open');
}

// Close chat on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isChatOpen) {
    closeChat();
  }
});

// Close chat on click outside
document.addEventListener('pointerdown', (e) => {
  if (!isChatOpen) return;
  if (chatPanel.contains(e.target)) return;
  if (e.target === chatBtn || chatBtn.contains(e.target)) return;
  closeChat();
});

// ===== Chat Drag & Resize =====
(function initChatBubble() {
  const dragHandle = document.getElementById('chat-drag-handle');
  const resizeHandle = document.getElementById('chat-resize-handle');
  let isDragging = false;
  let isResizing = false;
  let startX, startY, startW, startH, startRight, startBottom;

  // Inertia state
  let velX = 0, velY = 0;
  let prevX = 0, prevY = 0;
  let prevTime = 0;
  let inertiaRaf = null;

  function getChatRect() {
    const style = getComputedStyle(chatPanel);
    return {
      right: parseFloat(style.right) || 20,
      bottom: parseFloat(style.bottom) || 90,
      width: chatPanel.offsetWidth,
      height: chatPanel.offsetHeight
    };
  }

  function clampPosition(r, b) {
    const maxR = window.innerWidth - chatPanel.offsetWidth;
    const maxB = window.innerHeight - chatPanel.offsetHeight;
    return {
      right: Math.max(0, Math.min(r, maxR)),
      bottom: Math.max(0, Math.min(b, maxB))
    };
  }

  function stopInertia() {
    if (inertiaRaf) {
      cancelAnimationFrame(inertiaRaf);
      inertiaRaf = null;
    }
  }

  function runInertia() {
    const friction = 0.93;
    const minVel = 0.4;
    const bounceDampen = 0.25;

    function step() {
      velX *= friction;
      velY *= friction;

      if (Math.abs(velX) < minVel && Math.abs(velY) < minVel) {
        inertiaRaf = null;
        return;
      }

      const curRight = parseFloat(chatPanel.style.right) || 20;
      const curBottom = parseFloat(chatPanel.style.bottom) || 90;
      const maxR = window.innerWidth - chatPanel.offsetWidth;
      const maxB = window.innerHeight - chatPanel.offsetHeight;

      let nextRight = curRight - velX;
      let nextBottom = curBottom - velY;

      // Reflect overshoot instead of clamping
      if (nextRight < 0) {
        nextRight = -nextRight * bounceDampen;
        velX = Math.abs(velX) * bounceDampen;
      } else if (nextRight > maxR) {
        nextRight = maxR - (nextRight - maxR) * bounceDampen;
        velX = -Math.abs(velX) * bounceDampen;
      }

      if (nextBottom < 0) {
        nextBottom = -nextBottom * bounceDampen;
        velY = Math.abs(velY) * bounceDampen;
      } else if (nextBottom > maxB) {
        nextBottom = maxB - (nextBottom - maxB) * bounceDampen;
        velY = -Math.abs(velY) * bounceDampen;
      }

      // Safety clamp (prevent any micro-overshoot from floating point)
      nextRight = Math.max(0, Math.min(nextRight, maxR));
      nextBottom = Math.max(0, Math.min(nextBottom, maxB));

      chatPanel.style.right = nextRight + 'px';
      chatPanel.style.bottom = nextBottom + 'px';

      inertiaRaf = requestAnimationFrame(step);
    }
    inertiaRaf = requestAnimationFrame(step);
  }

  // Drag
  dragHandle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.btn-icon')) return;
    if (window.innerWidth <= 640) return;
    e.preventDefault();
    stopInertia();
    isDragging = true;
    chatPanel.classList.add('dragging');
    const rect = getChatRect();
    startX = e.clientX;
    startY = e.clientY;
    startRight = rect.right;
    startBottom = rect.bottom;
    prevX = e.clientX;
    prevY = e.clientY;
    prevTime = performance.now();
    velX = 0;
    velY = 0;
    dragHandle.setPointerCapture(e.pointerId);
  });

  dragHandle.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const now = performance.now();
    const dt = Math.max(1, now - prevTime);

    // Track velocity (exponential smoothing)
    const instantVX = (e.clientX - prevX) / dt * 16;
    const instantVY = (e.clientY - prevY) / dt * 16;
    velX = velX * 0.4 + instantVX * 0.6;
    velY = velY * 0.4 + instantVY * 0.6;

    prevX = e.clientX;
    prevY = e.clientY;
    prevTime = now;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const pos = clampPosition(startRight - dx, startBottom - dy);
    chatPanel.style.right = pos.right + 'px';
    chatPanel.style.bottom = pos.bottom + 'px';
  });

  dragHandle.addEventListener('pointerup', () => {
    if (!isDragging) return;
    isDragging = false;
    chatPanel.classList.remove('dragging');

    // Launch inertia if velocity is significant
    if (Math.abs(velX) > 1 || Math.abs(velY) > 1) {
      runInertia();
    }
  });

  // Resize (top-left corner → grows up-left)
  resizeHandle.addEventListener('pointerdown', (e) => {
    if (window.innerWidth <= 640) return;
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    chatPanel.classList.add('resizing');
    const rect = getChatRect();
    startX = e.clientX;
    startY = e.clientY;
    startW = rect.width;
    startH = rect.height;
    startRight = rect.right;
    startBottom = rect.bottom;
    resizeHandle.setPointerCapture(e.pointerId);
  });

  resizeHandle.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    const dx = startX - e.clientX;
    const dy = startY - e.clientY;
    const minW = 280, minH = 220;
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight - 16;
    let newW = Math.max(minW, Math.min(startW + dx, maxW));
    let newH = Math.max(minH, Math.min(startH + dy, maxH));
    chatPanel.style.width = newW + 'px';
    chatPanel.style.height = newH + 'px';
  });

  resizeHandle.addEventListener('pointerup', () => {
    if (!isResizing) return;
    isResizing = false;
    chatPanel.classList.remove('resizing');
  });
})();

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  send({ type: 'chat-message', text });
  chatInput.value = '';
}

function addChatMessage(msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-username">${escapeHtml(msg.username)}</span>
      <span class="chat-msg-time">${time}</span>
    </div>
    <div class="chat-msg-text">${escapeHtml(msg.text)}</div>
  `;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (!isChatOpen) {
    unreadCount++;
    chatUnread.textContent = unreadCount > 9 ? '9+' : unreadCount;
    chatUnread.style.display = '';
  }
}

// ===== Screen Share =====
async function toggleScreenShare() {
  if (screenStream) {
    stopScreenShare();
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    return; // User cancelled
  }

  screenStream.getVideoTracks()[0].onended = () => stopScreenShare();

  // Add video track to all peer connections
  for (const [peerId, peer] of peers) {
    const sender = peer.pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
    peer.screenSender = sender;
    // Renegotiate
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    send({ type: 'offer', to: peerId, sdp: peer.pc.localDescription });
  }

  send({ type: 'screen-share-start' });
  screenBtn.classList.add('sharing');

  // Add self preview
  const selfVideoEl = document.createElement('video');
  selfVideoEl.autoplay = true;
  selfVideoEl.playsInline = true;
  selfVideoEl.muted = true;
  selfVideoEl.srcObject = screenStream;
  activeScreenShares.set(myId, { stream: screenStream, videoEl: selfVideoEl, username: username + ' (ты)', isSelf: true });

  renderScreenShares();
}

function stopScreenShare() {
  if (!screenStream) return;

  // Remove track from all peers and renegotiate
  for (const [peerId, peer] of peers) {
    if (peer.screenSender) {
      peer.pc.removeTrack(peer.screenSender);
      peer.screenSender = null;
      // Renegotiate
      peer.pc.createOffer().then(offer => {
        return peer.pc.setLocalDescription(offer);
      }).then(() => {
        send({ type: 'offer', to: peerId, sdp: peer.pc.localDescription });
      }).catch(() => {});
    }
  }

  activeScreenShares.delete(myId);
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  send({ type: 'screen-share-stop' });
  screenBtn.classList.remove('sharing');
  renderScreenShares();
}

function renderScreenShares() {
  updateRoomUI();
}

// ===== Layout Management =====
function resetLayoutState() {
  currentLayout = 'grid';
  focusedShareId = null;
  contextMenuTargetId = null;
  hideContextMenu();
  layoutGrid.classList.add('active');
  layoutFocus.classList.remove('active');
  participantsEl.innerHTML = '';
  mainScreensContainer.innerHTML = '';
  sidebarContainer.innerHTML = '';
}

function updateRoomUI() {
  const shares = Array.from(activeScreenShares.entries());
  const hasShares = shares.length > 0;

  if (hasShares && currentLayout === 'grid') {
    // Transition from grid to focus
    const allCards = Array.from(participantsEl.children);
    animateFLIP(allCards, () => {
      switchToFocusLayout(shares);
    });
  } else if (!hasShares && currentLayout === 'focus') {
    // Transition from focus to grid
    const allCards = [...mainScreensContainer.children, ...sidebarContainer.children];
    animateFLIP(allCards, () => {
      switchToGridLayout();
    });
  } else if (hasShares) {
    // Already in focus, just re-render
    renderFocusContent(shares);
  } else {
    // Already in grid, just re-render
    renderGridContent();
  }
}

function switchToGridLayout() {
  currentLayout = 'grid';
  focusedShareId = null;
  layoutFocus.classList.remove('active');
  layoutGrid.classList.add('active');
  mainScreensContainer.innerHTML = '';
  sidebarContainer.innerHTML = '';
  renderGridContent();
}

function switchToFocusLayout(shares) {
  currentLayout = 'focus';
  // Auto-focus the first share
  if (!focusedShareId || !activeScreenShares.has(focusedShareId)) {
    focusedShareId = shares[0][0];
  }
  layoutGrid.classList.remove('active');
  layoutFocus.classList.add('active');
  participantsEl.innerHTML = '';
  renderFocusContent(shares);
}

function renderGridContent() {
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

function renderFocusContent(shares) {
  if (!shares) shares = Array.from(activeScreenShares.entries());

  // Validate focusedShareId
  if (!focusedShareId || !activeScreenShares.has(focusedShareId)) {
    focusedShareId = shares.length > 0 ? shares[0][0] : null;
  }

  // Main area: focused screen share(s)
  mainScreensContainer.innerHTML = '';
  if (focusedShareId) {
    const share = activeScreenShares.get(focusedShareId);
    if (share) {
      const item = createShareItem(focusedShareId, share);
      mainScreensContainer.appendChild(item);
    }
  }

  // Sidebar: all participants as mini-cards + non-focused screen shares as thumbnails
  sidebarContainer.innerHTML = '';

  // Self mini-card
  const selfCard = createMiniCard(myId, username, true, { color: selectedColor, icon: selectedIcon }, null);
  sidebarContainer.appendChild(selfCard);

  // Peer mini-cards
  for (const [id, peer] of peers) {
    const hasScreen = activeScreenShares.has(id);
    const isInMain = id === focusedShareId;

    if (hasScreen && !isInMain) {
      // Show as screen thumbnail card
      const share = activeScreenShares.get(id);
      const thumbCard = createScreenThumbCard(id, peer, share);
      sidebarContainer.appendChild(thumbCard);
    } else if (!isInMain) {
      // Show as regular mini-card
      const card = createMiniCard(id, peer.username, false, peer.avatar, { muted: peer.muted, deafened: peer.deafened });
      sidebarContainer.appendChild(card);
    }
  }

  // Self screen share thumbnail (if self is sharing but not focused)
  if (activeScreenShares.has(myId) && focusedShareId !== myId) {
    const selfShare = activeScreenShares.get(myId);
    const thumbCard = createScreenThumbCard(myId, { username: username + ' (ты)', avatar: { color: selectedColor, icon: selectedIcon } }, selfShare);
    sidebarContainer.appendChild(thumbCard);
  }
}

function createShareItem(peerId, share) {
  const item = document.createElement('div');
  item.className = 'lf-share-item';
  item.dataset.peerId = String(peerId);

  // Clone video element to avoid detaching from original
  const videoEl = share.videoEl;
  if (videoEl.parentNode) videoEl.remove();
  item.appendChild(videoEl);

  const label = document.createElement('div');
  label.className = 'lf-share-label';
  label.textContent = share.username;
  item.appendChild(label);

  // PiP button
  if (document.pictureInPictureEnabled) {
    const pipBtn = document.createElement('button');
    pipBtn.className = 'screenshare-pip-btn';
    pipBtn.title = 'Picture-in-Picture';
    pipBtn.setAttribute('aria-label', 'Picture-in-Picture');
    pipBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/></svg>`;
    pipBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        }
        await videoEl.requestPictureInPicture();
      } catch (err) {
        showToast('PiP недоступен', true);
      }
    });
    item.appendChild(pipBtn);
  }

  return item;
}

function createMiniCard(id, name, isSelf, avatar, peerState) {
  const card = document.createElement('div');
  card.className = 'mini-card';
  card.id = `participant-${id}`;

  const isMutedState = isSelf ? isMuted : peerState?.muted;
  const isDeafenedState = isSelf ? isDeafened : peerState?.deafened;

  if (isMutedState) card.classList.add('muted');
  if (isDeafenedState) card.classList.add('deafened');

  const avatarColor = avatar ? avatar.color : '#5865f2';
  const avatarIcon = avatar ? avatar.icon : name[0].toUpperCase();

  let miniBadges = '';
  if (!isSelf) {
    if (isMutedState) miniBadges += '<div class="status-badge mute-badge" title="Микрофон выключен"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg></div>';
    if (isDeafenedState) miniBadges += '<div class="status-badge deafen-badge" title="Звук выключен"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2"/></svg></div>';
  }

  card.innerHTML = `
    <div class="mini-avatar" style="background: ${avatarColor}">
      ${avatarIcon}
      ${miniBadges ? '<div class="status-badges">' + miniBadges + '</div>' : ''}
    </div>
    <div class="mini-name">${escapeHtml(name)}</div>
    ${isSelf ? '<div class="mini-you">ты</div>' : ''}
  `;

  if (isSelf) {
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      showProfilePopup(card.querySelector('.mini-avatar'));
    });
  } else {
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      showVolumePopup(id, card.querySelector('.mini-avatar'));
    });
  }

  return card;
}

function createScreenThumbCard(peerId, peer, share) {
  const card = document.createElement('div');
  card.className = 'mini-card has-screen';
  card.dataset.peerId = String(peerId);

  const avatarColor = peer.avatar ? peer.avatar.color : '#5865f2';
  const avatarIcon = peer.avatar ? peer.avatar.icon : peer.username[0].toUpperCase();
  const displayName = share.isSelf ? peer.username : peer.username;

  // Thumbnail with cloned video
  const thumb = document.createElement('div');
  thumb.className = 'mini-screen-thumb';

  const thumbVideo = document.createElement('video');
  thumbVideo.autoplay = true;
  thumbVideo.playsInline = true;
  thumbVideo.muted = true;
  thumbVideo.srcObject = share.stream || share.videoEl?.srcObject;
  thumb.appendChild(thumbVideo);

  const overlay = document.createElement('div');
  overlay.className = 'mini-screen-overlay';
  overlay.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="white"><path d="M8 5v14l11-7z"/></svg>';
  thumb.appendChild(overlay);
  card.appendChild(thumb);

  const info = document.createElement('div');
  info.className = 'mini-info';
  info.innerHTML = `
    <div class="mini-avatar" style="background: ${avatarColor}">${avatarIcon}</div>
    <span>${escapeHtml(displayName)}</span>
  `;
  card.appendChild(info);

  // Click to swap into main area
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    swapFocusedShare(peerId);
  });

  // Right-click for context menu
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, peerId);
  });

  return card;
}

function swapFocusedShare(newPeerId) {
  if (!activeScreenShares.has(newPeerId)) return;

  const allEls = [...mainScreensContainer.children, ...sidebarContainer.children];
  animateFLIP(allEls, () => {
    focusedShareId = newPeerId;
    renderFocusContent();
  });
}

// ===== Context Menu =====
function showContextMenu(x, y, peerId) {
  contextMenuTargetId = peerId;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 100)}px`;
  contextMenu.classList.add('show');

  setTimeout(() => {
    document.addEventListener('click', hideContextMenuOutside);
  }, 10);
}

function hideContextMenu() {
  contextMenu.classList.remove('show');
  contextMenuTargetId = null;
  document.removeEventListener('click', hideContextMenuOutside);
}

function hideContextMenuOutside(e) {
  if (!contextMenu.contains(e.target)) {
    hideContextMenu();
  }
}

// Context menu actions
ctxSwap.addEventListener('click', () => {
  if (contextMenuTargetId) {
    swapFocusedShare(contextMenuTargetId);
  }
  hideContextMenu();
});

ctxSplit.addEventListener('click', () => {
  // Split: show both screens in main area side by side
  if (contextMenuTargetId && activeScreenShares.has(contextMenuTargetId)) {
    const share = activeScreenShares.get(contextMenuTargetId);
    const item = createShareItem(contextMenuTargetId, share);
    mainScreensContainer.appendChild(item);
  }
  hideContextMenu();
});

// ===== Profile Popup =====
let activeProfilePopup = null;

function showProfilePopup(anchorEl) {
  closeVolumePopup();
  closeProfilePopup();

  const popup = document.createElement('div');
  popup.className = 'profile-popup';
  popup.id = 'profile-popup';

  let tempColor = selectedColor;
  let tempIcon = selectedIcon;

  let colorsHTML = '';
  for (const color of AVATAR_COLORS) {
    colorsHTML += `<div class="color-option${color === tempColor ? ' selected' : ''}" data-color="${color}" style="background:${color}" role="button" tabindex="0" aria-label="Цвет ${color}"></div>`;
  }

  let iconsHTML = '';
  for (const icon of AVATAR_ICONS) {
    iconsHTML += `<div class="icon-option${icon === tempIcon ? ' selected' : ''}" data-icon="${icon}" role="button" tabindex="0" aria-label="Иконка ${icon}">${icon}</div>`;
  }

  popup.innerHTML = `
    <div class="profile-popup-header">Редактировать профиль</div>
    <div class="profile-popup-section">
      <label>Имя</label>
      <input type="text" id="profile-name-input" value="${escapeHtml(username)}" maxlength="20" autocomplete="off">
    </div>
    <div class="profile-popup-section">
      <label>Цвет</label>
      <div class="color-options profile-colors">${colorsHTML}</div>
    </div>
    <div class="profile-popup-section">
      <label>Иконка</label>
      <div class="icon-options profile-icons">${iconsHTML}</div>
    </div>
    <button class="btn primary profile-save-btn" id="profile-save-btn">Сохранить</button>
  `;

  document.body.appendChild(popup);

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - 120, window.innerWidth - 260))}px`;
  popup.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - popup.offsetHeight - 8))}px`;

  // Color clicks
  popup.querySelectorAll('.profile-colors .color-option').forEach(el => {
    const selectColor = () => {
      tempColor = el.dataset.color;
      popup.querySelectorAll('.profile-colors .color-option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
    };
    el.addEventListener('click', selectColor);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectColor(); }
    });
  });

  // Icon clicks
  popup.querySelectorAll('.profile-icons .icon-option').forEach(el => {
    const selectIcon = () => {
      tempIcon = el.dataset.icon;
      popup.querySelectorAll('.profile-icons .icon-option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
    };
    el.addEventListener('click', selectIcon);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectIcon(); }
    });
  });

  // Save
  popup.querySelector('#profile-save-btn').addEventListener('click', () => {
    const newName = popup.querySelector('#profile-name-input').value.trim();
    if (!newName) {
      showToast('Имя не может быть пустым', true);
      return;
    }
    username = newName;
    selectedColor = tempColor;
    selectedIcon = tempIcon;
    localStorage.setItem('username', username);
    localStorage.setItem('avatar-color', selectedColor);
    localStorage.setItem('avatar-icon', selectedIcon);

    // Update lobby pickers if they exist
    updateAvatarPreview();
    updateAccordionMiniAvatar();
    usernameInput.value = username;

    send({ type: 'update-profile', username, avatar: { color: selectedColor, icon: selectedIcon } });
    renderParticipants();
    closeProfilePopup();
  });

  activeProfilePopup = popup;

  setTimeout(() => {
    document.addEventListener('click', closeProfilePopupOutside);
  }, 10);
}

function closeProfilePopup() {
  if (activeProfilePopup) {
    activeProfilePopup.remove();
    activeProfilePopup = null;
    document.removeEventListener('click', closeProfilePopupOutside);
  }
}

function closeProfilePopupOutside(e) {
  if (activeProfilePopup && !activeProfilePopup.contains(e.target)) {
    closeProfilePopup();
  }
}

// ===== Volume Control =====
let activeVolumePopup = null;

function showVolumePopup(peerId, anchorEl) {
  closeVolumePopup();
  const peer = peers.get(peerId);
  if (!peer) return;

  const popup = document.createElement('div');
  popup.className = 'volume-popup';
  popup.id = 'volume-popup';
  popup.dataset.peerId = String(peerId);

  const currentVolume = peer.gainNode ? Math.round(peer.gainNode.gain.value * 100) : 100;
  const isLocallyMuted = peer.locallyMuted || false;

  popup.innerHTML = `
    <div class="volume-popup-name">${escapeHtml(peer.username)}</div>
    <div class="volume-popup-slider">
      <input type="range" min="0" max="200" value="${isLocallyMuted ? 0 : currentVolume}" id="volume-slider" aria-label="Громкость ${escapeHtml(peer.username)}" ${isLocallyMuted ? 'disabled' : ''}>
      <span class="volume-popup-value" id="volume-value">${isLocallyMuted ? '0%' : currentVolume + '%'}</span>
    </div>
    <button class="volume-popup-mute-btn ${isLocallyMuted ? 'active' : ''}" id="volume-mute-btn">
      ${isLocallyMuted ? 'Размутить' : 'Замутить'}
    </button>
  `;

  document.body.appendChild(popup);

  // Position near anchor with bounds checking
  const rect = anchorEl.getBoundingClientRect();
  const popupWidth = 180;
  const popupHeight = popup.offsetHeight || 120;
  let left = rect.left + rect.width / 2 - popupWidth / 2;
  let top = rect.bottom + 8;

  // Bounds
  left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
  if (top + popupHeight > window.innerHeight - 8) {
    top = rect.top - popupHeight - 8;
  }
  top = Math.max(8, top);

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  const slider = popup.querySelector('#volume-slider');
  const valueEl = popup.querySelector('#volume-value');
  const muteLocalBtn = popup.querySelector('#volume-mute-btn');

  slider.addEventListener('input', () => {
    const val = parseInt(slider.value);
    valueEl.textContent = `${val}%`;
    if (peer.gainNode) {
      peer.gainNode.gain.value = val / 100;
    }
  });

  muteLocalBtn.addEventListener('click', () => {
    peer.locallyMuted = !peer.locallyMuted;
    if (peer.locallyMuted) {
      peer._savedVolume = peer.gainNode ? peer.gainNode.gain.value : 1.0;
      if (peer.gainNode) peer.gainNode.gain.value = 0;
      slider.value = 0;
      slider.disabled = true;
      valueEl.textContent = '0%';
      muteLocalBtn.textContent = 'Размутить';
      muteLocalBtn.classList.add('active');
    } else {
      const restored = peer._savedVolume ?? 1.0;
      if (peer.gainNode) peer.gainNode.gain.value = restored;
      slider.value = Math.round(restored * 100);
      slider.disabled = false;
      valueEl.textContent = `${Math.round(restored * 100)}%`;
      muteLocalBtn.textContent = 'Замутить';
      muteLocalBtn.classList.remove('active');
    }
  });

  activeVolumePopup = popup;

  // Close on click outside (delayed to avoid instant close)
  setTimeout(() => {
    document.addEventListener('click', closeVolumePopupOutside);
  }, 10);
}

function closeVolumePopup() {
  if (activeVolumePopup) {
    activeVolumePopup.remove();
    activeVolumePopup = null;
    document.removeEventListener('click', closeVolumePopupOutside);
  }
}

function closeVolumePopupOutside(e) {
  if (activeVolumePopup && !activeVolumePopup.contains(e.target)) {
    closeVolumePopup();
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

function initAvatarPicker() {
  // Colors
  for (const color of AVATAR_COLORS) {
    const el = document.createElement('div');
    el.className = 'color-option' + (color === selectedColor ? ' selected' : '');
    el.style.background = color;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `Цвет ${color}`);
    const selectColor = () => {
      selectedColor = color;
      localStorage.setItem('avatar-color', color);
      colorPickerEl.querySelectorAll('.color-option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      updateAvatarPreview();
      updateAccordionMiniAvatar();
      // Pop animation
      avatarPreviewEl.classList.remove('pop');
      void avatarPreviewEl.offsetWidth;
      avatarPreviewEl.classList.add('pop');
    };
    el.addEventListener('click', selectColor);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectColor(); }
    });
    // Hover preview
    el.addEventListener('mouseenter', () => {
      avatarPreviewEl.style.background = hexToRgba(color, 0.2);
      avatarPreviewEl.style.borderColor = hexToRgba(color, 0.4);
    });
    el.addEventListener('mouseleave', () => {
      updateAvatarPreview();
    });
    colorPickerEl.appendChild(el);
  }

  // Icons
  for (const icon of AVATAR_ICONS) {
    const el = document.createElement('div');
    el.className = 'icon-option' + (icon === selectedIcon ? ' selected' : '');
    el.textContent = icon;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `Иконка ${icon}`);
    const selectIcon = () => {
      selectedIcon = icon;
      localStorage.setItem('avatar-icon', icon);
      iconPickerEl.querySelectorAll('.icon-option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      updateAvatarPreview();
      updateAccordionMiniAvatar();
      // Pop animations
      avatarPreviewEl.classList.remove('pop');
      void avatarPreviewEl.offsetWidth;
      avatarPreviewEl.classList.add('pop');
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    };
    el.addEventListener('click', selectIcon);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectIcon(); }
    });
    // Hover preview
    el.addEventListener('mouseenter', () => {
      avatarPreviewEl.textContent = icon;
    });
    el.addEventListener('mouseleave', () => {
      updateAvatarPreview();
    });
    iconPickerEl.appendChild(el);
  }

  updateAvatarPreview();
}

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function updateAvatarPreview() {
  avatarPreviewEl.style.background = hexToRgba(selectedColor, 0.2);
  avatarPreviewEl.style.borderColor = hexToRgba(selectedColor, 0.4);
  avatarPreviewEl.textContent = selectedIcon;
}

function updateAccordionMiniAvatar() {
  const miniAvatar = document.getElementById('accordion-mini-avatar');
  if (miniAvatar) {
    miniAvatar.style.background = hexToRgba(selectedColor, 0.3);
    miniAvatar.textContent = selectedIcon;
  }
}

// ===== Accordion Lobby =====
let currentStep = 1;

function initAccordion() {
  const avatarContinueBtn = document.getElementById('avatar-continue-btn');
  const usernameContinueBtn = document.getElementById('username-continue-btn');

  // If returning user with saved data, auto-complete steps
  const savedUsername = localStorage.getItem('username');
  if (savedUsername) {
    usernameInput.value = savedUsername;
    completeStep(1);
    completeStep(2);
  }

  // Step 1: Avatar continue button
  avatarContinueBtn.addEventListener('click', () => completeStep(1));

  // Step 2: Username continue button
  usernameContinueBtn.addEventListener('click', () => {
    if (usernameInput.value.trim().length >= 1) {
      completeStep(2);
    } else {
      showToast('введи ник падла', true);
      usernameInput.focus();
    }
  });

  // Headers click navigation with validation
  document.getElementById('step-avatar-header').addEventListener('click', () => {
    const stepEl = document.getElementById('step-avatar');
    if (stepEl.classList.contains('active')) return; // already active, no hover/action
    goToStep(1);
  });

  document.getElementById('step-username-header').addEventListener('click', () => {
    const stepEl = document.getElementById('step-username');
    if (stepEl.classList.contains('active')) return;
    if (stepEl.classList.contains('locked')) {
      // Step 1 not completed — just complete it and go forward
      completeStep(1);
      return;
    }
    goToStep(2);
  });

  document.getElementById('step-rooms-header').addEventListener('click', () => {
    const stepEl = document.getElementById('step-rooms');
    if (stepEl.classList.contains('active')) return;
    if (stepEl.classList.contains('locked')) {
      // Validate: if step 2 is active/unlocked but username is empty
      const step2 = document.getElementById('step-username');
      if (step2.classList.contains('locked')) {
        // Step 1 not completed yet
        completeStep(1);
        return;
      }
      if (usernameInput.value.trim().length < 1) {
        showToast('введи ник падла', true);
        usernameInput.focus();
        return;
      }
      // Username filled, complete step 2 to unlock step 3
      completeStep(2);
      return;
    }
    // Not locked — navigate to it, but validate username first
    if (usernameInput.value.trim().length < 1) {
      showToast('введи ник падла', true);
      usernameInput.focus();
      lockStep(3);
      goToStep(2);
      return;
    }
    goToStep(3);
  });

  // Char counter
  const charCountEl = document.getElementById('char-count');
  const updateCharCount = () => {
    const len = usernameInput.value.length;
    charCountEl.textContent = `${len}/20`;
    charCountEl.className = 'char-count' + (len > 16 ? ' warn' : '');
  };

  // Init char count from saved value
  updateCharCount();

  // Username input — enable/disable continue button
  usernameInput.addEventListener('input', () => {
    updateCharCount();
    if (usernameInput.value.trim().length >= 1) {
      usernameContinueBtn.classList.remove('disabled');
    } else {
      usernameContinueBtn.classList.add('disabled');
      // If step 3 was unlocked, lock it back
      if (document.getElementById('step-rooms').classList.contains('completed') ||
          document.getElementById('step-rooms').classList.contains('active')) {
        lockStep(3);
      }
      document.getElementById('step-username').classList.remove('completed');
      document.getElementById('step-username').classList.add('active');
      document.getElementById('step-username-preview').style.display = 'none';
    }
  });

  // Enter key in username input submits
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && usernameInput.value.trim().length >= 1) {
      completeStep(2);
    }
  });
}

function goToStep(step) {
  document.querySelectorAll('.accordion-step').forEach(el => {
    if (!el.classList.contains('locked')) {
      el.classList.remove('active');
    }
  });

  const stepMap = { 1: 'step-avatar', 2: 'step-username', 3: 'step-rooms' };
  const el = document.getElementById(stepMap[step]);
  if (el && !el.classList.contains('locked')) {
    el.classList.add('active');
    el.classList.remove('completed');
    currentStep = step;

    if (step === 2) {
      setTimeout(() => usernameInput.focus(), 100);
    }
  }
}

function completeStep(step) {
  const stepMap = { 1: 'step-avatar', 2: 'step-username', 3: 'step-rooms' };
  const el = document.getElementById(stepMap[step]);
  if (!el) return;

  el.classList.remove('locked', 'active');
  el.classList.add('completed');

  if (step === 1) {
    const preview = document.getElementById('step-avatar-preview');
    const miniAvatar = document.getElementById('accordion-mini-avatar');
    miniAvatar.style.background = selectedColor;
    miniAvatar.textContent = selectedIcon;
    preview.style.display = '';
  }
  if (step === 2) {
    const preview = document.getElementById('step-username-preview');
    const previewText = document.getElementById('accordion-preview-username');
    previewText.textContent = usernameInput.value.trim();
    preview.style.display = '';
  }

  // Unlock and activate next step
  const nextStep = step + 1;
  if (nextStep <= 3) {
    const nextEl = document.getElementById(stepMap[nextStep]);
    if (nextEl) {
      nextEl.classList.remove('locked');
      if (!nextEl.classList.contains('completed')) {
        nextEl.classList.add('active');
        currentStep = nextStep;
        if (nextStep === 2) {
          setTimeout(() => usernameInput.focus(), 100);
        }
      }
    }
  }
}

function lockStep(step) {
  const stepMap = { 1: 'step-avatar', 2: 'step-username', 3: 'step-rooms' };
  for (let s = step; s <= 3; s++) {
    const el = document.getElementById(stepMap[s]);
    if (el) {
      el.classList.remove('active', 'completed');
      el.classList.add('locked');
    }
  }
}

// ===== Event Listeners =====
muteBtn.addEventListener('click', () => toggleMute());
deafenBtn.addEventListener('click', toggleDeafen);
screenBtn.addEventListener('click', toggleScreenShare);
chatBtn.addEventListener('click', toggleChat);
chatCloseBtn.addEventListener('click', toggleChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});
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
initAccordion();
connectWS();
