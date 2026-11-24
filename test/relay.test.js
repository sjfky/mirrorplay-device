// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The relay's behaviour, end to end over real sockets: a fake device in, a fake head unit watching,
// and the session rules checked from the outside. These are the tests that matter most, because the
// rules are where a projection relay actually does its work: gating frames a receiver cannot decode,
// coalescing key frame requests, keeping touch honest, and swapping one source for another.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../src/relay/server.js';
import { FakeDevice } from '../src/tools/fake-device.js';
import { FakeHeadUnit } from '../src/tools/fake-head-unit.js';
import { AvcConfig } from '../src/media/avc.js';
import { Kind, Flag, encodeTouch, decodeTouch, decodeBinary } from '../src/protocol/binary.js';

const SPS = new Uint8Array([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xca, 0x3c, 0x60, 0xca, 0x80]);
const PPS = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
const FORMAT = AvcConfig.wireFormat(AvcConfig.fromParameterSets(SPS, PPS), { fpsHint: 30 });
const IDR = new Uint8Array([0, 0, 0, 3, 0x65, 1, 2, 3]);
const DELTA = new Uint8Array([0, 0, 0, 3, 0x41, 1, 2, 3]);
const AUDIO = new Uint8Array([1, 2, 3, 4]);

let port = 3400;
const nextPort = () => ++port;

async function withRelay(options, body) {
  const relay = new Relay({ port: nextPort(), host: '127.0.0.1', token: 'test-token', ...options });
  await relay.listen();
  try {
    return await body(relay);
  } finally {
    await relay.close();
  }
}

const urlFor = (relay, path) => `ws://127.0.0.1:${relay.options.port}${path}`;
const deviceFor = (relay) => new FakeDevice({ port: relay.options.port, host: '127.0.0.1', token: 'test-token' });
const unitFor = (relay) => new FakeHeadUnit({ url: urlFor(relay, '/wire'), token: 'test-token' });

test('a receiver is paired, told the session, and waits for media', async () => {
  await withRelay({ source: 'none' }, async (relay) => {
    const unit = await unitFor(relay).connect();
    await unit.until((u) => u.welcome, 'welcome');
    assert.equal(unit.welcome.version ?? 0, 0);
    assert.ok(unit.welcome.clientId, 'a client id came back');
    assert.match(unit.welcome.sourceUrl, /^https?:\/\//, 'sourceUrl names the project, not a socket');
    assert.ok(!unit.error, `the relay rejected the hello: ${unit.error?.message}`);
    await unit.until((u) => u.session?.phase === 'RECONNECTING', 'waiting-media session state');
    assert.equal(unit.session.reason, 'startup/waiting-media');
    assert.equal(unit.messages.binary.length, 0, 'nothing was streamed to it');
    await unit.close();
  });
});

test('a receiver never sees a delta frame it cannot start from, and the first frame it gets is gap-flagged', async () => {
  await withRelay({ source: 'input' }, async (relay) => {
    const unit = await unitFor(relay).connect();
    const device = await deviceFor(relay).connect();
    await device.until((d) => d.controls.some((m) => m.type === 'start'), 'the relay asked the device to start');

    device.videoFormat(FORMAT);
    device.audioFormat({ role: 'MEDIA', codec: 'AAC_LC', sampleRate: 48000, channels: 2 });
    for (let n = 0; n < 3; n++) device.video({ avcc: DELTA, ptsUs: n * 33333, key: false });
    await new Promise((ok) => setTimeout(ok, 120));
    assert.equal(unit.received.video, 0, 'three deltas ahead of any key frame were withheld');

    device.video({ avcc: IDR, ptsUs: 100000, key: true });
    await unit.until((u) => u.received.video >= 1, 'the key frame');
    const first = unit.frames.at(0);
    assert.equal(first.key, true);
    assert.equal(first.gap, true, 'the first frame after a (re)start is the frame a decoder must flush for');
    const announced = unit.messages.text.filter((m) => m.type === 'video-format' || m.type === 'audio-format');
    assert.deepEqual(announced.map((m) => m.type).sort(), ['audio-format', 'video-format'], 'formats are re-announced before that frame');
    assert.equal(announced.find((m) => m.type === 'video-format').format.codecString, FORMAT.codecString);
    assert.ok(unit.view || !unit.videoFormat, 'a view-area follows a format and a display');

    device.video({ avcc: DELTA, ptsUs: 133333, key: false });
    await unit.until((u) => u.received.video >= 2, 'the delta after the key frame');
    assert.equal(unit.frames.at(-1).key, false);
    assert.equal(unit.frames.at(-1).gap, false, 'a gap flag is only ever on the frame that restarts decoding');
    assert.ok(unit.received.sequences.every((n, i) => i === 0 || n > unit.received.sequences[i - 1] - 2), 'frame numbering stays in order');
    await Promise.all([unit.close(), device.close()]);
  });
});

test('a late receiver joins on the next key frame, and repeated requests are coalesced', async () => {
  await withRelay({ source: 'input' }, async (relay) => {
    const device = await deviceFor(relay).connect();
    device.hello();
    device.videoFormat(FORMAT);
    const pump = pumpFrames(device, { gopEvery: 4 });
    const unit = await unitFor(relay).connect();
    await unit.until((u) => u.received.video > 0, 'first media');

    unit.control({ type: 'keyframe', screen: 0 });
    unit.send(unit.helloMessage()); // a reload repeats the hello, which asks for a resync too
    unit.control({ type: 'keyframe', screen: 0 });
    await new Promise((ok) => setTimeout(ok, 30));
    const requests = device.controls.filter((m) => m.type === 'keyframe').length;
    assert.ok(requests <= 2, `the limiter let ${requests} key frame requests through within one window`);
    await unit.until((u) => u.frames.filter((f) => f.key).length >= 2, 'resynchronisation on a later key frame');
    const resync = unit.frames.find((f) => f.gap && f.key);
    assert.ok(resync, 'the resumed stream is marked as a discontinuity');
    const seenAfter = unit.frames.slice(unit.frames.indexOf(resync) + 1);
    assert.ok(seenAfter.every((f) => f.key || f.gap === false), 'no stray gap flags after the resync point');
    pump.stop();
    await new Promise((ok) => setTimeout(ok, 60));
    assert.ok(!device.error, `the device saw ${device.error?.message}`);
    await Promise.all([unit.close(), device.close()]);
  });
});

test('a second receiver joins a running stream and both keep their own resync state', async () => {
  await withRelay({ source: 'input' }, async (relay) => {
    const device = await deviceFor(relay).connect();
    device.videoFormat(FORMAT);
    const pump = pumpFrames(device, { gopEvery: 3 });
    const first = await unitFor(relay).connect();
    await first.until((u) => u.received.video > 3, 'the first receiver streaming');
    const second = await unitFor(relay).connect();
    await second.until((u) => u.received.video > 0, 'the second receiver catching a key frame');
    assert.ok(second.frames[0].key, 'a joining receiver starts on a key frame, not in the middle of a GOP');
    assert.ok(first.received.video > 0 && second.received.video > 0, 'both receivers keep playing');
    assert.ok(second.frames.at(0).gap, 'the joining receiver is told it is starting mid-stream');
    pump.stop();
    await Promise.all([first.close(), second.close(), device.close()]);
  });
});

test('touch and keys travel to the device unchanged, and the relay knows who sent them', async () => {
  await withRelay({ source: 'input' }, async (relay) => {
    const device = await deviceFor(relay).connect();
    device.videoFormat(FORMAT);
    const warmup = pumpFrames(device, { gopEvery: 2, count: 400, intervalMs: 15 });
    const unit = await unitFor(relay).connect();
    await unit.until((u) => u.received.video > 0, 'media first, so the session is live');
    const contacts = [
      { id: 0, pressed: true, x: 0.25, y: 0.75 },
      { id: 1, pressed: true, x: 0.5, y: 0.5 },
    ];
    unit.touch(contacts);
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(device.received.touch, 1, 'the device saw the touch message');
    const { header, payload } = device.input.at(-1);
    assert.equal(header.kind, Kind.Touch);
    const echoed = decodeTouch(payload);
    assert.equal(echoed.length, 2, 'both contacts arrived');
    assert.deepEqual(echoed.map((c) => c.id), [0, 1]);
    for (const [index, contact] of echoed.entries()) {
      assert.equal(contact.pressed, true);
      assert.ok(Math.abs(contact.x - contacts[index].x) < 1 / 65535 + 1e-9, `x came back within one quantum: ${contact.x}`);
      assert.ok(Math.abs(contact.y - contacts[index].y) < 1 / 65535 + 1e-9, `y came back within one quantum: ${contact.y}`);
    }
    const state = relay.state();
    assert.equal(state.projection.stats.touchEvents, 1);
    assert.equal(state.projection.lastTouch.contacts.length, 2);

    unit.key(1, true);
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(device.received.key, 1);
    assert.equal(device.input.at(-1).header.kind, Kind.Key);
    warmup.stop();
    await Promise.all([unit.close(), device.close()]);
  });
});

test('a device replacing the synthetic source takes over without a format mix-up', async (t) => {
  const { findFfmpeg } = await import('../src/sources/ffmpeg.js');
  let ffmpeg = true;
  try {
    findFfmpeg();
  } catch {
    ffmpeg = false;
  }
  if (!ffmpeg) return t.skip('no ffmpeg to produce the synthetic source');
  await withRelay({ source: 'ffmpeg', scene: 'testsrc2', width: 640, height: 480, fps: 25, audio: false }, async (relay) => {
    const unit = await unitFor(relay).connect();
    await unit.until((u) => u.received.video > 2, 'synthetic media');
    const fromFfmpeg = unit.videoFormat;
    assert.match(fromFfmpeg.codecString, /^avc1\./);
    assert.equal(fromFfmpeg.width, 640);

    const device = await deviceFor(relay).connect();
    device.videoFormat({ ...FORMAT, width: 1280, height: 720 });
    // A format change only reaches a receiver with the first frame that uses it, so the device has
    // to produce an IDR before the relay has anything to announce.
    device.video({ avcc: IDR, ptsUs: 200000, key: true, gap: true });
    await unit.until((u) => u.messages.text.filter((m) => m.type === 'video-format').length >= 2, 'the new format announced');
    const before = unit.received.video;
    const pump = pumpFrames(device, { gopEvery: 2, count: 60, intervalMs: 15, startAt: 20 });
    await unit.until((u) => u.received.video >= before + 5, 'the device frames replacing the synthetic ones');
    pump.stop();
    const last = unit.messages.text.filter((m) => m.type === 'video-format').at(-1);
    assert.equal(last.format.width, 1280, 'and the announced geometry is the device one');
    assert.equal(relay.localSource, null, 'the synthetic source was released');
    assert.equal(relay.projection.sources.size, 1, 'exactly one input feeds the projection');
    await Promise.all([unit.close(), device.close()]);
  });
});

test('a late receiver joins on the next key frame, and repeated requests are coalesced', async () => {
  await withRelay({ source: 'input' }, async (relay) => {
    const device = await deviceFor(relay).connect();
    device.hello();
    device.videoFormat(FORMAT);
    const pump = pumpFrames(device, { gopEvery: 4 });
    const unit = await unitFor(relay).connect();
    await unit.until((u) => u.received.video > 0, 'first media');

    unit.control({ type: 'keyframe', screen: 0 });
    unit.send(unit.helloMessage()); // a reload repeats the hello, which asks for a resync too
    unit.control({ type: 'keyframe', screen: 0 });
    await new Promise((ok) => setTimeout(ok, 30));
    const requests = device.controls.filter((m) => m.type === 'keyframe').length;
    assert.ok(requests <= 2, `the limiter let ${requests} key frame requests through within one window`);
    await unit.until((u) => u.frames.filter((f) => f.key).length >= 2, 'resynchronisation on a later key frame');
    const resync = unit.frames.find((f) => f.gap && f.key);
    assert.ok(resync, 'the resumed stream is marked as a discontinuity');
    const seenAfter = unit.frames.slice(unit.frames.indexOf(resync) + 1);
    assert.ok(seenAfter.every((f) => f.key || f.gap === false), 'no stray gap flags after the resync point');
    pump.stop();
    await new Promise((ok) => setTimeout(ok, 60));
    assert.ok(!device.error, `the device saw ${device.error?.message}`);
    await Promise.all([unit.close(), device.close()]);
  });
});

test('a second receiver joins a running stream and both keep their own resync state', async () => {
  await withRelay({ source: 'input' }, async (relay) => {
    const device = await deviceFor(relay).connect();
    device.videoFormat(FORMAT);
    const pump = pumpFrames(device, { gopEvery: 3 });
    const first = await unitFor(relay).connect();
    await first.until((u) => u.received.video > 3, 'the first receiver streaming');
    const second = await unitFor(relay).connect();
    await second.until((u) => u.received.video > 0, 'the second receiver catching a key frame');
    assert.ok(second.frames[0].key, 'a joining receiver starts on a key frame, not in the middle of a GOP');
    assert.ok(first.received.video > 0 && second.received.video > 0, 'both receivers keep playing');
    assert.ok(second.frames.at(0).gap, 'the joining receiver is told it is starting mid-stream');
    pump.stop();
    await Promise.all([first.close(), second.close(), device.close()]);
  });
});

test('touch and keys travel to the device unchanged, and the relay knows who sent them', async () => {
  await withRelay({ source: 'input' }, async (relay) => {
    const device = await deviceFor(relay).connect();
    device.videoFormat(FORMAT);
    const warmup = pumpFrames(device, { gopEvery: 2, count: 400, intervalMs: 15 });
    const unit = await unitFor(relay).connect();
    await unit.until((u) => u.received.video > 0, 'media first, so the session is live');
    const contacts = [
      { id: 0, pressed: true, x: 0.25, y: 0.75 },
      { id: 1, pressed: true, x: 0.5, y: 0.5 },
    ];
    unit.touch(contacts);
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(device.received.touch, 1, 'the device saw the touch message');
    const { header, payload } = device.input.at(-1);
    assert.equal(header.kind, Kind.Touch);
    const echoed = decodeTouch(payload);
    assert.equal(echoed.length, 2, 'both contacts arrived');
    assert.deepEqual(echoed.map((c) => c.id), [0, 1]);
    for (const [index, contact] of echoed.entries()) {
      assert.equal(contact.pressed, true);
      assert.ok(Math.abs(contact.x - contacts[index].x) < 1 / 65535 + 1e-9, `x came back within one quantum: ${contact.x}`);
      assert.ok(Math.abs(contact.y - contacts[index].y) < 1 / 65535 + 1e-9, `y came back within one quantum: ${contact.y}`);
    }
    const state = relay.state();
    assert.equal(state.projection.stats.touchEvents, 1);
    assert.equal(state.projection.lastTouch.contacts.length, 2);

    unit.key(1, true);
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(device.received.key, 1);
    assert.equal(device.input.at(-1).header.kind, Kind.Key);
    warmup.stop();
    await Promise.all([unit.close(), device.close()]);
  });
});


test('an unknown token is refused before the socket opens', async () => {
  await withRelay({ source: 'none', token: 'right' }, async (relay) => {
    const unit = new FakeHeadUnit({ url: urlFor(relay, '/wire'), token: 'wrong' });
    await assert.rejects(() => unit.connect(), (error) => {
      assert.match(String(error.message ?? error), /401|Unexpected|Unauthorized|status code/i);
      return true;
    });
  });
});

test('a malformed message closes that socket and tells the peer why', async () => {
  await withRelay({ source: 'none' }, async (relay) => {
    const unit = await unitFor(relay).connect();
    await unit.until((u) => u.welcome, 'welcome');
    unit.socket.send(JSON.stringify({ type: 'hello', version: 0, token: 'test-token', decoders: 'not a list', displays: [], maxTouchContacts: 10, audio: [], microphone: false }));
    const closed = await unit.closed;
    assert.equal(closed.code, 1002, 'a protocol violation is a policy violation for the socket');
    assert.ok(unit.messages.text.some((m) => m.type === 'error'), 'and the reason was sent first');
    assert.match(unit.error.message, /malformed hello/);
  });
});

function pumpFrames(device, { gopEvery = 5, count = 120, startAt = 0, intervalMs = 20 } = {}) {
  let index = startAt;
  const timer = setInterval(() => {
    const key = index % gopEvery === 0;
    device.video({ avcc: key ? IDR : DELTA, ptsUs: index * 33333, key, gap: index === startAt });
    if (index - startAt >= count) return stop();
    index++;
  }, intervalMs);
  function stop() {
    clearInterval(timer);
  }
  return { stop };
}

test('a device that dies without closing its socket hands the projection back', async () => {
  const { findFfmpeg } = await import('../src/sources/ffmpeg.js');
  try {
    findFfmpeg();
  } catch {
    return; // the synthetic source is the thing under test here
  }
  await withRelay({ source: 'ffmpeg', scene: 'testsrc', width: 320, height: 240, fps: 20, audio: false }, async (relay) => {
    const unit = await unitFor(relay).connect();
    await unit.until((u) => u.received.video > 2, 'synthetic media');
    const device = await deviceFor(relay).connect();
    device.videoFormat(FORMAT);
    device.video({ avcc: IDR, ptsUs: 1000, key: true, gap: true });
    await unit.until((u) => u.messages.text.filter((m) => m.type === 'video-format').length >= 2, 'the device format');
    assert.equal(relay.localSource, null, 'the synthetic source stepped out for the device');

    // A car that loses power does not close its socket: half the TCP state simply stays. The
    // heartbeat is what notices, and its close handling is what brings the source back.
    device.socket.terminate();
    relay.keepaliveOnce();
    relay.keepaliveOnce();
    await relay.until((r) => r.localSource !== null, 'the synthetic source to be started again');
    await unit.until((u) => u.messages.text.some((m) => m.type === 'video-format' && m.format?.width === 320), 'the synthetic format again');
    assert.equal(relay.inputLinks.size, 0, 'the dead device was released');
    assert.equal(relay.projection.sources.size, 1, 'exactly one input feeds the projection');
    await unit.close();
  });
});

test('a peer that stops answering pings is terminated and logged', async () => {
  const { default: WebSocket } = await import('ws');
  await withRelay({ source: 'none' }, async (relay) => {
    const url = `ws://127.0.0.1:${relay.options.port}/wire?token=test-token`;
    const socket = new WebSocket(url);
    await new Promise((ok, fail) => {
      socket.on('open', ok);
      socket.on('error', fail);
    });
    const closed = new Promise((ok) => socket.on('close', ok));
    await new Promise((ok) => setTimeout(ok, 60));
    assert.equal(relay.projection.receivers.size, 1, 'the relay took the peer as a receiver');

    // Two passes inside the grace period are not a death sentence: this peer answered its ping and
    // must survive, because killing a healthy head unit the car merely hadn't woken yet is worse
    // than waiting one more interval.
    relay.keepaliveOnce();
    relay.keepaliveOnce();
    assert.equal(relay.wss.clients.size, 1, 'a peer inside the grace period is still connected');

    // What the heartbeat is looking for: a ping that went out and never got an answer.
    const peers = [...relay.wss.clients];
    for (const peer of peers) peer.pongPendingAt = 0;
    relay.keepaliveOnce(relay.clock.nowMs() + 60_000);
    await closed;
    await relay.until((r) => r.projection.receivers.size === 0, 'the receiver to be released');

    const trace = relay.state(new URLSearchParams({ trace: '1' })).trace ?? [];
    assert.ok(trace.some((entry) => entry.channel === 'socket' && /no answer to a ping for/.test(entry.text)), 'the heartbeat said why');
    assert.equal(relay.inputLinks.size, 0, 'nothing else was left behind');
  });
});

test('every module a page imports is really served', async () => {
  await withRelay({ source: 'none' }, async (relay) => {
    const pages = ['/', '/receiver', '/input', '/admin', '/check'];
    const seen = new Set();
    for (const page of pages) {
      const html = await (await fetch(`${relay.origin()}${page}?token=test-token`)).text();
      assert.ok(html.includes('<script type="module"'), `${page} has no module script`);
      for (const match of html.matchAll(/from\s+'(\/[^']+)'|import\s+'(\/[^']+)'/g)) {
        const path = match[1] ?? match[2];
        if (seen.has(path)) continue;
        seen.add(path);
        const response = await fetch(`${relay.origin()}${path}`);
        assert.equal(response.status, 200, `${page} imports ${path}, which the relay does not serve`);
        assert.match(response.headers.get('content-type'), /javascript/, `${path} must be served as javascript for a module import`);
      }
    }
    assert.ok(seen.size >= 4, `expected the pages to share the protocol modules, saw ${[...seen].join(', ')}`);
  });
});
