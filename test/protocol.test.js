// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The wire format on both sides of the socket: header layout, kinds, flags, and the touch and key
// payloads. These tests are the reason a Node relay and a browser page can agree byte for byte.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADER_SIZE, Kind, Flag, KeyCode, MAX_TOUCH_CONTACTS,
  encodeHeader, decodeHeader, encodeTouch, decodeTouch, encodeKey, decodeKey,
  encodeBinary, decodeBinary, videoMessage, WireFormatError,
} from '../src/protocol/binary.js';
import { parseMessage, encodeMessage, ProtocolError, toBase64, fromBase64 } from '../src/protocol/json.js';

test('header is exactly 24 bytes, little endian', () => {
  const header = encodeHeader({ kind: Kind.Video, sequence: 0x01020304, ptsUs: 0x0100000000n, senderClockUs: -2n, flags: Flag.Keyframe });
  assert.equal(header.length, HEADER_SIZE);
  assert.deepEqual([...header.subarray(0, 4)], [Kind.Video, 0, Flag.Keyframe, 0]);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  assert.equal(view.getUint32(4, true), 0x01020304);
  assert.equal(view.getBigInt64(8, true), 0x0100000000n);
  assert.equal(view.getBigInt64(16, true), -2n);
  const back = decodeHeader(header);
  assert.equal(back.kind, Kind.Video);
  assert.equal(back.sequence, 0x01020304);
  assert.equal(back.ptsUs, 0x0100000000n);
  assert.equal(back.senderClockUs, -2n);
});

test('kinds and flags match the upstream numbers', () => {
  assert.deepEqual({ ...Kind }, { Video: 1, Audio: 2, Microphone: 3, Touch: 16, Key: 17 });
  assert.deepEqual({ ...Flag }, { Keyframe: 1, Gap: 2 });
  assert.equal(KeyCode.Home, 0);
  assert.equal(KeyCode.Voice, 10);
});

test('reserved byte and flags are enforced', () => {
  const b = encodeHeader({ kind: Kind.Video });
  b[3] = 1;
  assert.throws(() => decodeHeader(b), /reserved header byte/);
  assert.throws(() => encodeHeader({ kind: Kind.Video, flags: 4 }), /Unknown header flags/);
  assert.throws(() => encodeHeader({ kind: 99 }), /Unknown message kind/);
  assert.throws(() => decodeHeader(new Uint8Array(23)), /Truncated message header/);
});

test('touch payload is id, pressed, x, y over 65535', () => {
  const contacts = [
    { id: 0, pressed: true, x: 0, y: 0 },
    { id: 3, pressed: true, x: 0.5, y: 1 },
    { id: 9, pressed: false, x: 1 / 65535, y: 0 },
  ];
  const payload = encodeTouch(contacts);
  assert.equal(payload[0], 3);
  assert.equal(payload.length, 1 + 3 * 6);
  const back = decodeTouch(payload);
  assert.deepEqual(back.map((c) => c.id), [0, 3, 9]);
  assert.equal(back[0].pressed, true);
  assert.equal(back[2].pressed, false);
  assert.ok(Math.abs(back[1].x - 0.5) < 1e-4, 'quantised to 16 bits');
  assert.equal(back[1].y, 1);
  assert.ok(Math.abs(back[2].x - 1 / 65535) < 1e-9);
});

test('touch payload rejects what a relay could not route', () => {
  assert.throws(() => encodeTouch([{ id: 0, pressed: true, x: 1.2, y: 0 }]), /outside the picture/);
  assert.throws(() => encodeTouch(Array.from({ length: MAX_TOUCH_CONTACTS + 1 }, (_, i) => ({ id: i % 10, pressed: true, x: 0, y: 0 }))), /Too many contacts|duplicate/);
  assert.throws(() => encodeTouch([{ id: 1, pressed: true, x: 0, y: 0 }, { id: 1, pressed: true, x: 0, y: 0 }]), /duplicate contact id/);
  assert.throws(() => decodeTouch(new Uint8Array([2, 0, 1, 0, 0, 0, 0])), /length or count/);
});

test('key payload is code plus down flag', () => {
  const down = encodeKey({ code: KeyCode.Back, down: true });
  assert.equal(down.length, 3);
  assert.deepEqual(decodeKey(down), { code: 1, down: true });
  assert.throws(() => encodeKey({ code: 11, down: true }), /Unknown key code/);
  assert.throws(() => decodeKey(new Uint8Array([1, 0, 2])), /Invalid key down/);
});

test('a video message names its own key frame', () => {
  // 0x65 = nal_unit_type 5 (IDR) behind a four-byte length, the shape the wire requires.
  const idr = new Uint8Array([0, 0, 0, 3, 0x65, 0x01, 0x02]);
  const delta = new Uint8Array([0, 0, 0, 3, 0x41, 0x01, 0x02]);
  assert.equal(decodeBinary(videoMessage({ avcc: idr, ptsUs: 1000, sequence: 7 })).header.flags, Flag.Keyframe);
  assert.equal(decodeBinary(videoMessage({ avcc: delta, ptsUs: 1000, sequence: 8 })).header.flags, 0);
  const gap = decodeBinary(videoMessage({ avcc: idr, ptsUs: 1000, sequence: 9, gap: true }));
  assert.equal(gap.header.flags, Flag.Keyframe | Flag.Gap);
  assert.equal(gap.payload.length, 7);
});

test('an unknown kind in a whole message is refused', () => {
  const b = encodeBinary({ kind: Kind.Touch }, encodeTouch([{ id: 0, pressed: true, x: 0, y: 0 }]));
  assert.equal(decodeBinary(b).header.kind, Kind.Touch);
  b[0] = 12;
  assert.throws(() => decodeBinary(b), WireFormatError);
});

test('json control messages are validated on the way in and out', () => {
  const hello = {
    type: 'hello',
    version: 0,
    token: 't',
    decoders: [{ codecString: 'avc1.42E01F', hardware: false }],
    displays: [{ screen: 0, width: 1280, height: 720, dpr: 1, refreshHz: 60, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }],
    maxTouchContacts: 10,
    audio: ['AAC_LC'],
    microphone: false,
  };
  assert.deepEqual(parseMessage(JSON.stringify(hello), 'client-to-relay'), hello);
  assert.throws(() => parseMessage({ ...hello, extra: 1 }, 'client-to-relay'), /malformed hello/);
  assert.throws(() => parseMessage({ ...hello, maxTouchContacts: 11 }, 'client-to-relay'), /malformed hello/);
  const welcome = {
    type: 'welcome', version: 0, clientId: 'c1', session: { id: '1', phase: 'CONNECTING' },
    sourceUrl: 'https://github.com/OpenXPlay/OpenXPlay-Stream', attribution: 'derived from OpenXPlay',
    projectUrl: 'http://localhost:3000', relay: { name: 'mirrorplay relay', version: '0.1.0' },
  };
  assert.throws(() => parseMessage(welcome, 'client-to-relay'), /welcome is not a client-to-relay message/);
  assert.deepEqual(parseMessage(welcome, 'relay-to-client'), welcome);
  assert.throws(() => parseMessage({ ...welcome, sourceUrl: 'ws://localhost:3000/wire' }, 'relay-to-client'), /malformed welcome/);
  assert.throws(() => parseMessage({ ...welcome, relay: { name: 'x'.repeat(200), version: '1' } }, 'relay-to-client'), /malformed welcome/);
  assert.deepEqual(parseMessage({ type: 'ping', t0Us: '1' }, 'device-to-relay'), { type: 'ping', t0Us: '1' });
  assert.throws(() => parseMessage({ type: 'welcome', ...welcome, clientId: 'c' }, 'device-to-relay'), /welcome is not a device-to-relay message/);
  assert.throws(() => parseMessage({ type: 'ping', t0Us: '1' }, 'nonsense'), /unknown direction nonsense/);
  assert.throws(() => parseMessage('not json', 'client-to-relay'), /must be valid JSON/);
});

test('a video-format message carries base64 avcC and nothing else', () => {
  const avcC = new Uint8Array([1, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0, 2, 0x67, 0x42, 1, 2, 0, 3, 0x68, 1, 2, 3]);
  const message = {
    type: 'video-format',
    screen: 0,
    format: { codec: 'H264', codecString: 'avc1.42C01F', config: toBase64(avcC), width: 640, height: 480, fpsHint: 30 },
  };
  const text = encodeMessage(message);
  assert.deepEqual(parseMessage(text, 'relay-to-client'), message);
  assert.deepEqual(fromBase64(JSON.parse(text).format.config), avcC);
  assert.throws(() => encodeMessage({ ...message, format: { ...message.format, config: 'not base64!!' } }), /refusing to emit/);
  assert.deepEqual(parseMessage(encodeMessage({ type: 'video-format', screen: 0, format: null }), 'relay-to-client').format, null);
});

test('session phases and reasons are the ones the relay announces', () => {
  const message = parseMessage(encodeMessage({ type: 'session', session: { id: '42', phase: 'RECONNECTING', reason: 'startup/waiting-media' } }), 'relay-to-client');
  assert.equal(message.session.phase, 'RECONNECTING');
  assert.equal(message.session.reason, 'startup/waiting-media');
  assert.throws(() => parseMessage({ type: 'session', session: { id: '42', phase: 'PLAYING' } }, 'relay'), /malformed session/);
});
