// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// H.264 parameter sets, Annex B framing and the ADTS reader. When ffmpeg is present the synthetic
// source test runs against the real encoder; the framing tests use hand written bytes so they also
// run where no encoder exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { units, annexBToAvcc, avccToAnnexB, isKeyFrame, nalTypes, parameterSets, Avcc, AnnexB, MediaError } from '../src/media/nal.js';
import { AccessUnitSplitter } from '../src/media/annexb.js';
import { AvcConfig, avcCFromAccessUnit } from '../src/media/avc.js';
import { AdtsStream, audioSpecificConfig, SAMPLE_RATES } from '../src/media/adts.js';
import { findFfmpeg, FfmpegSource, SCENE_ORDER, SCENES, lavfi } from '../src/sources/ffmpeg.js';

const FFMPEG = (() => {
  try {
    findFfmpeg();
    return true;
  } catch {
    return false;
  }
})();

// Taken from a libx264 encode of a real 640x480 baseline stream, so the constraint bytes and the
// HRD parameters are ones a decoder actually has to walk past.
const SPS = new Uint8Array([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xca, 0x3c, 0x60, 0xca, 0x80]);
const PPS = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x37, 0xff]);
const DELTA = new Uint8Array([0x41, 0x9a, 0x00, 0x37, 0xfe]);

test('annex B units split on three and four byte start codes', () => {
  const annexB = new Uint8Array([0, 0, 0, 1, ...SPS, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...IDR]);
  assert.deepEqual(nalTypes(annexB, AnnexB), [7, 8, 5]);
  assert.equal(units(annexB, AnnexB)[2].length, IDR.length);
  assert.equal(isKeyFrame(annexB, AnnexB), true);
  assert.equal(isKeyFrame(new Uint8Array([0, 0, 0, 1, ...DELTA]), AnnexB), false);
});

test('annex B rejects what a splitter could not frame', () => {
  assert.throws(() => units(new Uint8Array([1, 2, 3, 0, 0, 1, 0x41]), AnnexB), MediaError);
  assert.throws(() => units(new Uint8Array([0, 0, 1]), AnnexB), /Empty NAL unit/);
  assert.throws(() => units(new Uint8Array([0, 0, 0, 2, 0x41]), Avcc), /Invalid NAL length/);
});

test('annex B and avcc convert to the same units', () => {
  const annexB = new Uint8Array([0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...IDR]);
  const avcc = annexBToAvcc(annexB);
  assert.equal(avcc.length, 12 + SPS.length + PPS.length + IDR.length);
  assert.deepEqual([...avcc.subarray(0, 4)], [0, 0, 0, SPS.length]);
  assert.deepEqual(units(avcc, Avcc).map((u) => [...u]), units(annexB, AnnexB).map((u) => [...u]));
  assert.deepEqual(units(avccToAnnexB(avcc), AnnexB).map((u) => [...u]), units(avcc, Avcc).map((u) => [...u]));
  assert.equal(isKeyFrame(avcc, Avcc), true);
});

test('avcC parses geometry and builds the record libx264 would emit', () => {
  const config = AvcConfig.fromParameterSets(SPS, PPS);
  assert.equal(config[0], 1, 'configuration version');
  assert.equal(config[1], SPS[1], 'profile inherits from the SPS');
  assert.equal(config[4], 0xff, 'four byte nal lengths');
  assert.equal(config[5] & 31, 1, 'one SPS');
  const parsed = AvcConfig.parse(config);
  assert.equal(parsed.nalLengthSize, 4);
  assert.equal(parsed.width, 640);
  assert.equal(parsed.height, 480);
  assert.equal(parsed.codecString, 'avc1.42C01F');
  assert.equal(parsed.level, 31);
});

test('avcC refuses what a decoder could not use', () => {
  assert.throws(() => AvcConfig.parse(new Uint8Array([2, 0, 0, 0, 0])), /avcC version/);
  const lengths = AvcConfig.fromParameterSets(SPS, PPS);
  lengths[4] = 0xfe; // lengthSizeMinusOne is reserved at 2
  assert.throws(() => AvcConfig.parse(lengths), /NAL length size/);
  lengths[4] = 0xfd; // lengthSizeMinusOne 1 parses into two-byte lengths, which the wire rejects
  assert.equal(AvcConfig.parse(lengths).nalLengthSize, 2);
  assert.throws(() => AvcConfig.parse(new Uint8Array([1, 66, 192, 31, 255, 224])), /SPS and PPS|Truncated/);
});

test('a wire video format is base64 avcC plus geometry', () => {
  const wire = AvcConfig.wireFormat(AvcConfig.fromParameterSets(SPS, PPS), { fpsHint: 30 });
  assert.equal(wire.codec, 'H264');
  assert.equal(wire.width, 640);
  assert.equal(wire.height, 480);
  assert.equal(wire.fpsHint, 30);
  assert.equal(Buffer.from(wire.config, 'base64')[1], SPS[1]);
  const twoByteLengths = AvcConfig.fromParameterSets(SPS, PPS);
  twoByteLengths[4] = 0xfd; // lengthSizeMinusOne 1
  assert.throws(() => AvcConfig.wireFormat(twoByteLengths), /four-byte NAL lengths/);
});

test('avcC is rebuilt from the parameter sets inside an access unit', () => {
  const withSets = annexBToAvcc(new Uint8Array([0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...IDR]));
  assert.deepEqual([...avcCFromAccessUnit(withSets)], [...AvcConfig.fromParameterSets(SPS, PPS)]);
  const sliceOnly = new Uint8Array([0, 0, 0, 2, 0x41, 0x11]);
  const sets = parameterSets(sliceOnly, Avcc);
  assert.equal(sets.sps, null);
  assert.equal(sets.pps, null);
  assert.throws(() => avcCFromAccessUnit(sliceOnly), /no parameter sets/);
});

test('the splitter cuts on a delimiter and on a parameter set after a slice', () => {
  const stream = new Uint8Array([
    0, 0, 0, 1, 9, 0xf0, // AUD
    0, 0, 0, 1, ...SPS,
    0, 0, 0, 1, ...PPS,
    0, 0, 0, 1, ...IDR,
    0, 0, 0, 1, 9, 0x08, // next AUD
    0, 0, 0, 1, ...DELTA,
    0, 0, 0, 1, 9, 0x10, // and the delimiter after that, which is what closes the unit above
  ]);
  const units_ = new AccessUnitSplitter().push(stream);
  assert.equal(units_.length, 2);
  assert.equal(units_[0].key, true);
  assert.equal(units_[1].key, false);
  assert.deepEqual(nalTypes(units_[0].avcc, Avcc), [9, 7, 8, 5]);

  const noAud = new AccessUnitSplitter().push(
    new Uint8Array([0, 0, 0, 1, ...IDR, 0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...DELTA, 0, 0, 0, 1, ...SPS]),
  );
  assert.equal(noAud.length, 2, 'the IDR unit, then the unit opened by the repeated parameter sets');
  assert.deepEqual(nalTypes(noAud[0].avcc, Avcc), [5]);
  assert.deepEqual(nalTypes(noAud[1].avcc, Avcc), [7, 8, 1]);
});

test('adts frames become raw aac with a describable audio format', () => {
  // protection_absent=1 (7-byte header), AAC-LC profile 1, frequency index 3 (48 kHz), stereo,
  // and a frame length field of exactly 7: the header alone, so the raw payload is empty.
  const frame = new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0x00, 0xe0, 0xfc]);
  const stream = new AdtsStream();
  const first = stream.push(Buffer.from(frame));
  assert.equal(first.length, 1);
  assert.equal(first[0].aac.length, 0, 'the frame is all header');
  assert.equal(first[0].sampleRate, 48000);
  assert.equal(first[0].channels, 2);
  assert.equal(first[0].objectType, 2);
  assert.equal(stream.push(Buffer.from(frame))[0].accessUnit, 1, 'the frame counter keeps running');
  const asc = audioSpecificConfig(2, 48000, 2);
  assert.equal(asc[0] >> 3, 2, 'object type');
  assert.equal(((asc[0] & 7) << 1) | (asc[1] >> 7), SAMPLE_RATES.indexOf(48000), 'frequency index');
  assert.equal((asc[1] >> 3) & 15, 2, 'channel configuration');
  assert.throws(() => audioSpecificConfig(2, 44001, 2), /no ADTS index/);
});

test('adts resynchronises instead of inventing frames', () => {
  const stream = new AdtsStream();
  assert.deepEqual(stream.push(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), []);
  const frame = new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0x00, 0xe0, 0xfc]);
  assert.equal(stream.push(Buffer.from(frame)).length, 1, 'one whole frame');
  assert.equal(stream.push(Buffer.from([...frame.slice(0, 4)])).length, 0, 'a partial frame stays buffered');
  assert.equal(stream.push(Buffer.from(frame.slice(4))).length, 1, 'and completes on the rest');
});

async function collect(source, ms) {
  const video = [];
  const audio = [];
  const formats = [];
  source.on('video', (frame) => video.push(frame));
  source.on('audio', (frame) => audio.push(frame));
  source.on('videoFormat', ({ format }) => formats.push(format));
  source.on('audioFormat', ({ format }) => formats.push(format));
  source.start();
  await new Promise((ok) => setTimeout(ok, ms));
  await source.stop();
  return { video, audio, formats };
}

test('the synthetic source produces framed avcc access units', { skip: !FFMPEG }, async () => {
  const { video, audio, formats } = await collect(new FfmpegSource({ scene: 'testsrc2', width: 640, height: 480, fps: 25, gopSeconds: 1 }), 1400);
  assert.equal(formats.length, 2, 'one video format and one audio format were announced');
  const videoFormat = formats.find((format) => Object.hasOwn(format, 'width'));
  assert.equal(videoFormat.width, 640);
  assert.equal(videoFormat.height, 480);
  assert.equal(videoFormat.codec, 'H264');
  assert.match(videoFormat.codecString, /^avc1\.[0-9A-F]{6}$/);
  assert.ok(video.length > 10, `frames arrived (${video.length})`);
  assert.ok(video.some((f) => f.key), 'at least one IDR');
  assert.ok(audio.length > 5, 'audio arrived too');
  for (const frame of video.slice(0, 6)) {
    const types = nalTypes(frame.avcc, Avcc);
    assert.ok(types.some((t) => t >= 1 && t <= 5), 'a slice in every access unit');
    assert.equal(isKeyFrame(frame.avcc, Avcc), frame.key);
    if (frame.key) {
      // The record announced in video-format must be exactly what the IDR repeats in band, or a
      // receiver that misses the announcement cannot resynchronise.
      assert.deepEqual([...avcCFromAccessUnit(frame.avcc)], [...Buffer.from(videoFormat.config, 'base64')]);
    }
  }
});

/**
 * lavfi option lists are one flat string, and a wrong join (or a wrong option name) is a source
 * that never produces a frame. That mistake is invisible in the protocol tests, so every scene is
 * actually encoded here.
 */
test('a restarted source keeps producing frames', { skip: !FFMPEG }, async () => {
  const source = new FfmpegSource({ scene: 'testsrc', width: 320, height: 240, fps: 20, gopSeconds: 1, audio: false });
  const video = [];
  source.on('video', (frame) => video.push(frame));
  source.start();
  await new Promise((ok) => setTimeout(ok, 700));
  const before = video.length;
  await source.stop();
  assert.ok(before > 5, `frames before the restart (${before})`);

  const next = source.nextScene(1);
  source.setScene(next);
  source.start();
  await new Promise((ok) => setTimeout(ok, 700));
  await source.stop();
  assert.ok(video.length - before > 5, `frames after the restart (${video.length - before})`);
  assert.equal(source.label, SCENES[next].label, 'and the encoder really switched scene');
});

test('every named scene really encodes', { skip: !FFMPEG }, async () => {
  const { spawn } = await import('node:child_process');
  const ffmpeg = findFfmpeg();
  for (const scene of SCENE_ORDER) {
    const frames = await new Promise((resolve, reject) => {
      let text = '';
      const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', lavfi(scene, 320, 240, 15), '-frames:v', '10', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.on('data', (chunk) => (text += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(10) : reject(new Error(`${scene}: exit ${code} ${text.slice(0, 220)}`))));
    });
    assert.equal(frames, 10, `${scene} produced frames`);
    assert.ok(SCENES[scene].label.length > 0, `${scene} has a label for the operator`);
  }
});

test('the lavfi string is one flat option list', () => {
  assert.equal(lavfi('testsrc2', 640, 480, 25), 'testsrc2=size=640x480:rate=25');
  assert.equal(lavfi('life', 640, 480, 25), 'life=size=640x480:rate=25');
  assert.equal(lavfi('gradients', 640, 480, 25), 'gradients=type=radial:speed=0.8:size=640x480:rate=25');
  assert.equal(lavfi('mandelbrot', 320, 240, 15), 'mandelbrot=inner=120:size=320x240:rate=15');
});

test('scenes are named, ordered and switchable', () => {
  assert.ok(SCENE_ORDER.includes('testsrc2'));
  assert.equal(SCENES.life.source, 'life');
  const source = new FfmpegSource({ scene: 'life' });
  assert.equal(source.label, SCENES.life.label);
  const at = SCENE_ORDER.indexOf('life');
  assert.equal(source.nextScene(1), SCENE_ORDER[(at + 1) % SCENE_ORDER.length]);
  assert.equal(source.nextScene(-1), SCENE_ORDER[(at - 1 + SCENE_ORDER.length) % SCENE_ORDER.length]);
  assert.throws(() => source.setScene('nope'), /unknown scene/);
});

test('the encoder lookup finds the bundled build or says what to do', () => {
  assert.throws(() => findFfmpeg('/definitely/not/here'), (error) => {
    assert.equal(error.name, 'MediaSourceError');
    // The environment variable and the repository bin/ are consulted first, so an explicit path
    // that does not exist must not be reported as the only place a binary could be.
    assert.match(error.message, /does not exist/);
    return true;
  });
  assert.ok(findFfmpeg().length > 0, 'some ffmpeg is resolvable, from PATH or bin/');
});
