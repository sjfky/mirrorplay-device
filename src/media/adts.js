// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// ADTS → raw AAC frames. The audio source is ffmpeg's `-f adts` output; `audio-format` on the
// wire carries the codec, rate and channels, and every audio payload is one frame without its
// ADTS header, which is what an AudioDecoder configured as 'mp4a.40.2' takes.

import { MediaError } from './nal.js';

export const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export class AdtsStream {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.accessUnits = 0;
  }

  /** returns [{ aac, sampleRate, channels, objectType, accessUnit }] in stream order. */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      if (this.buf.length < 7) break;
      if (this.buf[0] !== 0xff || (this.buf[1] & 0xf0) !== 0xf0) {
        this.buf = this.buf.subarray(1); // resynchronise after a lost boundary
        continue;
      }
      const length = ((this.buf[3] & 3) << 11) | (this.buf[4] << 3) | (this.buf[5] >> 5);
      const header = this.buf[1] & 1 ? 7 : 9;
      if (length < header || length > this.buf.length) break;
      const frame = this.buf.subarray(0, length);
      this.buf = this.buf.subarray(length);
      const index = (frame[2] >> 2) & 15;
      if (index === 15) throw new MediaError('ADTS with an explicit sample rate is not supported');
      const sampleRate = SAMPLE_RATES[index];
      if (!sampleRate) throw new MediaError('ADTS frequency index is reserved');
      out.push({
        aac: frame.subarray(header, length),
        sampleRate,
        channels: ((frame[2] & 1) << 2) | (frame[3] >> 6),
        objectType: ((frame[2] >> 6) & 3) + 1,
        accessUnit: this.accessUnits++,
      });
    }
    return out;
  }
}

/** AudioSpecificConfig for `audio-format.config`, the short form an esds descriptor carries. */
export function audioSpecificConfig(objectType, sampleRate, channels) {
  const index = SAMPLE_RATES.indexOf(sampleRate);
  if (index < 0) throw new MediaError(`sample rate ${sampleRate} has no ADTS index`);
  return new Uint8Array([(objectType << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3)]);
}
