#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Command line for the relay. Everything the relay needs to start is here; the pages it serves
// read the same options back from /state.json.

import { parseArgs } from 'node:util';
import { Relay } from './relay/server.js';
import { SCENE_ORDER, MediaSourceError, findFfmpeg } from './sources/ffmpeg.js';

const USAGE = `mirrorplay — projection relay (H.264 + touch to a browser, OpenXPlay-shaped)

  mirrorplay [options]

  --port <n>          HTTP and WebSocket port                    (default 3000)
  --host <addr>       bind address                               (default 0.0.0.0)
  --token <text>      pairing token every page must carry        (default mirrorplay)
  --source <kind>     ffmpeg | input | none                      (default ffmpeg)
  --scene <name>      ${SCENE_ORDER.join(' ')}          (default testsrc2)
  --input <file>      loop this media file instead of a scene
  --size <WxH>        encoder frame size                         (default 1280x720)
  --fps <n>           frames per second                          (default 30)
  --gop <s>           seconds between IDR frames                 (default 2)
  --bitrate <bps>     video bitrate, e.g. 3M or 800k             (default 3M)
  --no-audio          leave the tone out
  --ffmpeg <path>     ffmpeg binary (or set MIRRORPLAY_FFMPEG)
  --verbose           log every relay event to stderr
  --help              this text

Pages once the relay runs:
  /                    what to open next
  /receiver            the head unit: opens the projection and decodes it
  /input               the device: encodes its screen or camera into the projection
  /admin               relay state, receiver stats, scene buttons, touch read-out
  /check               whether this browser can decode what the relay sends
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '3000' },
    host: { type: 'string', default: '0.0.0.0' },
    token: { type: 'string', default: 'mirrorplay' },
    source: { type: 'string', default: 'ffmpeg' },
    scene: { type: 'string', default: 'testsrc2' },
    input: { type: 'string' },
    size: { type: 'string', default: '1280x720' },
    fps: { type: 'string', default: '30' },
    gop: { type: 'string', default: '2' },
    bitrate: { type: 'string', default: '3M' },
    'no-audio': { type: 'boolean', default: false },
    ffmpeg: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (flags.help || positionals.includes('help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const [width, height] = flags.size.split(/[x×]/).map((n) => Number.parseInt(n, 10));
if (!width || !height) {
  process.stderr.write(`--size wants WxH, got "${flags.size}"\n`);
  process.exit(2);
}

if (!['ffmpeg', 'input', 'none'].includes(flags.source)) {
  process.stderr.write(`--source must be ffmpeg, input or none\n`);
  process.exit(2);
}

if (flags.source === 'ffmpeg' && !flags.input) {
  try {
    findFfmpeg(flags.ffmpeg);
  } catch (error) {
    process.stderr.write(`${error instanceof MediaSourceError ? error.message : error.message}\n\nTry --source none and open /input to stream from a device instead.\n`);
    process.exit(3);
  }
}

const relay = new Relay({
  port: Number(flags.port),
  host: flags.host,
  token: flags.token,
  source: flags.source,
  scene: flags.scene,
  input: flags.input,
  width,
  height,
  fps: Number(flags.fps),
  gopSeconds: Number(flags.gop),
  bitrate: flags.bitrate,
  audio: !flags['no-audio'],
  ffmpeg: flags.ffmpeg,
  verbose: flags.verbose,
});

await relay.listen();

const origin = relay.origin();
process.stdout.write(`
  mirrorplay relay  →  ${origin}

    ${origin}/        start here
    ${origin}/receiver  head unit (the car browser)
    ${origin}/input     device (a laptop or phone tab)
    ${origin}/admin     relay state
    ${origin}/check     browser capability probe

  source ${flags.source}${flags.source === 'ffmpeg' ? ` (${flags.input ? flags.input : flags.scene})` : ''}, size ${width}x${height}@${flags.fps}fps, token ${flags.token}

  This is a prototype: H.264 to a browser, touch back to the source.
  It carries no Apple CarPlay protocol and no MFi identity. Press Ctrl-C to stop.

`);

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  process.stdout.write(`\nstopping (${signal})\n`);
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
