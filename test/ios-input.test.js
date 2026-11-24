// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The input contract the iOS SDK is written against, checked from the relay's side with the same
// fixture bytes (device-ios/Fixtures, written by scripts/ios-fixtures.mjs) that the Swift tests have
// to reproduce.
//
// A native input differs from the browser one in three ways that matter, so all three are asserted:
// the record it announces comes from the parameter sets its hardware encoder reports, its first
// sample is the IDR carrying those sets in band, and every delta after that must be withheld from a
// viewer that has not seen that IDR yet. Touch and keys have to arrive as the identical envelope
// bytes, which is why the fixtures are compared byte for byte rather than merely parsed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Relay } from '../src/relay/server.js';
import { FakeHeadUnit } from '../src/tools/fake-head-unit.js';
import { Kind, Flag, decodeBinary, encodeBinary, encodeTouch } from '../src/protocol/binary.js';
import { encodeMessage } from '../src/protocol/json.js';
import { AvcConfig } from '../src/media/avc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'device-ios', 'Fixtures');
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
const bytes = (name) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const KEY = bytes('key-avcc.bin');
const DELTA = bytes('delta-avcc.bin');

let portSeed = 0;

function opened(socket) {
  return new Promise((ok, fail) => {
    socket.on('open', () => ok(socket));
    socket.on('error', fail);
  });
}

async function waitUntil(predicate, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * A relay with one viewer waiting and one socket standing where the iPhone would be. Nothing is
 * announced yet, because the order in which a native input says hello, announces a format and pushes
 * its first IDR is precisely what these tests are about.
 */
async function withNativeInput(run) {
  const relay = new Relay({ port: 3240 + ++portSeed, host: '127.0.0.1', token: 'ios', source: 'input' });
  await relay.listen();
  const viewer = await new FakeHeadUnit({ url: `ws://127.0.0.1:${relay.options.port}/wire`, token: 'ios' }).connect();
  const device = await opened(new WebSocket(`ws://127.0.0.1:${relay.options.port}/input-wire?token=ios`));
  device.binaryType = 'arraybuffer';
  const received = [];
  device.on('message', (data, isBinary) => received.push(isBinary ? decodeBinary(new Uint8Array(data)) : JSON.parse(data.toString())));

  const send = (payload, { key = false, gap = false, sequence = 0, ptsUs = 0 } = {}) =>
    device.send(encodeBinary({ kind: Kind.Video, flags: (key ? Flag.Keyframe : 0) | (gap ? Flag.Gap : 0), sequence, ptsUs: BigInt(ptsUs), senderClockUs: BigInt(ptsUs) }, payload));

  const introduce = () => {
    device.send(encodeMessage(manifest.messages.hello));
    device.send(encodeMessage(manifest.messages.videoFormat));
  };

  try {
    return await run({ relay, viewer, device, received, send, introduce });
  } finally {
    device.terminate();
    await viewer.close();
    await relay.close();
  }
}

test('a viewer waits for media, not merely for a peer to be connected', async () => {
  await withNativeInput(async ({ viewer, introduce }) => {
    const waiting = viewer.messages.text.filter((m) => m.type === 'session').at(-1);
    assert.equal(waiting.session.phase, 'RECONNECTING');
    assert.equal(waiting.session.reason, 'startup/waiting-media');

    introduce();
    // Introducing itself is not media: the viewer must still be told it is waiting.
    assert.equal(
      viewer.messages.text.filter((m) => m.type === 'session').at(-1).session.reason,
      'startup/waiting-media',
      'the announcement of a format without a picture is still not active',
    );
  });
});

test('a native input starts a viewer on its IDR, and withholds the deltas before it', async () => {
  await withNativeInput(async ({ relay, viewer, send, introduce }) => {
    introduce();
    for (let index = 0; index < 3; index++) send(DELTA, { sequence: index, ptsUs: index * 33333 });
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(viewer.received.video, 0, 'a delta is not a start point');
    assert.equal(relay.projection.snapshot().stats.frames, 3, 'the relay still counted what arrived');

    send(KEY, { key: true, gap: true, sequence: 3, ptsUs: 100000 });
    await viewer.until((watcher) => watcher.received.video >= 1, 'the IDR');
    const [first] = viewer.frames;
    assert.equal(first.key, true);
    assert.equal(first.gap, true, 'the restarted run says so, and the viewer flushes on it');
    assert.equal(first.bytes, KEY.length, 'the payload went through unchanged');
    assert.equal(
      viewer.messages.text.filter((m) => m.type === 'session').at(-1).session.phase,
      'ACTIVE',
      'media is what makes the session active',
    );

    for (let index = 4; index < 24; index++) send(DELTA, { sequence: index, ptsUs: index * 33333 });
    await viewer.until((watcher) => watcher.received.video >= 20, 'the deltas after the IDR');
    assert.ok(viewer.received.sequences.every((n, i) => i === 0 || n > viewer.received.sequences[i - 1]), 'numbering survives the fan-out');
    assert.equal(viewer.messages.text.filter((m) => m.type === 'video-format').length, 1, 'one announcement, not one per frame');
    assert.equal(relay.state().projection.sources.length, 1);
  });
});

test('the record a native input announces is the avcC these fixtures were built from', async () => {
  await withNativeInput(async ({ viewer, send, introduce }) => {
    introduce();
    send(KEY, { key: true, gap: true });
    await viewer.until((watcher) => watcher.videoFormat, 'the forwarded format');
    const config = new Uint8Array(Buffer.from(viewer.videoFormat.config, 'base64'));
    assert.deepEqual([...config], [...bytes('avcC.bin')], 'byte for byte, not merely the same codec string');
    const parsed = AvcConfig.parse(config);
    assert.equal(parsed.codecString, manifest.codec);
    assert.equal(parsed.width, manifest.size[0]);
    assert.equal(parsed.height, manifest.size[1]);
    assert.equal(parsed.nalLengthSize, 4, 'the wire demands four-byte NAL lengths');
    assert.ok(manifest.encoder.includes('libx264'), 'the reference stream is a real encode');
  });
});

test('touch and keys reach the native input as identical envelope bytes', async () => {
  await withNativeInput(async ({ viewer, received, send, introduce }) => {
    introduce();
    send(KEY, { key: true, gap: true });
    await viewer.until((watcher) => watcher.received.video >= 1, 'a first picture');

    viewer.touch(manifest.touch);
    const touch = await waitUntil(() => received.find((entry) => entry.header?.kind === Kind.Touch), 'the touch at the device');
    const fixturePayload = bytes('touch.bin').subarray(24);
    assert.equal(touch.payload.length, 1 + manifest.touch.length * 6, 'one count byte plus six per contact');
    assert.deepEqual([...touch.payload], [...fixturePayload], 'the very bytes the fixtures were built from — no re-quantising');
    assert.deepEqual([...encodeTouch(manifest.touch)], [...touch.payload], 'and this repository produces exactly the same payload');
    assert.ok(manifest.touch.every((contact, index) => touch.payload[1 + index * 6] === contact.id), 'contact ids preserved');

    viewer.key(manifest.key.code, manifest.key.down);
    const pressed = await waitUntil(() => received.find((entry) => entry.header?.kind === Kind.Key), 'the key at the device');
    assert.deepEqual([...pressed.payload], [...bytes('key.bin').subarray(24)]);
  });
});

test('an input that vanishes without a close handshake is reclaimed, and the viewer keeps waiting', async () => {
  await withNativeInput(async ({ relay, viewer, device, send, introduce }) => {
    introduce();
    send(KEY, { key: true, gap: true });
    await viewer.until((watcher) => watcher.received.video >= 1, 'media');
    assert.equal(viewer.messages.text.filter((m) => m.type === 'session').at(-1).session.phase, 'ACTIVE');

    // A phone that walks out of range does not close its socket. The relay pings, gets nothing
    // back, and only after the grace period of two intervals drops the peer — inside the grace
    // period a healthy head unit must survive, which is the other half of this test.
    const gone = new Promise((ok) => device.on('close', ok));
    device.terminate();
    await gone;
    await waitUntil(() => relay.inputLinks.size === 0, 'the device link to be released');

    const session = await waitUntil(
      () => (viewer.messages.text.filter((m) => m.type === 'session').at(-1)?.session.phase === 'RECONNECTING' ? viewer.messages.text.filter((m) => m.type === 'session').at(-1) : null),
      'the viewer to be told the media stopped',
    );
    assert.equal(session.session.phase, 'RECONNECTING');
    assert.ok(
      ['startup/waiting-media', 'startup/disconnected'].includes(session.session.reason),
      `the reason should describe the wait, got ${session.session.reason}`,
    );

    assert.equal(relay.state().inputs.length, 0, 'the relay no longer believes the device is there');
  });
});

test('the fixtures agree with this repository’s own codec, which is why two languages can trust them', () => {
  const envelope = bytes('key-envelope.bin');
  assert.equal(envelope.length, 24 + KEY.length, 'an envelope is a header plus its payload');
  const header = decodeBinary(envelope).header;
  assert.equal(header.kind, manifest.envelope.kind);
  assert.equal(header.flags, manifest.envelope.flags);
  assert.equal(header.sequence, manifest.envelope.sequence);
  assert.equal(header.ptsUs, BigInt(manifest.envelope.ptsUs));
  assert.equal(header.senderClockUs, BigInt(manifest.envelope.senderClockUs));
  assert.deepEqual([...envelope].slice(24), [...KEY], 'the header belongs to this picture');

  assert.equal(bytes('touch.bin')[24], manifest.touch.length);
  assert.deepEqual([...encodeTouch(manifest.touch)], [...bytes('touch.bin').subarray(24)]);
  assert.equal(bytes('key-annexb.bin').length, KEY.length, 'four-byte start codes and four-byte lengths are the same size');
  assert.ok(manifest.framing.includes('access unit'), 'the native path is one access unit per sample, never a concatenated stream');
});
