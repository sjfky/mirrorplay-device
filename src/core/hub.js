// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The projection session model and the fan-out between inputs and outputs. One source and any
// number of head units agree on this single shape; a source never learns how many receivers exist
// and a receiver never learns where its media comes from. Rules kept from the upstream model:
//
//   * phases CONNECTING / ACTIVE / RECONNECTING / ENDED, announced on `session` with a reason
//   * a format change is re-announced before the first frame that uses it
//   * a receiver only receives frames it can start decoding from, i.e. from the next key frame
//   * the first frame after a start or resync carries the gap flag, so the receiver flushes
//   * `keyframe` requests are coalesced and rate limited, since each one costs a real encode
//   * a receiver whose socket backs up is dropped forward to the next key frame, gap-flagged

import { EventEmitter } from 'node:events';
import { Kind, Flag, encodeBinary, decodeTouch, decodeKey } from '../protocol/binary.js';
import { ReceiverChan } from '../relay/links.js';

export const Phase = { Connecting: 'CONNECTING', Active: 'ACTIVE', Reconnecting: 'RECONNECTING', Ended: 'ENDED' };

export const STARTUP_REASONS = {
  connecting: 'startup/connecting',
  authenticating: 'startup/authenticating',
  joiningNetwork: 'startup/joining-network',
  waitingMedia: 'startup/waiting-media',
  failed: 'startup/failed',
  disconnected: 'startup/disconnected',
};

const KEY_REQUEST_MIN_INTERVAL_MS = 400;
// How far a source's own media line may lead or lag the relay's before the relay calls it a new run
// rather than jitter. Two frame periods at 60fps, generously rounded.
const MAX_PTS_DRIFT_US = 250_000n;

export class Projection extends EventEmitter {
  constructor({ clock, sessionId = 1, backpressureBytes = 2 * 1024 * 1024 }) {
    super();
    if (!clock) throw new TypeError('a projection needs the relay clock for senderClockUs');
    this.clock = clock;
    this.sessionId = sessionId;
    this.backpressureBytes = backpressureBytes;
    this.phase = Phase.Connecting;
    this.reason = STARTUP_REASONS.connecting;
    this.videoFormat = null;
    this.audioFormat = null;
    this.sources = new Set();
    this.receivers = new Set();
    this.sequence = { [Kind.Video]: 0, [Kind.Audio]: 0 };
    this.stats = {
      frames: 0,
      keyFrames: 0,
      bytes: 0,
      keyRequests: 0,
      deferredKeyRequests: 0,
      droppedForBackpressure: 0,
      touchEvents: 0,
      keyEvents: 0,
      audioFrames: 0,
    };
    this.receiversWhoWantKeyFrame = new Set();
    this.ptsAnchor = null;
    this.ptsLastAbsolute = 0n;
    this.ptsLastAtUs = 0n;
    this.ptsLastSource = 0n;
  }

  // ---- inputs --------------------------------------------------------------

  attachSource(link) {
    this.sources.add(link);
    link.onVideoFormat = (format) => this.setVideoFormat(format);
    link.onAudioFormat = (format) => this.setAudioFormat(format);
    link.onVideo = (frame) => this.publishVideo(frame);
    link.onAudio = (frame) => this.publishAudio(frame);
    link.onClosed((reason = 'source-ended') => {
      this.sources.delete(link);
      // A device whose socket vanished says "disconnected"; one whose media merely stopped says
      // "waiting-media", which is what the receivers are now doing.
      if (this.sources.size === 0) this.#settlePhase(reason === 'source-ended' ? STARTUP_REASONS.waitingMedia : STARTUP_REASONS.disconnected);
      this.emit('source-ended', { link, reason });
    });
    link.toInput?.({ type: 'start', videoFormat: this.videoFormat, audioFormat: this.audioFormat });
    this.#settlePhase();
    this.emit('source', link);
    return link;
  }

  /**
   * The one place that decides what the session is doing, because "a peer is connected" and "media
   * is flowing" are different promises to a viewer:
   *
   *   no source            → RECONNECTING, with the reason the source left, or waiting-media
   *   source, no media     → RECONNECTING, waiting-media: introduced is not yet streaming
   *   source and media     → ACTIVE
   */
  #settlePhase(lostReason = STARTUP_REASONS.waitingMedia) {
    if (this.sources.size === 0) return this.setPhase(Phase.Reconnecting, lostReason);
    if (this.videoFormat) return this.setPhase(Phase.Active, 'media-ready');
    return this.setPhase(Phase.Reconnecting, STARTUP_REASONS.waitingMedia);
  }

  setActive(reason = null) {
    this.setPhase(Phase.Active, reason);
  }

  sendToInput(message) {
    for (const source of this.sources) source.toInput?.(message);
  }

  setVideoFormat(format) {
    const changed = !sameFormat(this.videoFormat, format);
    if (!format || changed) this.#forgetMediaTimeline();
    this.videoFormat = format;
    if (changed) for (const receiver of this.receivers) receiver.awaitFormat();
    if (format) this.#settlePhase();
    this.emit('video-format', format);
  }

  setAudioFormat(format) {
    this.audioFormat = format;
    this.emit('audio-format', format);
  }

  setPhase(phase, reason = null) {
    if (this.phase === phase && this.reason === reason) return;
    this.phase = phase;
    this.reason = reason;
    const message = { type: 'session', session: { id: String(this.sessionId), phase, ...(reason ? { reason } : {}) } };
    for (const receiver of this.receivers) receiver.sendJson(message);
    this.emit('phase', phase, reason);
  }

  // ---- media outbound ------------------------------------------------------

  /**
   * A source counts media time from its own start, while `senderClockUs` is the relay's clock. Two
   * lines that never met cannot be subtracted, and "how far behind live am I" is a subtraction, so the
   * relay moves each run of media onto its own clock once and keeps it there: the first frame fixes an
   * anchor, later frames are anchor + pts. The anchor only changes when a run ends — the source's
   * counter goes backwards, or its media time and the relay's wall time drift more than a couple of
   * seconds apart, which is a restart rather than jitter.
   */
  #forgetMediaTimeline() {
    this.ptsAnchor = null;
    this.ptsLastSource = 0n;
  }

  mediaPtsUs(ptsUs, atUs = this.clock.epochAt()) {
    const fromSource = BigInt(Math.round(ptsUs ?? Number(atUs)));
    if (this.ptsAnchor === null) return this.#anchorAt(fromSource, atUs);
    const absolute = this.ptsAnchor + fromSource;
    // A source that counts backwards has started a new run: that is a restart, not jitter, and no
    // receiver should have to work the difference out for itself.
    if (fromSource < this.ptsLastSource) return this.#anchorAt(fromSource, atUs);
    const expected = this.ptsLastAbsolute + (atUs - this.ptsLastAtUs);
    const drift = absolute - expected;
    if (drift < 0n ? -drift > MAX_PTS_DRIFT_US : drift > MAX_PTS_DRIFT_US) return this.#anchorAt(fromSource, atUs);
    this.ptsLastAbsolute = absolute;
    this.ptsLastAtUs = atUs;
    this.ptsLastSource = fromSource;
    return absolute;
  }

  #anchorAt(fromSource, atUs) {
    this.ptsAnchor = atUs - fromSource;
    this.ptsLastAbsolute = atUs;
    this.ptsLastAtUs = atUs;
    this.ptsLastSource = fromSource;
    return atUs;
  }

  publishVideo({ avcc, ptsUs, key }) {
    if (!this.videoFormat) {
      this.stats.frames++;
      return; // nothing can decode a frame whose format was never announced
    }
    const sequence = this.sequence[Kind.Video];
    this.sequence[Kind.Video] = (sequence + 1) % 0x100000000;
    this.stats.frames++;
    this.stats.bytes += avcc.length;
    if (key) {
      this.stats.keyFrames++;
      this.receiversWhoWantKeyFrame.clear();
    }
    const header = {
      kind: Kind.Video,
      stream: 0,
      flags: key ? Flag.Keyframe : 0,
      sequence,
      ptsUs: this.mediaPtsUs(ptsUs),
      senderClockUs: this.clock.epochAt(),
    };
    for (const receiver of this.receivers) receiver.acceptVideo(header, avcc, key);
    this.emit('video', { header, avcc });
  }

  publishAudio({ aac, ptsUs, stream = 0 }) {
    if (!this.audioFormat) return;
    const sequence = this.sequence[Kind.Audio];
    this.sequence[Kind.Audio] = (sequence + 1) % 0x100000000;
    this.stats.audioFrames++;
    const message = encodeBinary(
      { kind: Kind.Audio, stream, flags: 0, sequence, ptsUs: this.mediaPtsUs(ptsUs), senderClockUs: this.clock.epochAt() },
      aac,
    );
    for (const receiver of this.receivers) receiver.sendRaw(message);
  }

  // ---- outputs -------------------------------------------------------------

  addReceiver(ws) {
    const receiver = new ReceiverChan(this.receivers.size, ws, this);
    this.receivers.add(receiver);
    this.emit('receiver-added', receiver);
    return receiver;
  }

  removeReceiver(receiver) {
    this.receivers.delete(receiver);
    this.receiversWhoWantKeyFrame.delete(receiver);
    this.emit('receiver-removed', receiver);
  }

  /**
   * A receiver that says hello is told, in this order: where the session stands, what media it is
   * about to receive, how the picture maps onto its display, and then — once the source can supply
   * an IDR — the frames themselves. A receiver never has to guess which format a frame belongs to.
   */
  onReceiverHello(receiver, hello) {
    receiver.hello = hello;
    receiver.announcedHello();
    this.emit('receiver-hello', receiver, hello);
    this.sendSession(receiver);
    // The view-area goes out with the formats, from one place, so a receiver can never see a
    // geometry that belongs to a format it has not been told about.
    if (this.videoFormat || this.audioFormat) receiver.announceFormats();
    else receiver.awaitFormat();
    this.requestKeyFrame(receiver);

  }

  sendSession(receiver) {
    receiver.sendJson({
      type: 'session',
      session: { id: String(this.sessionId), phase: this.phase, ...(this.reason ? { reason: this.reason } : {}) },
    });
  }

  sendViewArea(receiver) {
    const display = receiver.hello?.displays?.[0];
    const format = this.videoFormat;
    if (!display || !format) return;
    const scale = Math.min(display.width / format.width, display.height / format.height);
    const width = Math.round(format.width * scale);
    const height = Math.round(format.height * scale);
    receiver.sendJson({
      type: 'view-area',
      x: Math.round((display.width - width) / 2),
      y: Math.round((display.height - height) / 2),
      width,
      height,
      canvasWidth: display.width,
      canvasHeight: display.height,
    });
  }

  onDisplaySettings(receiver, settings) {
    this.emit('display-settings', receiver, settings);
    this.sendToInput({ type: 'display-settings', ...settings });
    receiver.sendJson({ type: 'display-settings', ...settings, videoCodec: 'h264' });
  }

  onReceiverPing(receiver, t0Us) {
    // t1 and t2 are on the epoch line, the only clock a browser can compare its own against; the
    // monotonic line stays inside the relay where a clock step cannot disturb it.
    const t1Us = this.clock.epochAt();
    receiver.sendJson({ type: 'pong', t0Us, t1Us: String(t1Us), t2Us: String(this.clock.epochAt()) });
  }

  /**
   * A receiver asks for a key frame. One request goes to the source for the whole group inside the
   * limiter window, and every receiver that still waits gets the next IDR, gap-flagged.
   */
  requestKeyFrame(receiver = null) {
    if (receiver) this.receiversWhoWantKeyFrame.add(receiver);
    const now = this.clock.nowMs();
    if (now - (this.lastKeyRequestMs ?? -Infinity) < KEY_REQUEST_MIN_INTERVAL_MS) {
      this.stats.deferredKeyRequests++;
      return false;
    }
    this.lastKeyRequestMs = now;
    this.stats.keyRequests++;
    this.sendToInput({ type: 'keyframe', screen: 0 });
    this.emit('keyframe-request', receiver);
    return true;
  }

  // ---- media inbound from a head unit --------------------------------------

  deliverToHeadUnit(header, payload) {
    if (header.kind === Kind.Touch) {
      const contacts = decodeTouch(payload);
      this.stats.touchEvents++;
      this.lastTouch = { contacts, atUs: this.clock.epochAt(), sequence: header.sequence };
      const delivered = [...this.sources].map((source) => `${source.kind}:${source.deliver?.(header, payload) !== false}`).join(' ');
      this.emit('touch', contacts, header, delivered);
      return { kind: 'touch', contacts };
    }
    if (header.kind === Kind.Key) {
      const key = decodeKey(payload);
      this.stats.keyEvents++;
      this.lastKey = { ...key, atUs: this.clock.epochAt() };
      const delivered = [...this.sources].map((source) => `${source.kind}:${source.deliver?.(header, payload) !== false}`).join(' ');
      this.emit('key', key, header, delivered);
      return { kind: 'key', ...key };
    }
    return null;
  }

  // ---- reporting -----------------------------------------------------------

  snapshot() {
    return {
      session: { id: this.sessionId, phase: this.phase, reason: this.reason },
      sources: [...this.sources].map((s) => ({ id: s.id, kind: s.kind, label: s.label?.() ?? null })),
      receivers: this.receivers.size,
      video: this.videoFormat
        ? { codec: this.videoFormat.codec, codecString: this.videoFormat.codecString, width: this.videoFormat.width, height: this.videoFormat.height, fpsHint: this.videoFormat.fpsHint ?? null }
        : null,
      audio: this.audioFormat ? { codec: this.audioFormat.codec, sampleRate: this.audioFormat.sampleRate, channels: this.audioFormat.channels } : null,
      stats: { ...this.stats, awaitingKeyFrame: this.receiversWhoWantKeyFrame.size },
      lastTouch: this.lastTouch
        ? { atUs: String(this.lastTouch.atUs), contacts: this.lastTouch.contacts.map((c) => ({ id: c.id, pressed: c.pressed, x: Number(c.x.toFixed(4)), y: Number(c.y.toFixed(4)) })) }
        : null,
      lastKey: this.lastKey ? { ...this.lastKey, atUs: String(this.lastKey.atUs) } : null,
      receiverDetail: [...this.receivers].map((r) => r.detail()),
    };
  }
}

function sameFormat(a, b) {
  if (!a || !b) return !a && !b;
  return a.codecString === b.codecString && a.config === b.config && a.width === b.width && a.height === b.height;
}
