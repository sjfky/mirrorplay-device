// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// A head unit that is not a browser tab: it speaks the wire protocol from Node, so the relay can be
// tested, and so a device without WebCodecs (an old car browser, a set-top box, a test harness) can
// still be exercised. It decodes nothing; it reports what it received, which is what a test needs.

import WebSocket from 'ws';
import { Kind, Flag, decodeBinary, encodeBinary, encodeTouch, encodeKey } from '../protocol/binary.js';
import { parseMessage } from '../protocol/json.js';

export class FakeHeadUnit {
  constructor({ url, token, hello = {}, quiet = true, viewAreaOf = null } = {}) {
    this.url = url;
    this.token = token;
    this.hello = hello;
    this.quiet = quiet;
    this.viewAreaOf = viewAreaOf;
    this.messages = { text: [], binary: [] };
    this.frames = [];
    this.received = { video: 0, audio: 0, bytes: 0, keyFrames: 0, gaps: 0, sequences: [] };
    this.session = null;
    this.videoFormat = null;
    this.audioFormat = null;
    this.view = null;
    this.welcome = null;
    this.closed = new Promise((resolve) => (this.onClosed = resolve));
  }

  log(...rest) {
    if (!this.quiet) console.log('[receiver]', ...rest);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`);
      this.socket = socket;
      socket.on('open', () => {
        this.log('open');
        // A real receiver page says hello the moment the socket opens; the relay answers with
        // welcome, session and the media formats.
        this.send(this.helloMessage());
        resolve(this);
      });
      socket.on('error', reject);
      socket.on('close', (code, reason) => {
        this.log(`close ${code} ${reason.toString()}`);
        this.closeCode = code;
        this.onClosed({ code, reason: reason.toString() });
      });
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          const message = parseMessage(data.toString());
          this.messages.text.push(message);
          return this.#text(message);
        }
        const { header, payload } = decodeBinary(data);
        this.messages.binary.push(header);
        return this.#binary(header, payload);
      });
    });
  }

  #text(message) {
    switch (message.type) {
      case 'welcome':
        this.welcome = message;
        break;
      case 'session':
        this.session = message.session;
        break;
      case 'video-format':
        this.videoFormat = message.format;
        break;
      case 'audio-format':
        this.audioFormat = message.format;
        break;
      case 'view-area':
        this.view = message;
        break;
      case 'pong':
        this.pong = message;
        break;
      case 'error':
        this.error = message;
        this.log(`error ${message.code} ${message.message}`);
        break;
      default:
        this.log(message.type);
    }
  }

  #binary(header, payload) {
    if (header.kind === Kind.Video) {
      this.received.video++;
      this.received.bytes += payload.byteLength;
      this.received.sequences.push(header.sequence);
      if ((header.flags & Flag.Keyframe) === Flag.Keyframe) this.received.keyFrames++;
      if ((header.flags & Flag.Gap) === Flag.Gap) this.received.gaps++;
      this.frames.push({ sequence: header.sequence, ptsUs: Number(header.ptsUs), key: (header.flags & Flag.Keyframe) === Flag.Keyframe, gap: (header.flags & Flag.Gap) === Flag.Gap, bytes: payload.byteLength, avcc: payload });
      if (this.frames.length > 200) this.frames.shift();
    } else if (header.kind === Kind.Audio) {
      this.received.audio++;
    }
  }

  helloMessage(overrides = {}) {
    return {
      type: 'hello',
      version: 0,
      token: this.token,
      decoders: [{ codecString: 'avc1.42E01F', hardware: false }],
      displays: [{ screen: 0, width: 1280, height: 720, dpr: 1, refreshHz: 60, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }],
      maxTouchContacts: 10,
      audio: ['AAC_LC'],
      microphone: false,
      ...this.hello,
      ...overrides,
    };
  }

  json(message) {
    this.socket.send(JSON.stringify(message));
    return this;
  }

  control(message) {
    this.socket.send(JSON.stringify({ type: 'keyframe', screen: 0, ...message }));
    return this;
  }

  binary(kind, payload) {
    const sequence = (this.outbound?.get(kind) ?? 0) + 1;
    this.outbound ??= new Map();
    this.outbound.set(kind, sequence % 0x100000000);
    this.socket.send(encodeBinary({ kind, stream: 0, flags: 0, sequence, ptsUs: BigInt(Date.now() * 1000), senderClockUs: BigInt(Date.now() * 1000) }, payload));
    return this;
  }

  send(message) {
    return this.json(message);
  }

  touch(contacts) {
    return this.binary(Kind.Touch, encodeTouch(contacts));
  }

  key(code, down = true) {
    return this.binary(Kind.Key, encodeKey({ code, down }));
  }

  helloJson(overrides = {}) {
    return this.json(this.helloMessage(overrides));
  }

  /** Waits until the predicate is true, so tests read the stream instead of sleeping. */
  async until(predicate, what = 'condition', { timeoutMs = 4000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate(this);
      if (value) return value;
      await new Promise((ok) => setTimeout(ok, intervalMs));
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
  }

  close() {
    this.socket?.close();
    return this.closed;
  }
}
