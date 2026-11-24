// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Bit reader over an H.264/HEVC NAL payload with emulation-prevention (0x03) removal applied,
// mirroring what a byte-oriented Exp-Golomb reader needs.

export class Bits {
  constructor(bytes, offset = 0) {
    const raw = bytes;
    const out = new Uint8Array(raw.length);
    let n = 0;
    for (let i = offset; i < raw.length; i++) {
      if (i + 2 < raw.length && raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 3) {
        out[n++] = 0;
        out[n++] = 0;
        i += 2;
        continue;
      }
      out[n++] = raw[i];
    }
    this.data = out.subarray(0, n);
    this.pos = 0; // bit position
  }

  u(n) {
    if (n > 32) throw new RangeError(`cannot read ${n} bits at once`);
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v >>> 0;
  }

  flag() {
    return this.u(1) === 1;
  }

  ue() {
    let zeros = 0;
    while (this.pos < this.data.length * 8 && this.u(1) === 0) zeros++;
    if (zeros >= 32) throw new RangeError('invalid exp-golomb prefix');
    let v = (1 << zeros) - 1;
    return zeros > 0 ? v + this.u(zeros) : v;
  }

  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}
