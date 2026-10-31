'use strict';
// Drives the real public/p2p.js with stubbed WebSocket/RTCPeerConnection
// to prove large manifests and long notes survive the data channel:
// the sender must chunk them, the receiver must reassemble them exactly.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeSocket {
  constructor(hub) {
    this.hub = hub;
    this.handlers = {};
    this.readyState = 1;
  }
  addEventListener(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg); }
  send(raw) { this.hub.route(this, raw); }
  close() { this.emit('close', {}); }
}

class FakeDC {
  constructor() { this.readyState = 'open'; this.binaryType = 'arraybuffer'; this.peer = null; this.sent = []; }
  send(data) { this.sent.push(data); if (this.peer && this.peer.onmessage) this.peer.onmessage({ data }); }
}

class FakePC {
  constructor() {
    this.handlers = {};
    this.localDescription = null;
    this.remoteDescription = null;
    this._dc = null;
  }
  set onicecandidate(fn) { this.handlers.ice = fn; }
  set ondatachannel(fn) { this.handlers.channel = fn; }
  set onconnectionstatechange(fn) { this.handlers.conn = fn; }
  createDataChannel() { this._dc = new FakeDC(); return this._dc; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 fake offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 fake answer' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    if (d.type === 'offer' && this.handlers.channel && this._peerDc) {
      this.handlers.channel({ channel: this._peerDc });
    }
  }
  async addIceCandidate() {}
  close() {}
}

// In-memory hub mimicking server.js relay rules.
const hub = {
  rooms: new Map(),
  route(ws, raw) {
    const msg = JSON.parse(raw);
    if (msg.type === 'register-sender') {
      this.rooms.set(msg.id, { sender: ws, receivers: new Map(), listing: msg.listing });
      ws.emit('message', { data: JSON.stringify({ type: 'registered', iceServers: [] }) });
    } else if (msg.type === 'join') {
      const room = this.rooms.get(msg.id);
      ws.emit('message', { data: JSON.stringify({ type: 'joined', senderOnline: true, listing: room.listing, iceServers: [] }) });
      room.receivers.set(ws, true);
      room.sender.emit('message', { data: JSON.stringify({ type: 'receiver-joined', receiverId: 'r1' }) });
    } else if (msg.type === 'signal') {
      const room = [...this.rooms.values()][0];
      if (ws === room.sender) {
        for (const r of room.receivers.keys()) r.emit('message', { data: JSON.stringify({ type: 'signal', data: msg.data }) });
      } else {
        room.sender.emit('message', { data: JSON.stringify({ type: 'signal', from: 'r1', data: msg.data }) });
      }
    }
  }
};

// Wire the two fake peer connections together: the receiver's data channel
// and the sender's ondatachannel end must be a linked pair.
let pcs = [];
class FakePCWired extends FakePC {
  constructor() {
    super();
    pcs.push(this);
  }
  createDataChannel(label) {
    const dc = super.createDataChannel(label);
    return dc;
  }
  async setRemoteDescription(d) {
    // Link the channels BEFORE the base implementation fires
    // ondatachannel for an incoming offer.
    if (d.type === 'offer' && pcs.length === 2 && pcs[0]._dc && !pcs[0]._dc.peer) {
      const receiverDc = pcs[0]._dc;
      const senderDc = new FakeDC();
      receiverDc.peer = senderDc;
      senderDc.peer = receiverDc;
      this._peerDc = senderDc;
    }
    await super.setRemoteDescription(d);
  }
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  TextEncoder,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  location: { protocol: 'https:', host: 'test.invalid' },
  crypto: require('node:crypto').webcrypto,
  WebSocket: class extends FakeSocket {
    constructor() { super(hub); queueMicrotask(() => this.emit('open', {})); }
  },
  RTCPeerConnection: FakePCWired,
  RTCSessionDescription: class { constructor(d) { Object.assign(this, d); } },
  RTCIceCandidate: class { constructor(c) { Object.assign(this, c); } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.WebSocket.OPEN = 1;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'p2p.js'), 'utf8'), sandbox);

const { startSender, startReceiver } = sandbox.UniShareLive;

(async () => {
  const files = [];
  for (let i = 0; i < 8000; i++) files.push({ path: `big-folder/file-${i}.bin`, size: 1000 + i });
  const listing = { kind: 'folder', topName: 'big-folder', folderName: 'big-folder', files, hasText: true };
  const bigText = 'hello-large-note '.repeat(20000); // ~340KB
  const manifestJson = JSON.stringify({ t: 'manifest', hasText: true, listing });
  assert.ok(manifestJson.length > 262144, 'manifest must exceed the 256KB data-channel limit');
  assert.ok(bigText.length > 262144, 'note must exceed the 256KB data-channel limit');

  await startSender({
    id: 'big-room-test', files: [], text: bigText, listing,
    passwordHash: null, expiresAt: null,
    onStatus: () => {}, onReceiverJoin: () => {}, onReceiverLeft: () => {},
    onProgress: () => {}, onFileSent: () => {}, onTransferComplete: () => {}
  });

  let gotManifest = null;
  let gotText = null;
  let fileError = null;
  let sessionErrors = 0;
  let receiverHandle = null;
  const done = new Promise(resolve => {
    startReceiver({
      id: 'big-room-test', passwordHash: null, timeoutMs: 5000,
      onStatus: () => {},
      onManifest: msg => { gotManifest = msg; },
      onText: text => { gotText = text; resolve(); },
      onFileStart: () => {}, onFileProgress: () => {}, onFileComplete: () => {},
      onFileError: (path, message) => { fileError = { path, message }; },
      onDone: () => {}, onError: () => { sessionErrors++; }
    }).then(receiver => {
      receiverHandle = receiver;
      // The receiver asks for the text once the manifest arrives; emulate
      // that here once we see the manifest (poll briefly).
      const iv = setInterval(() => {
        if (gotManifest) { clearInterval(iv); receiver.requestText(); }
      }, 10);
    });
  });

  // Let the handshake + channel open play out, then fire the receiver
  // data-channel open (the stub has no real ICE to do it).
  await new Promise(r => setTimeout(r, 100));
  const receiverDc = pcs[0]._dc;
  assert.ok(receiverDc, 'receiver data channel exists');
  receiverDc.onopen();

  await done;
  assert.ok(gotManifest, 'manifest received');
  assert.equal(gotManifest.listing.files.length, 8000, 'all 8000 files in manifest');
  assert.equal(gotManifest.listing.files[7999].path, 'big-folder/file-7999.bin');
  assert.equal(gotText, bigText, 'long note reassembled exactly');
  const senderDc = receiverDc.peer;
  assert.ok(senderDc.sent.length > 2, 'manifest was actually chunked into several sends');
  console.log('ok - 8000-file manifest chunked and reassembled exactly');
  console.log('ok - 340KB text note chunked and reassembled exactly');

  // A missing file fails per-file: the session stays alive and the text
  // can still be fetched afterwards.
  receiverHandle.requestFile('big-folder/does-not-exist.bin');
  await new Promise(r => setTimeout(r, 100));
  assert.ok(fileError, 'file-error reported for the missing file');
  assert.equal(fileError.path, 'big-folder/does-not-exist.bin');
  assert.equal(sessionErrors, 0, 'a single bad file does not kill the session');
  gotText = null;
  receiverHandle.requestText();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(gotText, bigText, 'session still serves requests after a file error');
  console.log('ok - per-file failure is isolated, session survives');
  console.log('chunk-verify: all checks passed');
  process.exit(0);
})().catch(err => { console.error('chunk-verify FAILED:', err); process.exit(1); });
