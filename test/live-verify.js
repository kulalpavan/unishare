'use strict';

/* Signaling-hub verification: runs without PostgreSQL by stubbing db.getShare.
 * Usage: node test/live-verify.js
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unishare:unishare@127.0.0.1:1/unishare';

const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');

const { server, db } = require('../server');

const SHARE_ID = 'testshareid123456';
const PASSWORD = 'hunter2';

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 4);
  db.getShare = async id => {
    if (id === SHARE_ID) {
      return {
        id: SHARE_ID,
        password_hash: hash,
        expires_at: null,
        created_at: Date.now()
      };
    }
    if (id === 'openshare12345678') {
      return { id, password_hash: null, expires_at: null, created_at: Date.now() };
    }
    return null;
  };

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

  // 1. Sender registers.
  const sender = await connect();
  sender.send(JSON.stringify({
    type: 'register-sender',
    id: SHARE_ID,
    listing: { kind: 'files', files: [{ path: 'a.txt', size: 5 }] }
  }));
  const registered = await nextMessage(sender);
  assert.equal(registered.type, 'registered');
  assert.ok(Array.isArray(registered.iceServers) && registered.iceServers.length);
  console.log('ok - sender registers, ICE servers returned');

  // 2. Receiver with wrong password is rejected.
  const wrongPw = await connect();
  wrongPw.send(JSON.stringify({ type: 'join', id: SHARE_ID, password: 'nope' }));
  const rejected = await nextMessage(wrongPw);
  assert.equal(rejected.type, 'error');
  assert.equal(rejected.code, 'wrong-password');
  wrongPw.close();
  console.log('ok - wrong password rejected');

  // 3. Receiver with correct password joins; sender is notified.
  const receiver = await connect();
  receiver.send(JSON.stringify({ type: 'join', id: SHARE_ID, password: PASSWORD }));
  const joined = await nextMessage(receiver);
  assert.equal(joined.type, 'joined');
  assert.equal(joined.senderOnline, true);
  assert.deepEqual(joined.listing, { kind: 'files', files: [{ path: 'a.txt', size: 5 }] });
  const receiverJoined = await nextMessage(sender);
  assert.equal(receiverJoined.type, 'receiver-joined');
  const receiverId = receiverJoined.receiverId;
  assert.ok(receiverId);
  console.log('ok - password-gated join, sender notified');

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

  // 5. Unknown share is rejected.
  const stranger = await connect();
  stranger.send(JSON.stringify({ type: 'join', id: 'doesnotexist12345', password: '' }));
  const notFound = await nextMessage(stranger);
  assert.equal(notFound.type, 'error');
  assert.equal(notFound.code, 'share-not-found');
  stranger.close();
  console.log('ok - unknown share rejected');

  // 6. Sender disconnect notifies the receiver.
  sender.close();
  const offline = await nextMessage(receiver);
  assert.equal(offline.type, 'sender-offline');
  receiver.close();
  console.log('ok - sender disconnect notifies receivers');

  // 7. Open (passwordless) share join works when sender is offline.
  const late = await connect();
  late.send(JSON.stringify({ type: 'join', id: 'openshare12345678', password: '' }));
  const lateJoined = await nextMessage(late);
  assert.equal(lateJoined.type, 'joined');
  assert.equal(lateJoined.senderOnline, false);
  late.close();
  console.log('ok - offline sender reported for open share');

  server.close();
  console.log('live-verify: all checks passed');
}

main().catch(err => {
  console.error('live-verify FAILED:', err);
  try { server.close(); } catch {}
  process.exit(1);
});
