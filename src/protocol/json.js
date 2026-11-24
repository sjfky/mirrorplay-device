// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// JSON control messages of the projection wire protocol. Text frames carry these, binary frames
// carry the envelope in ./binary.js. Field names, value ranges and message directions match the
// protocol the OpenXPlay projection model uses, so a receiver written against one speaks the same
// language as the other.
//
// 64-bit values are decimal strings (i64) because JSON numbers lose precision above 2^53.

export const PROTOCOL_VERSION = 0;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// Directions. A receiver is a head unit's browser; an input is whatever feeds the projection (a
// device's encoder in a browser, or, on the relay's own side, the ffmpeg source). Both speak this
// one protocol, which is why the model keeps inputs and outputs apart: adding an output never
// changes an input.
// Which endpoint may send which message. The names read as the trip a message makes, because a
// head unit and a device are both "clients" of the relay in the socket sense and quite different
// in the protocol sense.
export const DIRECTIONS = {
  // head unit -> relay
  'client-to-relay': ['hello', 'keyframe', 'pause', 'display-settings', 'fullscreen-exit', 'restart', 'stats', 'receiver-info', 'ping', 'pong'],
  // relay -> head unit
  'relay-to-client': ['welcome', 'session', 'video-format', 'audio-format', 'view-area', 'display-settings', 'host-ui', 'ping', 'pong', 'error'],
  // device -> relay
  'device-to-relay': ['hello', 'video-format', 'audio-format', 'restart', 'ping', 'pong', 'error'],
  // relay -> device
  'relay-to-device': ['welcome', 'start', 'keyframe', 'view', 'display-settings', 'pause', 'session', 'ping', 'pong', 'error'],
};

const FRAME_RATES = ['AUTO', 'FPS_30', 'FPS_35', 'FPS_40', 'FPS_45', 'FPS_50', 'FPS_55', 'FPS_60'];
const AUDIO_CODECS = ['AAC_LC', 'OPUS', 'PCM_S16LE'];
const ROLES = ['MEDIA', 'ALERT', 'VOICE', 'TELEPHONY', 'OTHER'];

const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x) => typeof x === 'string';
const nonempty = (x) => str(x) && x.length > 0;
// Relay and receiver names end up in a page title, so they stay short and free of control codes.
const boundedText = (x) => nonempty(x) && x.length <= 128 && !/[\u0000-\u001f\u007f]/.test(x);
const bool = (x) => typeof x === 'boolean';
const int = (x) => Number.isInteger(x);
const nat = (x) => int(x) && x >= 0;
const pos = (x) => int(x) && x > 0;
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const oneOf = (...v) => (x) => v.includes(x);
const opt = (check) => (x) => x === undefined || check(x);
const nul = (check) => (x) => x === null || check(x);
const list = (check) => (x) => Array.isArray(x) && x.every(check);
const base64 = (x) => str(x) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x) && x.length > 0;
const i64 = (x) => {
  if (!str(x) || !/^-?(0|[1-9][0-9]*)$/.test(x) || x.length > 21) return false;
  const n = BigInt(x);
  return n >= -(1n << 63n) && n < 1n << 63n;
};
const shape = (fields) => (x) =>
  isObj(x) && Object.keys(x).every((k) => Object.hasOwn(fields, k)) && Object.entries(fields).every(([k, check]) => check(x[k]));

const isDiagnostic = (value) =>
  value === null || (typeof value === 'string' && value.length <= 64) || (typeof value === 'number' && Number.isFinite(value));

const SESSION = shape({ id: i64, phase: oneOf('CONNECTING', 'ACTIVE', 'RECONNECTING', 'ENDED'), reason: opt(str) });
const SAFE_AREA = shape({ top: nat, right: nat, bottom: nat, left: nat });
const DISPLAY = shape({
  screen: (x) => nat(x) && x <= 255,
  width: pos,
  height: pos,
  dpr: num,
  refreshHz: num,
  frameRate: opt(oneOf(...FRAME_RATES)),
  sustainedFps: opt(num),
  viewport: opt(shape({ width: pos, height: pos })),
  fullscreen: opt(bool),
  fullscreenPreferred: opt(bool),
  safeArea: SAFE_AREA,
});

const STATS_FIELDS = {
  type: oneOf('stats'),
  screen: (x) => nat(x) && x <= 255,
  decodeMs: nul(num),
  decodeQueue: nat,
  dropped: nat,
  rendered: nat,
  decodedLatencyMs: nul(num),
  renderedLatencyMs: nul(num),
  clockOffsetUs: nul(i64),
  rttUs: nul(i64),
  session: opt((x) => i64(x) || (int(x) && Number.isSafeInteger(x))),
  videoFramesPerSecond: opt(num),
  renderedFps: opt(num),
  renderLateFrames: opt(nat),
  renderSupersededFrames: opt(nat),
  decoderErrors: opt(nat),
  wsBytesPerSecond: opt(num),
  audioBufferedMs: opt(nul(num)),
  audioUnderruns: opt(nat)
};

const CHECKS = {
  hello: shape({
    type: oneOf('hello'),
    version: oneOf(0),
    token: str,
    decoders: list(shape({ codecString: (x) => str(x) && x.length > 0, hardware: bool })),
    playback: opt(oneOf('SMART', 'QUALITY', 'SPEED')),
    videoCodec: opt(oneOf('AUTO', 'H264')),
    displays: list(DISPLAY),
    maxTouchContacts: (x) => nat(x) && x <= 10,
    audio: list(oneOf(...AUDIO_CODECS)),
    microphone: bool,
    // An input names itself so the relay can show which device is feeding the projection.
    source: opt((x) => str(x) && x.length <= 64),
  }),
  welcome: shape({
    type: oneOf('welcome'),
    version: oneOf(0),
    clientId: (x) => str(x) && x.length > 0,
    session: SESSION,
    receiverBuild: opt(boundedText),
    sourceUrl: (x) => {
      if (!str(x)) return false;
      try {
        const u = new URL(x);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },
    attribution: nonempty,
    projectUrl: (x) => {
      if (!str(x)) return false;
      try {
        const u = new URL(x);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },
    relay: opt(shape({ name: boundedText, version: boundedText })),
    features: opt(list((x) => str(x) && x.length > 0)),
  }),
  session: shape({ type: oneOf('session'), session: SESSION }),
  'video-format': shape({
    type: oneOf('video-format'),
    screen: (x) => nat(x) && x <= 255,
    format: nul(shape({
      codec: oneOf('H264', 'H265'),
      codecString: (x) => str(x) && x.length > 0,
      config: base64,
      width: pos,
      height: pos,
      fpsHint: opt(num),
    })),
  }),
  'audio-format': shape({
    type: oneOf('audio-format'),
    stream: (x) => nat(x) && x <= 255,
    format: nul(shape({
      role: oneOf(...ROLES),
      codec: oneOf(...AUDIO_CODECS),
      sampleRate: pos,
      channels: pos,
      config: opt(base64),
    })),
  }),
  'view-area': shape({ type: oneOf('view-area'), x: nat, y: nat, width: pos, height: pos, canvasWidth: pos, canvasHeight: pos }),
  'display-settings': shape({
    type: oneOf('display-settings'),
    resolution: oneOf('auto', 'native', '1080p', '720p', 'screen'),
    screenWidth: oneOf(125, 200, 250, 300),
    videoCodec: opt(oneOf('auto', 'h265', 'h264')),
    frameRate: opt(oneOf(...FRAME_RATES)),
  }),
  'fullscreen-exit': shape({ type: oneOf('fullscreen-exit'), hiddenMs: nul(num), display: DISPLAY, autoRestore: opt(oneOf('restored', 'denied', 'off')) }),
  keyframe: shape({ type: oneOf('keyframe'), screen: (x) => nat(x) && x <= 255 }),
  pause: shape({ type: oneOf('pause'), screen: (x) => nat(x) && x <= 255, paused: bool }),
  restart: shape({ type: oneOf('restart') }),
  'host-ui': shape({ type: oneOf('host-ui') }),
  start: shape({
    type: oneOf('start'),
    videoFormat: opt(nul(shape({ codec: oneOf('H264', 'H265'), codecString: (x) => str(x) && x.length > 0, config: base64, width: pos, height: pos, fpsHint: opt(num) }))),
    audioFormat: opt(nul(shape({ role: oneOf(...ROLES), codec: oneOf(...AUDIO_CODECS), sampleRate: pos, channels: pos, config: opt(base64) }))),
    scene: opt(str),
  }),
  view: shape({
    type: oneOf('view'),
    displays: list(DISPLAY),
    viewArea: opt(shape({ x: nat, y: nat, width: pos, height: pos, canvasWidth: pos, canvasHeight: pos })),
    videoCodec: opt(oneOf('AUTO', 'H264')),
  }),
  ping: shape({ type: oneOf('ping'), t0Us: i64 }),
  pong: shape({ type: oneOf('pong'), t0Us: i64, t1Us: i64, t2Us: i64 }),
  // Statistics are a base shape plus whatever a browser wants to add. The base fields keep the same
  // meaning on every receiver; the extras are diagnostics, and numbers and strings only, so a page
  // cannot smuggle an object into the relay's state by way of a stats message.
  stats: (x) => {
    if (!isObj(x)) return false;
    const base = Object.fromEntries(Object.entries(x).filter(([key]) => Object.hasOwn(STATS_FIELDS, key)));
    if (!shape(STATS_FIELDS)(base)) return false;
    return Object.entries(x).every(([key, value]) => Object.hasOwn(STATS_FIELDS, key) || isDiagnostic(value));
  },
  'receiver-info': (x) => isObj(x) && str(x.type) && new TextEncoder().encode(JSON.stringify(x)).length <= 65536,
  'mic': shape({
    type: oneOf('mic'),
    stream: (x) => nat(x) && x <= 255,
    request: nul(shape({ codec: oneOf(...AUDIO_CODECS), sampleRate: pos, channels: pos, frameMs: num })),
  }),
  error: shape({ type: oneOf('error'), code: (x) => str(x) && x.length > 0, message: str }),
};

/** Parse one control message. `direction` is 'client' (receiver → relay) or 'relay'. */
export function parseMessage(input, direction) {
  let x = input;
  if (typeof input === 'string') {
    try {
      x = JSON.parse(input);
    } catch {
      throw new ProtocolError('a control message must be valid JSON');
    }
  }
  // Shape first, direction second: a message that is malformed is worth reporting as such even if
  // it would also have been out of place on this socket.
  if (!isObj(x) || !str(x.type) || !CHECKS[x.type]) throw new ProtocolError(`unknown message type ${x.type ?? '?'}`);
  if (!CHECKS[x.type](x)) throw new ProtocolError(`malformed ${x.type} message`);
  if (direction === undefined) return x;
  if (!Object.hasOwn(DIRECTIONS, direction)) throw new ProtocolError(`unknown direction ${direction}`);
  if (!DIRECTIONS[direction].includes(x.type)) throw new ProtocolError(`${x.type} is not a ${direction} message`);
  return x;
}

export function encodeMessage(message) {
  if (!isObj(message) || !CHECKS[message.type]) throw new ProtocolError('cannot encode an unknown message');
  if (!CHECKS[message.type](message)) throw new ProtocolError(`refusing to emit a malformed ${message.type} message`);
  return JSON.stringify(message);
}


/** base64 for the `config` fields (avcC, AudioSpecificConfig, …). */
export { toBase64, fromBase64 } from '../util/base64.js';
