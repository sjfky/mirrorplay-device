// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The relay process. One HTTP server serves the pages and the state endpoints; two WebSocket paths
// carry the projection: `/wire` for a head unit watching, `/input-wire` for a device feeding. The
// relay owns the session model, and the pages are plain files, so a head unit only has to open a URL
// — nothing is installed on it.
//
// Sources:
//   --source ffmpeg   synthetic scene (or a looped file with --input). Default.
//   --source input    wait for a device tab to start streaming.
//   --source none     attach nothing: receivers sit in startup/waiting-media.
//
// One input feeds a projection at a time, so a device that connects replaces the synthetic source,
// and when the last device goes the source comes back. Dead peers are found by WebSocket ping/pong,
// because a car that loses power does not close its sockets.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Clock } from '../core/clock.js';
import { Projection, Phase, STARTUP_REASONS } from '../core/hub.js';
import { InputLink, LocalSource } from './links.js';
import { FfmpegSource, SCENE_ORDER } from '../sources/ffmpeg.js';
import { Kind, Flag } from '../protocol/binary.js';
import { encodeMessage } from '../protocol/json.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..'); // src/, which is also where the pages live
const WEB = join(SRC, 'web');
const PROJECT = join(SRC, '..');

export const VERSION = '0.1.0';

const PAGES = {
  '/': 'index.html',
  '/receiver': 'receiver.html',
  '/input': 'input.html',
  '/admin': 'admin.html',
  '/check': 'check.html',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const ROLE_BY_PATH = { '/wire': 'receiver', '/input-wire': 'input' };

/**
 * The two surfaces a phone can install to its home screen. Each gets its own manifest because they
 * are different jobs with different names: one watches the projection, one sends it.
 */
const INSTALLABLE = {
  '/receiver/manifest.webmanifest': {
    page: '/receiver',
    name: 'mirrorplay · head unit',
    short_name: 'head unit',
    description: 'Watches the projection in this browser and sends its own touches back to the relay.',
    theme: '#0a0d11',
  },
  '/input/manifest.webmanifest': {
    page: '/input',
    name: 'mirrorplay · device',
    short_name: 'device',
    description: 'Sends this phone’s own camera or screen into the projection, and draws the head unit’s taps.',
    theme: '#0a0d11',
  },
};

// How often the relay asks a peer whether it is still there, and how long it may stay quiet before
// that counts as gone. The grace period is deliberately longer than one interval: two passes in the
// same instant must not kill a peer that simply has not had the chance to answer yet.
const HEARTBEAT_MS = 5000;
const PONG_GRACE_MS = 2 * HEARTBEAT_MS;
const TRACE_LIMIT = 400;

export class Relay {
  constructor({
    port = 3000,
    host = '0.0.0.0',
    token = 'mirrorplay',
    source = 'ffmpeg',
    scene = 'testsrc2',
    input = null,
    width = 1280,
    height = 720,
    fps = 30,
    bitrate = '3M',
    gopSeconds = 1,
    audio = true,
    ffmpeg = null,
    backpressureBytes = 4 * 1024 * 1024,
    verbose = false,
  } = {}) {
    this.options = {
      port,
      host,
      token,
      source,
      scene: SCENE_ORDER.includes(scene) ? scene : 'testsrc2',
      input,
      width,
      height,
      fps,
      bitrate,
      gopSeconds,
      audio,
      ffmpeg,
    };
    this.verbose = verbose;
    this.clock = new Clock();
    this.trace = [];
    this.projection = new Projection({ clock: this.clock, sessionId: Number(process.pid) % 100000, backpressureBytes });
    this.inputLinks = new Set();
    this.localSource = null;
    this.sample = null;
    this.connections = 0;
    this.announcedSample = false;
    this.server = createServer((req, res) => this.#http(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.#watchProjection();
    this.heartbeat = setInterval(() => this.keepaliveOnce(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  async listen() {
    await new Promise((ok, fail) => {
      this.server.once('error', fail);
      this.server.listen(this.options.port, this.options.host, ok);
    });
    this.server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    if (this.options.source === 'ffmpeg') this.#startLocalSource();
    else this.projection.setPhase(Phase.Reconnecting, this.options.source === 'input' ? STARTUP_REASONS.joiningNetwork : STARTUP_REASONS.waitingMedia);
    this.log('relay', `listening on ${this.origin()} (token ${this.options.token})`);
    return this;
  }

  origin() {
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.options.port;
    const name = this.options.host === '0.0.0.0' || this.options.host === '::' ? 'localhost' : this.options.host;
    return `http://${name}:${port}`;
  }

  // ---- peers ---------------------------------------------------------------

  /**
   * One heartbeat pass. A peer is only dropped after it has failed to answer a ping for
   * `PONG_GRACE_MS`, and the clock is a parameter so a test — or a car that slept through a night —
   * can say how much time has passed instead of waiting for it.
   */
  keepaliveOnce(nowMs = this.clock.nowMs()) {
    for (const ws of this.wss.clients) {
      if (ws.pongPendingAt !== undefined && nowMs - ws.pongPendingAt >= PONG_GRACE_MS) {
        this.log('socket', `${ws.peerLabel ?? 'a peer'}: no answer to a ping for ${Math.round(nowMs - ws.pongPendingAt)}ms, closing`);
        ws.terminate();
        continue;
      }
      if (ws.pongPendingAt === undefined) {
        ws.pongPendingAt = nowMs;
        ws.ping();
      }
    }
  }

  #upgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (error) {
      return this.#deny(socket, '400 Bad Request');
    }
    const role = ROLE_BY_PATH[url.pathname];
    if (!role) return this.#deny(socket, '404 Not Found');
    if (url.searchParams.get('token') !== this.options.token) return this.#deny(socket, '401 Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws, role, req));
  }

  #deny(socket, status) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    this.log('socket', `refused upgrade: ${status}`);
  }

  #attach(ws, role, req) {
    const id = this.connections++;
    ws.peerLabel = `${role} #${id}`;
    ws.pongPendingAt = undefined;
    ws.on('pong', () => {
      ws.pongPendingAt = undefined;
    });
    if (role === 'input') return this.#attachInput(ws, id);

    const receiver = this.projection.addReceiver(ws);
    receiver.host = req.headers.host ?? this.origin().slice(7);
    ws.on('message', (data, isBinary) => this.#route(receiver, data, isBinary));
    ws.on('close', () => this.projection.removeReceiver(receiver));
    ws.on('error', (error) => this.log('receiver', `#${id} ${error.message}`));
    this.log('receiver', `#${id} connected from ${req.socket.remoteAddress}`);
    return receiver;
  }

  #attachInput(ws, id) {
    const link = new InputLink(id, ws);
    this.inputLinks.add(link);
    link.onClosed((reason) => this.#inputGone(link, id, reason));
    link.onError = (message) => this.log('input', `#${id} reported ${message.code}: ${message.message}`);
    ws.on('message', (data, isBinary) => this.#routeInput(link, data, isBinary));
    this.projection.attachSource(link);
    void this.#makeRoomForDevice();
    this.log('input', `#${id} connected`);
    return link;
  }

  #inputGone(link, id, reason) {
    this.inputLinks.delete(link);
    this.log('input', `#${id} stopped (${reason})`);
    if (this.inputLinks.size > 0) return;
    if (this.options.source === 'ffmpeg' && !this.localSource) this.#startLocalSource();
    else if (this.options.source !== 'ffmpeg') this.projection.setPhase(Phase.Reconnecting, STARTUP_REASONS.waitingMedia);
  }

  #route(link, data, isBinary) {
    try {
      return link.receive(data, isBinary);
    } catch (error) {
      this.#reject(link, error);
    }
    return undefined;
  }

  #routeInput(link, data, isBinary) {
    const seen = this.#route(link, data, isBinary);
    if (seen === 'video-format' || seen === 'audio-format') this.log('input', `#${link.id} announced ${seen}`);
  }

  /** A protocol violation gets one explanation, then the socket goes away. */
  #reject(link, error) {
    this.log('wire', `#${link.id} rejected ${error.name}: ${error.message}`);
    try {
      link.send(encodeMessage({ type: 'error', code: error.name ?? 'wire-format', message: error.message }), true);
    } catch {
      // the frame that failed validation is often not an encodable message either
    }
    link.close(1002, 'wire format');
  }

  // ---- the synthetic source ------------------------------------------------

  #startLocalSource(scene = this.options.scene) {
    const o = this.options;
    const ffmpeg = new FfmpegSource({
      ffmpeg: o.ffmpeg,
      scene,
      width: o.width,
      height: o.height,
      fps: o.fps,
      bitrate: o.bitrate,
      gopSeconds: o.gopSeconds,
      audio: o.audio,
      input: o.input,
    });
    const link = new LocalSource(`local-${this.connections++}`, ffmpeg, {
      onLog: (entry) => this.log('ffmpeg', entry.text),
      onScene: (name) => {
        this.options.scene = name;
      },
    });
    this.localSource = link;
    this.projection.attachSource(link);
    this.log('source', `${ffmpeg.label} → ${o.width}x${o.height}@${o.fps}fps, IDR every ${o.gopSeconds}s`);
    return link;
  }

  /**
   * One input per projection: a device that arrives replaces the synthetic source. The detach comes
   * first, so there is never a moment when two inputs are feeding the same session and a receiver
   * sees the two formats interleaved.
   */
  async #makeRoomForDevice() {
    if (!this.localSource || this.inputLinks.size === 0) return;
    const previous = this.localSource;
    this.localSource = null;
    this.projection.sources.delete(previous);
    await previous.stop();
    this.log('source', 'synthetic source gave way to a device');
  }

  // ---- pages, state, operator actions --------------------------------------

  #http(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (error) {
      return this.#text(res, 400, `bad request url: ${error.message}\n`);
    }
    const path = url.pathname;
    if (path === '/state.json') return this.#json(res, this.state(url.searchParams));
    if (path === '/events') return this.#json(res, this.trace.slice(-Number(url.searchParams.get('n') ?? 60)));
    if (path === '/version') return this.#json(res, { name: 'mirrorplay-relay', version: VERSION, clockUs: String(this.clock.epochAt()) });
    if (path === '/probe.json') return this.#probeJson(res);
    if (Object.hasOwn(INSTALLABLE, path)) return this.#manifest(res, path);
    if (path === '/probe.avcc') return this.#probeAvcc(res);
    if (path === '/admin/action' && req.method === 'POST') return this.#action(req, res);
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (PAGES[path]) return this.#file(res, join(WEB, PAGES[path]));
    if (path.startsWith('/web/')) return this.#file(res, resolve(WEB, `.${path.slice(4)}`));
    // The pages import the same protocol and media modules the relay runs on: one copy of the code
    // for both sides of the socket.
    if (path.startsWith('/src/')) return this.#file(res, resolve(PROJECT, path.slice(1)));
    return this.#text(res, 404, `not found: ${path}\n`);
  }

  state(params = new URLSearchParams()) {
    return {
      clockUs: String(this.clock.epochAt()),
      origin: this.origin(),
      token: this.options.token,
      options: this.options,
      scenes: SCENE_ORDER,
      connections: this.connections,
      inputs: [...this.inputLinks].map((link) => ({ id: link.id, hello: link.hello ?? null, label: link.label() })),
      projection: this.projection.snapshot(),
      selfTest: this.sample ? { bytes: this.sample.avcc.length, atUs: this.sample.atUs } : null,
      trace: params.get('trace') === '1' ? this.trace.slice(-40) : undefined,
    };
  }

  /**
   * The first key frame the relay ever saw is kept so a browser can try decoding a real frame from
   * this relay without pairing or a user gesture. That is what /check answers with.
   */
  #probeJson(res) {
    if (!this.sample) return this.#json(res, { available: false, reason: 'no key frame seen yet; start a source or open /input' });
    this.#json(res, { available: true, atUs: this.sample.atUs, bytes: this.sample.avcc.length, format: this.projection.videoFormat, url: '/probe.avcc' });
  }

  #probeAvcc(res) {
    if (!this.sample) return this.#text(res, 503, 'no key frame captured yet\n');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(this.sample.avcc);
  }

  async #action(req, res) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let command = {};
      try {
        command = JSON.parse(body || '{}');
      } catch (error) {
        return this.#json(res, { ok: false, error: `invalid JSON: ${error.message}` });
      }
      switch (command.type) {
        case 'scene': {
          if (!SCENE_ORDER.includes(command.scene)) return this.#json(res, { ok: false, error: `unknown scene ${command.scene}` });
          if (this.localSource) void this.localSource.restart(command.scene);
          else if (this.options.source === 'ffmpeg') this.#startLocalSource(command.scene);
          else return this.#json(res, { ok: false, error: 'a device is feeding the projection; the scene belongs to the synthetic source' });
          break;
        }
        case 'restart':
          if (this.localSource) void this.localSource.restart();
          else this.projection.sendToInput({ type: 'restart' });
          break;
        case 'keyframe':
          this.projection.lastKeyRequestMs = -Infinity; // an operator is not bound by the limiter
          this.projection.requestKeyFrame();
          break;
        case 'pause':
          this.projection.sendToInput({ type: 'pause', paused: !!command.paused });
          break;
        default:
          return this.#json(res, { ok: false, error: `unknown action ${command.type}` });
      }
      this.log('admin', JSON.stringify(command));
      this.#json(res, { ok: true, session: this.projection.snapshot().session });
    });
  }

  /**
   * A web app installed to an iPhone's home screen has to arrive at the relay already paired: a
   * static manifest cannot know this deployment's pairing token, and without it the installed page
   * opens into "no token, nothing to watch". So the manifest is generated, and the token travels in
   * start_url's query — the same way every link in the app's own pages carries it.
   */
  #manifest(res, path) {
    const spec = INSTALLABLE[path];
    // Every URL here is relative on purpose. An absolute origin would bake in whatever this process
    // thinks it is called — `localhost` when bound to 0.0.0.0 — and a phone reaching the relay over
    // the LAN would then install an app whose icons and start page point at the wrong machine. The
    // browser resolves all of these against the manifest URL instead, which is the same host the user
    // actually typed.
    const icons = [180, 192, 512].map((size) => ({
      src: `/web/icons/mirrorplay-${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: size === 512 ? 'any maskable' : 'any',
    }));
    const query = new URLSearchParams({ token: this.options.token, installed: '1' });
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      name: spec.name,
      short_name: spec.short_name,
      description: spec.description,
      start_url: `${spec.page}?${query}`,
      scope: `/`,
      display: 'standalone',
      orientation: 'any',
      background_color: spec.theme,
      theme_color: spec.theme,
      lang: 'en',
      icons,
      // iOS reads apple-touch-icon from the HTML link tag rather than from here; the manifest matters
      // for Android and desktop, and start_url carrying the token matters on both.
      display_override: ['standalone', 'minimal-ui', 'browser'],
    }));
  }

  #json(res, value) {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  #text(res, status, text) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  async #file(res, path) {
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (error) {
      this.#text(res, error.code === 'ENOENT' ? 404 : 500, `${error.code ?? 'error'}: ${path}\n`);
    }
  }

  // ---- what the relay notices about itself ---------------------------------

  #watchProjection() {
    const p = this.projection;
    p.on('receiver-hello', (receiver, hello) => {
      receiver.sendJson({
        type: 'welcome',
        version: 0,
        clientId: randomUUID().slice(0, 8),
        session: { id: String(p.sessionId), phase: p.phase, ...(p.reason ? { reason: p.reason } : {}) },
        // sourceUrl names where the wire format comes from; it is not a socket address.
        sourceUrl: 'https://github.com/OpenXPlay/OpenXPlay-Stream',
        attribution: 'mirrorplay prototype; projection wire format derived from OpenXPlay (AGPL-3.0-only)',
        projectUrl: `http://${receiver.host}`,
        relay: { name: 'mirrorplay relay', version: VERSION },
        receiverBuild: VERSION,
        features: ['video', 'audio', 'touch', 'key', 'view-area', 'clock'],
      });
      void hello;
    });
    p.on('touch', (contacts, header, delivered) => this.log('touch', `${contacts.length} contact(s) at ${contacts.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ') || '(none)'} → ${delivered}`));
    p.on('key', (key, header, delivered) => this.log('key', `code ${key.code} ${key.down ? 'down' : 'up'} → ${delivered}`));
    p.on('keyframe-request', (receiver) => this.log('policy', `key frame wanted (receiver #${receiver?.id ?? 'coalesced'})`));
    p.on('display-settings', (receiver, settings) => this.log('display', `${settings.resolution}${settings.frameRate ? ` ${settings.frameRate}` : ''}`));
    p.on('video-format', (format) => this.log('media', format ? `${format.codecString} ${format.width}x${format.height}` : 'no video format'));
    p.on('audio-format', (format) => this.log('media', format ? `${format.codec} ${format.sampleRate}Hz/${format.channels}ch` : 'no audio format'));
    p.on('phase', (phase, reason) => this.log('session', `${phase}${reason ? ` (${reason})` : ''}`));
    p.on('source-ended', ({ reason }) => this.log('session', `source ended (${reason})`));
    p.on('video', ({ header, avcc }) => {
      if (header.kind === Kind.Video && (header.flags & Flag.Keyframe) === Flag.Keyframe && !this.sample) {
        this.sample = { avcc: Buffer.from(avcc), atUs: String(this.clock.epochAt()) };
        this.log('media', `self-test sample kept (${avcc.length} bytes)`);
      }
    });
  }

  /** The settled state, for the operator page and for the tests: no guessed sleeps. */
  async until(predicate, what = 'the relay to settle', { timeoutMs = 4000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate(this);
      if (value) return value;
      await new Promise((ok) => setTimeout(ok, intervalMs));
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
  }

  log(channel, text) {
    const entry = { atUs: String(this.clock.epochAt()), channel, text };
    this.trace.push(entry);
    if (this.trace.length > TRACE_LIMIT) this.trace.shift();
    if (this.verbose) process.stderr.write(`[${channel}] ${text}\n`);
    return entry;
  }

  async close() {
    clearInterval(this.heartbeat);
    for (const link of this.inputLinks) link.close(1001, 'relay shutting down');
    this.inputLinks.clear();
    for (const receiver of this.projection.receivers) receiver.close(1001, 'relay shutting down');
    await this.localSource?.stop();
    this.localSource = null;
    await new Promise((ok) => this.wss.close(ok));
    await new Promise((ok) => this.server.close(ok));
  }
}
