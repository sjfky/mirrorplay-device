// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic video and audio source driven by an ffmpeg child process. It stands in for a CarPlay
// input: it produces the same projection session (H.264 access units with in-band parameter sets,
// AAC audio, presentation timestamps) so everything except Apple's pairing and MFi authentication
// is real and testable without an iPhone.
//
// Two children, one per media type: raw Annex B for video and ADTS for audio. Separate pipes avoid
// the buffering a muxer would add. Timestamps are counted from the same start rather than read off
// a wall clock, so both media share one arithmetic timeline (frame index / rate) and stay aligned.
//
// A `keyframe` request cannot be forced at an arbitrary instant through a command line, so IDR
// cadence is fixed with `-g` plus `keyint`/`min_keyint`, `scenecut=0` and `open_gop=0` keep it
// deterministic, and a request is answered by waiting for the next IDR. A scene change does
// restart the encoder, and the relay announces the first frame after it with the gap flag.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessUnitSplitter } from '../media/annexb.js';
import { AvcConfig } from '../media/avc.js';
import { AdtsStream, audioSpecificConfig } from '../media/adts.js';
import { toBase64 } from '../util/base64.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMON = ['-hide_banner', '-loglevel', 'error'];

export class MediaSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaSourceError';
  }
}

/**
 * lavfi sources that move, count frames and draw a grid, so delay and dropped frames are visible
 * from across the room. `size` and `rate` are added by #videoArgs, not stored here, because a lavfi
 * option list is one flat `name=a=1:b=2` string and getting that composition wrong makes the source
 * fail to start — which is why test/media.test.js encodes every one of them.
 */
export const SCENES = {
  testsrc2: { label: 'Motion test', source: 'testsrc2' },
  testsrc: { label: 'Test pattern', source: 'testsrc' },
  bars: { label: 'Colour bars', source: 'smptebars' },
  gradients: { label: 'Gradients', source: 'gradients=type=radial:speed=0.8' },
  mandelbrot: { label: 'Mandelbrot', source: 'mandelbrot=inner=120' },
  life: { label: 'Life', source: 'life' },
  cellauto: { label: 'Cellular automaton', source: 'cellauto=rule=110' },
};

export const SCENE_ORDER = Object.keys(SCENES);
const AUDIO_RATE = 48000;

/** `name=opts:size=WxH:rate=N` — one flat option list, exactly as lavfi wants it. */
export function lavfi(scene, width, height, fps) {
  const source = SCENES[scene].source;
  const media = `size=${width}x${height}:rate=${fps}`;
  // A source that already has options (gradients=type=radial) continues with ':', a bare name
  // (testsrc2) needs its first '='. Getting this wrong is a filter graph that will not start.
  return source.includes('=') ? `${source}:${media}` : `${source}=${media}`;
}

export function findFfmpeg(explicit) {
  // A path somebody typed on the command line is honoured, not silently replaced: falling back to
  // another binary would mean encoding with a build the operator never chose.
  if (explicit) {
    if (!existsSync(explicit)) throw new MediaSourceError(`--ffmpeg ${explicit} does not exist`);
    return explicit;
  }
  for (const candidate of [process.env.MIRRORPLAY_FFMPEG, join(HERE, '..', '..', 'bin', 'ffmpeg'), 'ffmpeg']) {
    if (!candidate) continue;
    if (candidate === 'ffmpeg') return candidate; // resolved through PATH by spawn
    if (existsSync(candidate)) return candidate;
  }
  throw new MediaSourceError('ffmpeg not found: pass --ffmpeg <path>, set MIRRORPLAY_FFMPEG, or put a build in ./bin/ffmpeg');
}

export class FfmpegSource extends EventEmitter {
  constructor({ ffmpeg, scene = 'testsrc2', width = 1280, height = 720, fps = 30, gopSeconds = 2, bitrate = '3M', audio = true, input = null } = {}) {
    super();
    this.ffmpeg = findFfmpeg(ffmpeg);
    this.setScene(scene);
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.gopSeconds = gopSeconds;
    this.bitrate = bitrate;
    this.audioEnabled = audio;
    this.input = input;
    this.children = [];
    this.videoUnits = 0;
    this.announced = { video: false, audio: false };
    this.stopping = false;
  }

  get label() {
    return this.input ? `loop ${this.input}` : SCENES[this.scene].label;
  }

  setScene(scene) {
    if (!SCENES[scene]) throw new MediaSourceError(`unknown scene "${scene}"`);
    this.scene = SCENES[scene] ? scene : this.scene;
    return this.label;
  }

  nextScene(step = 1) {
    const at = SCENE_ORDER.indexOf(this.scene);
    const next = SCENE_ORDER[(at + step + SCENE_ORDER.length) % SCENE_ORDER.length];
    return next;
  }

  videoPtsUs() {
    return (this.videoUnits++ * 1e6) / this.fps;
  }

  #videoArgs() {
    return [
      ...COMMON,
      ...(this.input ? ['-stream_loop', '-1', '-re', '-i', this.input] : ['-re', '-f', 'lavfi', '-i', lavfi(this.scene, this.width, this.height, this.fps)]),
      '-map', '0:v:0', '-an',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p', '-bf', '0',
      '-b:v', this.bitrate, '-g', String(this.gop()),
      '-x264-params', ['scenecut=0', 'open_gop=0', `keyint=${this.gop()}`, `min_keyint=${this.gop()}`, 'aud=1'].join(':'),
      '-f', 'h264', '-',
    ];
  }

  #audioArgs() {
    return [
      ...COMMON,
      ...(this.input ? ['-stream_loop', '-1', '-re', '-i', this.input] : ['-re', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${AUDIO_RATE}`]),
      '-map', '0:a:0?', '-vn', '-c:a', 'aac', '-ar', String(AUDIO_RATE), '-ac', '2', '-b:a', '64k', '-f', 'adts', '-',
    ];
  }

  gop() {
    return Math.max(Math.round(this.fps * this.gopSeconds), 1);
  }

  start() {
    // The frame handlers drop everything while a stop is in progress, so a restart has to clear the
    // flag it was set with, or the scene changes but the picture stops.
    this.stopping = false;
    this.videoUnits = 0;
    this.announced = { video: false, audio: false };
    const splitter = new AccessUnitSplitter();
    const adts = new AdtsStream();
    const video = this.#spawn(this.#videoArgs(), 'video');
    this.children = [video];
    if (this.audioEnabled) this.children.push(this.#spawn(this.#audioArgs(), 'audio'));
    let closed = 0;

    video.stdout.on('data', (chunk) => {
      if (this.stopping) return;
      for (const unit of splitter.push(chunk)) {
        if (!this.announced.video) {
          if (!unit.key) return; // parameter sets arrive inside the first IDR
          this.announceVideo(unit.annexB);
        }
        this.emit('video', { avcc: unit.avcc, ptsUs: this.videoPtsUs(), key: unit.key, source: this });
      }
    });

    const audio = this.children[1];
    audio?.stdout.on('data', (chunk) => {
      if (this.stopping) return;
      for (const frame of adts.push(chunk)) {
        if (!this.announced.audio) {
          this.announced.audio = true;
          this.emit('audioFormat', {
            format: {
              role: 'MEDIA',
              codec: 'AAC_LC',
              sampleRate: frame.sampleRate,
              channels: frame.channels,
              config: toBase64(audioSpecificConfig(frame.objectType, frame.sampleRate, frame.channels)),
            },
            source: this,
          });
        }
        this.emit('audio', {
          aac: frame.aac,
          ptsUs: (frame.accessUnit * 1024 * 1e6) / frame.sampleRate,
          stream: 0,
          source: this,
        });
      }
    });

    for (const child of this.children) {
      child.on('close', (code, signal) => {
        closed++;
        if (!this.stopping && role === 'video') {
          for (const unit of splitter.flush()) this.emit('video', { avcc: unit.avcc, ptsUs: this.videoPtsUs(), key: unit.key, source: this });
        }
        if (!this.stopping && closed >= this.children.length) {
          this.emit('ended', { reason: `encoder-exited code=${code} signal=${signal ?? 'none'}`, source: this });
        }
      });
      child.on('error', (error) => {
        if (!this.stopping) this.emit('ended', { reason: `encoder-failed: ${error.message}`, source: this });
      });
    }
    return this;
  }

  #spawn(args, role) {
    const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (chunk) => this.emit('log', { level: 'warning', text: `[${role}] ${chunk.toString().replace(/\s+$/, '')}` }));
    child.on('error', (error) => this.emit('log', { level: 'error', text: `[${role}] ${error.message}` }));
    return child;
  }

  announceVideo(annexB) {
    this.announced.video = true;
    this.emit('videoFormat', { format: AvcConfig.wireFormat(AvcConfig.fromAnnexB(annexB), { fpsHint: this.fps }), source: this });
  }

  async stop() {
    this.stopping = true;
    const alive = this.children.filter((c) => c.exitCode === null && c.signalCode === null);
    for (const child of alive) child.kill('SIGTERM');
    await Promise.all(alive.map((c) => new Promise((resolve) => c.once('close', resolve))));
  }
}

