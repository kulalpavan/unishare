'use strict';

/* Signaling-hub verification for the pure-P2P server (no database).
 * Usage: node test/live-verify.js
 */

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

  // 7. Expired rooms are rejected.
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
  assert.equal(expired.code, 'share-not-found');
  late.close();
  expSender.close();
  console.log('ok - expired rooms are gone');

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

  server.close();
  console.log('live-verify: all checks passed');
}

main().catch(err => {
  console.error('live-verify FAILED:', err);
  try { server.close(); } catch {}
  process.exit(1);
});
