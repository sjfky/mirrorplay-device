// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Binary envelope of the projection wire protocol.
//
// A message is a 24-byte little-endian header followed by its payload:
//
//   0  kind    u8   1 video  2 audio  3 microphone  16 touch  17 key
//   1  stream  u8   audio/microphone stream index; 0 for video, touch and key
//   2  flags   u8   bit0 key frame, bit1 discontinuity (the receiver must flush and wait)
//   3          u8   reserved, always zero
//   4  sequence u32 per-kind counter, so a receiver can name a hole in the stream
//   8  ptsUs     i64 presentation time, microseconds
//   16 senderClockUs i64 sender monotonic clock at the moment the message was produced
//
// Video payloads are AVCC access units: 4-byte big-endian length + NAL, repeated. Audio payloads
// are one raw AAC, Opus or PCM frame. Touch and key payloads are coded below.

import { isKeyFrame, Avcc } from '../media/nal.js';

export const HEADER_SIZE = 24;
export const Kind = { Video: 1, Audio: 2, Microphone: 3, Touch: 16, Key: 17 };
export const Flag = { Keyframe: 1, Gap: 2 };
export const MAX_TOUCH_CONTACTS = 10;
export const KeyCode = {
  Home: 0, Back: 1, Select: 2, KnobLeft: 3, KnobRight: 4, KnobUp: 5,
  KnobDown: 6, PlayPause: 7, Next: 8, Previous: 9, Voice: 10,
};

export class WireFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WireFormatError';
  }
}

const KIND_VALUES = Object.values(Kind);

function check(condition, message) {
  if (!condition) throw new WireFormatError(message);
}

export function encodeHeader({ kind, stream = 0, flags = 0, sequence = 0, ptsUs = 0n, senderClockUs = 0n }) {
  check(KIND_VALUES.includes(kind), 'Unknown message kind');
  check(Number.isInteger(stream) && stream >= 0 && stream <= 255, 'Stream must fit u8');
  check(Number.isInteger(flags) && flags >= 0 && flags <= 3, 'Unknown header flags');
  check(Number.isInteger(sequence) && sequence >= 0 && sequence <= 0xffffffff, 'Sequence must fit u32');
  for (const clock of [ptsUs, senderClockUs]) {
    check(typeof clock === 'bigint' && clock >= -(1n << 63n) && clock < 1n << 63n, 'Clock must fit i64');
  }
  const b = new Uint8Array(HEADER_SIZE);
  const v = new DataView(b.buffer);
  b[0] = kind;
  b[1] = stream;
  b[2] = flags;
  v.setUint32(4, sequence, true);
  v.setBigInt64(8, ptsUs, true);
  v.setBigInt64(16, senderClockUs, true);
  return b;
}

export function decodeHeader(b) {
  check(b.length >= HEADER_SIZE, 'Truncated message header');
  check(b[3] === 0, 'Nonzero reserved header byte');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const header = {
    kind: b[0],
    stream: b[1],
    flags: b[2],
    sequence: v.getUint32(4, true),
    ptsUs: v.getBigInt64(8, true),
    senderClockUs: v.getBigInt64(16, true),
  };
  check(KIND_VALUES.includes(header.kind), 'Unknown message kind');
  check(header.flags <= 3, 'Unknown header flags');
  return header;
}

/** {id, pressed, x, y} with x and y normalised to the 0..1 picture area. */
export function encodeTouch(contacts) {
  check(contacts.length <= MAX_TOUCH_CONTACTS, 'Too many contacts');
  const b = new Uint8Array(1 + contacts.length * 6);
  const v = new DataView(b.buffer);
  b[0] = contacts.length;
  const seen = new Set();
  contacts.forEach((c, i) => {
    check(Number.isInteger(c.id) && c.id >= 0 && c.id <= 9 && !seen.has(c.id), 'Invalid or duplicate contact id');
    seen.add(c.id);
    check(typeof c.pressed === 'boolean', 'Invalid pressed value');
    check(Number.isFinite(c.x) && c.x >= 0 && c.x <= 1, 'Coordinate x is outside the picture');
    check(Number.isFinite(c.y) && c.y >= 0 && c.y <= 1, 'Coordinate y is outside the picture');
    const o = 1 + i * 6;
    b[o] = c.id;
    b[o + 1] = c.pressed ? 1 : 0;
    v.setUint16(o + 2, Math.round(c.x * 65535), true);
    v.setUint16(o + 4, Math.round(c.y * 65535), true);
  });
  return b;
}

export function decodeTouch(b) {
  check(b.length > 0, 'Missing touch count');
  check(b[0] <= MAX_TOUCH_CONTACTS && b.length === 1 + b[0] * 6, 'Invalid touch payload length or count');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const seen = new Set();
  return Array.from({ length: b[0] }, (_, i) => {
    const o = 1 + i * 6;
    const id = b[o];
    check(id <= 9 && !seen.has(id), 'Invalid or duplicate contact id');
    seen.add(id);
    check(b[o + 1] <= 1, 'Invalid pressed value');
    return { id, pressed: b[o + 1] === 1, x: v.getUint16(o + 2, true) / 65535, y: v.getUint16(o + 4, true) / 65535 };
  });
}

export function encodeKey({ code, down }) {
  check(Number.isInteger(code) && code >= 0 && code <= 10, 'Unknown key code');
  check(typeof down === 'boolean', 'Invalid key down value');
  return new Uint8Array([code, 0, down ? 1 : 0]);
}

export function decodeKey(b) {
  check(b.length === 3, 'Key payload must be three bytes');
  const code = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(0, true);
  check(code <= 10, 'Unknown key code');
  check(b[2] <= 1, 'Invalid key down value');
  return { code, down: b[2] === 1 };
}

export function encodeBinary(header, payload) {
  const head = encodeHeader(header);
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out.set(head);
  out.set(payload, HEADER_SIZE);
  return out;
}

export function decodeBinary(message) {
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  const header = decodeHeader(bytes);
  const payload = bytes.subarray(HEADER_SIZE);
  if (header.kind === Kind.Touch) decodeTouch(payload);
  if (header.kind === Kind.Key) decodeKey(payload);
  return { header, payload };
}

/** Convenience frame envelope for a video source: flags come from the payload itself. */
export function videoMessage({ avcc, ptsUs = 0, key, sequence = 0, senderClockUs = 0n, gap = false }) {
  let flags = 0;
  if (key ?? isKeyFrame(avcc, Avcc)) flags |= Flag.Keyframe;
  if (gap) flags |= Flag.Gap;
  return encodeBinary(
    { kind: Kind.Video, flags, sequence, ptsUs: BigInt(ptsUs), senderClockUs: BigInt(senderClockUs) },
    avcc instanceof Uint8Array ? avcc : new Uint8Array(avcc),
  );
}
