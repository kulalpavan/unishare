'use strict';

/* Grace-period verification for the pure-P2P server.
 * A sender that drops (phone tab backgrounded while the link is shared
 * in another app) must not kill the share instantly: the room is kept
 * for a grace period, joins during it report sender-away, and a
 * re-register under the same id revives the room. Explicit Stop Sharing
 * ends the room at once. Usage: node test/grace-verify.js
 */

// Short grace so the expiry checks run fast; the mechanism is the same
// as the 10-minute production default.
process.env.LIVE_SENDER_GRACE_MS = '400';

const assert = require('node:assert');
const WebSocket = require('ws');

const { server } = require('../server');

const LISTING = { kind: 'files', files: [{ path: 'a.txt', size: 5 }], hasText: false };

async function main() {
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

  const register = async (id, socket) => {
    socket.send(JSON.stringify({
      type: 'register-sender', id, listing: LISTING, passwordHash: null, expiresAt: null
    }));
    const msg = await nextMessage(socket);
    assert.equal(msg.type, 'registered');
    return msg;
  };

  // 1. Sender drops with no receiver yet: the room survives, and a join
  // during the grace period reports sender-away, not share-not-found.
  const sender1 = await connect();
  await register('grace-room-12345', sender1);
  sender1.close();
  await new Promise(r => setTimeout(r, 100));
  const early = await connect();
  early.send(JSON.stringify({ type: 'join', id: 'grace-room-12345', passwordHash: null }));
  const away = await nextMessage(early);
  assert.equal(away.type, 'error');
  assert.equal(away.code, 'sender-away');
  assert.equal(away.retryAfterMs, 3000);
  early.close();
  console.log('ok - join during grace reports sender-away, link stays alive');

  // 2. The sender comes back and re-registers the same id: the room
  // revives and a join succeeds.
  const sender2 = await connect();
  await register('grace-room-12345', sender2);
  const revived = await connect();
  revived.send(JSON.stringify({ type: 'join', id: 'grace-room-12345', passwordHash: null }));
  const joined = await nextMessage(revived);
  assert.equal(joined.type, 'joined');
  assert.equal(joined.senderOnline, true);
  assert.deepEqual(joined.listing, LISTING);
  console.log('ok - re-register under the same id revives the room');

  // 3. Once the grace period ends, the room is gone for good.
  sender2.close();
  revived.close();
  await new Promise(r => setTimeout(r, 600));
  const late = await connect();
  late.send(JSON.stringify({ type: 'join', id: 'grace-room-12345', passwordHash: null }));
  const gone = await nextMessage(late);
  assert.equal(gone.type, 'error');
  assert.equal(gone.code, 'share-not-found');
  late.close();
  console.log('ok - room is gone after the grace period ends');

  // 4. Stop Sharing ends the room immediately: no grace period, the
  // receiver is told it ended on purpose, and the id can be reused.
  const sender3 = await connect();
  await register('stop-room-1234567', sender3);
  const receiver3 = await connect();
  receiver3.send(JSON.stringify({ type: 'join', id: 'stop-room-1234567', passwordHash: null }));
  const joined3 = await nextMessage(receiver3);
  assert.equal(joined3.type, 'joined');
  await nextMessage(sender3); // receiver-joined
  const receiverClosed = new Promise(resolve => receiver3.once('close', resolve));
  sender3.send(JSON.stringify({ type: 'stop-sharing' }));
  const ended = await nextMessage(receiver3);
  assert.equal(ended.type, 'error');
  assert.equal(ended.code, 'share-ended');
  await receiverClosed;
  const afterStop = await connect();
  afterStop.send(JSON.stringify({ type: 'join', id: 'stop-room-1234567', passwordHash: null }));
  const stopped = await nextMessage(afterStop);
  assert.equal(stopped.code, 'share-not-found');
  afterStop.close();
  const sender4 = await connect();
  await register('stop-room-1234567', sender4);
  sender4.close();
  sender3.close();
  console.log('ok - stop-sharing ends the room at once, receivers told, id reusable');

  // 5. A receiver already in the room hears sender-offline on the drop
  // and sender-back when the sender re-registers.
  const sender5 = await connect();
  await register('back-room-123456', sender5);
  const receiver5 = await connect();
  receiver5.send(JSON.stringify({ type: 'join', id: 'back-room-123456', passwordHash: null }));
  assert.equal((await nextMessage(receiver5)).type, 'joined');
  await nextMessage(sender5); // receiver-joined
  sender5.close();
  const offline = await nextMessage(receiver5);
  assert.equal(offline.type, 'sender-offline');
  const sender6 = await connect();
  await register('back-room-123456', sender6);
  const back = await nextMessage(receiver5);
  assert.equal(back.type, 'sender-back');
  receiver5.close();
  sender6.close();
  console.log('ok - waiting receivers hear sender-offline then sender-back');

  // 6. Expiry beats grace: an expired room reports share-expired even
  // while the grace period would still be running.
  const sender7 = await connect();
  sender7.send(JSON.stringify({
    type: 'register-sender', id: 'expiry-room-1234', listing: LISTING,
    passwordHash: null, expiresAt: Date.now() + 50
  }));
  assert.equal((await nextMessage(sender7)).type, 'registered');
  sender7.close();
  await new Promise(r => setTimeout(r, 120));
  const expJoin = await connect();
  expJoin.send(JSON.stringify({ type: 'join', id: 'expiry-room-1234', passwordHash: null }));
  const expired = await nextMessage(expJoin);
  assert.equal(expired.type, 'error');
  assert.equal(expired.code, 'share-expired');
  expJoin.close();
  console.log('ok - expiry beats grace, expired rooms stay expired');

  // 7. A room with a connected receiver is not deleted when the sender
  // drops: a second join still reports sender-away, not not-found.
  const sender8 = await connect();
  await register('held-room-123456', sender8);
  const receiver8 = await connect();
  receiver8.send(JSON.stringify({ type: 'join', id: 'held-room-123456', passwordHash: null }));
  assert.equal((await nextMessage(receiver8)).type, 'joined');
  await nextMessage(sender8); // receiver-joined
  sender8.close();
  assert.equal((await nextMessage(receiver8)).type, 'sender-offline');
  const second = await connect();
  second.send(JSON.stringify({ type: 'join', id: 'held-room-123456', passwordHash: null }));
  const held = await nextMessage(second);
  assert.equal(held.type, 'error');
  assert.equal(held.code, 'sender-away');
  second.close();
  receiver8.close();
  console.log('ok - rooms with connected receivers survive the sender drop');

  server.close();
  console.log('grace-verify: all checks passed');
}

main().catch(err => {
  console.error('grace-verify FAILED:', err);
  try { server.close(); } catch {}
  process.exit(1);
});
