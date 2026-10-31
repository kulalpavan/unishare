'use strict';

/* UniShare live P2P transfers (hybrid mode).
 *
 * The stored share in PostgreSQL remains the fallback. When the sender's tab
 * is still open, the receiver downloads straight from the sender's browser
 * over a WebRTC data channel, relayed only for handshake signaling through
 * the server's /live WebSocket hub. No file bytes pass through the server.
 *
 * Wire protocol (data channel):
 *   receiver -> sender: { t: 'get-manifest' } | { t: 'get-text' } | { t: 'get-file', path }
 *   sender -> receiver: { t: 'manifest', ... } | { t: 'text', text }
 *                       | { t: 'file-start', path, size } + binary chunks + { t: 'file-end', path }
 *                       | { t: 'error', message }
 */

(function (global) {
  const CHUNK_SIZE = 16384; // 16KB chunks (see migration blueprint)
  const BUFFER_HIGH_WATER = 256 * 1024;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/live`;
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

  function handleSignalMessage(pc, data, sendSignal) {
    if (data.sdp) {
      return pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(() => {
          if (data.sdp.type === 'offer') {
            return pc.createAnswer().then(answer => pc.setLocalDescription(answer))
              .then(() => sendSignal({ sdp: pc.localDescription }));
          }
          return null;
        });
    }
    if (data.candidate) {
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

  function attachSenderChannel(dc, filesByPath, text, onProgress) {
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
        } else if (msg.t === 'get-text') {
          dc.send(JSON.stringify({ t: 'text', text }));
        } else if (msg.t === 'get-manifest') {
          dc.send(JSON.stringify({ t: 'manifest', hasText: !!text }));
        }
      } catch (err) {
        try { dc.send(JSON.stringify({ t: 'error', message: err.message })); } catch {}
      }
    };
  }

  /* Sender side: keep this tab open and serve the picked files live. */
  async function startSender(opts) {
    const { id, files, text, listing, onStatus, onReceiverJoin, onProgress } = opts;
    const filesByPath = new Map(files.map(f => [f.path, f]));
    const peers = new Map(); // receiverId -> { pc, dc }
    const socket = new WebSocket(wsUrl());
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    let closed = false;

    const setStatus = msg => { if (onStatus) onStatus(msg); };

    socket.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'registered') {
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) iceServers = msg.iceServers;
        setStatus('Live: this tab is sharing directly. Receivers will download from you while it stays open.');
        return;
      }
      if (msg.type === 'receiver-joined') {
        const receiverId = msg.receiverId;
        const pc = makePeerConnection(iceServers, data => {
          socket.send(JSON.stringify({ type: 'signal', to: receiverId, data }));
        }, dc => attachSenderChannel(dc, filesByPath, text, onProgress));
        peers.set(receiverId, { pc, dc: null });
        if (onReceiverJoin) onReceiverJoin(receiverId);
        setStatus('Live: a receiver connected. Sending directly from this tab…');
        return;
      }
      if (msg.type === 'receiver-left') {
        const peer = peers.get(msg.receiverId);
        if (peer) { try { peer.pc.close(); } catch {} peers.delete(msg.receiverId); }
        return;
      }
      if (msg.type === 'signal' && msg.from) {
        const peer = peers.get(msg.from);
        if (peer) {
          handleSignalMessage(peer.pc, msg.data, data => {
            socket.send(JSON.stringify({ type: 'signal', to: msg.from, data }));
          });
        }
        return;
      }
      if (msg.type === 'error') setStatus(`Live sharing unavailable: ${msg.code || 'error'}`);
    });

    socket.addEventListener('close', () => {
      if (!closed) setStatus('Live sharing ended. The stored copy is still available from the link.');
    });

    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    socket.send(JSON.stringify({ type: 'register-sender', id, listing }));

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
      id, password, timeoutMs, onStatus, onManifest, onText, onFileStart,
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
    }, timeoutMs || 5000);

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
        pc = makePeerConnection(iceServers, data => {
          socket.send(JSON.stringify({ type: 'signal', data }));
        });
        dc = pc.createDataChannel('unishare');
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => {
          if (onStatus) onStatus('Connected directly to the sender.');
          dc.send(JSON.stringify({ t: 'get-manifest' }));
          flushRequests();
        };
        dc.onmessage = handleChannelMessage;
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
        // Socket dropped after joining: the live path is gone.
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
    socket.send(JSON.stringify({ type: 'join', id, password: password || '' }));

    return {
      requestText() { queueRequest({ t: 'get-text' }); },
      requestFile(path) { queueRequest({ t: 'get-file', path }); },
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

  global.UniShareLive = { startSender, startReceiver };
})(window);
