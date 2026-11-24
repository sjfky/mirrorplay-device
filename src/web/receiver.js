// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The head unit end. It decodes the projection with WebCodecs, paints it on a canvas, turns touch
// and keyboard into the wire's input payloads, and reports statistics the relay can show. The three
// playback modes are the only trade a head unit makes, and they change nothing about the stream:
//
//   SPEED    show every frame the instant it is ready; a frame that misses its slot is dropped
//   SMART    a small buffer, sized from the arrival jitter actually measured
//   QUALITY  a fixed visible-frame of buffer, so motion stays smooth when the network does not
//
// Everything is measured against the relay's clock: frames carry `senderClockUs`, and the ping/pong
// exchange gives the offset between that clock and this page, so "behind live" means the same thing
// on every head unit.

import { Kind, Flag, encodeTouch, encodeKey } from '/src/protocol/binary.js';
import { fromBase64 } from '/src/util/base64.js';
import { Wire } from '/web/wire.js';

export const MODES = {
  SPEED: { name: 'SPEED', label: 'Speed', bufferMs: 0, slackMs: 8 },
  SMART: { name: 'SMART', label: 'Smart', bufferMs: 24, slackMs: 60, adaptive: true, maxBufferMs: 140 },
  QUALITY: { name: 'QUALITY', label: 'Quality', bufferMs: 220, slackMs: 400 },
};

const STATS_INTERVAL_MS = 1000;
const PING_INTERVAL_MS = 2000;

export class Receiver {
  constructor({ canvas, url, mode = MODES.SMART, onState = () => {}, onEvent = () => {} }) {
    if (!('VideoDecoder' in globalThis)) throw new Error('WebCodecs is unavailable in this browser');
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.mode = MODES[mode.name ?? mode] ?? MODES.SMART;
    this.onState = onState;
    this.onEvent = onEvent;
    this.video = { format: null, codec: null, waitingKeyFrame: true, newestPtsUs: null, announced: null };
    this.audio = { format: null, codec: null, nextAt: 0, bufferedMs: 0, underruns: 0 };
    this.pending = []; // decoded VideoFrames, oldest first
    this.clock = { offsetUs: 0n, rttUs: null };
    this.arrival = { lastUs: null, jitterMs: 0, samples: [] };
    this.counts = { frames: 0, decoded: 0, rendered: 0, droppedLate: 0, droppedNoKey: 0, resyncs: 0, bytes: 0, touch: 0, key: 0, audioPackets: 0 };
    this.received = { firstAtMs: null, lastAtMs: null };
    this.state = { clientId: null, relay: null, session: null, viewArea: null, fps: 0, latencyMs: null, videoFormatAnnounced: false };
    this.started = false;
    this.decoder = null;
    this.audioDecoder = null;
    this.audioContext = null;
    this.fingerPrints = new Map();
    this.wire = new Wire({
      role: 'receiver',
      url,
      onJson: (message) => this.#json(message),
      onBinary: (header, payload) => this.#binary(header, payload),
      onOpen: () => this.#hello(),
      onClose: (event) => this.#event('socket', `closed (${event.code}${event.reason ? ` ${event.reason}` : ''})`),
      onError: (error) => this.#event('wire', error.message),
    });
  }

  start() {
    this.started = true;
    this.wire.connect();
    this.#bindInput();
    this.timers = [
      setInterval(() => this.#stats(), STATS_INTERVAL_MS),
      setInterval(() => this.#ping(), PING_INTERVAL_MS),
    ];
    this.#render();
    return this;
  }

  stop() {
    this.started = false;
    for (const timer of this.timers ?? []) clearInterval(timer);
    clearTimeout(this.renderTimer);
    cancelAnimationFrame(this.frame);
    this.wire.close();
    for (const item of this.pending.splice(0)) item.frame.close();
    closeQuietly(this.decoder);
    closeQuietly(this.audioDecoder);
    this.audioContext?.close?.().catch(() => {});
  }

  setMode(name) {
    this.mode = MODES[name] ?? MODES[name?.name] ?? this.mode;
    this.#event('mode', this.mode.label);
    this.#emit();
    return this.mode;
  }

  requestKeyFrame() {
    this.video.waitingKeyFrame = true;
    return this.wire.json({ type: 'keyframe', screen: 0 });
  }

  displaySettings(patch) {
    const message = { type: 'display-settings', resolution: 'auto', screenWidth: 250, videoCodec: 'auto', ...patch };
    return this.wire.json(message) ? message : null;
  }

  // ---- inbound -------------------------------------------------------------

  #hello() {
    const rect = this.canvas.getBoundingClientRect();
    this.wire.json({
      type: 'hello',
      version: 0,
      token: new URL(this.wire.url).searchParams.get('token') ?? 'mirrorplay',
      decoders: [{ codecString: 'avc1.42E01F', hardware: false }, { codecString: 'avc1.640028', hardware: false }],
      playback: this.mode.name,
      videoCodec: 'AUTO',
      displays: [
        {
          screen: 0,
          width: Math.round((rect.width || this.canvas.width) * (devicePixelRatio || 1)),
          height: Math.round((rect.height || this.canvas.height) * (devicePixelRatio || 1)),
          dpr: devicePixelRatio || 1,
          refreshHz: this.state.refreshHz ?? 60,
          viewport: { width: Math.round(rect.width || this.canvas.width), height: Math.round(rect.height || this.canvas.height) },
          fullscreen: document.fullscreenElement === this.canvas,
          fullscreenPreferred: true,
          safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      ],
      maxTouchContacts: 10,
      audio: ['AAC_LC'],
      microphone: false,
    });
  }

  #json(message) {
    switch (message.type) {
      case 'welcome':
        this.state.clientId = message.clientId;
        this.state.relay = message.relay ?? null;
        this.#event('welcome', `${message.relay?.name ?? 'relay'} ${message.relay?.version ?? ''}`);
        this.#emit();
        break;
      case 'session':
        this.state.session = message.session;
        this.#event('session', `${message.session.phase}${message.session.reason ? ` (${message.session.reason})` : ''}`);
        if (message.session.phase === 'ENDED') this.#flush('session ended', { reset: true });
        this.#emit();
        break;
      case 'video-format':
        return this.#configure(message.format);
      case 'audio-format':
        return this.#configureAudio(message.format);
      case 'view-area':
        this.state.viewArea = message;
        this.#emit();
        break;
      case 'display-settings':
        this.state.displaySettings = message;
        this.#event('display', `${message.resolution} · ${message.videoCodec ?? 'auto'}`);
        this.#emit();
        break;
      case 'pong': {
        // The exchange is the only place the two clocks meet: t0 and t2 are this page's, t1 is the
        // relay's. Everything else on the wire is stated in the relay's time.
        const { rttUs, offsetUs } = clockExchange(message.t0Us, message.t1Us, message.t2Us);
        this.clock.rttUs = Number(rttUs);
        this.clock.offsetUs = offsetUs;
        this.#emit();
        break;
      }
      case 'error':
        this.#event('relay error', `${message.code}: ${message.message}`);
        break;
      default:
        break;
    }
  }

  #binary(header, payload) {
    if (header.kind === Kind.Video) return this.#video(header, payload);
    if (header.kind === Kind.Audio) return this.#audioFrame(header, payload);
    this.#event('wire', `unexpected kind ${header.kind}`);
  }

  #video(header, payload) {
    const key = (header.flags & Flag.Keyframe) === Flag.Keyframe;
    const gap = (header.flags & Flag.Gap) === Flag.Gap;
    this.counts.frames++;
    this.counts.bytes += payload.byteLength;
    const now = Number(clockUs());
    this.received.firstAtMs ??= now / 1000;
    this.#observeArrival(now);
    if (!this.state.videoFormatAnnounced) this.state.videoFormatAnnounced = true;
    // A gap says "flush, this frame starts a fresh decode chain". The frame that carries it is a key
    // frame, so it is the restart point rather than a reason to wait for the next one.
    // The frame that carries a gap is the restart point. Asking the relay for yet another key frame
    // here would make every resync cost one more GOP.
    if (gap) this.#flush(gapReason(key), { wait: !key, askForKeyFrame: !key });
    if (this.video.waitingKeyFrame) {
      if (!key) {
        this.counts.droppedNoKey++;
        return;
      }
      this.video.waitingKeyFrame = false;
      this.#event('resync', 'key frame after a wait');
    }
    if (!this.decoder || this.decoder.state !== 'configured') {
      this.video.waitingKeyFrame = true;
      return;
    }
    const ptsUs = Number(header.ptsUs);
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ptsUs, data: payload }));
      this.video.newestPtsUs = ptsUs;
      if (this.clock.rttUs === null && !this.pingScheduled) {
        this.pingScheduled = true;
        setTimeout(() => this.#ping(), 150); // the first delay figure means nothing before a round trip
      }
    } catch (error) {
      this.counts.resyncs++;
      this.#event('decode', error.message);
      // The decoder itself is fine; the payload was not. Drop the queue and wait for an IDR.
      this.#flush('decode failed');
    }
  }

  #audioFrame(header, payload) {
    if (!this.audioDecoder || this.audioContext?.state === 'closed') return;
    this.counts.audioPackets++;
    try {
      this.audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Number(header.ptsUs), data: payload }));
    } catch (error) {
      this.#event('audio', error.message);
    }
  }

  // ---- decoders ------------------------------------------------------------

  async #configure(format) {
    this.video.format = format;
    this.video.announced = format ? format.codecString : null;
    // Whatever is queued belongs to the old format.
    this.#flush('new video format', { askForKeyFrame: false });
    closeQuietly(this.decoder);
    this.decoder = null;
    if (!format) {
      closeQuietly(this.decoder);
      this.decoder = null;
      return this.#event('video', 'the relay has no video yet');
    }
    const description = fromBase64(format.config);
    const config = {
      codec: format.codecString,
      description,
      optimizeForLatency: this.mode.bufferMs === 0,
      // Without this a Chromium decoder reads the payload as Annex B and finds none.
      ...(format.codec === 'H264' ? { avc: { format: 'avcc' } } : {}),
    };
    let support;
    try {
      support = await VideoDecoder.isConfigSupported(config);
    } catch (error) {
      return this.#event('video', `this browser refused ${format.codecString}: ${error.message}`);
    }
    if (!support.supported) return this.#event('video', `this browser cannot decode ${format.codecString} — try /check`);
    this.decoder = new VideoDecoder({
      output: (frame) => this.#decoded(frame),
      error: (error) => {
        this.counts.resyncs++;
        this.#event('decoder', error.message);
        this.#flush('decoder error', { reset: true });
      },
    });
    this.decoder.configure(support.config ?? config);
    this.requestKeyFrame();
    this.#event('video', `${format.codecString} ${format.width}×${format.height}`);
    this.#emit();
  }

  #decoded(frame) {
    this.counts.decoded++;
    this.pending.push({ frame, ptsUs: frame.timestamp });
    const keep = 2 + Math.ceil(this.#bufferUs() / 10000);
    while (this.pending.length > keep) {
      const discarded = this.pending.shift();
      discarded.frame.close();
      this.counts.droppedLate++;
    }
  }

  #configureAudio(format) {
    this.audio.format = format;
    closeQuietly(this.audioDecoder);
    this.audioDecoder = null;
    if (!format) return;
    if (!('AudioDecoder' in globalThis)) return this.#event('audio', 'no AudioDecoder in this browser');
    try {
      this.audioContext ??= new AudioContext({ latencyHint: 'interactive' });
    } catch (error) {
      return this.#event('audio', `output unavailable: ${error.message}`);
    }
    if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => this.#event('audio', 'browser blocked the audio until you interact'));
    const config = {
      codec: format.codec === 'AAC_LC' ? 'mp4a.40.2' : format.codec === 'OPUS' ? 'opus' : 's16',
      sampleRate: format.sampleRate,
      numberOfChannels: format.channels,
    };
    if (format.config) config.description = fromBase64(format.config);
    this.audioDecoder = new AudioDecoder({
      output: (data) => this.#play(data),
      error: (error) => this.#event('audio', error.message),
    });
    this.audioDecoder.configure(config);
    this.audio.nextAt = this.audioContext.currentTime;
    this.#event('audio', `${format.codec} ${format.sampleRate} Hz ${format.channels} ch`);
  }

  #play(data) {
    const context = this.audioContext;
    if (!context || context.state === 'closed') return data.close();
    const buffer = context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let channel = 0; channel < data.numberOfChannels; channel++) {
      const plane = new Float32Array(data.numberOfFrames);
      // Chromium renamed this option along the way: recent builds want planeNumber, others planeIndex.
      try {
        data.copyTo(plane, { planeNumber: channel, format: 'f32-planar' });
      } catch {
        data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
      }
      buffer.copyToChannel(plane, channel);
    }
    data.close();
    if (context.currentTime > this.audio.nextAt + buffer.duration) {
      this.audio.underruns++;
      this.audio.nextAt = context.currentTime; // the browser already drained what we queued
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(this.audio.nextAt);
    this.audio.nextAt += buffer.duration;
    this.audio.bufferedMs = Math.max(0, (this.audio.nextAt - context.currentTime) * 1000);
  }

  // ---- display -------------------------------------------------------------

  // rAF is the right clock while the page is on screen. Some browsers throttle a rAF-heavy page that
  // is not focused at all, which would look exactly like a stalled decoder, so fall back to a timer.
  #render = () => {
    if (!this.started) return;
    if (document.hidden) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.renderTimer = setTimeout(this.#render, 33);
    } else {
      clearTimeout(this.renderTimer);
      this.frame = requestAnimationFrame(this.#render);
    }
    const queue = this.pending;
    if (!queue.length) return;
    const newest = this.video.newestPtsUs ?? queue[queue.length - 1].ptsUs;
    const bufferUs = this.#bufferUs();
    let index = 0;
    while (index + 1 < queue.length && newest - queue[index + 1].ptsUs >= bufferUs) index++;
    for (let i = 0; i < index; i++) {
      queue.shift().frame.close();
      this.counts.droppedLate++;
    }
    const chosen = queue.shift();
    // A frame worth showing never arrives too late for its own slot in Speed mode, and in the
    // buffering modes an old frame is still worth painting rather than leaving the last one up.
    const ageUs = newest - chosen.ptsUs;
    if (ageUs > (this.mode.slackMs + this.mode.bufferMs) * 1000 && this.mode === MODES.SPEED) {
      chosen.frame.close();
      this.counts.droppedLate++;
      return;
    }
    this.#paint(chosen.frame);
    const presentedUs = Number(clockUs());
    chosen.frame.close();
    this.counts.rendered++;
    this.state.latencyMs = (presentedUs - chosen.ptsUs - Number(this.clock.offsetUs)) / 1000;
  };

  #paint(frame) {
    const canvas = this.canvas;
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    const area = placement(canvas.width, canvas.height, width, height);
    this.context.fillStyle = '#000';
    this.context.fillRect(0, 0, canvas.width, canvas.height);
    this.context.drawImage(frame, area.x, area.y, area.width, area.height);
  }

  #bufferUs() {
    if (!this.mode.adaptive) return this.mode.bufferMs * 1000;
    // Smart mode: two arrival gaps of headroom, never below the mode's floor, never above its cap.
    const headroom = Math.round(this.arrival.jitterMs * 2 + (this.state.refreshHz ? 1000 / this.state.refreshHz : 17) * 1000);
    return Math.min(this.mode.maxBufferMs, Math.max(this.mode.bufferMs, headroom / 1000)) * 1000;
  }

  #observeArrival(nowUs) {
    if (this.arrival.lastUs) {
      const gapMs = (nowUs - this.arrival.lastUs) / 1000;
      if (gapMs > 0 && gapMs < 1000) {
        this.arrival.samples.push(gapMs);
        if (this.arrival.samples.length > 24) this.arrival.samples.shift();
        const sorted = [...this.arrival.samples].sort((a, b) => a - b);
        const p10 = sorted[Math.floor(sorted.length * 0.1)];
        const p90 = sorted[Math.floor(sorted.length * 0.9)];
        this.arrival.gapMs = p10;
        this.arrival.jitterMs = 0.75 * this.arrival.jitterMs + 0.25 * Math.max(0, p90 - p10);
      }
    }
    this.arrival.lastUs = nowUs;
  }

  /**
   * Drop what is queued and decide what the decoder keeps.
   *
   * A gap is a restart point, not a broken decoder: the picture stays configured, because a
   * VideoDecoder that has been reset cannot take a single frame again until it is configured a
   * second time. Only a decoder that actually misbehaved gets reset.
   */
  #flush(reason, { reset = false, askForKeyFrame = true, wait = true } = {}) {
    this.video.waitingKeyFrame = wait;
    for (const item of this.pending.splice(0)) item.frame.close();
    if (reset) {
      try {
        this.decoder?.reset?.();
      } catch {
        /* a closed decoder needs no reset */
      }
    }
    if (askForKeyFrame && this.decoder) this.requestKeyFrame();
    this.#event('flush', `${reason}${reset ? ' (decoder reset)' : ''}`);
  }

  // ---- outbound input ------------------------------------------------------

  #bindInput() {
    this.canvas.style.touchAction = 'none';
    const picture = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const format = this.video.format ?? { width: rect.width, height: rect.height };
      const area = placement(rect.width, rect.height, format.width, format.height);
      const x = (event.clientX - rect.left - area.x) / area.width;
      const y = (event.clientY - rect.top - area.y) / area.height;
      return { x: clamp01(x), y: clamp01(y), inPicture: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
    };
    const send = () => {
      const contacts = [...this.fingerPrints.values()];
      if (!contacts.length) return;
      this.counts.touch++;
      this.wire.binary(Kind.Touch, encodeTouch(contacts.slice(0, 10)));
      this.#event('touch', contacts.map((c) => `${c.x.toFixed(3)},${c.y.toFixed(3)}${c.pressed ? '' : '↑'}`).join(' '));
    };
    this.canvas.addEventListener('pointerdown', (event) => {
      const spot = picture(event);
      this.fingerPrints.set(event.pointerId, { id: this.fingerPrints.size % 10, pressed: true, x: spot.x, y: spot.y });
      // Capture is a convenience for dragging, not part of the report. An injected pointer event has
      // no active pointer to capture and throws, and that must not cost the touch its own message.
      try {
        this.canvas.setPointerCapture?.(event.pointerId);
      } catch {
        /* not a trusted pointer; the coordinates still go out below */
      }
      send();
    });
    this.canvas.addEventListener('pointermove', (event) => {
      const contact = this.fingerPrints.get(event.pointerId);
      if (!contact) return;
      Object.assign(contact, picture(event), { pressed: true });
      send();
      if (event.preventDefault) event.preventDefault();
    });
    const lifted = (event) => {
      const contact = this.fingerPrints.get(event.pointerId);
      if (!contact) return;
      contact.pressed = false;
      send();
      this.fingerPrints.delete(event.pointerId);
      this.wire.binary(Kind.Touch, encodeTouch([])); // the empty set says "nothing is touching now"
    };
    this.canvas.addEventListener('pointerup', lifted);
    this.canvas.addEventListener('pointercancel', lifted);
    const keys = { Escape: 1, Enter: 2, Space: 7, ArrowLeft: 3, ArrowRight: 4, ArrowUp: 5, ArrowDown: 6, Home: 0 };
    const key = (event, down) => {
      const code = keys[event.key];
      if (code === undefined || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      this.counts.key++;
      this.wire.binary(Kind.Key, encodeKey({ code, down }));
    };
    this.keydown = (event) => key(event, true);
    this.keyup = (event) => key(event, false);
    addEventListener('keydown', this.keydown);
    addEventListener('keyup', this.keyup);
  }

  #ping() {
    if (!this.wire.ready) return;
    this.wire.json({ type: 'ping', t0Us: String(clockUs()) });
  }

  /** The first delay figure means nothing before one round trip, so ask for it as soon as media starts. */
  #pingSoon() {
    setTimeout(() => this.#ping(), 150);
  }

  #stats() {
    const now = Number(clockUs());
    const elapsedMs = this.received.lastAtMs ? now / 1000 - this.received.lastAtMs : 0;
    this.received.lastAtMs = now / 1000;
    const renderedSince = this.counts.rendered - (this.lastRendered ?? 0);
    this.lastRendered = this.counts.rendered;
    const fps = elapsedMs ? Math.round((renderedSince * 1000) / elapsedMs) : 0;
    this.state.fps = fps;
    this.wire.json({
      type: 'stats',
      screen: 0,
      decodeMs: null,
      decodeQueue: this.decoder?.decodeQueueSize ?? 0,
      dropped: this.counts.droppedLate + this.counts.droppedNoKey,
      rendered: this.counts.rendered,
      decodedLatencyMs: this.state.latencyMs,
      renderedLatencyMs: this.state.latencyMs,
      clockOffsetUs: String(this.clock.offsetUs),
      rttUs: this.clock.rttUs === null ? null : String(this.clock.rttUs),
      renderedFps: fps,
      videoFramesPerSecond: Math.round(((this.counts.frames - (this.lastFrames ?? 0)) * 1000) / (elapsedMs || 1000)),
      wsBytesPerSecond: Math.round(((this.counts.bytes - (this.lastBytes ?? 0)) * 8) / (elapsedMs || 1000)),
      renderLateFrames: this.counts.droppedLate,
      renderSupersededFrames: this.counts.droppedNoKey,
      decoderResets: this.counts.resyncs,
      audioBufferedMs: this.audio.bufferedMs || null,
      audioUnderruns: this.audio.underruns,
    });
    this.lastFrames = this.counts.frames;
    this.lastBytes = this.counts.bytes;
    this.#emit();
  }

  #emit() {
    this.onState({
      ...this.state,
      counts: { ...this.counts },
      mode: this.mode,
      rttUs: this.clock.rttUs,
      clockOffsetUs: String(this.clock.offsetUs),
      jitterMs: this.arrival.jitterMs,
      jitterGapMs: this.arrival.gapMs,
      bufferUs: this.#bufferUs(),
      audio: this.audio.format,
      video: this.video.format,
    });
  }

  #event(type, text) {
    this.onEvent({ type, text });
    this.#emit();
  }
}

function gapReason(key) {
  return key ? 'gap, then a key frame' : 'gap in the middle of a GOP';
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

function clockUs() {
  return BigInt(Math.round(performance.timeOrigin * 1000 + performance.now() * 1000));
}

function closeQuietly(decoder) {
  try {
    if (decoder?.state === 'configured') decoder.close();
  } catch {
    /* an encoder-side reset is not this page's problem */
  }
}

/** Letterbox: the largest copy of the picture that fits, centred. */
export function placement(canvasWidth, canvasHeight, pictureWidth, pictureHeight) {
  const scale = Math.min(canvasWidth / pictureWidth, canvasHeight / pictureHeight);
  const width = Math.round(pictureWidth * scale);
  const height = Math.round(pictureHeight * scale);
  return { x: Math.round((canvasWidth - width) / 2), y: Math.round((canvasHeight - height) / 2), width, height };
}
