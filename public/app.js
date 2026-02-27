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
const chatPanel = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatBtn = document.getElementById('chat-btn');
const chatCloseBtn = document.getElementById('chat-close-btn');
const chatUnread = document.getElementById('chat-unread');
const screenBtn = document.getElementById('screen-btn');
const mainArea = document.querySelector('.main-area');

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
          roomCountEl.textContent = `${room.count}/10`;
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
  lobbyScreen.classList.remove('active');
  roomScreen.classList.add('active');
  roomNameEl.textContent = currentRoom;
  const room = roomsData.find(r => r.name === currentRoom);
  roomCountEl.textContent = room ? `${room.count}/10` : '';
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

  chatMessages.innerHTML = '';
  isChatOpen = false;
  chatPanel.classList.remove('open');
  unreadCount = 0;
  chatUnread.style.display = 'none';

  stopScreenShare();
  activeScreenShares.clear();
  renderScreenShares();

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
    if (!audioContext) audioContext = new AudioContext();
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
  activeScreenShares.delete(id);
  renderScreenShares();
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

  // Remove track from all peers
  for (const [, peer] of peers) {
    if (peer.screenSender) {
      peer.pc.removeTrack(peer.screenSender);
      peer.screenSender = null;
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
  // Remove existing screenshare area
  const existing = document.querySelector('.screenshare-area');
  if (existing) existing.remove();

  const shares = Array.from(activeScreenShares.entries());

  if (shares.length === 0) {
    mainArea.classList.remove('has-screenshare');
    return;
  }

  mainArea.classList.add('has-screenshare');
  const area = document.createElement('div');
  area.className = `screenshare-area count-${Math.min(shares.length, 4)}`;

  for (const [, share] of shares) {
    const item = document.createElement('div');
    item.className = 'screenshare-item';
    item.appendChild(share.videoEl);

    const label = document.createElement('div');
    label.className = 'screenshare-label';
    label.textContent = share.username;
    item.appendChild(label);

    // PiP button
    if (document.pictureInPictureEnabled) {
      const pipBtn = document.createElement('button');
      pipBtn.className = 'screenshare-pip-btn';
      pipBtn.title = 'Picture-in-Picture';
      pipBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/></svg>`;
      pipBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          }
          await share.videoEl.requestPictureInPicture();
        } catch (err) {
          showToast('PiP недоступен', true);
        }
      });
      item.appendChild(pipBtn);
    }

    item.addEventListener('click', () => {
      item.classList.toggle('focused');
    });
    area.appendChild(item);
  }

  // Insert before participants
  mainArea.insertBefore(area, participantsEl);
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

  const currentVolume = peer.gainNode ? Math.round(peer.gainNode.gain.value * 100) : 100;
  const isLocallyMuted = peer.locallyMuted || false;

  popup.innerHTML = `
    <div class="volume-popup-name">${escapeHtml(peer.username)}</div>
    <div class="volume-popup-slider">
      <input type="range" min="0" max="200" value="${isLocallyMuted ? 0 : currentVolume}" id="volume-slider" ${isLocallyMuted ? 'disabled' : ''}>
      <span class="volume-popup-value" id="volume-value">${isLocallyMuted ? '0%' : currentVolume + '%'}</span>
    </div>
    <button class="volume-popup-mute-btn ${isLocallyMuted ? 'active' : ''}" id="volume-mute-btn">
      ${isLocallyMuted ? 'Размутить' : 'Замутить'}
    </button>
  `;

  document.body.appendChild(popup);

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = `${rect.left + rect.width / 2 - 90}px`;
  popup.style.top = `${rect.bottom + 8}px`;

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
    el.addEventListener('click', () => {
      selectedColor = color;
      localStorage.setItem('avatar-color', color);
      colorPickerEl.querySelectorAll('.color-option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      updateAvatarPreview();
      updateAccordionMiniAvatar();
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
      updateAccordionMiniAvatar();
    });
    iconPickerEl.appendChild(el);
  }

  updateAvatarPreview();
}

function updateAvatarPreview() {
  avatarPreviewEl.style.background = selectedColor;
  avatarPreviewEl.textContent = selectedIcon;
}

function updateAccordionMiniAvatar() {
  const miniAvatar = document.getElementById('accordion-mini-avatar');
  if (miniAvatar) {
    miniAvatar.style.background = selectedColor;
    miniAvatar.textContent = selectedIcon;
  }
}

// ===== Accordion Lobby =====
let currentStep = 1;

function initAccordion() {
  // Step 1 is active by default — avatar is pre-selected from localStorage
  // So immediately complete step 1 and unlock step 2
  completeStep(1);

  // If username saved, complete step 2
  const savedUsername = localStorage.getItem('username');
  if (savedUsername) {
    usernameInput.value = savedUsername;
    completeStep(2);
  }

  // Headers click to go back
  document.getElementById('step-avatar-header').addEventListener('click', () => goToStep(1));
  document.getElementById('step-username-header').addEventListener('click', () => {
    if (!document.getElementById('step-username').classList.contains('locked')) goToStep(2);
  });
  document.getElementById('step-rooms-header').addEventListener('click', () => {
    if (!document.getElementById('step-rooms').classList.contains('locked')) goToStep(3);
  });

  // Username input — unlock step 3 when typing
  usernameInput.addEventListener('input', () => {
    if (usernameInput.value.trim().length >= 1) {
      completeStep(2);
    } else {
      lockStep(3);
      document.getElementById('step-username').classList.remove('completed');
      document.getElementById('step-username').classList.add('active');
      document.getElementById('step-username-preview').style.display = 'none';
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
muteBtn.addEventListener('click', toggleMute);
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
