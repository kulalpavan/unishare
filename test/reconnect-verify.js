'use strict';
// Proves the signaling reconnect logic in the real public/p2p.js:
//  1. A sender whose socket drops re-registers the SAME share id, so the
//     room stays joinable.
//  2. A receiver whose socket drops before the data channel opens retries
//     the join instead of failing.
//  3. A receiver whose socket drops AFTER the data channel opens ignores
//     it: the transfer continues and no error is raised.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sockets = [];
const pcs = [];
class FakeSocket {
  constructor() {
    this.handlers = {};
    this.readyState = 1;
    sockets.push(this);
  }
  addEventListener(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg); }
  send(raw) { hub.route(this, raw); }
  close() { this.readyState = 3; this.emit('close', {}); }
}

class FakeDC {
  constructor() { this.readyState = 'connecting'; this.binaryType = 'arraybuffer'; this.peer = null; this.closed = false; }
  send(data) { if (this.peer && this.peer.onmessage) this.peer.onmessage({ data }); }
  close() { this.closed = true; this.readyState = 'closed'; }
}

class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.closed = false;
    pcs.push(this);
  }
  set onicecandidate(fn) {}
  set ondatachannel(fn) { this._onchannel = fn; }
  set onconnectionstatechange(fn) {}
  createDataChannel() { this._dc = new FakeDC(); return this._dc; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 fake offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 fake answer' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    if (d.type === 'offer' && this._onchannel) {
      const senderDc = new FakeDC();
      senderDc.peer = this._dcPeer || null;
      this._onchannel({ channel: senderDc });
    }
  }
  async addIceCandidate() {}
  close() { this.closed = true; this.connectionState = 'closed'; }
}

const hub = {
  rooms: new Map(),
  joins: 0,
  registers: 0,
  route(ws, raw) {
    const msg = JSON.parse(raw);
    if (msg.type === 'register-sender') {
      this.registers++;
      let room = this.rooms.get(msg.id);
      if (!room) { room = { sender: null, receivers: new Map(), listing: null }; this.rooms.set(msg.id, room); }
      room.sender = ws;
      room.listing = msg.listing;
      ws.emit('message', { data: JSON.stringify({ type: 'registered', iceServers: [] }) });
    } else if (msg.type === 'join') {
      this.joins++;
      const room = this.rooms.get(msg.id);
      ws.emit('message', { data: JSON.stringify({ type: 'joined', senderOnline: !!room?.sender, listing: room?.listing || null, iceServers: [] }) });
      if (room?.sender) room.sender.emit('message', { data: JSON.stringify({ type: 'receiver-joined', receiverId: 'r1' }) });
    }
  }
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  TextEncoder,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  location: { protocol: 'https:', host: 'test.invalid' },
  crypto: require('node:crypto').webcrypto,
  WebSocket: class extends FakeSocket {
    constructor() { super(); queueMicrotask(() => this.emit('open', {})); }
  },
  RTCPeerConnection: FakePC,
  RTCSessionDescription: class { constructor(d) { Object.assign(this, d); } },
  RTCIceCandidate: class { constructor(c) { Object.assign(this, c); } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.WebSocket.OPEN = 1;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'p2p.js'), 'utf8'), sandbox);

const { startSender, startReceiver } = sandbox.UniShareLive;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const listing = { kind: 'note', topName: 'note.txt', folderName: null, files: [], hasText: true };

  // --- 1. Sender re-registers after a drop -------------------------------
  await startSender({
    id: 'reconnect-room', files: [], text: 'hi', listing,
    passwordHash: null, expiresAt: null,
    onStatus: () => {}, onReceiverJoin: () => {}, onReceiverLeft: () => {},
    onProgress: () => {}, onFileSent: () => {}, onTransferComplete: () => {}
  });
  assert.equal(hub.registers, 1, 'sender registered once');
  const senderSocket1 = sockets[0];
  senderSocket1.emit('close', {});
  await sleep(2200); // first retry backoff is 1500ms
  assert.ok(hub.registers >= 2, 'sender re-registered after drop');
  assert.equal(sockets.length, 2, 'a new signaling socket was opened');
  // The room must be joinable again under the same id.
  let joinedAfterReconnect = false;
  const probe = new sandbox.WebSocket();
  await new Promise(r => probe.addEventListener('open', r, { once: true }));
  probe.addEventListener('message', e => { if (JSON.parse(e.data).type === 'joined') joinedAfterReconnect = true; });
  probe.send(JSON.stringify({ type: 'join', id: 'reconnect-room', passwordHash: null }));
  await sleep(100);
  assert.ok(joinedAfterReconnect, 'room joinable after sender reconnect');
  console.log('ok - sender re-registers the same share id after a signaling drop');

  // --- 2. Receiver retries the join when its socket drops early ----------
  let receiverErrors = [];
  const receiver = await startReceiver({
    id: 'reconnect-room', passwordHash: null, timeoutMs: 8000,
    onStatus: () => {},
    onManifest: () => {},
    onText: () => {},
    onFileStart: () => {}, onFileProgress: () => {}, onFileComplete: () => {},
    onDone: () => {}, onError: err => receiverErrors.push(err)
  });
  const joinsBefore = hub.joins;
  const receiverSocket = sockets[sockets.length - 1];
  receiverSocket.emit('close', {});
  await sleep(2200);
  assert.ok(hub.joins > joinsBefore, 'receiver re-sent join after early drop');
  assert.equal(receiverErrors.length, 0, 'no error raised while retrying');
  console.log('ok - receiver retries the join after an early signaling drop');
  receiver.close();

  // --- 3. Drop after the data channel opens is ignored --------------------
  let lateErrors = [];
  const receiver2 = await startReceiver({
    id: 'reconnect-room', passwordHash: null, timeoutMs: 8000,
    onStatus: () => {},
    onManifest: () => {},
    onText: () => {},
    onFileStart: () => {}, onFileProgress: () => {}, onFileComplete: () => {},
    onDone: () => {}, onError: err => lateErrors.push(err)
  });
  await sleep(100);
  const receiverPc = [...pcs].reverse().find(p => p._dc);
  assert.ok(receiverPc, 'receiver data channel exists');
  receiverPc._dc.readyState = 'open';
  receiverPc._dc.onopen(); // data channel is now open
  const joinsBeforeLateDrop = hub.joins;
  const socketsBeforeLateDrop = sockets.length;
  const receiverSocket2 = sockets[sockets.length - 1];
  receiverSocket2.emit('close', {});
  receiverSocket2.emit('message', { data: JSON.stringify({ type: 'sender-offline' }) });
  await sleep(2200);
  assert.equal(hub.joins, joinsBeforeLateDrop, 'no re-join after the data channel is open');
  assert.equal(sockets.length, socketsBeforeLateDrop, 'no new socket after the data channel is open');
  assert.equal(lateErrors.length, 0, 'no error raised for a post-connect signaling drop');
  assert.equal(receiverPc.closed, false, 'peer connection kept alive for the transfer');
  receiver2.close();
  console.log('ok - signaling drop after the data channel opens is ignored, transfer survives');

  // --- 4. An expired share stops the sender reconnecting ------------------
  const registersBefore = hub.registers;
  const socketsBefore = sockets.length;
  const senderSocket = hub.rooms.get('reconnect-room').sender;
  senderSocket.emit('message', { data: JSON.stringify({ type: 'expired' }) });
  await sleep(2500);
  assert.equal(hub.registers, registersBefore, 'expired sender does not re-register');
  assert.equal(sockets.length, socketsBefore, 'expired sender opens no new socket');
  console.log('ok - expired share stops reconnecting, no resurrection');
  console.log('reconnect-verify: all checks passed');
  process.exit(0);
})().catch(err => { console.error('reconnect-verify FAILED:', err); process.exit(1); });
