// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Transport links. Three kinds of peer reach the projection through one small interface, which is
// what keeps inputs and outputs independent of one another:
//
//   LocalSource   the in-process ffmpeg source (no socket at all)
//   InputLink     a device tab — the stand-in for a phone — that encodes and streams into the relay
//   ReceiverChan  a head unit's browser that decodes the projection
//
// Socket links expose send(data, text?), sendJson(message), sendRaw(bytes), bufferedAmount(),
// close(), id. The projection assigns onVideoFormat/onAudioFormat/onVideo/onAudio on the
// media side; anything travelling towards a device leaves through toInput() or deliver(), so touch
// and keys keep the very envelope they arrived in.

import { Kind, Flag, decodeBinary, decodeTouch, decodeKey, encodeBinary, WireFormatError } from '../protocol/binary.js';
import { encodeMessage, parseMessage, ProtocolError } from '../protocol/json.js';
import { SCENE_ORDER } from '../sources/ffmpeg.js';

const OPEN = 1;

/**
 * A peer leaving is something more than one party needs to know: the session model stops publishing
 * media, and the relay process decides whether the synthetic source takes over again. So a close is
 * broadcast to every registered handler instead of being a single slot that whoever registered last
 * silently replaces — which is exactly how a dead device used to leave the projection waiting.
 */
export class CloseNotifier {
  constructor() {
    this.closed = false;
    this.closeHandlers = [];
  }

  /** Say the peer is gone, once, whatever the reason was. */
  notifyClosed(reason = 'closed') {
    if (this.closed) return false;
    this.closed = true;
    for (const handle of this.closeHandlers) handle(reason);
    return true;
  }

  onClosed(handle) {
    this.closeHandlers.push(handle);
    return () => {
      const at = this.closeHandlers.indexOf(handle);
      if (at >= 0) this.closeHandlers.splice(at, 1);
    };
  }
}

class SocketLink extends CloseNotifier {
  constructor(id, ws, role) {
    super();
    this.id = id;
    this.ws = ws;
    this.role = role;
    this.lastError = null;
    ws.on('close', () => this.notifyClosed('socket-closed'));
    ws.on('error', (error) => {
      this.lastError = error.message;
    });
  }

  send(data, text = false) {
    if (this.closed || this.ws.readyState !== OPEN) return false;
    this.ws.send(data, { binary: !text });
    return true;
  }

  sendJson(message) {
    return this.send(encodeMessage(message), true);
  }

  sendRaw(bytes) {
    return this.send(bytes, false);
  }

  bufferedAmount() {
    return this.closed ? 0 : (this.ws.bufferedAmount ?? 0);
  }

  close(code = 1000, reason = '') {
    if (!this.closed) this.ws.close(code, reason);
  }
}

/** A device streaming in. Whatever the head unit touches is handed straight back to it. */
export class InputLink extends SocketLink {
  constructor(id, ws) {
    super(id, ws, 'input');
    this.kind = 'browser-device';
    this.hello = null;
  }

  label() {
    return this.hello?.source?.toString().slice(0, 64) ?? 'browser device';
  }

  /** Text or binary frames arriving from the device, routed into the projection. */
  receive(data, isBinary) {
    if (isBinary) {
      const { header, payload } = decodeBinary(data);
      if (header.kind === Kind.Video) {
        this.onVideo?.({ avcc: payload, ptsUs: Number(header.ptsUs), key: (header.flags & Flag.Keyframe) === Flag.Keyframe });
        return 'video';
      }
      if (header.kind === Kind.Audio) {
        this.onAudio?.({ aac: payload, ptsUs: Number(header.ptsUs), stream: header.stream });
        return 'audio';
      }
      throw new WireFormatError(`an input sends video or audio, not kind ${header.kind}`);
    }
    const message = parseMessage(data.toString(), 'device-to-relay');
    switch (message.type) {
      case 'hello':
        this.hello = message;
        break;
      case 'video-format':
        this.onVideoFormat?.(message.format);
        break;
      case 'audio-format':
        this.onAudioFormat?.(message.format);
        break;
      case 'restart':
        this.notifyClosed('device-requested-restart');
        break;
      case 'error':
        this.onError?.(message);
        break;
      default:
        break; // ping, pong and stats from a device are not part of this build
    }
    return message.type;
  }

  toInput(message) {
    if (message.type === 'keyframe') this.keyframeRequests = (this.keyframeRequests ?? 0) + 1;
    return this.sendJson(message);
  }

  /** Touch and keys produced on a head unit, forwarded verbatim to the device. */
  deliver(header, payload) {
    if (header.kind !== Kind.Touch && header.kind !== Kind.Key) return false;
    return this.sendRaw(encodeBinary(header, payload));
  }
}

/** A head unit watching the projection, plus the resynchronisation policy that goes with it. */
export class ReceiverChan extends SocketLink {
  constructor(id, ws, projection) {
    super(id, ws, 'receiver');
    this.projection = projection;
    this.hello = null;
    this.awaitingKeyFrame = true;
    this.pendingFormats = true;
    this.counts = { sent: 0, dropped: 0, resyncs: 0, backpressureDrops: 0 };
    this.lastStats = null;
    this.lastInfo = null;
  }

  /** Formats and media are announced by the projection, so a receiver starts on hello. */
  receive(data, isBinary) {
    if (isBinary) {
      const { header, payload } = decodeBinary(data);
      if (header.kind !== Kind.Touch && header.kind !== Kind.Key) throw new WireFormatError(`a receiver sends touch or keys, not kind ${header.kind}`);
      this.projection.deliverToHeadUnit(header, payload);
      return header.kind === Kind.Touch ? 'touch' : 'key';
    }
    const message = parseMessage(data.toString(), 'client-to-relay');
    switch (message.type) {
      case 'hello':
        this.projection.onReceiverHello(this, message);
        break;
      case 'keyframe':
        this.awaitingKeyFrame = true;
        this.projection.requestKeyFrame(this);
        break;
      case 'display-settings':
        this.projection.onDisplaySettings(this, message);
        break;
      case 'pause':
        this.paused = message.paused;
        this.projection.sendToInput({ type: 'pause', screen: message.screen, paused: message.paused });
        break;
      case 'stats':
        this.lastStats = message;
        break;
      case 'receiver-info':
        this.lastInfo = message;
        break;
      case 'restart':
        this.projection.sendToInput({ type: 'restart' });
        break;
      case 'ping':
        this.projection.onReceiverPing(this, message.t0Us);
        break;
      case 'pong':
        break;
      case 'fullscreen-exit':
        this.projection.onDisplaySettings(this, { type: 'display-settings', resolution: 'auto', screenWidth: 250, videoCodec: 'auto' });
        break;
      default:
        break;
    }
    return message.type;
  }

  /**
   * Formats first, then the geometry they map onto, and only then frames: a receiver can create its
   * decoder and its letterbox before the first picture arrives, in one pass.
   */
  announceFormats() {
    if (this.projection.videoFormat) {
      this.sendJson({ type: 'video-format', screen: 0, format: this.projection.videoFormat });
    }
    if (this.projection.audioFormat) {
      this.sendJson({ type: 'audio-format', stream: 0, format: this.projection.audioFormat });
    }
    if (this.hello) this.projection.sendViewArea(this);
    this.pendingFormats = false;
    this.awaitingKeyFrame = true;
  }

  awaitFormat() {
    this.pendingFormats = true;
    this.awaitingKeyFrame = true;
  }

  awaitingResync() {
    return this.awaitingKeyFrame || this.pendingFormats;
  }

  /** A repeated hello (a reload, a wake-up) is the same receiver, not a second one. */
  announcedHello() {
    this.hellos = (this.hellos ?? 0) + 1;
    this.awaitingKeyFrame = true;
    this.pendingFormats = true;
  }

  /** One published video frame, filtered by what this receiver can currently decode. */
  acceptVideo(header, avcc, key) {
    if (this.paused) return;
    if (this.pendingFormats) {
      if (!key) return this.drop();
      this.announceFormats();
    }
    if (this.awaitingKeyFrame) {
      if (!key) return this.drop();
      this.awaitingKeyFrame = false;
      this.counts.resyncs++;
      header = { ...header, flags: header.flags | Flag.Gap };
    }
    if (this.bufferedAmount() > this.projection.backpressureBytes) {
      this.awaitingKeyFrame = true;
      this.counts.backpressureDrops++;
      this.projection.stats.droppedForBackpressure++;
      return this.drop();
    }
    this.counts.sent++;
    this.sendRaw(encodeBinary(header, avcc));
  }

  drop() {
    this.counts.dropped++;
  }

  detail() {
    return {
      id: this.id,
      hello: this.hello
        ? {
            decoders: this.hello.decoders,
            displays: this.hello.displays.map((d) => ({ width: d.width, height: d.height, refreshHz: d.refreshHz, dpr: d.dpr })),
            playback: this.hello.playback ?? 'SMART',
            videoCodec: this.hello.videoCodec ?? 'AUTO',
            maxTouchContacts: this.hello.maxTouchContacts,
            audio: this.hello.audio,
            microphone: this.hello.microphone,
          }
        : null,
      awaitingKeyFrame: this.awaitingKeyFrame,
      paused: this.paused ?? false,
      counts: { ...this.counts },
      stats: this.lastStats,
      bufferedAmount: this.bufferedAmount(),
    };
  }
}

/**
 * The synthetic source. It has no socket: ffmpeg hands frames straight to the projection. A head
 * unit's input drives it, because a synthetic scene is the only device this build owns end to end:
 * a tap near the left or right edge steps the scene, Home returns to the first one. A `keyframe`
 * request cannot interrupt a command-line encoder, so the answer is to wait for its cadence,
 * which is what the key frame limiter assumes for such a source (see sources/ffmpeg.js).
 */
export class LocalSource extends CloseNotifier {
  constructor(id, source, { onLog, onScene } = {}) {
    super();
    this.id = id;
    this.kind = 'local-source';
    this.source = source;
    this.onLog = onLog ?? (() => {});
    this.onScene = onScene ?? (() => {});
    this.sequence = 0;
    this.restarting = false;
    source.on('videoFormat', ({ format }) => this.onVideoFormat?.(format));
    source.on('audioFormat', ({ format }) => this.onAudioFormat?.(format));
    source.on('video', (frame) => this.onVideo?.(frame));
    source.on('audio', (frame) => this.onAudio?.(frame));
    source.on('log', (entry) => this.onLog({ ...entry, from: 'ffmpeg' }));
    source.on('ended', (info) => this.notifyClosed(info?.reason ?? 'source-ended'));
  }

  label() {
    return this.source.label;
  }

  toInput(message) {
    switch (message.type) {
      case 'start':
        if (message.scene && SCENE_ORDER.includes(message.scene)) this.source.setScene(message.scene);
        this.source.start();
        break;
      case 'keyframe':
        // The encoder is a command line child process, so an IDR lands on its own cadence. Waiting is
        // the honest answer, and it is what the key frame limiter assumes for such a source.
        this.onLog({ level: 'debug', from: 'ffmpeg', text: `key frame requested; the next IDR lands within ${this.source.gopSeconds}s` });
        break;
      case 'restart':
        void this.restart();
        break;
      case 'pause':
        this.onLog({ level: 'debug', from: 'ffmpeg', text: message.paused ? 'head unit paused' : 'head unit resumed' });
        break;
      default:
        break;
    }
  }

  deliver(header, payload) {
    if (header.kind === Kind.Touch) {
      const contacts = decodeTouch(payload);
      if (contacts.length && !this.source.input) this.#stepSceneFromTouch(contacts[0]);
      return contacts;
    }
    if (header.kind === Kind.Key) {
      const key = decodeKey(payload);
      if (key.down && key.code === 0 && !this.source.input) void this.restart(SCENE_ORDER[0]);
      return key;
    }
    return false;
  }

  #stepSceneFromTouch(contact) {
    if (!contact.pressed) return;
    const edge = contact.x < 0.12 ? -1 : contact.x > 0.88 ? 1 : 0;
    if (!edge) return;
    const next = this.source.nextScene(edge);
    this.onLog({ level: 'info', from: 'ffmpeg', text: `touch at x=${contact.x.toFixed(2)} → scene ${next}` });
    void this.restart(next);
  }

  async restart(scene) {
    if (this.restarting) return;
    this.restarting = true;
    if (scene && SCENE_ORDER.includes(scene)) {
      this.source.setScene(scene);
      this.onScene(scene);
    }
    await this.source.stop();
    this.restarting = false;
    this.source.start();
  }

  async stop() {
    await this.source.stop();
  }
}
