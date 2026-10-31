'use strict';

// UniShare — pure peer-to-peer edition.
//
// The server is only two things:
//   1. A static file server for the frontend.
//   2. A WebSocket signaling hub (/live) that introduces the sender's and
//      receiver's browsers so they can connect directly over WebRTC.
//
// There is no database and no file storage. File bytes and text never touch
// this server — they stream browser-to-browser over WebRTC data channels.
// A share lives only while the sender's tab stays open; closing the tab
// ends the share. Passwords are verified by comparing SHA-256 hashes, so
// the server never sees a plaintext password.

const path = require('path');
const crypto = require('crypto');
const http = require('http');

const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
// Large enough for very big folder listings (thousands of files) sent in
// register-sender; still bounded so one client can't OOM the server.
const MAX_SIGNAL_BYTES = 4 * 1024 * 1024;
const ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// ICE servers for WebRTC peer connections. Configure via ICE_SERVERS env var
// (JSON array). Defaults to Google's free public STUN server; add a free TURN
// entry (e.g. Open Relay Project) for symmetric-NAT fallback.
function iceServers() {
  try {
    const parsed = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : null;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: 'p2p', liveRooms: liveRooms.size });
});

app.get('/api/ice', (req, res) => {
  res.json({ iceServers: iceServers() });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.use((req, res) => {
  res.status(404);
  if (req.path.startsWith('/api/')) return res.json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'Server error.' });
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Signaling hub. Rooms are ephemeral in-memory mappings, wiped when the
// sender's connection drops or the room expires.
// ---------------------------------------------------------------------------

const liveRooms = new Map(); // shareId -> { sender, receivers, listing, passwordHash, expiresAt, createdAt }

const wss = new WebSocketServer({ server, path: '/live', maxPayload: MAX_SIGNAL_BYTES });

// A socket with no 'error' listener turns any protocol error (e.g. a message
// over maxPayload -> 1009) into an uncaught exception that kills the whole
// process. Never let one bad client take the server down.
wss.on('error', err => console.error('[live] hub error:', err.message));

function liveSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

function hashesEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!HASH_RE.test(a) || !HASH_RE.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function roomExpired(room) {
  return room.expiresAt !== null && room.expiresAt <= Date.now();
}

function getLiveRoom(id) {
  const room = liveRooms.get(id);
  if (!room) return null;
  if (roomExpired(room)) {
    if (room.sender) { try { room.sender.ws.close(); } catch {} }
    for (const receiver of room.receivers.values()) {
      liveSend(receiver, { type: 'error', code: 'share-expired' });
      try { receiver.close(); } catch {}
    }
    liveRooms.delete(id);
    return null;
  }
  return room;
}

function pruneRoom(id) {
  const room = liveRooms.get(id);
  if (!room) return;
  const senderGone = !room.sender || room.sender.ws.readyState !== room.sender.ws.OPEN;
  if (senderGone && room.receivers.size === 0) liveRooms.delete(id);
}

wss.on('connection', ws => {
  ws._id = crypto.randomBytes(8).toString('hex');
  ws._role = null;
  ws._roomId = null;
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
  ws.on('error', err => {
    console.error('[live] socket error:', err.message);
    try { ws.close(); } catch {}
  });

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return liveSend(ws, { type: 'error', code: 'bad-message' });
    }
    if (!msg || typeof msg.type !== 'string') {
      return liveSend(ws, { type: 'error', code: 'bad-message' });
    }

    try {
      if (msg.type === 'register-sender') {
        if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) {
          return liveSend(ws, { type: 'error', code: 'bad-id' });
        }
        if (msg.passwordHash != null && !HASH_RE.test(msg.passwordHash)) {
          return liveSend(ws, { type: 'error', code: 'bad-message' });
        }
        const expiresAt = typeof msg.expiresAt === 'number' && msg.expiresAt > Date.now()
          ? msg.expiresAt
          : null;
        let room = liveRooms.get(msg.id);
        if (room && room.sender && room.sender.ws.readyState === room.sender.ws.OPEN) {
          try { room.sender.ws.close(); } catch {}
        }
        room = {
          sender: { ws, id: ws._id },
          receivers: room ? room.receivers : new Map(),
          listing: msg.listing && typeof msg.listing === 'object' ? msg.listing : null,
          passwordHash: msg.passwordHash || null,
          expiresAt,
          createdAt: Date.now()
        };
        liveRooms.set(msg.id, room);
        ws._role = 'sender';
        ws._roomId = msg.id;
        return liveSend(ws, { type: 'registered', iceServers: iceServers() });
      }

      if (msg.type === 'join') {
        if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) {
          return liveSend(ws, { type: 'error', code: 'bad-id' });
        }
        const room = getLiveRoom(msg.id);
        if (!room) return liveSend(ws, { type: 'error', code: 'share-not-found' });
        const senderOnline = !!(room.sender && room.sender.ws.readyState === room.sender.ws.OPEN);
        if (!senderOnline) return liveSend(ws, { type: 'error', code: 'sender-offline' });
        if (room.passwordHash && !hashesEqual(room.passwordHash, msg.passwordHash)) {
          return liveSend(ws, { type: 'error', code: 'wrong-password' });
        }
        room.receivers.set(ws._id, ws);
        ws._role = 'receiver';
        ws._roomId = msg.id;
        liveSend(ws, {
          type: 'joined',
          senderOnline: true,
          listing: room.listing,
          expiresAt: room.expiresAt,
          iceServers: iceServers()
        });
        liveSend(room.sender.ws, { type: 'receiver-joined', receiverId: ws._id });
        return;
      }

      if (msg.type === 'signal') {
        const room = ws._roomId ? liveRooms.get(ws._roomId) : null;
        if (!room || !msg.data || typeof msg.data !== 'object') return;
        if (ws._role === 'receiver' && room.sender) {
          liveSend(room.sender.ws, { type: 'signal', from: ws._id, data: msg.data });
        } else if (ws._role === 'sender' && typeof msg.to === 'string') {
          const target = room.receivers.get(msg.to);
          if (target) liveSend(target, { type: 'signal', from: ws._id, data: msg.data });
        }
        return;
      }

      if (msg.type === 'transfer-complete') {
        const room = ws._roomId ? liveRooms.get(ws._roomId) : null;
        if (room && ws._role === 'receiver' && room.sender) {
          liveSend(room.sender.ws, { type: 'transfer-complete', receiverId: ws._id });
        }
        return;
      }
    } catch (err) {
      console.error('[live] message handler failed:', err.message);
      liveSend(ws, { type: 'error', code: 'server-error' });
    }
  });

  ws.on('close', () => {
    const room = ws._roomId ? liveRooms.get(ws._roomId) : null;
    if (!room) return;
    if (ws._role === 'sender' && room.sender && room.sender.ws === ws) {
      room.sender = null;
      for (const receiver of room.receivers.values()) {
        liveSend(receiver, { type: 'sender-offline' });
      }
    }
    if (ws._role === 'receiver') {
      room.receivers.delete(ws._id);
      if (room.sender) liveSend(room.sender.ws, { type: 'receiver-left', receiverId: ws._id });
    }
    pruneRoom(ws._roomId);
  });
});

// Heartbeat + stale-room sweep.
setInterval(() => {
  for (const [id, room] of liveRooms) {
    if (roomExpired(room)) {
      if (room.sender) { try { room.sender.ws.close(); } catch {} }
      for (const receiver of room.receivers.values()) {
        liveSend(receiver, { type: 'error', code: 'share-expired' });
        try { receiver.close(); } catch {}
      }
      liveRooms.delete(id);
      continue;
    }
    const senderGone = !room.sender || room.sender.ws.readyState !== room.sender.ws.OPEN;
    if (senderGone && room.receivers.size === 0) liveRooms.delete(id);
  }
  for (const ws of wss.clients) {
    if (!ws._alive) { try { ws.terminate(); } catch {} continue; }
    ws._alive = false;
    try { ws.ping(); } catch {}
  }
}, 30 * 1000).unref();

// Absolute room age cap.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of liveRooms) {
    if (now - room.createdAt > ROOM_MAX_AGE_MS) {
      if (room.sender) { try { room.sender.ws.close(); } catch {} }
      for (const receiver of room.receivers.values()) { try { receiver.close(); } catch {} }
      liveRooms.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

async function start() {
  server.listen(PORT, () => {
    console.log(`UniShare (pure P2P) running at http://localhost:${PORT}`);
  });
}

async function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
  start().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, server, start, liveRooms, iceServers, wss };
