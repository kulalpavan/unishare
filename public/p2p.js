'use strict';

/* UniShare live P2P transfers — pure peer-to-peer edition.
 *
 * There is no server storage. The sender's tab holds the files and text;
 * the receiver pulls them over a WebRTC data channel. The server's /live
 * WebSocket hub only relays handshake signals and presence events.
 *
 * Wire protocol (data channel):
 *   receiver -> sender: { t: 'get-manifest' } | { t: 'get-text' } | { t: 'get-file', path }
 *   sender -> receiver: { t: 'manifest', ... } | { t: 'text', text }
 *                       | { t: 'file-start', path, size } + binary chunks + { t: 'file-end', path }
 *                       | { t: 'error', message }
 *   either way: { t: 'chat', from, text, at } — ephemeral chat. Messages
 *   travel only over the data channel, are kept only in page memory, and
 *   are never written to disk or sent to the server. Closing the tab
 *   erases them.
 *
 * Passwords are verified by comparing SHA-256 hashes: the sender registers
 * the hash, the receiver sends the hash of what was typed, and the server
 * compares them. Plaintext passwords never leave the browser that typed them.
 */

(function (global) {
  const CHUNK_SIZE = 16384; // 16KB chunks
  const BUFFER_HIGH_WATER = 256 * 1024;
  // Browsers cap a single data-channel message (~256KB). A manifest for a
  // large folder (or a long text note) can exceed that, and dc.send() then
  // throws — which surfaced as a generic failure a few seconds after the
  // listing appeared. Split big JSON messages into small parts instead.
  const JSON_CHUNK_SIZE = 60000;
  // Cap reassembled JSON messages: a header claiming more parts than this
  // is rejected instead of allocating a giant array (a malicious sender
  // could otherwise OOM the receiver's tab). 200 parts * 60KB = 12MB,
  // far above any legitimate manifest (bounded by the 4MB signaling cap).
  const MAX_JSON_PARTS = 200;
  // Chat limits: messages are truncated when sent, and anything arriving
  // over the cap is dropped, so a misbehaving peer can't flood a tab's
  // memory with chat text.
  const MAX_CHAT_CHARS = 2000;
  const MAX_CHAT_RECEIVE = 4000;
  // Fallback ICE servers if the hub returns none: STUN plus the Open Relay
  // Project's free shared TURN servers (same default as the server).
  // Every transport is listed: plain UDP relay fails on networks that
  // block UDP, so TCP on ports 80/443 and TLS (TURNS) on 443 are included
  // as fallbacks — without them, restrictive Wi-Fi/firewalls can never
  // connect at all.
  const TURN_USERNAME = 'openrelayproject';
  const TURN_CREDENTIAL = 'openrelayproject';
  const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    { urls: 'turn:openrelay.metered.ca:443', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: TURN_USERNAME, credential: TURN_CREDENTIAL }
  ];

  function sendJson(dc, obj) {
    const s = JSON.stringify(obj);
    if (s.length <= JSON_CHUNK_SIZE) {
      dc.send(s);
      return;
    }
    const parts = [];
    for (let i = 0; i < s.length; i += JSON_CHUNK_SIZE) parts.push(s.slice(i, i + JSON_CHUNK_SIZE));
    dc.send(JSON.stringify({ t: 'json-start', parts: parts.length }));
    parts.forEach((data, i) => dc.send(JSON.stringify({ t: 'json-part', i, data })));
    dc.send(JSON.stringify({ t: 'json-end' }));
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/live`;
  }

  async function sha256Hex(text) {
    if (!crypto.subtle) {
      throw new Error('Password protection needs HTTPS — this page was opened over plain HTTP.');
    }
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function makeId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function waitForBufferLow(dc) {
    return new Promise(resolve => {
      const done = () => {
        dc.onbufferedamountlow = null;
        resolve();
      };
      dc.onbufferedamountlow = done;
      // Safety net in case the event already fired.
      setTimeout(done, 250);
    });
  }

  async function sendFile(dc, file, path, onProgress) {
    let offset = 0;
    dc.send(JSON.stringify({ t: 'file-start', path, size: file.size }));
    while (offset < file.size) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      if (dc.bufferedAmount > BUFFER_HIGH_WATER) await waitForBufferLow(dc);
      if (dc.readyState !== 'open') throw new Error('Connection closed mid-transfer.');
      dc.send(buf);
      offset += buf.byteLength;
      if (onProgress) onProgress(path, offset, file.size);
    }
    dc.send(JSON.stringify({ t: 'file-end', path }));
  }

  // ICE candidates that arrive before the remote description is set are
  // rejected by the browser (InvalidStateError) — and in a fast loopback
  // exchange that is usually the FIRST (host) candidate, i.e. exactly the
  // one that makes same-network transfers work. Buffer them per connection
  // and flush once the remote description lands.
  function flushPendingCandidates(pc) {
    const pending = pc._pendingCandidates;
    if (!pending || !pending.length) return;
    pc._pendingCandidates = [];
    for (const c of pending) {
      pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
  }

  function handleSignalMessage(pc, data, sendSignal) {
    if (data.sdp) {
      return pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(() => {
          flushPendingCandidates(pc);
          if (data.sdp.type === 'offer') {
            return pc.createAnswer().then(answer => pc.setLocalDescription(answer))
              .then(() => sendSignal({ sdp: pc.localDescription }));
          }
          return null;
        })
        .catch(err => console.error('[p2p] signal failed:', err.message));
    }
    if (data.candidate) {
      if (!pc.remoteDescription) {
        (pc._pendingCandidates || (pc._pendingCandidates = [])).push(data.candidate);
        return Promise.resolve();
      }
      return pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
    return Promise.resolve();
  }

  function makePeerConnection(iceServers, onSignal, onChannel) {
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = e => {
      if (e.candidate) onSignal({ candidate: e.candidate });
    };
    if (onChannel) pc.ondatachannel = e => onChannel(e.channel);
    return pc;
  }

  function attachSenderChannel(dc, filesByPath, text, listing, onProgress, onFileSent, onChat, peerLabel) {
    dc.binaryType = 'arraybuffer';
    dc.onmessage = async event => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // Binary chunks are never sent to the sender.
      }
      if (!msg || typeof msg.t !== 'string') return;
      try {
        if (msg.t === 'chat') {
          // Ephemeral chat from one receiver: delivered only to this tab's
          // UI, never stored, never relayed to other receivers.
          if (typeof msg.text === 'string' && msg.text.length <= MAX_CHAT_RECEIVE && onChat) {
            try { onChat({ from: peerLabel || 'Receiver', text: msg.text, at: msg.at || Date.now() }); } catch {}
          }
          return;
        }
        if (msg.t === 'get-file') {
          const entry = filesByPath.get(msg.path);
          if (!entry) {
            // Per-file failure: report just this file so the receiver can
            // keep downloading the rest instead of failing the session.
            sendJson(dc, { t: 'file-error', path: msg.path, message: `File not found: ${msg.path}` });
            return;
          }
          try {
            await sendFile(dc, entry.file, msg.path, onProgress);
          } catch (err) {
            sendJson(dc, { t: 'file-error', path: msg.path, message: err.message });
            return;
          }
          if (onFileSent) onFileSent(msg.path);
        } else if (msg.t === 'get-text') {
          sendJson(dc, { t: 'text', text });
        } else if (msg.t === 'get-manifest') {
          sendJson(dc, { t: 'manifest', hasText: !!text, listing: listing || null });
        }
      } catch (err) {
        try { sendJson(dc, { t: 'error', message: err.message }); } catch {}
      }
    };
  }

  /* Sender side: keep this tab open and serve the picked files live. */
  async function startSender(opts) {
    const {
      id, files, text, listing, passwordHash, expiresAt,
      onStatus, onReceiverJoin, onReceiverLeft, onProgress, onFileSent, onTransferComplete,
      onChat, onConnect
    } = opts;
    const filesByPath = new Map(files.map(f => [f.path, f]));
    const peers = new Map(); // receiverId -> { pc, dc, label }
    const pendingSignals = new Map(); // receiverId -> [data] received before the peer existed
    let socket = null;
    let iceServers = DEFAULT_ICE_SERVERS.slice();
    let closed = false;
    let everRegistered = false;
    let expired = false;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let receiverCount = 0;
    let wakeLock = null;
    const MAX_RECONNECT_ATTEMPTS = 30;

    const setStatus = msg => { if (onStatus) onStatus(msg); };

    const sendSocket = obj => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify(obj)); } catch {}
      }
    };

    const register = () => {
      // The share counts as attempted the moment registration is sent:
      // if this socket dies before the server's reply lands (the tab
      // was backgrounded in the same instant), the close handler must
      // still reconnect and re-register instead of giving up.
      everRegistered = true;
      sendSocket({
        type: 'register-sender',
        id,
        listing,
        passwordHash: passwordHash || null,
        expiresAt: expiresAt || null
      });
    };

    // Build (or rebuild) the peer connection for one receiver: used when a
    // receiver joins, and again when a receiver restarts its connection
    // after an ICE failure and re-offers.
    function createPeerFor(receiverId) {
      const label = `Receiver ${++receiverCount}`;
      const pc = makePeerConnection(iceServers, data => {
        sendSocket({ type: 'signal', to: receiverId, data });
      }, dc => {
        const peer = peers.get(receiverId);
        if (peer) peer.dc = dc;
        dc.onopen = () => { if (onConnect) { try { onConnect(receiverId, label); } catch {} } };
        dc.onclose = () => {
          const p = peers.get(receiverId);
          if (p && p.dc === dc) p.dc = null;
        };
        attachSenderChannel(dc, filesByPath, text, listing, onProgress, onFileSent, onChat, label);
      });
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          try { pc.close(); } catch {}
          peers.delete(receiverId);
          pendingSignals.delete(receiverId);
        }
      };
      peers.set(receiverId, { pc, dc: null, label });
      // Replay any signals that arrived before this peer existed.
      const queued = pendingSignals.get(receiverId);
      if (queued) {
        pendingSignals.delete(receiverId);
        for (const data of queued) {
          handleSignalMessage(pc, data, sigData => {
            sendSocket({ type: 'signal', to: receiverId, data: sigData });
          });
        }
      }
      return pc;
    }

    // A dropped signaling socket must not end the share: the sender's tab
    // still holds the files, so reconnect and re-register the same id.
    // In-progress direct transfers keep running on their data channels.
    function connectSocket() {
      reconnectTimer = null;
      socket = new WebSocket(wsUrl());
      const thisSocket = socket;
      socket.addEventListener('message', onSocketMessage);
      socket.addEventListener('open', () => {
        if (socket !== thisSocket) return; // superseded socket
        reconnectAttempts = 0;
        register();
      }, { once: true });
      socket.addEventListener('close', () => {
        // Only the current socket may trigger a reconnect. A close from
        // a superseded socket must not schedule another reconnect or the
        // tab ends up with duplicate sockets and repeated "interrupted"
        // notices while the transfer itself is fine.
        if (socket !== thisSocket) return;
        if (closed || expired || !everRegistered) return;
        if (reconnectTimer) return; // a reconnect is already scheduled
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          setStatus('Live sharing ended. The share link no longer works.');
          return;
        }
        reconnectAttempts++;
        setStatus('Connection interrupted. Reconnecting… Keep this tab open.');
        reconnectTimer = setTimeout(connectSocket, Math.min(1500 * reconnectAttempts, 10000));
      });
    }

    // Keep the screen awake while this tab is the sender: on a phone,
    // a sleeping screen is the fastest way for the OS to suspend the
    // tab and drop the share.
    async function requestWakeLock() {
      if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
      if (wakeLock) return;
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch {}
    }
    const releaseWakeLock = () => {
      if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
    };

    // Returning to the tab (or coming back online) must reconnect NOW,
    // not whenever the backoff timer happens to fire: the user just
    // came back from sharing the link in another app, and the receiver
    // may already be waiting on the other end.
    const nudgeReconnect = () => {
      if (closed || expired) return;
      if (socket && socket.readyState === WebSocket.OPEN) return;
      reconnectAttempts = 0;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connectSocket();
    };
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        requestWakeLock();
        nudgeReconnect();
      }
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', nudgeReconnect);
    }
    requestWakeLock();

    function onSocketMessage(event) {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'registered') {
        everRegistered = true;
        requestWakeLock();
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) iceServers = msg.iceServers;
        // After a mid-share reconnect the "interrupted" notice must not
        // stick: with a receiver already connected, say so explicitly.
        if (peers.size > 0) setStatus('Reconnected. The receiver is still connected — sharing continues.');
        else setStatus('Live: waiting for the receiver. Keep this tab open.');
        return;
      }
      if (msg.type === 'expired') {
        // The share lapsed: stop reconnecting so it can't resurrect.
        expired = true;
        clearTimeout(reconnectTimer);
        setStatus('This share has expired.');
        try { socket.close(); } catch {}
        return;
      }
      if (msg.type === 'receiver-joined') {
        const receiverId = msg.receiverId;
        const old = peers.get(receiverId);
        if (old) { try { old.pc.close(); } catch {} peers.delete(receiverId); }
        createPeerFor(receiverId);
        if (onReceiverJoin) onReceiverJoin(receiverId);
        setStatus('Receiver connected. Sending directly from this tab…');
        return;
      }
      if (msg.type === 'receiver-left') {
        const peer = peers.get(msg.receiverId);
        if (peer) { try { peer.pc.close(); } catch {} peers.delete(msg.receiverId); }
        pendingSignals.delete(msg.receiverId);
        if (onReceiverLeft) onReceiverLeft(msg.receiverId);
        setStatus('Receiver left. Keep this tab open for another download, or close it to end the share.');
        return;
      }
      if (msg.type === 'transfer-complete') {
        if (onTransferComplete) onTransferComplete(msg.receiverId);
        setStatus('✓ Receiver downloaded everything. You can close this tab now.');
        return;
      }
      if (msg.type === 'signal' && msg.from) {
        let peer = peers.get(msg.from);
        if (!peer && msg.data && msg.data.sdp && msg.data.sdp.type === 'offer') {
          // The receiver restarted its peer connection after an ICE
          // failure: the old peer is gone, so build a fresh one for this
          // re-offer instead of dropping the handshake. Queued signals
          // for the dead peer are stale — drop them.
          pendingSignals.delete(msg.from);
          createPeerFor(msg.from);
          peer = peers.get(msg.from);
        }
        if (peer) {
          handleSignalMessage(peer.pc, msg.data, data => {
            sendSocket({ type: 'signal', to: msg.from, data });
          });
        } else {
          // The offer can beat the receiver-joined event: hold it until
          // the peer connection exists instead of dropping it.
          const queued = pendingSignals.get(msg.from) || [];
          queued.push(msg.data);
          pendingSignals.set(msg.from, queued);
        }
        return;
      }
      if (msg.type === 'error') {
        // A rejection saying the share expired is final: stop
        // reconnecting so a dead id can't be revived by the retry loop.
        if (msg.code === 'share-expired') {
          expired = true;
          clearTimeout(reconnectTimer);
        }
        setStatus(`Live sharing unavailable: ${msg.code || 'error'}`);
      }
    }

    connectSocket();

    // The open handler registers this tab; wait for the first connection
    // so the caller knows the share is live (reconnects re-register).
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    return {
      // Broadcast a chat message to every connected receiver. Returns how
      // many receivers it reached (0 when nobody is connected yet).
      // Messages are truncated, never stored, and never touch the server.
      sendChat(rawText) {
        const message = String(rawText == null ? '' : rawText).slice(0, MAX_CHAT_CHARS).trim();
        if (!message) return 0;
        let delivered = 0;
        for (const peer of peers.values()) {
          if (peer.dc && peer.dc.readyState === 'open') {
            try { sendJson(peer.dc, { t: 'chat', from: 'sender', text: message, at: Date.now() }); delivered++; } catch {}
          }
        }
        return delivered;
      },
      close() {
        closed = true;
        clearTimeout(reconnectTimer);
        // Deliberate end: tell the hub so the room dies at once instead
        // of lingering through the sender grace period.
        sendSocket({ type: 'stop-sharing' });
        releaseWakeLock();
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('online', nudgeReconnect);
        }
        for (const peer of peers.values()) { try { peer.pc.close(); } catch {} }
        peers.clear();
        try { socket.close(); } catch {}
      }
    };
  }

  /* Receiver side: connect to the sender's tab and pull files over WebRTC. */
  async function startReceiver(opts) {
    const {
      id, passwordHash, timeoutMs, onStatus, onJoin, onManifest, onText, onFileStart,
      onFileProgress, onFileComplete, onFileError, onDone, onError, onChat, onConnect
    } = opts;

    let socket = null;
    let pc = null;
    let dc = null;
    let iceServers = DEFAULT_ICE_SERVERS.slice();
    let settled = false;
    let currentFile = null; // { path, size, chunks, received }
    let joinTimer = null;
    let reconnectTimer = null;
    let joinAttempts = 0;
    const MAX_JOIN_ATTEMPTS = 4;
    let awayTimer = null;
    let awayDeadline = 0;
    // How long a receiver waits for an away sender before giving up:
    // long enough to cover sharing the link in another app and coming
    // back, short enough that a truly dead link still fails cleanly.
    const AWAY_WAIT_MS = 5 * 60 * 1000;
    const AWAY_RETRY_MS = 3000;
    let peerAttempts = 0;
    const MAX_PEER_ATTEMPTS = 2;
    const pendingRequests = [];

    const dcOpen = () => !!(dc && dc.readyState === 'open');

    const sendSocket = obj => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify(obj)); } catch {}
      }
    };

    const flushRequests = () => {
      if (!dcOpen()) return;
      while (pendingRequests.length) dc.send(pendingRequests.shift());
    };

    const queueRequest = obj => {
      const payload = JSON.stringify(obj);
      if (dcOpen()) dc.send(payload);
      else pendingRequests.push(payload);
    };

    const fail = err => {
      if (settled) return;
      settled = true;
      clearTimeout(joinTimer);
      clearTimeout(connectWatchdog);
      clearTimeout(reconnectTimer);
      clearTimeout(awayTimer);
      removeReceiverListeners();
      try { socket.close(); } catch {}
      if (pc) { try { pc.close(); } catch {} }
      if (onError) onError(err);
    };

    const armJoinTimer = () => {
      clearTimeout(joinTimer);
      joinTimer = setTimeout(() => {
        fail(new Error('sender-offline'));
      }, timeoutMs || 8000);
    };

    // If the direct connection never establishes, say so instead of
    // leaving the page blank forever.
    let connectWatchdog = null;
    const armConnectWatchdog = () => {
      clearTimeout(connectWatchdog);
      connectWatchdog = setTimeout(() => {
        if (dcOpen() || settled) return;
        // Slow ICE (e.g. TURN allocation on a bad network) gets one
        // retry with a fresh connection instead of an instant failure.
        if (peerAttempts < MAX_PEER_ATTEMPTS) {
          if (onStatus) onStatus('Direct connection is taking a while. Retrying…');
          startPeerConnection();
        } else {
          fail(new Error('connection-failed'));
        }
      }, 20000);
    };

    // The sender stepped away (backgrounded tab, brief drop) but the
    // share is still alive in its grace period: keep re-joining every
    // few seconds instead of failing, until the wait budget runs out.
    const enterAwayWait = () => {
      if (settled || dcOpen()) return;
      clearTimeout(joinTimer);
      if (!awayDeadline) awayDeadline = Date.now() + AWAY_WAIT_MS;
      if (onStatus) onStatus('The sender stepped away — waiting for them to come back online…');
      clearTimeout(awayTimer);
      awayTimer = setTimeout(() => {
        if (settled || dcOpen()) return;
        if (Date.now() > awayDeadline) {
          fail(new Error('sender-offline'));
          return;
        }
        armJoinTimer();
        sendSocket({ type: 'join', id, passwordHash: passwordHash || null });
      }, AWAY_RETRY_MS);
    };

    // Returning to the tab re-joins at once when the receiver is still
    // waiting, instead of leaving the join timer to expire mid-wait.
    const nudgeReceiver = () => {
      if (settled || dcOpen()) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        joinAttempts = 0;
        clearTimeout(reconnectTimer);
        connectSocket();
      } else if (awayDeadline) {
        clearTimeout(awayTimer);
        clearTimeout(joinTimer);
        armJoinTimer();
        sendSocket({ type: 'join', id, passwordHash: passwordHash || null });
      }
    };
    const onReceiverVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') nudgeReceiver();
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onReceiverVisibility);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', nudgeReceiver);
    }
    const removeReceiverListeners = () => {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onReceiverVisibility);
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('online', nudgeReceiver);
      }
    };

    // A signaling drop before the data channel opens is retried: the
    // sender may have reconnected under the same id. Once the data
    // channel is open, signaling is no longer needed and its loss is
    // ignored so an in-progress transfer is never killed by it.
    function connectSocket() {
      reconnectTimer = null;
      socket = new WebSocket(wsUrl());
      const thisSocket = socket;
      socket.addEventListener('message', onSocketMessage);
      socket.addEventListener('open', () => {
        if (socket !== thisSocket) return; // superseded socket
        armJoinTimer();
        sendSocket({ type: 'join', id, passwordHash: passwordHash || null });
      }, { once: true });
      socket.addEventListener('close', () => {
        if (socket !== thisSocket) return; // superseded socket
        if (settled) return;
        clearTimeout(awayTimer);
        if (dcOpen()) {
          if (onStatus) onStatus('Signaling connection lost — the direct transfer continues.');
          return;
        }
        if (reconnectTimer) return; // a retry is already scheduled
        clearTimeout(joinTimer);
        if (pc) { try { pc.close(); } catch {} pc = null; dc = null; }
        if (joinAttempts >= MAX_JOIN_ATTEMPTS) {
          fail(new Error('sender-offline'));
          return;
        }
        joinAttempts++;
        if (onStatus) onStatus('Connection interrupted. Retrying…');
        reconnectTimer = setTimeout(connectSocket, 1500);
      });
    }

    // (Re)build the peer connection and offer. A failed ICE attempt is
    // retried once with a fresh connection before giving up: TURN
    // allocation and NAT mapping can fail transiently, and a single
    // attempt makes the share look broken when a retry would connect.
    function startPeerConnection() {
      if (pc) { try { pc.close(); } catch {} }
      pc = null;
      dc = null;
      peerAttempts++;
      pc = makePeerConnection(iceServers, data => {
        sendSocket({ type: 'signal', data });
      });
      const thisPc = pc;
      pc.onconnectionstatechange = () => {
        if (thisPc.connectionState !== 'failed') return;
        if (settled || pc !== thisPc) return;
        if (peerAttempts < MAX_PEER_ATTEMPTS) {
          if (onStatus) onStatus('Direct connection failed. Retrying…');
          startPeerConnection();
        } else {
          fail(new Error('connection-failed'));
        }
      };
      dc = pc.createDataChannel('unishare');
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        clearTimeout(connectWatchdog);
        // A working connection refreshes the retry budget, so a later
        // failure gets a fresh retry instead of failing outright.
        peerAttempts = 0;
        if (onStatus) onStatus('Connected directly to the sender.');
        if (onConnect) { try { onConnect(); } catch {} }
        dc.send(JSON.stringify({ t: 'get-manifest' }));
        flushRequests();
      };
      dc.onmessage = handleChannelMessage;
      armConnectWatchdog();
      thisPc.createOffer()
        .then(offer => thisPc.setLocalDescription(offer))
        .then(() => {
          if (settled || pc !== thisPc) return; // abandoned by a reconnect
          sendSocket({ type: 'signal', data: { sdp: thisPc.localDescription } });
        })
        .catch(err => { if (!settled && pc === thisPc) fail(err); });
    }

    function onSocketMessage(event) {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'error') {
        if (dcOpen()) return;
        // The share exists but its sender is away inside the grace
        // period (or the join was rate-limited): wait and retry
        // instead of failing the link.
        if (msg.code === 'sender-away' || msg.code === 'sender-offline' || msg.code === 'rate-limited') {
          clearTimeout(joinTimer);
          enterAwayWait();
          return;
        }
        clearTimeout(joinTimer);
        fail(new Error(msg.code || 'error'));
        return;
      }

      if (msg.type === 'joined') {
        clearTimeout(joinTimer);
        awayDeadline = 0;
        clearTimeout(awayTimer);
        joinAttempts = 0;
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) iceServers = msg.iceServers;
        if (!msg.senderOnline) {
          fail(new Error('sender-offline'));
          return;
        }
        if (onStatus) onStatus('Live sender found. Connecting directly…');
        if (onJoin && msg.listing) onJoin(msg.listing);
        peerAttempts = 0;
        startPeerConnection();
        return;
      }

      if (msg.type === 'sender-offline') {
        if (dcOpen()) return;
        // No direct connection yet and the sender's signaling dropped:
        // the share may revive inside the grace period, so wait and
        // re-join instead of failing outright.
        clearTimeout(joinTimer);
        enterAwayWait();
        return;
      }

      if (msg.type === 'sender-back') {
        if (settled || dcOpen()) return;
        // The sender re-registered: re-join now instead of waiting for
        // the next retry tick.
        awayDeadline = 0;
        clearTimeout(awayTimer);
        clearTimeout(joinTimer);
        armJoinTimer();
        sendSocket({ type: 'join', id, passwordHash: passwordHash || null });
        return;
      }

      if (msg.type === 'signal' && pc) {
        handleSignalMessage(pc, msg.data, () => {});
        return;
      }
    }

    let jsonParts = null; // reassembly buffer for chunked JSON messages

    function handleChannelMessage(event) {
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        // Reassemble a chunked JSON message, then handle it as one message.
        if (msg.t === 'json-start') {
          if (!Number.isInteger(msg.parts) || msg.parts < 1 || msg.parts > MAX_JSON_PARTS) {
            jsonParts = null;
            return;
          }
          jsonParts = new Array(msg.parts).fill(null);
          return;
        }
        if (msg.t === 'json-part') {
          if (jsonParts && Number.isInteger(msg.i) && msg.i < jsonParts.length) jsonParts[msg.i] = msg.data;
          return;
        }
        if (msg.t === 'json-end') {
          if (!jsonParts || jsonParts.some(p => p === null)) { jsonParts = null; return; }
          const full = jsonParts.join('');
          jsonParts = null;
          try { msg = JSON.parse(full); } catch { return; }
        }
        if (msg.t === 'manifest' && onManifest) onManifest(msg);
        if (msg.t === 'text' && onText) onText(msg.text);
        if (msg.t === 'chat') {
          // Ephemeral chat from the sender: UI-only, never stored.
          if (typeof msg.text === 'string' && msg.text.length <= MAX_CHAT_RECEIVE && onChat) {
            try { onChat({ from: 'sender', text: msg.text, at: msg.at || Date.now() }); } catch {}
          }
          return;
        }
        if (msg.t === 'error') fail(new Error(msg.message || 'transfer-error'));
        if (msg.t === 'file-error') {
          // Only this file failed; the session stays alive for the rest.
          if (currentFile && currentFile.path === msg.path) currentFile = null;
          if (onFileError) onFileError(msg.path, msg.message || 'transfer-error');
        }
        if (msg.t === 'file-start') {
          currentFile = { path: msg.path, size: msg.size, chunks: [], received: 0 };
          if (onFileStart) onFileStart(msg.path, msg.size);
        }
        if (msg.t === 'file-end' && currentFile) {
          const blob = new Blob(currentFile.chunks);
          const done = currentFile;
          currentFile = null;
          if (onFileComplete) onFileComplete(done.path, done.size, blob);
        }
        return;
      }
      if (currentFile) {
        currentFile.chunks.push(event.data);
        currentFile.received += event.data.byteLength;
        if (onFileProgress) onFileProgress(currentFile.path, currentFile.received, currentFile.size);
      }
    }

    connectSocket();

    // The open handler sends the join; wait for the first connection so
    // the caller knows the join is underway (retries re-join).
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    return {
      requestText() { queueRequest({ t: 'get-text' }); },
      requestFile(path) { queueRequest({ t: 'get-file', path }); },
      // Send a chat message straight to the sender over the data channel.
      // Returns false when the direct connection isn't open yet — chat is
      // never queued or stored, so an unsent message is simply not sent.
      sendChat(rawText) {
        const message = String(rawText == null ? '' : rawText).slice(0, MAX_CHAT_CHARS).trim();
        if (!message || !dcOpen()) return false;
        try { dc.send(JSON.stringify({ t: 'chat', from: 'receiver', text: message, at: Date.now() })); return true; }
        catch { return false; }
      },
      notifyDownloaded() {
        sendSocket({ type: 'transfer-complete' });
      },
      finish() {
        settled = true;
        clearTimeout(joinTimer);
        clearTimeout(connectWatchdog);
        clearTimeout(reconnectTimer);
        clearTimeout(awayTimer);
        removeReceiverListeners();
        if (onDone) onDone();
        try { socket.close(); } catch {}
        if (pc) { try { pc.close(); } catch {} }
      },
      close() {
        settled = true;
        clearTimeout(joinTimer);
        clearTimeout(connectWatchdog);
        clearTimeout(reconnectTimer);
        clearTimeout(awayTimer);
        removeReceiverListeners();
        try { socket.close(); } catch {}
        if (pc) { try { pc.close(); } catch {} }
      }
    };
  }

  global.UniShareLive = { startSender, startReceiver, sha256Hex, makeId };
})(window);
