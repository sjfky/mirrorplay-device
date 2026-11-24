// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// NAL unit framing. Two container forms, same as the upstream model: Annex B (start codes,
// what a raw encoder emits) and AVCC (four-byte big-endian lengths, which is what the wire
// payload requires). Framing of a byte stream into access units is left to the container
// demuxer (fMP4 gives exact per-sample boundaries); this module works one access unit at a time.

export const AnnexB = 'annexb';
export const Avcc = 'avcc';

export class MediaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaError';
  }
}

/** NAL units of one access unit; throws on a truncated or malformed stream. */
export function units(data, format = AnnexB) {
  const out = [];
  if (format === Avcc) {
    let p = 0;
    while (p < data.length) {
      if (data.length - p < 4) throw new MediaError('Truncated NAL length');
      const n = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
      p += 4;
      if (n === 0 || n > data.length - p) throw new MediaError('Invalid NAL length');
      out.push(data.subarray(p, p + n));
      p += n;
    }
    return out;
  }
  let i = 0;
  let zeros = 0;
  let start = -1;
  const push = (end) => {
    if (end <= start) throw new MediaError('Empty NAL unit');
    out.push(data.subarray(start, end));
  };
  while (i < data.length) {
    if (data[i] === 1 && zeros >= 2) {
      const prefix = i - zeros;
      if (start >= 0) push(prefix);
      else if (prefix !== 0) throw new MediaError('Unexpected bytes before start code');
      start = i + 1;
      zeros = 0;
      i++;
      continue;
    }
    if (start < 0 && data[i] !== 0) throw new MediaError('Missing Annex B start code');
    zeros = data[i] === 0 ? zeros + 1 : 0;
    i++;
  }
  if (start < 0) throw new MediaError('Missing Annex B start code');
  push(data.length - zeros);
  return out;
}

export function annexBToAvcc(data) {
  const list = units(data, AnnexB);
  let size = 0;
  for (const u of list) size += 4 + u.length;
  const out = new Uint8Array(size);
  let p = 0;
  for (const u of list) {
    out[p++] = (u.length >>> 24) & 255;
    out[p++] = (u.length >>> 16) & 255;
    out[p++] = (u.length >>> 8) & 255;
    out[p++] = u.length & 255;
    out.set(u, p);
    p += u.length;
  }
  return out;
}

export function avccToAnnexB(data) {
  const list = units(data, Avcc);
  let size = 0;
  for (const u of list) size += 4 + u.length;
  const out = new Uint8Array(size);
  let p = 0;
  for (const u of list) {
    out[p++] = 0;
    out[p++] = 0;
    out[p++] = 0;
    out[p++] = 1;
    out.set(u, p);
    p += u.length;
  }
  return out;
}

/** nal_unit_type of every unit in the access unit, in order. */
export function nalTypes(data, format = AnnexB) {
  return units(data, format).map((u) => u[0] & 31);
}

/** An access unit is a key frame when it carries an IDR slice (nal_unit_type 5). */
export function isKeyFrame(data, format = AnnexB) {
  return units(data, format).some((u) => (u[0] & 31) === 5);
}

/** The first SPS and PPS of an access unit, in whichever container the unit uses. */
export function parameterSets(data, format = Avcc) {
  let sps = null;
  let pps = null;
  for (const u of units(data, format)) {
    const type = u[0] & 31;
    if (type === 7 && !sps) sps = u;
    if (type === 8 && !pps) pps = u;
  }
  return { sps, pps };
}
