(() => {
  const $ = (id) => document.getElementById(id);
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

  if (!createBtn || !window.io) return;

  let socket = null;
  let roomCode = '';
  let pc = null;
  let dataChannel = null;
  let joined = false;
  let isInitiator = false;
  let currentIncoming = null;
  let receivedChunks = [];
  let receivedBytes = 0;
  let sending = false;
  let pendingIceCandidates = [];
  const CHUNK_SIZE = 16 * 1024;
  const MAX_DIRECT_SIZE = 500 * 1024 * 1024;

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
    let result = '';
    for (let i = 0; i < 6; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
  }
  function connectSocket() {
    if (socket) return;
    socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => log('Connected to signaling server.'));
    socket.on('connect_error', () => setStatus('Cannot reach the signaling server. Check that NetShare is running.', 'error'));
    socket.on('transfer:joined', (data) => {
      joined = true;
      roomCode = data.room;
      roomCodeDisplay.textContent = roomCode;
      roomCodeDisplay.hidden = false;
      $('room-code-placeholder').hidden = true;
      copyRoomBtn.hidden = false;
      setStatus(data.waiting ? 'Room created. Waiting for the other device…' : 'Joined room. Connecting…', 'waiting');
      log(data.waiting ? `Room ${roomCode} created. Share the code with the receiver.` : `Joined room ${roomCode}.`);
    });
    socket.on('transfer:room-ready', async (data) => {
      isInitiator = Boolean(data.initiator);
      createPeerConnection();
      setStatus('Both devices joined. Establishing direct connection…', 'waiting');
      if (isInitiator) {
        try {
          dataChannel = pc.createDataChannel('netshare-file', { ordered: true });
          configureDataChannel(dataChannel);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('transfer:signal', { room: roomCode, kind: 'offer', payload: pc.localDescription.toJSON() });
        } catch (error) {
          log(`Could not start connection: ${error.message}`, 'error');
        }
      }
    });
    socket.on('transfer:signal', async (message) => {
      try {
        if (!pc) createPeerConnection();
        if (message.kind === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
          for (const candidate of pendingIceCandidates) await pc.addIceCandidate(candidate);
          pendingIceCandidates = [];
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('transfer:signal', { room: roomCode, kind: 'answer', payload: pc.localDescription.toJSON() });
        } else if (message.kind === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
          for (const candidate of pendingIceCandidates) await pc.addIceCandidate(candidate);
          pendingIceCandidates = [];
        } else if (message.kind === 'ice' && message.payload) {
          const candidate = new RTCIceCandidate(message.payload);
          if (pc.remoteDescription && pc.remoteDescription.type) await pc.addIceCandidate(candidate);
          else pendingIceCandidates.push(candidate);
        }
      } catch (error) {
        log(`Connection negotiation issue: ${error.message}`, 'error');
      }
    });
    socket.on('transfer:error', (data) => {
      setStatus(data.message || 'Could not join the room.', 'error');
      log(data.message || 'Room error.', 'error');
      joined = false;
    });
    socket.on('transfer:peer-left', () => {
      setStatus('The other device disconnected. Create or join a room again to reconnect.', 'error');
      log('The other device left the room.', 'error');
      resetPeerConnection();
      joined = false;
    });
    socket.on('disconnect', () => setStatus('Signaling connection lost. Refresh the page to reconnect.', 'error'));
  }
  function createPeerConnection() {
    if (pc) return;
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    pc.onicecandidate = (event) => {
      if (event.candidate && socket && roomCode) {
        socket.emit('transfer:signal', { room: roomCode, kind: 'ice', payload: event.candidate.toJSON() });
      }
    };
    pc.ondatachannel = (event) => {
      dataChannel = event.channel;
      configureDataChannel(dataChannel);
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        setStatus('Direct connection established. Ready to transfer files.', 'connected');
        transferControls.hidden = false;
        log('Peer-to-peer connection established. File data will use WebRTC.');
      } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        setStatus(`Connection ${pc.connectionState}. Try again on the same Wi-Fi.`, 'error');
      }
    };
  }
  function configureDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 64 * 1024;
    channel.onopen = () => {
      transferControls.hidden = false;
      setStatus('Direct connection established. Ready to transfer files.', 'connected');
      log('Direct file-transfer channel is ready.');
    };
    channel.onclose = () => log('Direct transfer channel closed.', 'error');
    channel.onerror = () => log('A data-channel error occurred.', 'error');
    channel.onmessage = handleIncomingMessage;
  }
  function resetPeerConnection() {
    if (dataChannel) { try { dataChannel.close(); } catch (_) {} }
    if (pc) { try { pc.close(); } catch (_) {} }
    dataChannel = null;
    pc = null;
    pendingIceCandidates = [];
    transferControls.hidden = true;
  }
  function enterRoom(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(clean)) {
      setStatus('Room codes must contain 4–12 letters or numbers.', 'error');
      return;
    }
    connectSocket();
    roomCode = clean;
    roomCodeDisplay.textContent = clean;
    socket.emit('transfer:join', { room: clean });
  }
  createBtn.addEventListener('click', () => {
    if (socket && joined) socket.emit('transfer:leave');
    resetPeerConnection();
    joined = false;
    roomCode = makeCode();
    connectSocket();
    if (socket.connected) socket.emit('transfer:join', { room: roomCode });
    else socket.once('connect', () => socket.emit('transfer:join', { room: roomCode }));
  });
  joinBtn.addEventListener('click', () => {
    if (socket && joined) socket.emit('transfer:leave');
    resetPeerConnection();
    joined = false;
    enterRoom(roomInput.value);
  });
  roomInput.addEventListener('input', () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); });
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
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes / 1024, index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return `${size.toFixed(1)} ${units[index]}`;
  }
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
    if (file.size > MAX_DIRECT_SIZE) { setStatus('For this demo, direct transfers are limited to 500 MB per file.', 'error'); return; }
    if (!dataChannel || dataChannel.readyState !== 'open') { setStatus('Wait until the direct connection is ready.', 'error'); return; }
    if (sending) return;
    sending = true;
    sendBtn.disabled = true;
    try {
      dataChannel.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }));
      let offset = 0;
      while (offset < file.size) {
        await waitForBuffer(dataChannel);
        const chunk = await file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size)).arrayBuffer();
        dataChannel.send(chunk);
        offset += chunk.byteLength;
        setProgress((offset / Math.max(file.size, 1)) * 100, `Sending ${file.name}: ${Math.round(offset / Math.max(file.size, 1) * 100)}%`);
      }
      dataChannel.send(JSON.stringify({ type: 'file-end', name: file.name }));
      setProgress(100, `Sent ${file.name} (${formatBytes(file.size)}).`);
      log(`Sent ${file.name} directly (${formatBytes(file.size)}).`, 'success');
    } catch (error) {
      setStatus(`Transfer failed: ${error.message}`, 'error');
      log(`Transfer failed: ${error.message}`, 'error');
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  });
  function handleIncomingMessage(event) {
    if (typeof event.data === 'string') {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'file-meta') {
        currentIncoming = message;
        receivedChunks = [];
        receivedBytes = 0;
        setProgress(0, `Receiving ${message.name}: 0%`);
        log(`Receiving ${message.name} (${formatBytes(message.size)}).`);
      } else if (message.type === 'file-end' && currentIncoming) {
        const blob = new Blob(receivedChunks, { type: currentIncoming.mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const item = document.createElement('div');
        item.className = 'received-file';
        const info = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = currentIncoming.name;
        const size = document.createElement('span');
        size.textContent = formatBytes(currentIncoming.size);
        const link = document.createElement('a');
        link.href = url;
        link.download = currentIncoming.name;
        link.className = 'button secondary';
        link.textContent = 'Save file ↓';
        info.append(title, size);
        item.append(info, link);
        receivedFiles.prepend(item);
        setProgress(100, `Received ${currentIncoming.name} (${formatBytes(currentIncoming.size)}).`);
        log(`Received ${currentIncoming.name}. Click Save file to download it.`, 'success');
        currentIncoming = null;
        receivedChunks = [];
      }
    } else if (currentIncoming) {
      receivedChunks.push(event.data);
      receivedBytes += event.data.byteLength;
      setProgress((receivedBytes / Math.max(currentIncoming.size, 1)) * 100, `Receiving ${currentIncoming.name}: ${Math.round(receivedBytes / Math.max(currentIncoming.size, 1) * 100)}%`);
    }
  }
})();
