// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// What a device does in this build: capture something, encode it to H.264 with WebCodecs, and hand
// it to the relay. It stands where a phone would stand. Touch and keys that come back from a head
// unit are drawn into the picture before it is encoded, so a tap on the car screen shows up — the
// loop closes in the pixels, which is the only way to prove the input path without a real iPhone.

import { Kind, Flag, decodeTouch, decodeKey } from '/src/protocol/binary.js';
import { AvcConfig } from '/src/media/avc.js';
import { annexBToAvcc } from '/src/media/nal.js';
import { Wire } from '/web/wire.js';

/**
 * Encoder candidates, best-supported first. Chromium's software H.264 encoder says 'unsupported' to
 * baseline at 720p while accepting High at level 4.0, so the device page asks instead of assuming;
 * afterwards the truth comes from the parameter sets the encoder actually produced.
 */
export const ENCODER_CANDIDATES = ['avc1.640034', 'avc1.640028', 'avc1.4D0034', 'avc1.4D0032', 'avc1.42E01E', 'avc1.42001E'];

export class DeviceSender {
  constructor({
    video,
    canvas,
    url = Wire.urlFor('/input-wire'),
    source = 'screen',
    fps = 30,
    bitrate = 3_000_000,
    deviceId = null,
    onEvent = () => {},
    onStats = () => {},
  }) {
    if (!('VideoEncoder' in globalThis) || !('VideoFrame' in globalThis)) throw new Error('WebCodecs is unavailable in this browser');
    this.video = video;
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.url = url;
    this.source = source;
    this.fps = fps;
    this.bitrate = bitrate;
    this.deviceId = deviceId;
    this.onEvent = onEvent;
    this.onStats = onStats;
    this.contacts = new Map();
    this.bytes = 0;
    this.sinceIdr = 0;
    this.packets = 0;
    this.keyPackets = 0;
    this.forceKeyFrame = true;
    this.paused = false;
    this.running = false;
    this.startedAtUs = 0;
    this.wire = new Wire({
      url,
      role: 'input',
      onJson: (message) => this.#json(message),
      onBinary: (header, payload) => {
        // A last-resort breadcrumb: when a head unit's tap fails to appear here, the relay's own log
        // says whether the envelope left, and this says whether it arrived.
        window.__binary = [...(window.__binary ?? []), { kind: header.kind, bytes: payload.byteLength, at: Date.now() }].slice(-12);
        return this.#inputHeader(header, payload);
      },
      onOpen: () => this.#announce(),
      onClose: (event) => this.onEvent({ type: 'socket', text: `closed (${event.code})` }),
      onError: (error) => this.onEvent({ type: 'error', text: error.message }),
    });
  }

  connect() {
    this.wire.connect();
    return this;
  }

  #announce() {
    this.wire.json({
      type: 'hello',
      version: 0,
      token: new URL(this.url).searchParams.get('token') ?? 'mirrorplay',
      decoders: [],
      displays: [{ screen: 0, width: this.canvas.width || 1280, height: this.canvas.height || 720, dpr: devicePixelRatio || 1, refreshHz: this.fps, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }],
      maxTouchContacts: 10,
      audio: [],
      microphone: false,
      source: `mirrorplay device (${this.source})`,
    });
  }

  #json(message) {
    switch (message.type) {
      case 'start':
        return this.start().catch((error) => this.onEvent({ type: 'error', text: `capture: ${error.name} ${error.message}` }));
      case 'keyframe':
        this.forceKeyFrame = true; // a browser encoder can honour this; a command-line one cannot
        return this.onEvent({ type: 'encoder', text: 'key frame forced on the next picture' });
      case 'pause':
        this.paused = message.paused;
        return this.onEvent({ type: 'encoder', text: this.paused ? 'paused by the head unit' : 'resumed' });
      case 'display-settings':
        if (message.frameRate?.startsWith('FPS_')) this.fps = Number(message.frameRate.slice(4));
        void this.configure();
        return this.onEvent({ type: 'encoder', text: `head unit wants ${message.resolution} (${this.fps}fps)` });
      case 'restart':
        return this.restart();
      default:
        return this.onEvent({ type: 'socket', text: message.type });
    }
  }

  #inputHeader(header, payload) {
    if (header.kind === Kind.Touch) {
      const contacts = decodeTouch(payload).filter((c) => c.pressed);
      this.contacts = new Map(contacts.map((c, i) => [c.id, { ...c, id: c.id }]));
      this.onEvent({ type: 'touch', text: contacts.length ? contacts.map((c) => `#${c.id} ${c.x.toFixed(3)},${c.y.toFixed(3)}`).join(' ') : 'all fingers lifted' });
      return;
    }
    if (header.kind === Kind.Key) {
      this.lastKey = decodeKey(payload);
      this.onEvent({ type: 'key', text: `code ${this.lastKey.code} ${this.lastKey.down ? 'down' : 'up'}` });
    }
  }

  async start({ source = this.source, deviceId = this.deviceId } = {}) {
    this.source = source;
    const stream =
      source === 'camera'
        ? await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: this.fps } }, audio: false })
        : await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: this.fps } }, audio: false });
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    const settings = stream.getVideoTracks()[0].getSettings();
    this.canvas.width = Math.round(settings.width ?? this.video.videoWidth ?? 1280);
    this.canvas.height = Math.round(settings.height ?? this.video.videoHeight ?? 720);
    this.fps = Math.round(settings.frameRate ?? this.fps);
    this.running = true;
    await this.configure();
    this.startedAtUs = performance.now() * 1000;
    this.onEvent({ type: 'capture', text: `${this.source} ${this.canvas.width}×${this.canvas.height}@${this.fps}` });
    this.#loop();
    return stream;
  }

  static async pickCodec(width, height, bitrate) {
    for (const codec of ENCODER_CANDIDATES) {
      const probe = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, avc: { format: 'annexb' } }).catch(() => ({ supported: false }));
      if (probe.supported) return codec;
    }
    return null;
  }

  async configure() {
    if (!this.running) return;
    // A live encoder is not drained and refilled: a reconfigure drops what was still queued, which is
    // right when the picture it described no longer matches the size the head unit asked for.
    const previous = this.encoder;
    this.formatAnnounced = false; // a new encoder means new parameter sets
    const codec = await DeviceSender.pickCodec(this.canvas.width, this.canvas.height, this.bitrate);
    if (!codec) {
      this.running = false;
      this.onEvent({ type: 'error', text: 'this browser has no H.264 encoder the relay can use' });
      return;
    }
    this.codec = codec;
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.#encode(chunk, meta),
      error: (error) => {
        this.running = false;
        this.onEvent({ type: 'error', text: `encoder: ${error.message}` });
      },
    });
    this.encoder.configure({
      codec,
      width: this.canvas.width,
      height: this.canvas.height,
      frameRate: this.fps,
      bitrate: this.bitrate,
      latencyMode: 'realtime',
      // Chromium's H.264 encoder only writes Annex B, so the bytes are reframed below before they
      // reach the socket: the wire payload stays AVCC for every source, browser or ffmpeg.
      avc: { format: 'annexb' }, // reframed to AVCC on the way out, see #encode
    });
    this.gapNext = true;
    this.forceKeyFrame = true;
    this.gopFrames = Math.max(1, Math.round(this.fps * 2));
    this.sinceIdr = this.gopFrames; // the first picture out is an IDR, and it carries the format
    if (previous && previous.state !== 'closed') {
      try {
        previous.close();
      } catch {
        /* an encoder that already faulted needs no close */
      }
    }
  }

  /**
   * A browser encoder hands back complete pictures, so the framing work happens here: the Annex B
   * bytes Chromium writes are reframed as AVCC, which is what the wire carries for every source.
   *
   * The format announcement has to come before any frame means something to a receiver. Chromium
   * gives no description record when it is set to Annex B, so the parameter sets the IDR carries in
   * band are the authority — precisely why the projection model keeps them in band.
   */
  #encode(chunk, meta) {
    const annexb = new Uint8Array(chunk.byteLength);
    chunk.copyTo(annexb);
    const avcc = annexBToAvcc(annexb);
    const key = chunk.type === 'key';
    if (!this.formatAnnounced) {
      if (!key) return; // a delta before the first IDR would be dropped by the relay anyway
      const description = meta?.decoderConfig?.description;
      let avcC;
      try {
        avcC = description ? new Uint8Array(description) : AvcConfig.fromAnnexB(annexb);
      } catch (error) {
        this.onEvent({ type: 'error', text: `no parameter sets in the encoder output: ${error.message}` });
        return;
      }
      const format = AvcConfig.wireFormat(avcC, { fpsHint: this.fps });
      this.formatAnnounced = true;
      this.wire.json({ type: 'video-format', screen: 0, format });
      this.onEvent({ type: 'encoder', text: `announced ${format.codecString} ${format.width}×${format.height}` });
    }
    const gap = this.gapNext;
    this.gapNext = false;
    this.wire.binary(Kind.Video, avcc, {
      flags: (key ? Flag.Keyframe : 0) | (gap ? Flag.Gap : 0),
      ptsUs: chunk.timestamp,
    });
    this.packets++;
    this.bytes += avcc.byteLength;
    if (key) this.keyPackets++;
    this.onStats({
      packets: this.packets,
      keyPackets: this.keyPackets,
      kibibytes: Math.round(this.bytes / 1024),
      queue: this.encoder?.encodeQueueSize ?? 0,
      contacts: this.contacts.size,
      codec: this.codec,
      formatAnnounced: this.formatAnnounced,
      running: this.running,
      size: `${this.canvas.width}×${this.canvas.height}@${this.fps}`,
    });
  }

  #loop() {
    if (!this.running) return;
    let lastEncodeUs = 0;
    const pump = () => {
      if (!this.running) return;
      requestAnimationFrame(pump);
      const nowUs = performance.now() * 1000;
      const periodUs = 1e6 / this.fps;
      if (this.paused || this.video.readyState < 2 || this.encoder?.state !== 'configured') return;
      // rAF runs at the display rate; the encoder is asked at the capture rate.
      if (nowUs - lastEncodeUs < periodUs - periodUs * 0.1) return;
      lastEncodeUs = nowUs;
      this.#compose();
      const frame = new VideoFrame(this.canvas, { timestamp: Math.round(nowUs - this.startedAtUs) });
      // A head unit can only join, or resynchronise, on a key frame. `keyFrame: true` is a request to
      // the encoder rather than a promise, so one is also asked for on a clock.
      const due = this.sinceIdr >= this.gopFrames;
      this.encoder.encode(frame, this.forceKeyFrame || due ? { keyFrame: true } : undefined);
      if (this.forceKeyFrame || due) this.sinceIdr = 0;
      else this.sinceIdr++;
      this.forceKeyFrame = false;
      frame.close();
    };
    requestAnimationFrame(pump);
  }

  /** The picture the head unit gets: the capture, plus whatever the head unit itself just did. */
  #compose() {
    const { context, canvas } = this;
    context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    for (const contact of this.contacts.values()) {
      const x = contact.x * canvas.width;
      const y = contact.y * canvas.height;
      // The relay only reports fingers that are down; a lifted finger arrives as its absence.
      context.beginPath();
      context.lineWidth = 6;
      context.strokeStyle = '#4fd1a5';
      context.arc(x, y, 26, 0, Math.PI * 2);
      context.stroke();
      context.font = '20px ui-monospace, monospace';
      context.fillStyle = '#ffffff';
      context.fillText(String(contact.id), x + 30, y - 20);
    }
    if (this.lastKey?.down) {
      context.fillStyle = '#4fd1a5';
      context.font = '28px ui-monospace, monospace';
      context.fillText(`key ${this.lastKey.code}`, 16, canvas.height - 16);
    }
  }

  async restart() {
    this.running = false;
    this.stopTracks();
    this.formatAnnounced = false;
    this.packets = 0;
    await new Promise((ok) => setTimeout(ok, 60));
    this.running = true;
    return this.start();
  }

  stopTracks() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  stop() {
    this.running = false;
    this.stopTracks();
    this.encoder?.flush().catch(() => {});
    this.encoder?.close?.();
    this.wire.close('device stopped');
  }
}


