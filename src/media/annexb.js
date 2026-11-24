// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Annex B stream → access units. The encoder source runs libx264 with `aud=1`, so every access
// unit starts with an access unit delimiter (nal_unit_type 9) and the cut is exact. A second rule
// (parameter set after a slice) covers encoder streams that carry no delimiters.

import { AnnexB, annexBToAvcc, isKeyFrame, nalTypes } from './nal.js';

const AUD = 9;
const SPS = 7;
const SLICE = [1, 2, 3, 4, 5];

export class AccessUnitSplitter {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** Feed encoder bytes; returns the access units that became complete. */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      const marks = startCodes(this.buf);
      if (marks.prefixes.length < 2) break;
      const cut = nextBoundary(marks);
      if (cut < 0) break;
      const head = this.buf.subarray(marks.prefixes[0], cut);
      this.buf = this.buf.subarray(cut);
      const types = nalTypes(head, AnnexB);
      if (!types.some((t) => SLICE.includes(t))) continue; // delimiters and parameter sets alone
      out.push({ annexB: head, avcc: annexBToAvcc(head), key: isKeyFrame(head, AnnexB), types });
    }
    return out;
  }

  /**
   * The last access unit of a stream has no following start code to be cut before, so it stays in
   * the buffer until told otherwise. An encoder that is flushing at the end of a file, or a source
   * that is being stopped, owes the receiver that final picture rather than dropping it silently.
   */
  flush() {
    const marks = startCodes(this.buf);
    if (!marks.prefixes.length) {
      this.buf = Buffer.alloc(0);
      return [];
    }
    const head = this.buf.subarray(marks.prefixes[0]);
    this.buf = Buffer.alloc(0);
    const types = nalTypes(head, AnnexB);
    if (!types.some((type) => SLICE.includes(type))) return [];
    return [{ annexB: head, avcc: annexBToAvcc(head), key: isKeyFrame(head, AnnexB), types }];
  }
}

function nextBoundary(marks) {
  for (let i = 1; i < marks.prefixes.length; i++) {
    const type = marks.types[i];
    if (type === AUD) return marks.prefixes[i];
    if (type === SPS && marks.types.slice(0, i).some((t) => SLICE.includes(t))) return marks.prefixes[i];
  }
  return -1;
}

/** Start-code prefix offsets, payload offsets and nal_unit_types found in order in `buf`. */
function startCodes(buf) {
  const prefixes = [];
  const payloads = [];
  const types = [];
  let i = 0;
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) {
        if (i + 3 < buf.length) {
          prefixes.push(i);
          payloads.push(i + 3);
          types.push(buf[i + 3] & 31);
        }
        i += 3;
        continue;
      }
      if (buf[i + 2] === 0 && i + 4 <= buf.length && buf[i + 3] === 1) {
        if (i + 4 < buf.length) {
          prefixes.push(i);
	  payloads.push(i + 4);
          types.push(buf[i + 4] & 31);
        }
        i += 4;
        continue;
      }
    }
    i++;
  }
  return { prefixes, payloads, types };
}
