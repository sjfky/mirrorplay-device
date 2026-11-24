// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The session rules, checked with stub links so each one is deterministic: what a receiver is
// allowed to see, when the relay asks a source for a key frame, and what happens when a receiver
// cannot drain the socket. The socket-level tests are in relay.test.js; these are the policy paths
// that a real network makes hard to hit on purpose.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Projection, Phase } from '../src/core/hub.js';
import { CloseNotifier } from '../src/relay/links.js';
import { Clock } from '../src/core/clock.js';
import { Kind, Flag, decodeBinary, encodeBinary, encodeTouch, encodeKey, HEADER_SIZE } from '../src/protocol/binary.js';
import { parseMessage } from '../src/protocol/json.js';
import { AvcConfig } from '../src/media/avc.js';

const FORMAT = AvcConfig.wireFormat(
  AvcConfig.fromParameterSets(
    new Uint8Array([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xca, 0x3c, 0x60, 0xca, 0x80]),
    new Uint8Array([0x68, 0xce, 0x3c, 0x80]),
  ),
  { fpsHint: 30 },
);
const IDR = new Uint8Array([0, 0, 0, 3, 0x65, 1, 2]);
const DELTA = new Uint8Array([0, 0, 0, 3, 0x41, 1, 2]);

/** Records every byte a link would put on the wire, so assertions are about protocol, not timing.
 * It is the socket a ReceiverChan or InputLink would be handed, so no network is involved. */
class StubSocket {
  constructor({ buffered = 0 } = {}) {
    this.sent = [];
    this.bufferedAmountValue = buffered;
    this.closedCode = null;
    this.readyState = 1;
  }

  on() {}

  send(data, options = {}) {
    this.sent.push({ data, text: !options.binary });
  }

  close(code = 1000) {
    this.closedCode = code;
    this.readyState = 3;
  }

  get bufferedAmount() {
    return this.bufferedAmountValue;
  }

  get text() {
    return this.sent.filter((entry) => entry.text).map((entry) => JSON.parse(entry.data));
  }

  get media() {
    return this.sent.filter((entry) => !entry.text).map((entry) => decodeBinary(new Uint8Array(entry.data)));
  }

  types() {
    return this.text.map((message) => message.type);
  }

  findType(type) {
    return this.text.filter((message) => message.type === type);
  }

  /** The wire in order, so a claim about ordering reads as a claim about ordering. */
  stream() {
    return this.sent.map((entry) => (entry.text ? JSON.parse(entry.data).type : 'binary'));
  }
}

// The stub is a link, so it uses the same close broadcast the real links do: a test that cannot
// notifyClosed() is a test that cannot check what happens when a peer walks away.
class StubLink extends CloseNotifier {
  constructor(id, { buffered = 0 } = {}) {
    super();
    this.id = id;
    this.sent = [];
    this.bufferedAmountValue = buffered;
  }

  send(data, text = false) {
    if (this.closed) return false;
    this.sent.push({ data, text });
    return true;
  }

  sendRaw(bytes) {
    return this.send(bytes, false);
  }

  sendJson(message) {
    return this.send(JSON.stringify(message), true);
  }

  bufferedAmount() {
    return this.bufferedAmountValue;
  }

  close(code = 1000) {
    this.notifyClosed(`closed ${code}`);
  }

  get text() {
    return this.sent.filter((entry) => entry.text).map((entry) => parseMessage(entry.data));
  }

  get media() {
    return this.sent.filter((entry) => !entry.text).map((entry) => decodeBinary(new Uint8Array(entry.data)));
  }

  types() {
    return this.text.map((message) => message.type);
  }

  stream() {
    return this.sent.map((entry) => (entry.text ? JSON.parse(entry.data).type : 'binary'));
  }
}

/** The device end of a projection, as seen by the rules: a link with toInput and deliver hooks. */
function attachSource(projection, { buffered = 0 } = {}) {
  const link = new StubLink(99, { buffered });
  link.kind = 'stub-input';
  link.toInput = (message) => link.sent.push({ data: JSON.stringify(message), text: true });
  link.deliver = () => true;
  link.label = () => 'stub';
  projection.attachSource(link);
  return link;
}

function attachReceiver(projection, { buffered = 0 } = {}) {
  const socket = new StubSocket({ buffered });
  const receiver = projection.addReceiver(socket);
  return { receiver, stub: socket };
}

const hello = (overrides = {}) => ({
  type: 'hello',
  version: 0,
  token: 't',
  decoders: [{ codecString: 'avc1.42E01F', hardware: false }],
  displays: [{ screen: 0, width: 1280, height: 720, dpr: 1, refreshHz: 60, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }],
  maxTouchContacts: 10,
  audio: ['AAC_LC'],
  microphone: false,
  ...overrides,
});

test('a new projection starts in startup/connecting', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 1 });
  assert.equal(projection.phase, Phase.Connecting);
  assert.equal(projection.reason, 'startup/connecting');
  assert.equal(projection.snapshot().sources.length, 0);
});

test('frames are counted but withheld until a format exists, and a source without media only waits', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 2 });
  const source = attachSource(projection);
  assert.deepEqual(
    projection.snapshot().session,
    { id: 2, phase: Phase.Reconnecting, reason: 'startup/waiting-media' },
    'a peer being connected is not the same promise as media flowing',
  );
  projection.publishVideo({ avcc: IDR, ptsUs: 0, key: true });
  assert.equal(projection.snapshot().stats.frames, 1, 'the frame was counted');
  assert.equal(projection.snapshot().video, null, 'but no format exists yet');

  projection.attachSource(source);
  assert.equal(projection.snapshot().sources.length, 1, 'a Set does not double-count a re-attach');

  projection.setVideoFormat(FORMAT);
  assert.deepEqual(projection.snapshot().video, {
    codec: FORMAT.codec,
    codecString: FORMAT.codecString,
    width: FORMAT.width,
    height: FORMAT.height,
    fpsHint: FORMAT.fpsHint,
  });
  assert.equal(projection.snapshot().session.phase, Phase.Active, 'media, not a handshake, makes it active');
});

test('a receiver only sees frames from the first key frame, gap-flagged, then deltas', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 3 });
  projection.setVideoFormat(FORMAT);
  const source = attachSource(projection);
  const { receiver, stub } = attachReceiver(projection);
  receiver.receive(JSON.stringify(hello()), false);

  const seen = () => stub.media.length;
  projection.publishVideo({ avcc: DELTA, ptsUs: 0, key: false });
  projection.publishVideo({ avcc: DELTA, ptsUs: 33333, key: false });
  assert.equal(seen(), 0, 'two deltas ahead of any key frame were withheld');

  projection.publishVideo({ avcc: IDR, ptsUs: 66666, key: true });
  assert.equal(seen(), 1);
  const first = stub.media[0];
  assert.equal(first.header.flags, Flag.Keyframe | Flag.Gap);
  assert.ok(first.header.ptsUs > 66665n, 'media time is carried onto the relay clock')

  projection.publishVideo({ avcc: DELTA, ptsUs: 99999, key: false });
  const second = stub.media[1];
  assert.equal(second.header.flags, 0);
  assert.equal(second.header.sequence, first.header.sequence + 1);
  // Spacing is the relay's promise: whatever line the source counted on, two frames 33333µs apart
  // stay 33333µs apart after the anchor.
  assert.equal(second.header.ptsUs - first.header.ptsUs, 33333n);

  // The announcements have to precede the first frame, or a receiver would decode without a config.
  assert.deepEqual(stub.stream().slice(0, 4), ['session', 'video-format', 'view-area', 'binary'], 'a receiver is told the formats before any frame');
  assert.equal(stub.types().includes('audio-format'), false, 'no audio format was ever announced');
  const area = stub.findType('view-area')[0];
  // A 4:3 picture on a 16:9 display: height-limited, so 640x480 becomes 960x720 and is centred.
  assert.equal(area.width, 960);
  assert.equal(area.height, 720);
  assert.equal(area.x, 160);
  assert.equal(area.y, 0);
  assert.equal(area.canvasWidth, 1280);
  assert.ok(source.sent.some((entry) => entry.text && JSON.parse(entry.data).type === 'keyframe'), 'the relay asked the source for a key frame at hello');
});

test('the same hello twice is a resync, not a second subscription', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 4 });
  projection.setVideoFormat(FORMAT);
  attachSource(projection);
  const { receiver, stub } = attachReceiver(projection);
  receiver.receive(JSON.stringify(hello()), false);
  projection.publishVideo({ avcc: IDR, ptsUs: 0, key: true });
  const afterFirst = stub.media.length;
  receiver.receive(JSON.stringify(hello()), false);
  assert.equal(projection.receivers.size, 1);
  projection.publishVideo({ avcc: DELTA, ptsUs: 33333, key: false });
  assert.equal(stub.media.length, afterFirst, 'the delta is held until a new key frame');
  projection.publishVideo({ avcc: IDR, ptsUs: 66666, key: true });
  const resumed = stub.media.at(-1);
  assert.equal(resumed.header.flags, Flag.Keyframe | Flag.Gap);
  assert.equal(receiver.detail().counts.resyncs, 2, 'the first frame and the restart both count');
});

test('key frame requests are coalesced inside the limiter window', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 5 });
  projection.setVideoFormat(FORMAT);
  const source = attachSource(projection);
  const pairs = [attachReceiver(projection), attachReceiver(projection)];
  for (const { receiver } of pairs) receiver.receive(JSON.stringify(hello()), false);
  const asked = () => source.sent.filter((e) => e.text && JSON.parse(e.data).type === 'keyframe').length;
  const baseline = asked();
  pairs[0].receiver.receive(JSON.stringify({ type: 'keyframe', screen: 0 }), false);
  pairs[1].receiver.receive(JSON.stringify({ type: 'keyframe', screen: 0 }), false);
  pairs[0].receiver.receive(JSON.stringify({ type: 'keyframe', screen: 0 }), false);
  assert.equal(asked(), baseline, 'three requests in one window cost the source nothing extra');
  assert.equal(projection.snapshot().stats.deferredKeyRequests + projection.snapshot().stats.keyRequests >= 1, true);
});

test('a receiver that cannot drain is held back to the next key frame', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 6, backpressureBytes: 1024 });
  projection.setVideoFormat(FORMAT);
  attachSource(projection);
  const { receiver, stub } = attachReceiver(projection, { buffered: 4096 });
  receiver.receive(JSON.stringify(hello()), false);
  projection.publishVideo({ avcc: IDR, ptsUs: 0, key: true });
  assert.equal(stub.media.length, 0, 'nothing is queued onto a socket that is already full');
  assert.ok(receiver.detail().counts.dropped >= 1);
  assert.equal(receiver.awaitingKeyFrame, true, 'and it will restart on a key frame');
  stub.bufferedAmountValue = 0;
  projection.publishVideo({ avcc: DELTA, ptsUs: 33333, key: false });
  assert.equal(stub.media.length, 0, 'a delta still cannot be the restart point');
  projection.publishVideo({ avcc: IDR, ptsUs: 66666, key: true });
  assert.equal(stub.media.length, 1);
  assert.equal(stub.media[0].header.flags, Flag.Keyframe | Flag.Gap);
  assert.equal(projection.snapshot().stats.droppedForBackpressure >= 1, true);
});

test('a format change is re-announced before the first frame using it', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 7 });
  projection.setVideoFormat(FORMAT);
  attachSource(projection);
  const { receiver, stub } = attachReceiver(projection);
  receiver.receive(JSON.stringify(hello()), false);
  projection.publishVideo({ avcc: IDR, ptsUs: 0, key: true });
  const formatsBefore = stub.types().filter((type) => type === 'video-format').length;

  const bigger = { ...FORMAT, width: 1920, height: 1080, codecString: 'avc1.42E028' };
  projection.setVideoFormat(bigger);
  projection.publishVideo({ avcc: DELTA, ptsUs: 33333, key: false });
  assert.equal(stub.media.length, 1, 'the old-format decoder must not be fed new-format deltas');
  projection.publishVideo({ avcc: IDR, ptsUs: 66666, key: true });
  assert.equal(stub.media.length, 2);
  assert.equal(stub.types().filter((type) => type === 'video-format').length, formatsBefore + 1);
  assert.deepEqual(stub.stream().slice(-3), ['video-format', 'view-area', 'binary'], 'the format a frame needs is announced before that frame');
  assert.equal(stub.text.findLast((m) => m.type === 'video-format').format.width, 1920);
  void receiver;
});

test('touch and keys reach the source with their envelope intact, and are counted', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 8 });
  const source = attachSource(projection);
  const deliveries = [];
  source.deliver = (header, payload) => deliveries.push({ header, payload });
  const { receiver } = attachReceiver(projection);
  const packet = (kind, sequence, payload) => new Uint8Array(encodeBinary({ kind, stream: 0, flags: 0, sequence, ptsUs: BigInt(sequence), senderClockUs: BigInt(sequence) }).byteLength + payload.byteLength);
  receiver.receive(outPacket(Kind.Touch, encodeTouch([{ id: 0, pressed: true, x: 0.1, y: 0.9 }]), 1n), true);
  receiver.receive(outPacket(Kind.Key, encodeKey({ code: 1, down: true }), 2n), true);
  void packet;
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].header.kind, Kind.Touch);
  assert.equal(deliveries[1].header.kind, Kind.Key);
  const snapshot = projection.snapshot();
  assert.equal(snapshot.stats.touchEvents, 1);
  assert.equal(snapshot.stats.keyEvents, 1);
  assert.equal(snapshot.lastTouch.contacts[0].x, 0.1);
  assert.equal(snapshot.lastTouch.contacts[0].y, 0.9);
  assert.equal(snapshot.lastKey.code, 1);
  assert.equal(snapshot.lastKey.down, true);
});

test('a source going away leaves the viewers waiting, and says which kind of gone', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 9 });
  const source = attachSource(projection);
  const { receiver, stub } = attachReceiver(projection);
  receiver.receive(JSON.stringify(hello()), false);
  // A receiver is only told about the session when it introduces itself; the hello above is what
  // makes every following phase change visible to it.
  assert.deepEqual(stub.types().filter((type) => type === 'session').length, 1, 'one session at hello');

  source.notifyClosed('source-ended');
  let session = stub.text.findLast((message) => message.type === 'session');
  assert.equal(session.session.phase, Phase.Reconnecting);
  assert.equal(session.session.reason, 'startup/waiting-media', 'the encoder stopped, media is what is missing');

  const second = attachSource(projection);
  session = stub.text.findLast((message) => message.type === 'session');
  assert.equal(session.session.reason, 'startup/waiting-media', 'attaching without media is still waiting');
  projection.setVideoFormat(FORMAT);
  session = stub.text.findLast((message) => message.type === 'session');
  assert.equal(session.session.phase, Phase.Active);

  second.notifyClosed('socket-closed');
  session = stub.text.findLast((message) => message.type === 'session');
  assert.equal(session.session.reason, 'startup/disconnected', 'a device whose socket vanished says so');
  void receiver;
});

test('a receiver ping is answered with the relay clock', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 10 });
  attachSource(projection);
  const { receiver, stub } = attachReceiver(projection);
  receiver.receive(JSON.stringify({ type: 'ping', t0Us: '123456789' }), false);
  const first = stub.text.findLast((m) => m.type === 'pong');
  assert.equal(first.t0Us, '123456789', "the receiver's own stamp comes back unchanged");
  receiver.receive(JSON.stringify({ type: 'ping', t0Us: '123456790' }), false);
  const second = stub.text.findLast((m) => m.type === 'pong');
  assert.ok(BigInt(second.t1Us) >= BigInt(first.t1Us), 't1 advances on the relay clock');
  assert.ok(BigInt(second.t2Us) >= BigInt(second.t1Us), 't2 is taken on the way out');
});

test('stats from a receiver are kept for the operator', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 11 });
  attachSource(projection);
  const { receiver } = attachReceiver(projection);
  const stats = {
    type: 'stats', screen: 0, decodeMs: 4.5, decodeQueue: 2, dropped: 1, rendered: 240,
    decodedLatencyMs: 28, renderedLatencyMs: 31, clockOffsetUs: '-1500', rttUs: '900',
    renderedFps: 29, videoFramesPerSecond: 30, wsBytesPerSecond: 3_000_000,
  };
  receiver.receive(JSON.stringify(stats), false);
  assert.equal(receiver.detail().stats.renderedFps, 29);
  assert.equal(projection.snapshot().receiverDetail[0].stats.rttUs, '900');
});

function outPacket(kind, payload, sequence = 0n) {
  return Uint8Array.from(encodeBinary({ kind, stream: 0, flags: 0, sequence: Number(sequence), ptsUs: sequence, senderClockUs: sequence }, payload));
}

test('the media clock survives a restart without asking the receiver to guess', () => {
  const projection = new Projection({ clock: new Clock(), sessionId: 12 });
  projection.setVideoFormat(FORMAT);
  const source = attachSource(projection);
  const { receiver, stub } = attachReceiver(projection);
  receiver.receive(JSON.stringify(hello()), false);
  projection.publishVideo({ avcc: IDR, ptsUs: 500_000, key: true });
  projection.publishVideo({ avcc: DELTA, ptsUs: 533_333, key: false });
  const [first, second] = stub.media;
  assert.equal(second.header.ptsUs - first.header.ptsUs, 33_333n);

  // The encoder restarts and counts from zero again. That is a new run, not a clock running backwards
  // inside one, so the relay re-anchors here instead of announcing negative delays.
  projection.publishVideo({ avcc: IDR, ptsUs: 0, key: true });
  const restarted = stub.media.at(-1);
  assert.ok(restarted.header.ptsUs >= first.header.ptsUs, 'presentation time never goes backwards');
  assert.ok(restarted.header.ptsUs <= restarted.header.senderClockUs, 'nor claims to be from the future');
  projection.publishVideo({ avcc: DELTA, ptsUs: 33_333, key: false });
  const after = stub.media.at(-1);
  assert.equal(after.header.ptsUs - restarted.header.ptsUs, 33_333n, 'and the new run keeps its own spacing');
  void source;
});
