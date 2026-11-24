// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// AVC decoder configuration record (avcC) and SPS geometry. The wire format carries avcC
// base64-encoded in the `video-format` message and every video frame as AVCC, so both directions
// need this parse.

import { Bits } from './bits.js';
import { toBase64 } from '../util/base64.js';
import { MediaError, units, AnnexB, Avcc, parameterSets } from './nal.js';

const HIGH_PROFILES = [44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244];

export class AvcConfig {
  constructor(fields) {
    Object.assign(this, fields);
  }

  static parse(data) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    let p = 0;
    const u8 = () => {
      if (p >= b.length) throw new MediaError('Truncated avcC');
      return b[p++];
    };
    if (u8() !== 1) throw new MediaError('Unsupported avcC version');
    const profile = u8();
    const compatibility = u8();
    const level = u8();
    const lengths = u8();
    if ((lengths & 3) === 2) throw new MediaError('Invalid avcC NAL length size');
    const readSets = (count, kind) => {
      const sets = [];
      for (let i = 0; i < count; i++) {
        if (b.length - p < 2) throw new MediaError('Truncated avcC parameter set');
        const n = (b[p] << 8) | b[p + 1];
        p += 2;
        if (n === 0 || n > b.length - p) throw new MediaError('Invalid avcC parameter set length');
        const set = b.subarray(p, p + n);
        p += n;
        if ((set[0] & 0x9f) !== kind) throw new MediaError('Invalid AVC parameter-set NAL type');
        sets.push(set);
      }
      return sets;
    };
    const sps = readSets(u8() & 31, 7);
    const pps = readSets(u8(), 8);
    if (!sps.length || !pps.length) throw new MediaError('avcC requires SPS and PPS');
    // The High-profile scaling-list extension is optional; FFmpeg and Chromium ignore it, so we
    // do not depend on it and only keep what the mandatory header carried.
    const { width, height } = AvcConfig.parseSps(sps[0]);
    return new AvcConfig({
      profile,
      compatibility,
      level,
      nalLengthSize: (lengths & 3) + 1,
      sps,
      pps,
      width,
      height,
      codecString: `avc1.${hex(profile)}${hex(compatibility)}${hex(level)}`,
    });
  }

  /** Picture size of an SPS, honouring chroma format, frame-only flag and cropping window. */
  static parseSps(sps) {
    if (!sps.length || (sps[0] & 0x9f) !== 7) throw new MediaError('Expected AVC SPS');
    const b = new Bits(sps, 1);
    const profile = b.u(8);
    b.u(16); // constraint flags + reserved
    if (b.ue() > 31) throw new MediaError('Invalid seq_parameter_set_id');
    let chroma = 1;
    let separate = false;
    if (HIGH_PROFILES.includes(profile)) {
      chroma = b.ue();
      if (chroma > 3) throw new MediaError('Invalid chroma_format_idc');
      if (chroma === 3) separate = b.flag();
      if (b.ue() > 6 || b.ue() > 6) throw new MediaError('Unsupported AVC bit depth');
      b.u(1); // qpprime_y_zero_transform_bypass_flag
      if (b.flag()) {
        const counts = chroma === 3 ? 12 : 8;
        for (let i = 0; i < counts; i++) {
          if (!b.flag()) continue;
          let last = 8;
          let next = 8;
          for (let k = 0; k < (i < 6 ? 16 : 64); k++) {
            if (next !== 0) {
              next = (((last + b.se()) % 256) + 256) % 256;
              if (next !== 0) last = next;
            }
          }
        }
      }
    }
    if (b.ue() > 12) throw new MediaError('Invalid log2_max_frame_num_minus4');
    switch (b.ue()) {
      case 0:
        if (b.ue() > 12) throw new MediaError('Invalid log2_max_pic_order_cnt_lsb_minus4');
        break;
      case 1:
        b.u(1);
        b.se();
        b.se();
        const n = b.ue();
        if (n > 255) throw new MediaError('Invalid picture-order cycle');
        for (let i = 0; i < n; i++) b.se();
        break;
      case 2:
        break;
      default:
        throw new MediaError('Invalid pic_order_cnt_type');
    }
    b.ue(); // num_ref_frames
    b.u(1); // gaps_in_frame_num_value_allowed_flag
    const wm = b.ue() + 1; // pic_width_in_mbs_minus1
    const hm = b.ue() + 1; // pic_height_in_map_units_minus1
    const frame = b.flag(); // frame_mbs_only_flag
    if (!frame) b.u(1); // mb_adaptive_frame_field_flag
    b.u(1); // direct_8x8_inference_flag
    const crop = [0, 0, 0, 0];
    if (b.flag()) crop.forEach((_, i) => (crop[i] = b.ue()));
    const chromaIdc = separate ? 0 : chroma;
    const x = chromaIdc === 1 || chromaIdc === 2 ? 2 : 1;
    const factor = frame ? 1 : 2;
    const y = chromaIdc === 1 ? 2 * factor : factor;
    const width = wm * 16 - (crop[0] + crop[1]) * x;
    const height = hm * 16 * factor - (crop[2] + crop[3]) * y;
    if (width <= 0 || height <= 0) throw new MediaError('Invalid AVC picture size');
    return { width, height };
  }

  /** Build the mandatory five-byte header plus both parameter sets, as FFmpeg's mp4 muxer does. */
  static fromParameterSets(sps, pps) {
    if (sps.length < 4 || sps.length > 65535) throw new MediaError('Invalid SPS length');
    if (pps.length > 65535) throw new MediaError('Invalid PPS length');
    return new Uint8Array([
      1,
      sps[1],
      sps[2],
      sps[3],
      0xff,
      0xe1,
      (sps.length >> 8) & 255,
      sps.length & 255,
      ...sps,
      1,
      (pps.length >> 8) & 255,
      pps.length & 255,
      ...pps,
    ]);
  }

  /** avcC from an Annex B access unit that carries its own parameter sets (IDR pictures do). */
  static fromAnnexB(data) {
    let sps = null;
    let pps = null;
    for (const u of units(data, AnnexB)) {
      const type = u[0] & 31;
      if (type === 7 && !sps) sps = u;
      if (type === 8) pps = pps ?? u;
    }
    if (!sps || !pps) throw new MediaError('Parameter sets missing from the access unit');
    return AvcConfig.fromParameterSets(sps, pps);
  }

  /** The `video-format.format` message a receiver needs before it can create a VideoDecoder. */
  static wireFormat(avcC, { fpsHint } = {}) {
    const cfg = AvcConfig.parse(avcC);
    if (cfg.nalLengthSize !== 4) throw new MediaError('video frames require four-byte NAL lengths');
    return {
      codec: 'H264',
      codecString: cfg.codecString,
      config: toBase64(avcC),
      width: cfg.width,
      height: cfg.height,
      ...(fpsHint ? { fpsHint } : {}),
    };
  }
}

export function avcCFromAccessUnit(avcc) {
  let sps = null;
  let pps = null;
  for (const u of units(avcc, Avcc)) {
    const type = u[0] & 31;
    if (type === 7) sps = sps ?? u;
    if (type === 8) pps = pps ?? u;
  }
  if (!sps || !pps) throw new MediaError('access unit carries no parameter sets');
  return AvcConfig.fromParameterSets(sps, pps);
}

const hex = (n) => (n & 255).toString(16).padStart(2, '0').toUpperCase();
