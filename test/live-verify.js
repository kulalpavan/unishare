'use strict';

/* Signaling-hub verification for the pure-P2P server (no database).
 * Usage: node test/live-verify.js
 */

// Small caps so the limit tests below run fast; the mechanism is the same
// as the production defaults.
process.env.LIVE_MAX_ROOMS = '4';
process.env.LIVE_MAX_LISTING_BYTES = '2048';
process.env.LIVE_RATE_LIMIT = '30';
process.env.LIVE_RATE_WINDOW_MS = '10000';

const assert = require('node:assert');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const { server } = require('../server');

const SHARE_ID = 'testshareid123456';
const PASSWORD = 'hunter2';

const sha256Hex = text => crypto.createHash('sha256').update(text).digest('hex');

async function main() {
  const passwordHash = sha256Hex(PASSWORD);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `ws://127.0.0.1:${port}/live`;

  const connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

  const nextMessage = ws => new Promise(resolve => {
    ws.once('message', raw => resolve(JSON.parse(raw.toString())));
  });

  // 1. Sender registers with listing + password hash + expiry.
  const sender = await connect();
  sender.send(JSON.stringify({
    type: 'register-sender',
    id: SHARE_ID,
    listing: { kind: 'files', files: [{ path: 'a.txt', size: 5 }], hasText: false },
    passwordHash,
    expiresAt: Date.now() + 60 * 60 * 1000
  }));
  const registered = await nextMessage(sender);
  assert.equal(registered.type, 'registered');
  assert.ok(Array.isArray(registered.iceServers) && registered.iceServers.length);
  console.log('ok - sender registers, ICE servers returned');

  // 2. Receiver with wrong password hash is rejected.
  const wrongPw = await connect();
  wrongPw.send(JSON.stringify({ type: 'join', id: SHARE_ID, passwordHash: sha256Hex('nope') }));
  const rejected = await nextMessage(wrongPw);
  assert.equal(rejected.type, 'error');
  assert.equal(rejected.code, 'wrong-password');
  wrongPw.close();
  console.log('ok - wrong password rejected');

  // 3. Receiver with correct hash joins; sender is notified; listing flows.
  const receiver = await connect();
  receiver.send(JSON.stringify({ type: 'join', id: SHARE_ID, passwordHash }));
  const joined = await nextMessage(receiver);
  assert.equal(joined.type, 'joined');
  assert.equal(joined.senderOnline, true);
  assert.deepEqual(joined.listing, { kind: 'files', files: [{ path: 'a.txt', size: 5 }], hasText: false });
  const receiverJoined = await nextMessage(sender);
  assert.equal(receiverJoined.type, 'receiver-joined');
  const receiverId = receiverJoined.receiverId;
  assert.ok(receiverId);
  console.log('ok - password-hash join, sender notified, listing delivered');

  // 4. Signals relay both ways.
  receiver.send(JSON.stringify({ type: 'signal', data: { sdp: { type: 'offer', sdp: 'v=0 fake' } } }));
  const toSender = await nextMessage(sender);
  assert.equal(toSender.type, 'signal');
  assert.equal(toSender.data.sdp.type, 'offer');
  sender.send(JSON.stringify({ type: 'signal', to: receiverId, data: { candidate: { candidate: 'fake' } } }));
  const toReceiver = await nextMessage(receiver);
  assert.equal(toReceiver.type, 'signal');
  assert.equal(toReceiver.data.candidate.candidate, 'fake');
  console.log('ok - signals relay sender <-> receiver');

  // 5. transfer-complete notifies the sender.
  receiver.send(JSON.stringify({ type: 'transfer-complete' }));
  const complete = await nextMessage(sender);
  assert.equal(complete.type, 'transfer-complete');
  assert.equal(complete.receiverId, receiverId);
  console.log('ok - transfer-complete reaches the sender');

  // 6. Unknown share is rejected.
  const stranger = await connect();
  stranger.send(JSON.stringify({ type: 'join', id: 'doesnotexist12345', passwordHash: null }));
  const notFound = await nextMessage(stranger);
  assert.equal(notFound.type, 'error');
  assert.equal(notFound.code, 'share-not-found');
  stranger.close();
  console.log('ok - unknown share rejected');

  // 7. Expired rooms are rejected with the expiry code (not "not found").
  const expSender = await connect();
  expSender.send(JSON.stringify({
    type: 'register-sender',
    id: 'expiredshare123456',
    listing: { kind: 'note', files: [], hasText: true },
    passwordHash: null,
    expiresAt: Date.now() + 50
  }));
  const expRegistered = await nextMessage(expSender);
  assert.equal(expRegistered.type, 'registered');
  await new Promise(r => setTimeout(r, 120));
  const late = await connect();
  late.send(JSON.stringify({ type: 'join', id: 'expiredshare123456', passwordHash: null }));
  const expired = await nextMessage(late);
  assert.equal(expired.type, 'error');
  assert.equal(expired.code, 'share-expired');
  late.close();
  expSender.close();
  console.log('ok - expired rooms report share-expired');

  // 8. Sender disconnect notifies the receiver.
  sender.close();
  const offline = await nextMessage(receiver);
  assert.equal(offline.type, 'sender-offline');
  receiver.close();
  console.log('ok - sender disconnect notifies receivers');

  // 9. Joining after the sender left reports sender-offline / not found.
  const ghost = await connect();
  ghost.send(JSON.stringify({ type: 'join', id: SHARE_ID, passwordHash }));
  const gone = await nextMessage(ghost);
  assert.equal(gone.type, 'error');
  assert.ok(['sender-offline', 'share-not-found'].includes(gone.code));
  ghost.close();
  console.log('ok - dead rooms are not joinable');

  // 10. An oversized message closes only that socket (1009) and never
  // crashes the server: a fresh client must still be able to register.
  const abusive = await connect();
  const abusiveClosed = new Promise(resolve => abusive.once('close', (code) => resolve(code)));
  abusive.send(Buffer.alloc(5 * 1024 * 1024, 0x61)); // 5MB > 4MB cap
  const closeCode = await abusiveClosed;
  assert.equal(closeCode, 1009);
  const survivor = await connect();
  survivor.send(JSON.stringify({
    type: 'register-sender',
    id: 'survivorroom12345',
    listing: { kind: 'note', files: [], hasText: true },
    passwordHash: null,
    expiresAt: null
  }));
  const survivorRegistered = await nextMessage(survivor);
  assert.equal(survivorRegistered.type, 'registered');
  survivor.close();
  console.log('ok - oversized message kills only its own socket, server survives');

  // 11. An expired share id can't be re-registered (tombstone): the sender
  // gets share-expired and the id stays dead.
  const resurrect = await connect();
  resurrect.send(JSON.stringify({
    type: 'register-sender',
    id: 'expiredshare123456',
    listing: { kind: 'note', files: [], hasText: true },
    passwordHash: null,
    expiresAt: null
  }));
  const tombstoned = await nextMessage(resurrect);
  assert.equal(tombstoned.type, 'error');
  assert.equal(tombstoned.code, 'share-expired');
  resurrect.close();
  console.log('ok - expired ids stay expired, no resurrection');

  // 12. Flooding one socket trips the rate limit.
  const flooder = await connect();
  const replies = [];
  flooder.on('message', raw => replies.push(JSON.parse(raw.toString())));
  for (let i = 0; i < 35; i++) {
    flooder.send(JSON.stringify({ type: 'join', id: 'doesnotexist12345', passwordHash: null }));
  }
  await new Promise(r => setTimeout(r, 300));
  assert.ok(replies.slice(0, 30).every(m => m.code === 'share-not-found'), 'first burst answered normally');
  assert.ok(replies.some(m => m.code === 'rate-limited'), 'burst past the limit is rate-limited');
  flooder.close();
  console.log('ok - message floods are rate-limited');

  // 13. Room count and total listing bytes are capped.
  const bigListing = { kind: 'files', files: Array.from({ length: 60 }, (_, i) => ({ path: `folder/file-${i}.bin`, size: i })), hasText: false };
  assert.ok(JSON.stringify(bigListing).length > 2048, 'test listing exceeds the test cap');
  const tooBig = await connect();
  tooBig.send(JSON.stringify({
    type: 'register-sender', id: 'biglistingroom12', listing: bigListing, passwordHash: null, expiresAt: null
  }));
  const capped = await nextMessage(tooBig);
  assert.equal(capped.type, 'error');
  assert.equal(capped.code, 'listing-limit');
  tooBig.close();
  const roomSockets = [];
  for (let i = 0; i < 4; i++) {
    const s = await connect();
    roomSockets.push(s);
    s.send(JSON.stringify({
      type: 'register-sender', id: `caproom${i}123456789`, listing: { kind: 'note', files: [], hasText: true }, passwordHash: null, expiresAt: null
    }));
    const reg = await nextMessage(s);
    assert.equal(reg.type, 'registered');
  }
  const fifth = await connect();
  fifth.send(JSON.stringify({
    type: 'register-sender', id: 'caproom4123456789', listing: { kind: 'note', files: [], hasText: true }, passwordHash: null, expiresAt: null
  }));
  const roomCapped = await nextMessage(fifth);
  assert.equal(roomCapped.type, 'error');
  assert.equal(roomCapped.code, 'room-limit');
  fifth.close();
  for (const s of roomSockets) s.close();
  console.log('ok - room count and listing memory are capped');

  // 14. /api/ice advertises TURN on every transport (UDP, TCP, TLS), so
  // restrictive networks that block UDP still get a relay path.
  const iceRes = await fetch(`http://127.0.0.1:${port}/api/ice`);
  const iceBody = await iceRes.json();
  const urls = (iceBody.iceServers || []).map(s => s.urls);
  assert.ok(urls.some(u => u.startsWith('turn:') && !u.includes('transport=')), 'UDP TURN present');
  assert.ok(urls.some(u => u.includes('?transport=tcp') && u.startsWith('turn:')), 'TCP TURN present');
  assert.ok(urls.some(u => u.startsWith('turns:')), 'TLS TURN present');
  console.log('ok - ICE servers include UDP, TCP and TLS TURN');

  server.close();
  console.log('live-verify: all checks passed');
}

main().catch(err => {
  console.error('live-verify FAILED:', err);
  try { server.close(); } catch {}
  process.exit(1);
});
