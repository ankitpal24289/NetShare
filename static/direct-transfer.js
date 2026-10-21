(() => {
  const $ = id => document.getElementById(id);
  const createBtn = $('create-room-btn');
  const joinBtn = $('join-room-btn');
  const roomInput = $('room-code-input');
  const roomCodeDisplay = $('room-code-display');
  const copyRoomBtn = $('copy-room-btn');
  const connectionStatus = $('direct-status');
  const transferControls = $('transfer-controls');
  const fileInput = $('direct-file-input');
  const sendBtn = $('send-direct-btn');
  const fileLabel = $('direct-file-label');
  const progressWrap = $('direct-progress-wrap');
  const progressBar = $('direct-progress');
  const progressText = $('direct-progress-text');
  const receivedFiles = $('received-files');
  const transferLog = $('transfer-log');
  const participantList = $('participant-list');
  const leaveBtn = $('leave-room-btn');

  if (!createBtn || !window.io) {
    if (connectionStatus) connectionStatus.textContent = 'The Socket.IO client could not load. Refresh and check your internet connection.';
    return;
  }

  let socket;
  let roomCode = '';
  let joined = false;
  let sending = false;
  let pendingJoinCode = '';
  const peers = new Map(); // peer socket ID -> { pc, channel, pendingIce, incoming }
  const CHUNK_SIZE = 16 * 1024;
  const MAX_DIRECT_SIZE = 500 * 1024 * 1024;
  const MAX_ROOM_MEMBERS = 5;

  function log(message, type = '') {
    const item = document.createElement('div');
    item.className = `log-item ${type}`;
    item.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
    transferLog.prepend(item);
  }
  function setStatus(message, state = '') {
    connectionStatus.textContent = message;
    connectionStatus.className = `direct-status ${state}`;
  }
  function setProgress(percent, message) {
    progressWrap.hidden = false;
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    progressText.textContent = message;
  }
  function makeCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes / 1024, index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return `${size.toFixed(1)} ${units[index]}`;
  }
  function updateParticipants() {
    if (!participantList) return;
    participantList.replaceChildren();
    const ids = socket?.id ? [socket.id, ...peers.keys()] : [...peers.keys()];
    if (!ids.length) {
      const li = document.createElement('li');
      li.textContent = 'No participants yet';
      participantList.append(li);
      return;
    }
    ids.forEach((id, index) => {
      const li = document.createElement('li');
      li.textContent = `${id === socket?.id ? 'You' : `Participant ${index + 1}`} · ${id === socket?.id ? 'this device' : (peers.get(id)?.pc.connectionState || 'connecting')}`;
      participantList.append(li);
    });
  }
  function connectSocket() {
    if (socket) return socket;
    socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 8, timeout: 15000 });
    socket.on('connect', () => {
      log('Connected to signaling server.');
      if (pendingJoinCode && !joined) {
        const code = pendingJoinCode;
        pendingJoinCode = '';
        socket.emit('transfer:join', { room: code });
      }
    });
    socket.on('connect_error', error => {
      setStatus(`Cannot reach signaling server: ${error.message || 'connection error'}.`, 'error');
      log('Socket connection failed. Check Render logs and refresh.', 'error');
    });
    socket.on('transfer:joined', data => {
      joined = true;
      roomCode = data.room;
      roomCodeDisplay.textContent = roomCode;
      roomCodeDisplay.hidden = false;
      $('room-code-placeholder').hidden = true;
      copyRoomBtn.hidden = false;
      leaveBtn.hidden = false;
      const count = Number(data.count || 1);
      setStatus(`Joined room ${roomCode}. ${count} participant${count === 1 ? '' : 's'} present; connecting…`, 'waiting');
      log(`Joined room ${roomCode}. You can share this code with up to ${MAX_ROOM_MEMBERS - 1} other participants.`);
      (data.peers || []).forEach(peerId => createPeer(peerId, false));
      updateParticipants();
    });
    socket.on('transfer:peer-joined', data => {
      if (!joined || data.room !== roomCode || !data.sid || data.sid === socket.id) return;
      log('A participant joined the room.');
      createPeer(data.sid, true);
      updateParticipants();
    });
    socket.on('transfer:signal', async message => {
      if (!joined || message.room !== roomCode || !message.from || message.from === socket.id) return;
      try {
        const entry = createPeer(message.from, false);
        const pc = entry.pc;
        if (message.kind === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
          for (const candidate of entry.pendingIce) await pc.addIceCandidate(candidate);
          entry.pendingIce = [];
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(message.from, 'answer', pc.localDescription.toJSON());
        } else if (message.kind === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
          for (const candidate of entry.pendingIce) await pc.addIceCandidate(candidate);
          entry.pendingIce = [];
        } else if (message.kind === 'ice' && message.payload) {
          const candidate = new RTCIceCandidate(message.payload);
          if (pc.remoteDescription) await pc.addIceCandidate(candidate);
          else entry.pendingIce.push(candidate);
        }
      } catch (error) {
        log(`Connection negotiation issue: ${error.message}`, 'error');
      }
    });
    socket.on('transfer:error', data => {
      setStatus(data.message || 'Could not join the room.', 'error');
      log(data.message || 'Room error.', 'error');
      joined = false;
      pendingJoinCode = '';
    });
    socket.on('transfer:peer-left', data => {
      const entry = peers.get(data.sid);
      if (entry) {
        try { entry.channel?.close(); entry.pc.close(); } catch (_) {}
        peers.delete(data.sid);
      }
      updateParticipants();
      if (joined) setStatus(`A participant left. ${peers.size + 1} participant(s) remain.`, 'waiting');
      log('A participant left the room.');
    });
    socket.on('transfer:left', () => log('You left the room.'));
    socket.on('disconnect', reason => {
      setStatus(`Signaling disconnected (${reason}). Trying to reconnect…`, 'error');
    });
    return socket;
  }
  function sendSignal(target, kind, payload) {
    if (socket?.connected && roomCode) socket.emit('transfer:signal', { room: roomCode, target, kind, payload });
  }
  function createPeer(peerId, shouldInitiate) {
    if (peers.has(peerId)) return peers.get(peerId);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    const entry = { pc, channel: null, pendingIce: [], incoming: null };
    peers.set(peerId, entry);

    pc.onicecandidate = event => {
      if (event.candidate) sendSignal(peerId, 'ice', event.candidate.toJSON());
    };
    pc.ondatachannel = event => configureChannel(entry, event.channel, peerId);
    pc.onconnectionstatechange = () => {
      updateParticipants();
      const states = [...peers.values()].map(p => p.pc.connectionState);
      const connected = states.filter(state => state === 'connected').length;
      if (connected > 0) {
        transferControls.hidden = false;
        setStatus(`Connected to ${connected} participant${connected === 1 ? '' : 's'}. Ready to transfer files.`, 'connected');
      } else if (states.some(state => state === 'failed')) {
        setStatus('A direct connection failed. Try another network; some networks require a TURN relay.', 'error');
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') log('ICE connection failed. A TURN relay may be needed on this network.', 'error');
    };
    if (shouldInitiate) {
      const channel = pc.createDataChannel('netshare-file', { ordered: true });
      configureChannel(entry, channel, peerId);
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => sendSignal(peerId, 'offer', pc.localDescription.toJSON()))
        .catch(error => log(`Could not start connection: ${error.message}`, 'error'));
    }
    updateParticipants();
    return entry;
  }
  function configureChannel(entry, channel, peerId) {
    entry.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 64 * 1024;
    channel.onopen = () => {
      transferControls.hidden = false;
      setStatus(`Connected to ${[...peers.values()].filter(p => p.channel?.readyState === 'open').length} participant(s). Ready to transfer files.`, 'connected');
      log('A peer-to-peer file channel is ready.', 'success');
      updateParticipants();
    };
    channel.onclose = () => { log('A participant file channel closed.'); updateParticipants(); };
    channel.onerror = () => log('A data-channel error occurred.', 'error');
    channel.onmessage = event => handleIncomingMessage(entry, event, peerId);
  }
  function closeAllPeers() {
    for (const entry of peers.values()) {
      try { entry.channel?.close(); entry.pc.close(); } catch (_) {}
    }
    peers.clear();
    transferControls.hidden = true;
    updateParticipants();
  }
  function joinRoom(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(clean)) {
      setStatus('Room codes must contain 4–12 letters or numbers.', 'error');
      return;
    }
    closeAllPeers();
    joined = false;
    roomCode = clean;
    pendingJoinCode = clean;
    roomCodeDisplay.textContent = clean;
    connectSocket();
    if (socket.connected) {
      pendingJoinCode = '';
      socket.emit('transfer:join', { room: clean });
    } else {
      setStatus('Connecting to the signaling server…', 'waiting');
      // The connect handler sends the join event when ready.
    }
  }
  createBtn.addEventListener('click', () => {
    if (joined && socket) socket.emit('transfer:leave');
    closeAllPeers();
    joined = false;
    pendingJoinCode = '';
    joinRoom(makeCode());
  });
  joinBtn.addEventListener('click', () => {
    if (joined && socket) socket.emit('transfer:leave');
    joinRoom(roomInput.value);
  });
  roomInput.addEventListener('input', () => {
    roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  });
  leaveBtn.addEventListener('click', () => {
    if (socket && joined) socket.emit('transfer:leave');
    closeAllPeers();
    joined = false;
    roomCode = '';
    pendingJoinCode = '';
    leaveBtn.hidden = true;
    copyRoomBtn.hidden = true;
    roomCodeDisplay.hidden = true;
    $('room-code-placeholder').hidden = false;
    setStatus('You left the room. Create or join a room to continue.', 'waiting');
  });
  copyRoomBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(roomCodeDisplay.textContent);
      copyRoomBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyRoomBtn.textContent = 'Copy code'; }, 1500);
    } catch (_) {
      roomInput.value = roomCodeDisplay.textContent;
      roomInput.focus();
      roomInput.select();
      setStatus('Select the room code and copy it manually.', 'waiting');
    }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileLabel.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : 'Choose a file to send';
  });
  function waitForBuffer(channel) {
    if (channel.bufferedAmount < 1024 * 1024) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { channel.removeEventListener('bufferedamountlow', done); resolve(); };
      channel.addEventListener('bufferedamountlow', done, { once: true });
    });
  }
  sendBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) { setStatus('Choose a file first.', 'error'); return; }
    if (file.size > MAX_DIRECT_SIZE) { setStatus('Direct transfers are limited to 500 MB per file in this demo.', 'error'); return; }
    const channels = [...peers.values()].map(entry => entry.channel).filter(channel => channel?.readyState === 'open');
    if (!channels.length) { setStatus('Wait until at least one participant is connected.', 'error'); return; }
    if (sending) return;
    sending = true;
    sendBtn.disabled = true;
    try {
      const meta = JSON.stringify({ type: 'file-meta', transferId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' });
      channels.forEach(channel => channel.send(meta));
      let offset = 0;
      while (offset < file.size) {
        await Promise.all(channels.map(waitForBuffer));
        const chunk = await file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size)).arrayBuffer();
        channels.forEach(channel => {
          if (channel.readyState === 'open') channel.send(chunk);
        });
        offset += chunk.byteLength;
        setProgress(offset / Math.max(file.size, 1) * 100, `Sending ${file.name}: ${Math.round(offset / Math.max(file.size, 1) * 100)}% to ${channels.length} participant(s)`);
      }
      const end = JSON.stringify({ type: 'file-end', name: file.name });
      channels.forEach(channel => { if (channel.readyState === 'open') channel.send(end); });
      setProgress(100, `Sent ${file.name} (${formatBytes(file.size)}) to ${channels.length} participant(s).`);
      log(`Sent ${file.name} (${formatBytes(file.size)}) to ${channels.length} participant(s).`, 'success');
    } catch (error) {
      setStatus(`Transfer failed: ${error.message}`, 'error');
      log(`Transfer failed: ${error.message}`, 'error');
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  });
  function handleIncomingMessage(entry, event, peerId) {
    if (typeof event.data === 'string') {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'file-meta') {
        entry.incoming = { ...message, chunks: [], bytes: 0, peerId };
        setProgress(0, `Receiving ${message.name}: 0%`);
        log(`Receiving ${message.name} (${formatBytes(message.size)}) from a participant.`);
      } else if (message.type === 'file-end' && entry.incoming) {
        const incoming = entry.incoming;
        const blob = new Blob(incoming.chunks, { type: incoming.mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const item = document.createElement('div');
        item.className = 'received-file';
        const info = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = incoming.name;
        const size = document.createElement('span');
        size.textContent = `${formatBytes(incoming.size)} · received from participant`;
        const link = document.createElement('a');
        link.href = url;
        link.download = incoming.name;
        link.className = 'button secondary';
        link.textContent = 'Save file ↓';
        info.append(title, size);
        item.append(info, link);
        receivedFiles.prepend(item);
        setProgress(100, `Received ${incoming.name} (${formatBytes(incoming.size)}).`);
        log(`Received ${incoming.name}. Click Save file to download it.`, 'success');
        entry.incoming = null;
      }
    } else if (entry.incoming) {
      entry.incoming.chunks.push(event.data);
      entry.incoming.bytes += event.data.byteLength;
      setProgress(entry.incoming.bytes / Math.max(entry.incoming.size, 1) * 100,
        `Receiving ${entry.incoming.name}: ${Math.round(entry.incoming.bytes / Math.max(entry.incoming.size, 1) * 100)}%`);
    }
  }
  connectSocket();
})();
