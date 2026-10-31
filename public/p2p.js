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
 *
 * Passwords are verified by comparing SHA-256 hashes: the sender registers
 * the hash, the receiver sends the hash of what was typed, and the server
 * compares them. Plaintext passwords never leave the browser that typed them.
 */

(function (global) {
  const CHUNK_SIZE = 16384; // 16KB chunks
  const BUFFER_HIGH_WATER = 256 * 1024;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/live`;
  }

  async function sha256Hex(text) {
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

  function attachSenderChannel(dc, filesByPath, text, listing, onProgress, onFileSent) {
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
        if (msg.t === 'get-file') {
          const entry = filesByPath.get(msg.path);
          if (!entry) {
            dc.send(JSON.stringify({ t: 'error', message: `File not found: ${msg.path}` }));
            return;
          }
          await sendFile(dc, entry.file, msg.path, onProgress);
          if (onFileSent) onFileSent(msg.path);
        } else if (msg.t === 'get-text') {
          dc.send(JSON.stringify({ t: 'text', text }));
        } else if (msg.t === 'get-manifest') {
          dc.send(JSON.stringify({ t: 'manifest', hasText: !!text, listing: listing || null }));
        }
      } catch (err) {
        try { dc.send(JSON.stringify({ t: 'error', message: err.message })); } catch {}
      }
    };
  }

  /* Sender side: keep this tab open and serve the picked files live. */
  async function startSender(opts) {
    const {
      id, files, text, listing, passwordHash, expiresAt,
      onStatus, onReceiverJoin, onReceiverLeft, onProgress, onFileSent, onTransferComplete
    } = opts;
    const filesByPath = new Map(files.map(f => [f.path, f]));
    const peers = new Map(); // receiverId -> { pc, dc }
    const pendingSignals = new Map(); // receiverId -> [data] received before the peer existed
    const socket = new WebSocket(wsUrl());
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    let closed = false;

    const setStatus = msg => { if (onStatus) onStatus(msg); };

    socket.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'registered') {
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) iceServers = msg.iceServers;
        setStatus('Live: waiting for the receiver. Keep this tab open.');
        return;
      }
      if (msg.type === 'receiver-joined') {
        const receiverId = msg.receiverId;
        const pc = makePeerConnection(iceServers, data => {
          socket.send(JSON.stringify({ type: 'signal', to: receiverId, data }));
        }, dc => attachSenderChannel(dc, filesByPath, text, listing, onProgress, onFileSent));
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') {
            try { pc.close(); } catch {}
            peers.delete(receiverId);
          }
        };
        peers.set(receiverId, { pc, dc: null });
        // Replay any signals that arrived before this peer existed.
        const queued = pendingSignals.get(receiverId);
        if (queued) {
          pendingSignals.delete(receiverId);
          for (const data of queued) {
            handleSignalMessage(pc, data, sigData => {
              socket.send(JSON.stringify({ type: 'signal', to: receiverId, data: sigData }));
            });
          }
        }
        if (onReceiverJoin) onReceiverJoin(receiverId);
        setStatus('Receiver connected. Sending directly from this tab…');
        return;
      }
      if (msg.type === 'receiver-left') {
        const peer = peers.get(msg.receiverId);
        if (peer) { try { peer.pc.close(); } catch {} peers.delete(msg.receiverId); }
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
        const peer = peers.get(msg.from);
        if (peer) {
          handleSignalMessage(peer.pc, msg.data, data => {
            socket.send(JSON.stringify({ type: 'signal', to: msg.from, data }));
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
      if (msg.type === 'error') setStatus(`Live sharing unavailable: ${msg.code || 'error'}`);
    });

    socket.addEventListener('close', () => {
      if (!closed) setStatus('Live sharing ended. The share link no longer works.');
    });

    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    socket.send(JSON.stringify({
      type: 'register-sender',
      id,
      listing,
      passwordHash: passwordHash || null,
      expiresAt: expiresAt || null
    }));

    return {
      close() {
        closed = true;
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
      onFileProgress, onFileComplete, onDone, onError
    } = opts;

    const socket = new WebSocket(wsUrl());
    let pc = null;
    let dc = null;
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    let settled = false;
    let currentFile = null; // { path, size, chunks, received }
    const pendingRequests = [];

    const flushRequests = () => {
      if (!dc || dc.readyState !== 'open') return;
      while (pendingRequests.length) dc.send(pendingRequests.shift());
    };

    const queueRequest = obj => {
      const payload = JSON.stringify(obj);
      if (dc && dc.readyState === 'open') dc.send(payload);
      else pendingRequests.push(payload);
    };

    const fail = err => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      if (pc) { try { pc.close(); } catch {} }
      if (onError) onError(err);
    };

    const joinTimer = setTimeout(() => {
      fail(new Error('sender-offline'));
    }, timeoutMs || 8000);

    // If the direct connection never establishes, say so instead of
    // leaving the page blank forever.
    let connectWatchdog = null;
    const armConnectWatchdog = () => {
      clearTimeout(connectWatchdog);
      connectWatchdog = setTimeout(() => {
        if (!dc || dc.readyState !== 'open') fail(new Error('connection-failed'));
      }, 20000);
    };

    socket.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'error') {
        clearTimeout(joinTimer);
        fail(new Error(msg.code || 'error'));
        return;
      }

      if (msg.type === 'joined') {
        clearTimeout(joinTimer);
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) iceServers = msg.iceServers;
        if (!msg.senderOnline) {
          fail(new Error('sender-offline'));
          return;
        }
        if (onStatus) onStatus('Live sender found. Connecting directly…');
        if (onJoin && msg.listing) onJoin(msg.listing);
        pc = makePeerConnection(iceServers, data => {
          socket.send(JSON.stringify({ type: 'signal', data }));
        });
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') fail(new Error('connection-failed'));
        };
        dc = pc.createDataChannel('unishare');
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => {
          clearTimeout(connectWatchdog);
          if (onStatus) onStatus('Connected directly to the sender.');
          dc.send(JSON.stringify({ t: 'get-manifest' }));
          flushRequests();
        };
        dc.onmessage = handleChannelMessage;
        armConnectWatchdog();
        pc.createOffer()
          .then(offer => pc.setLocalDescription(offer))
          .then(() => socket.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } })))
          .catch(err => fail(err));
        return;
      }

      if (msg.type === 'sender-offline') {
        fail(new Error('sender-offline'));
        return;
      }

      if (msg.type === 'signal' && pc) {
        handleSignalMessage(pc, msg.data, () => {});
        return;
      }
    });

    socket.addEventListener('close', () => {
      if (!settled && pc && pc.connectionState !== 'closed') {
        fail(new Error('sender-offline'));
      }
    });

    function handleChannelMessage(event) {
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.t === 'manifest' && onManifest) onManifest(msg);
        if (msg.t === 'text' && onText) onText(msg.text);
        if (msg.t === 'error') fail(new Error(msg.message || 'transfer-error'));
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

    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.send(JSON.stringify({ type: 'join', id, passwordHash: passwordHash || null }));

    return {
      requestText() { queueRequest({ t: 'get-text' }); },
      requestFile(path) { queueRequest({ t: 'get-file', path }); },
      notifyDownloaded() {
        try { socket.send(JSON.stringify({ type: 'transfer-complete' })); } catch {}
      },
      finish() {
        settled = true;
        if (onDone) onDone();
        try { socket.close(); } catch {}
        if (pc) { try { pc.close(); } catch {} }
      },
      close() {
        settled = true;
        try { socket.close(); } catch {}
        if (pc) { try { pc.close(); } catch {} }
      }
    };
  }

  global.UniShareLive = { startSender, startReceiver, sha256Hex, makeId };
})(window);
