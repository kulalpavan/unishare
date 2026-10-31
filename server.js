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
// Abuse limits: cap the number of live rooms and the total listing bytes
// held in memory, so one client can't exhaust the free instance's RAM.
// Overridable via env for tests.
const MAX_ROOMS = Number(process.env.LIVE_MAX_ROOMS || 1000);
const MAX_TOTAL_LISTING_BYTES = Number(process.env.LIVE_MAX_LISTING_BYTES || 32 * 1024 * 1024);
const RATE_LIMIT = Number(process.env.LIVE_RATE_LIMIT || 120);
const RATE_WINDOW_MS = Number(process.env.LIVE_RATE_WINDOW_MS || 10000);
// Expired share ids are remembered so a sender that auto-reconnects can't
// resurrect an expired share as never-expiring.
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 5000;

const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // No inline scripts or styles exist in the pages, and JSZip is vendored
  // locally, so a strict policy costs nothing and blocks injected scripts.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// ICE servers for WebRTC peer connections. Configure via ICE_SERVERS env var
// (JSON array). Defaults to Google's free public STUN server plus the Open
// Relay Project's free shared TURN servers: without TURN, two browsers
// behind symmetric NATs (common on mobile networks) can never connect
// directly. The Open Relay credentials below are the project's published
// shared demo credentials; heavy users should get their own free ones.
function iceServers() {
  try {
    const parsed = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : null;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ];
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
const expiredIds = new Map(); // shareId -> tombstone timestamp (expiry resurrection guard)
let totalListingBytes = 0;

function listingBytesOf(listing) {
  try { return listing ? JSON.stringify(listing).length : 0; } catch { return 0; }
}

function deleteRoom(id) {
  const room = liveRooms.get(id);
  if (!room) return;
  totalListingBytes -= listingBytesOf(room.listing);
  if (totalListingBytes < 0) totalListingBytes = 0;
  liveRooms.delete(id);
}

// Expire a room: tombstone the id so it can't be re-registered, tell the
// sender it expired (so it stops reconnecting), and close receivers out.
function expireRoom(id) {
  const room = liveRooms.get(id);
  if (!room) return;
  deleteRoom(id);
  expiredIds.set(id, Date.now());
  if (expiredIds.size > MAX_TOMBSTONES) {
    const oldest = expiredIds.keys().next().value;
    expiredIds.delete(oldest);
  }
  if (room.sender) {
    liveSend(room.sender.ws, { type: 'expired' });
    try { room.sender.ws.close(); } catch {}
  }
  for (const receiver of room.receivers.values()) {
    liveSend(receiver, { type: 'error', code: 'share-expired' });
    try { receiver.close(); } catch {}
  }
}

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
    expireRoom(id);
    return null;
  }
  return room;
}

function pruneRoom(id) {
  const room = liveRooms.get(id);
  if (!room) return;
  const senderGone = !room.sender || room.sender.ws.readyState !== room.sender.ws.OPEN;
  if (senderGone && room.receivers.size === 0) deleteRoom(id);
}

wss.on('connection', ws => {
  ws._id = crypto.randomBytes(8).toString('hex');
  ws._role = null;
  ws._roomId = null;
  ws._alive = true;
  ws._msgTimestamps = [];
  ws.on('pong', () => { ws._alive = true; });
  ws.on('error', err => {
    console.error('[live] socket error:', err.message);
    try { ws.close(); } catch {}
  });

  ws.on('message', async raw => {
    // Per-socket rate limit (sliding window). Legitimate handshakes need
    // only a few dozen messages; floods get dropped with an error.
    const nowMs = Date.now();
    ws._msgTimestamps = ws._msgTimestamps.filter(t => nowMs - t < RATE_WINDOW_MS);
    if (ws._msgTimestamps.length >= RATE_LIMIT) {
      return liveSend(ws, { type: 'error', code: 'rate-limited' });
    }
    ws._msgTimestamps.push(nowMs);
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
        if (expiredIds.has(msg.id)) {
          liveSend(ws, { type: 'error', code: 'share-expired' });
          try { ws.close(); } catch {}
          return;
        }
        const newListingBytes = listingBytesOf(msg.listing && typeof msg.listing === 'object' ? msg.listing : null);
        const oldListingBytes = liveRooms.has(msg.id) ? listingBytesOf(liveRooms.get(msg.id).listing) : 0;
        if (!liveRooms.has(msg.id) && liveRooms.size >= MAX_ROOMS) {
          liveSend(ws, { type: 'error', code: 'room-limit' });
          try { ws.close(); } catch {}
          return;
        }
        if (totalListingBytes - oldListingBytes + newListingBytes > MAX_TOTAL_LISTING_BYTES) {
          liveSend(ws, { type: 'error', code: 'listing-limit' });
          try { ws.close(); } catch {}
          return;
        }
        const expiresAt = typeof msg.expiresAt === 'number' && msg.expiresAt > Date.now()
          ? msg.expiresAt
          : null;
        let room = liveRooms.get(msg.id);
        if (room && room.sender && room.sender.ws.readyState === room.sender.ws.OPEN) {
          try { room.sender.ws.close(); } catch {}
        }
        totalListingBytes += newListingBytes - oldListingBytes;
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
        // Report expiry with its own code instead of "not found".
        const raw = liveRooms.get(msg.id);
        if (raw && roomExpired(raw)) {
          expireRoom(msg.id);
          return liveSend(ws, { type: 'error', code: 'share-expired' });
        }
        const room = getLiveRoom(msg.id);
        if (!room) return liveSend(ws, { type: 'error', code: 'share-not-found' });
        const senderOnline = !!(room.sender && room.sender.ws.readyState === room.sender.ws.OPEN);
        if (!senderOnline) return liveSend(ws, { type: 'error', code: 'sender-offline' });
        if (room.receivers.size >= 20) {
          return liveSend(ws, { type: 'error', code: 'room-full' });
        }
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
      expireRoom(id);
      continue;
    }
    const senderGone = !room.sender || room.sender.ws.readyState !== room.sender.ws.OPEN;
    if (senderGone && room.receivers.size === 0) deleteRoom(id);
  }
  for (const ws of wss.clients) {
    if (!ws._alive) { try { ws.terminate(); } catch {} continue; }
    ws._alive = false;
    try { ws.ping(); } catch {}
  }
}, 30 * 1000).unref();

// Absolute room age cap + tombstone cleanup.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of liveRooms) {
    if (now - room.createdAt > ROOM_MAX_AGE_MS) {
      if (room.sender) { try { room.sender.ws.close(); } catch {} }
      for (const receiver of room.receivers.values()) { try { receiver.close(); } catch {} }
      deleteRoom(id);
    }
  }
  for (const [id, at] of expiredIds) {
    if (now - at > TOMBSTONE_TTL_MS) expiredIds.delete(id);
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
