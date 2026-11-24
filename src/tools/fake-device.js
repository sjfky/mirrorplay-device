#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// A device without a browser tab. Two uses: as a class in the tests, so a relay can be exercised
// deterministically, and as a command line, so a head unit can be tried against a fake phone that
// streams a real ffmpeg-encoded scene.
//
//   node src/tools/fake-device.js --relay-port 3000 --token mirrorplay --scene life --frames 60
//
// Nothing in here invents a CarPlay session: it is the shape of the input side, in this prototype's
// own terms, which is exactly what the relay has to be able to cope with.

import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { Kind, Flag, encodeBinary, decodeBinary } from '../protocol/binary.js';
import { encodeMessage, parseMessage } from '../protocol/json.js';

export class FakeDevice {
  constructor({ port = 3000, host = '127.0.0.1', token = 'mirrorplay', label = 'fake device', path = '/input-wire', url = null } = {}) {
    this.url = url ?? `ws://${host}:${port}${path}?token=${encodeURIComponent(token)}`;
    this.label = label;
    this.sent = { video: 0, audio: 0 };
    this.received = { touch: 0, key: 0 };
    this.controls = [];
    this.input = [];
    this.sequence = { [Kind.Video]: 0, [Kind.Audio]: 0 };
    this.socket = null;
  }

  connect({ timeoutMs = 2000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('the relay did not accept the device within the timeout')), timeoutMs);
      socket.on('open', () => {
        clearTimeout(timer);
        this.#sendHello();
        resolve(this);
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('close', (code, reason) => {
        this.closedWith = { code, reason: reason.toString() };
      });
      socket.on('message', (data, isBinary) => {
        try {
          if (!isBinary) {
            const message = parseMessage(data.toString(), 'relay-to-device');
            this.controls.push(message);
            return;
          }
          const { header, payload } = decodeBinary(data);
          this.input.push({ header, payload });
          if (header.kind === Kind.Touch) this.received.touch++;
          if (header.kind === Kind.Key) this.received.key++;
        } catch (error) {
          this.error = error;
        }
      });
    });
  }

  #sendHello() {
    this.send({
      type: 'hello',
      version: 0,
      token: new URL(this.url).searchParams.get('token') ?? 'mirrorplay',
      source: this.label,
      decoders: [{ codecString: 'avc1.42E01F', hardware: false }],
      displays: [{ screen: 0, width: 1280, height: 720, dpr: 1, refreshHz: 60, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }],
      maxTouchContacts: 10,
      audio: ['AAC_LC'],
      microphone: false,
    });
  }

  hello(source = this.label) {
    this.label = source;
    return this.#sendHello();
  }

  send(message) {
    if (typeof message === 'string' || message instanceof Uint8Array) this.socket.send(message);
    else this.socket.send(JSON.stringify(message));
    return this;
  }

  videoFormat(format) {
    return this.send({ type: 'video-format', screen: 0, format });
  }

  audioFormat(format) {
    return this.send({ type: 'audio-format', stream: 0, format });
  }

  video({ avcc, ptsUs, key = false, gap = false }) {
    const sequence = this.sequence[Kind.Video]++;
    this.socket.send(
      encodeBinary(
        { kind: Kind.Video, stream: 0, flags: (key ? Flag.Keyframe : 0) | (gap ? Flag.Gap : 0), sequence, ptsUs: BigInt(ptsUs), senderClockUs: BigInt(ptsUs) },
        avcc,
      ),
    );
    this.sent.video++;
    return this;
  }

  audio({ aac, ptsUs, stream = 0 }) {
    const sequence = this.sequence[Kind.Audio]++;
    this.socket.send(encodeBinary({ kind: Kind.Audio, stream, flags: 0, sequence, ptsUs: BigInt(ptsUs), senderClockUs: BigInt(ptsUs) }, aac));
    this.sent.audio++;
    return this;
  }

  /** Shared with the fake head unit: wait for a condition instead of sleeping. */
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
    return new Promise((ok) => (this.socket?.readyState === 3 ? ok() : this.socket?.once('close', ok) ?? ok()));
  }
}

const IDR = new Uint8Array([0, 0, 0, 3, 0x65, 0x11, 0x22]);
const DELTA = new Uint8Array([0, 0, 0, 3, 0x41, 0x11, 0x22]);

async function cli() {
  const { values: flags } = parseArgs({
    options: {
      'relay-port': { type: 'string', default: '3000' },
      host: { type: 'string', default: '127.0.0.1' },
      token: { type: 'string', default: 'mirrorplay' },
      frames: { type: 'string', default: '30' },
      gop: { type: 'string', default: '10' },
      scene: { type: 'string', default: null },
      width: { type: 'string', default: '1280' },
      height: { type: 'string', default: '720' },
      fps: { type: 'string', default: '30' },
    },
  });
  const device = new FakeDevice({ port: Number(flags['relay-port']), host: flags.host, token: flags.token, label: flags.scene ? `ffmpeg ${flags.scene}` : 'fake device' });
  await device.connect();
  // A format a decoder would accept: avcC with the baseline profile and 640x480 geometry, which is
  // the same shape real encoder output produces.
  const { AvcConfig } = await import('../media/avc.js');
  const avcC = AvcConfig.fromParameterSets(
    new Uint8Array([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xca, 0x3c, 0x60, 0xca, 0x80]),
    new Uint8Array([0x68, 0xce, 0x3c, 0x80]),
  );
  device.videoFormat({ ...AvcConfig.wireFormat(avcC, { fpsHint: Number(flags.fps) }) });
  const interval = 1000 / Number(flags.fps);
  let sent = 0;
  const timer = setInterval(() => {
    const ptsUs = Math.round(sent * 1e6 / Number(flags.fps));
    const key = sent % Number(flags.gop) === 0;
    device.video({ avcc: key ? IDR : DELTA, ptsUs, key, gap: sent === 0 });
    sent++;
    if (sent >= Number(flags.frames)) {
      clearInterval(timer);
      process.stdout.write(`device sent ${sent} frames, saw ${device.received.touch} touch and ${device.received.key} key messages\n`);
      setTimeout(() => device.close().then(() => process.exit(0)), 1500);
    }
  }, interval);
  process.on('SIGINT', () => {
    clearInterval(timer);
    device.close().then(() => process.exit(0));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await cli();
