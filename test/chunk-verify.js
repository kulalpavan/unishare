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
  offers: 0,
  route(ws, raw) {
    const msg = JSON.parse(raw);
    if (msg.type === 'signal' && msg.data && msg.data.sdp && msg.data.sdp.type === 'offer') this.offers++;
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
    // ondatachannel for an incoming offer. A fresh peer (e.g. after an
    // ICE retry) has no linked channel yet, so pair it with the newest
    // unpaired data channel.
    if (d.type === 'offer' && !this._peerDc) {
      const other = [...pcs].reverse().find(p => p !== this && p._dc && !p._dc.peer);
      if (other) {
        const senderDc = new FakeDC();
        other._dc.peer = senderDc;
        senderDc.peer = other._dc;
        this._peerDc = senderDc;
      }
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

  const senderChats = [];
  const senderHandle = await startSender({
    id: 'big-room-test', files: [], text: bigText, listing,
    passwordHash: null, expiresAt: null,
    onStatus: () => {}, onReceiverJoin: () => {}, onReceiverLeft: () => {},
    onProgress: () => {}, onFileSent: () => {}, onTransferComplete: () => {},
    onChat: msg => senderChats.push(msg), onConnect: () => {}
  });

  let gotManifest = null;
  let manifestCount = 0;
  let gotText = null;
  let fileError = null;
  let sessionErrors = 0;
  let receiverHandle = null;
  const receiverChats = [];
  const done = new Promise(resolve => {
    startReceiver({
      id: 'big-room-test', passwordHash: null, timeoutMs: 5000,
      onStatus: () => {},
      onManifest: msg => { gotManifest = msg; manifestCount++; },
      onText: text => { gotText = text; resolve(); },
      onFileStart: () => {}, onFileProgress: () => {}, onFileComplete: () => {},
      onFileError: (path, message) => { fileError = { path, message }; },
      onDone: () => {}, onError: () => { sessionErrors++; },
      onChat: msg => receiverChats.push(msg), onConnect: () => {}
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

  // Ephemeral chat over the same data channel: receiver -> sender (labeled
  // per peer) and sender -> receiver, with nothing stored anywhere.
  assert.equal(receiverHandle.sendChat('hey sender, got the listing'), true, 'chat sends while connected');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(senderChats.length, 1, 'sender received the chat');
  assert.equal(senderChats[0].text, 'hey sender, got the listing');
  assert.equal(senderChats[0].from, 'Receiver 1', 'sender sees the per-peer label');
  assert.equal(senderHandle.sendChat('hey receiver, sending soon'), 1, 'sender broadcast reaches the receiver');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(receiverChats.length, 1, 'receiver received the chat');
  assert.equal(receiverChats[0].text, 'hey receiver, sending soon');
  assert.equal(receiverChats[0].from, 'sender');
  // Long messages are truncated at send time, never delivered whole.
  receiverHandle.sendChat('x'.repeat(5000));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(senderChats[1].text.length, 2000, 'oversized chat truncated to the cap');
  // Raw oversized messages from a modified peer are dropped, not rendered.
  senderDc.send(JSON.stringify({ t: 'chat', from: 'sender', text: 'y'.repeat(5000), at: 1 }));
  receiverDc.send(JSON.stringify({ t: 'chat', from: 'receiver', text: 'z'.repeat(5000), at: 1 }));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(receiverChats.length, 1, 'oversized inbound chat dropped on the receiver');
  assert.equal(senderChats.length, 2, 'oversized inbound chat dropped on the sender');
  assert.equal(sessionErrors, 0, 'chat traffic never fails the session');
  console.log('ok - ephemeral chat round-trips, truncates, and drops oversized messages');

  // ICE failure retry: a failed peer connection is rebuilt once (fresh
  // offer) instead of killing the session — first with the sender's
  // peer still alive (re-negotiation), then with both peers dead (the
  // sender builds a fresh peer for the re-offer).
  const offersBefore = hub.offers;
  pcs[0].connectionState = 'failed';
  pcs[0].handlers.conn();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(sessionErrors, 0, 'first ICE failure does not fail the session');
  assert.ok(hub.offers > offersBefore, 'receiver re-offered after ICE failure');
  // The rebuilt connection opens: the retry budget resets, so a later
  // failure gets a fresh retry instead of failing outright.
  pcs[2]._dc.onopen();
  await new Promise(r => setTimeout(r, 50));
  const senderPc = pcs[1];
  senderPc.connectionState = 'failed';
  senderPc.handlers.conn();
  pcs[2].connectionState = 'failed';
  pcs[2].handlers.conn();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(sessionErrors, 0, 'ICE failure on both sides does not fail the session');
  assert.ok(hub.offers >= offersBefore + 2, 're-offers sent after both-side failure');
  const manifestsBefore = manifestCount;
  const newestReceiverDc = [...pcs].reverse().find(p => p._dc && p._dc.peer)._dc;
  assert.ok(newestReceiverDc, 'a linked receiver channel exists after retry');
  newestReceiverDc.onopen();
  await new Promise(r => setTimeout(r, 100));
  assert.ok(manifestCount > manifestsBefore, 'manifest flows again over the rebuilt connection');
  console.log('ok - ICE failure retried with a fresh connection, session survives');
  console.log('chunk-verify: all checks passed');
  process.exit(0);
})().catch(err => { console.error('chunk-verify FAILED:', err); process.exit(1); });
