// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// One socket carrying the projection, shared by the receiver page and the device page. Text frames
// are JSON control messages, binary frames are the 24-byte envelope from ../protocol/binary.js.
// Reconnecting is the normal case, not the error case: a car browser drops its network every time
// the car sleeps, so the socket comes back on its own with the same token.

import { decodeBinary, encodeBinary } from '/src/protocol/binary.js';
import { parseMessage, encodeMessage } from '/src/protocol/json.js';
import { relayToken } from '/web/token.js';

export const MIN_RETRY_MS = 400;
export const MAX_RETRY_MS = 8000;

export class Wire {
  constructor({ role, url, onJson, onBinary, onOpen, onClose, onError, clockUs }) {
    this.role = role ?? 'receiver';
    this.url = url;
    this.onJson = onJson ?? (() => {});
    this.onBinary = onBinary ?? (() => {});
    this.onOpen = onOpen ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.onError = onError ?? (() => {});
    this.clockUs = clockUs ?? (() => BigInt(Math.round(performance.timeOrigin * 1000 + performance.now() * 1000)));
    this.sequence = new Map();
    this.socket = null;
    this.wanted = true;
    this.retryMs = MIN_RETRY_MS;
    this.opened = 0;
    this.closedCount = 0;
  }

  static urlFor(path, params = new URLSearchParams(location.search)) {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = params.get('token') ?? relayToken();
    return `${scheme}//${location.host}${path}?token=${encodeURIComponent(token)}`;
  }

  connect() {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return this;
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.opened++;
      this.retryMs = MIN_RETRY_MS;
      this.onOpen();
    });
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data === 'string') return this.onJson(parseMessage(event.data));
        const { header, payload } = decodeBinary(new Uint8Array(event.data));
        return this.onBinary(header, payload);
      } catch (error) {
        // Kept for the browser check: an envelope this page cannot read is a protocol bug, and the
        // relay's own log would otherwise look fine.
        window.__wireErrors = [...(window.__wireErrors ?? []), `${error.name}: ${error.message}`.slice(0, 160)].slice(-8);
        this.onError(error);
      }
    });
    socket.addEventListener('close', (event) => {
      this.closedCount++;
      this.onClose(event);
      if (!this.wanted) return;
      const wait = Math.min(this.retryMs, MAX_RETRY_MS);
      this.retryMs *= 2;
      this.timer = setTimeout(() => this.connect(), wait);
    });
    socket.addEventListener('error', () => this.onError(new Error('socket error')));
    return this;
  }

  get ready() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  json(message) {
    if (!this.ready) return false;
    this.socket.send(encodeMessage(message));
    return true;
  }

  binary(kind, payload, { flags = 0, ptsUs = 0n, stream = 0 } = {}) {
    if (!this.ready) return false;
    const sequence = this.sequence.get(kind) ?? 0;
    this.sequence.set(kind, (sequence + 1) % 0x100000000);
    this.socket.send(
      encodeBinary(
        { kind, stream, flags, sequence, ptsUs: BigInt(Math.round(Number(ptsUs))), senderClockUs: this.clockUs() },
        payload,
      ),
    );
    return true;
  }

  reconnect() {
    this.wanted = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.connect();
  }

  close(reason = 'page closed') {
    this.wanted = false;
    clearTimeout(this.timer);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000, reason);
    this.socket = null;
  }
}
