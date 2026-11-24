#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Build the byte fixtures the iOS input端 is tested against.
//
//   node scripts/ios-fixtures.mjs [--ffmpeg <path>] [--out device-ios/Fixtures]
//
// Why fixtures instead of a shared spec: the risky part of a second implementation is not the
// JSON, it is the byte level — avcC built from SPS/PPS, Annex B reframed as AVCC, the 24-byte
// envelope, the touch and key payloads. Those are pinned here as files, produced with this
// repository's own codec, and the Swift tests must reproduce them exactly from the same inputs.
// A Swift test that disagrees with a fixture is a protocol mismatch, not a bug in the test.
//
// The H.264 input is whatever libx264 really encoded (a 720p test pattern), because a record built
// from invented SPS bytes proves nothing about the constraint bytes and HRD fields a real encoder
// writes.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Kind, Flag, KeyCode, encodeBinary, encodeTouch, encodeKey } from '../src/protocol/binary.js';
import { encodeMessage } from '../src/protocol/json.js';
import { AvcConfig } from '../src/media/avc.js';
import { AccessUnitSplitter } from '../src/media/annexb.js';
import { Avcc, AnnexB, nalTypes, parameterSets, units as unitsOf, annexBToAvcc, isKeyFrame } from '../src/media/nal.js';
import { findFfmpeg } from '../src/sources/ffmpeg.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const { values: flags } = parseArgs({
  options: {
    ffmpeg: { type: 'string' },
    out: { type: 'string', default: join(ROOT, 'device-ios', 'Fixtures') },
    size: { type: 'string', default: '1280x720' },
    fps: { type: 'string', default: '18' },
  },
});

const ffmpeg = findFfmpeg(flags.ffmpeg);
const [width, height] = flags.size.split('x').map(Number);
const fps = Number(flags.fps);

const run = (label, bytes) => {
  mkdirSync(resolve(flags.out), { recursive: true });
  writeFileSync(join(resolve(flags.out), label), Buffer.from(bytes));
  process.stdout.write(`  ${label.padEnd(26)} ${bytes.length} bytes\n`);
};

process.stdout.write(`\nencoding a reference stream with ${ffmpeg}\n`);
const encode = spawnSync(
  ffmpeg,
  [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=${fps}`,
    '-frames:v', '10',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p', '-bf', '0',
    '-x264-params', `scenecut=0:open_gop=0:keyint=3:min_keyint=3:aud=1`,
    '-f', 'h264', '-',
  ],
  { maxBuffer: 1 << 26 },
);
if (encode.status) throw new Error(`ffmpeg failed: ${encode.stderr?.toString()}`);

// A hardware encoder does not write access unit delimiters, and it repeats the parameter sets
// without a sei on every IDR, so the fixtures have to be shaped that way to be worth anything. This
// takes libx264 output with delimiters (which frames the units unambiguously), strips the delimiter
// and the sei out of each unit, and then proves the splitter can recover the very same units from
// the stripped stream, cutting instead at the parameter set that opens the next picture.
// A native encoder hands the app one finished access unit per sample and never needs delimiters:
// the parameter sets ride in band on the IDR and nowhere else. So the fixtures are per access unit.
// This also records the limit of cutting a *concatenated* Annex B stream without delimiters: it
// works only between IDR pictures (a P frame has no boundary at all), which is why the ffmpeg
// source is started with `aud=1` and the browser path never produces Annex B on the wire.
const delimited = new AccessUnitSplitter();
const accessUnits = [...delimited.push(encode.stdout), ...delimited.flush()];
const framed = accessUnits.map((unit) => reframe(keepOnly(unit.annexB, [7, 8, 5, 1, 2, 3, 4])));
const units = framed;

const firstKey = units.find((unit) => unit.key);
const firstDelta = units.find((unit) => !unit.key && unit.types.some((type) => type >= 1 && type <= 5));
if (!firstKey || !firstDelta) throw new Error('the reference stream needs an IDR and a following delta');

/** Drop the units a native encoder would not write (delimiter, sei) and restart-code the rest. */
function keepOnly(annexB, types) {
  const kept = unitsOf(annexB, AnnexB).filter((unit) => types.includes(unit[0] & 31));
  const size = kept.reduce((n, unit) => n + unit.length + 4, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const unit of kept) {
    out.set([0, 0, 0, 1], at);
    at += 4;
    out.set(unit, at);
    at += unit.length;
  }
  return out;
}

/** Annex B bytes for one access unit, both framings, the way the relay wants them. */
function reframe(annexB) {
  const avcc = annexBToAvcc(annexB);
  return { annexB, avcc, key: isKeyFrame(annexB, AnnexB), types: nalTypes(avcc, Avcc) };
}


const { sps, pps } = parameterSets(firstKey.annexB, AnnexB);
const avcC = AvcConfig.fromParameterSets(sps, pps);
const wireFormat = AvcConfig.wireFormat(avcC, { fpsHint: fps });

process.stdout.write(`\nreference: ${wireFormat.codecString} ${wireFormat.width}x${wireFormat.height}, ${units.length} units from ${encode.stdout.length} Annex B bytes\n\n`);

// 1. parameter sets on their own, which is all a hardware encoder will hand back.
run('sps.bin', sps);
run('pps.bin', pps);
run('avcC.bin', avcC);

// 2. framing: one IDR as Annex B (with parameter sets in band, no delimiters) and its AVCC twin.
run('key-annexb.bin', firstKey.annexB);
run('key-avcc.bin', firstKey.avcc);
run('delta-avcc.bin', firstDelta.avcc);

// 3. envelopes. The pts and clock values are fixed so the Swift side can rebuild the same header.
const envelope = { kind: Kind.Video, stream: 0, flags: Flag.Keyframe | Flag.Gap, sequence: 7, ptsUs: 123456000, senderClockUs: 987654321000 };
run('key-envelope.bin', encodeBinary({ ...envelope, ptsUs: BigInt(envelope.ptsUs), senderClockUs: BigInt(envelope.senderClockUs) }, firstKey.avcc));

const touch = [
  { id: 0, pressed: true, x: 0.25, y: 0.75 },
  { id: 3, pressed: true, x: 0.5, y: 0.5 },
  { id: 9, pressed: false, x: 1 / 65535, y: 1 },
];
run('touch.bin', encodeBinary({ kind: Kind.Touch, sequence: 12, ptsUs: 0n, senderClockUs: 42n }, encodeTouch(touch)));

const key = { code: KeyCode.KnobRight, down: true };
run('key.bin', encodeBinary({ kind: Kind.Key, sequence: 13, ptsUs: 0n, senderClockUs: 43n }, encodeKey(key)));

// 4. the two control messages an iOS input sends before the first frame.
const hello = {
  type: 'hello',
  version: 0,
  token: 'mirrorplay',
  decoders: [],
  displays: [
    {
      screen: 0, width, height, dpr: 3, refreshHz: 60,
      safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
      viewport: { width: 430, height: 932 },
      fullscreen: false, fullscreenPreferred: false,
    },
  ],
  maxTouchContacts: 10,
  audio: ['AAC_LC'],
  microphone: false,
  source: 'mirrorplay iOS device',
};
const format = { type: 'video-format', screen: 0, format: wireFormat };

const manifest = {
  note: 'Generated by scripts/ios-fixtures.mjs. Regenerate with the same command; a Swift test that disagrees with a fixture is a protocol mismatch.',
  ffmpeg,
  encoder: 'libx264 baseline level 3.1, no B frames, open_gop=0, IDR every 3 frames',
  framing: 'delimited and sei units removed; the native path is one access unit per sample on the wire, never a concatenated stream',
  size: [width, height],
  fps,
  units: units.length,
  codec: wireFormat.codecString,
  avcC: Buffer.from(avcC).toString('hex'),
  envelope,
  touch,
  key,
  // The Swift side asserts the object it encodes matches these fields, and that the bytes of
  // `config` are the same avcC record above — JSON whitespace is not part of the contract.
  messages: { hello, videoFormat: format },
};
writeFileSync(join(resolve(flags.out), 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
process.stdout.write(`  ${'manifest.json'.padEnd(26)} ${JSON.stringify(manifest).length} bytes\n`);

process.stdout.write(`\nfixtures written to ${resolve(flags.out)}\n`);
