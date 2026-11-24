// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The relay's clock. It counts from the process start rather than from the wall calendar, for the
// same reason the real relay does: a device in a car has no network and often no valid date when it
// boots, and a projection timeline must not care. Everything that leaves the relay in
// `senderClockUs`, and everything the media timeline is anchored to, comes from this one line.

export class Clock {
  constructor(Date = globalThis.Date, hrtime = process.hrtime) {
    this.origin = hrtime.bigint();
    this.epochUs = BigInt(Date.now()) * 1000n;
    this.hrtime = hrtime;
  }

  /** Microseconds since the relay started. Internal bookkeeping, immune to clock steps. */
  nowUs() {
    return (this.hrtime.bigint() - this.origin) / 1000n;
  }

  /**
   * The same line, expressed as microseconds since the Unix epoch, which is the only line a browser
   * can compare its own clock with. A `ping`/`pong` exchange measures the difference between the two
   * on a receiver, and `senderClockUs` on every media envelope is on this line.
   */
  epochAt(us = this.nowUs()) {
    return this.epochUs + us;
  }

  nowMs() {
    return Number(this.nowUs()) / 1000;
  }

  /** Uptime of the relay, for the operator pages. */
  since(startUs) {
    return Number(this.nowUs() - BigInt(startUs)) / 1000;
  }
}

/** Offset of the relay clock relative to a receiver's clock, plus the round trip, in microseconds. */
export function clockExchange(t0Us, t1Us, t2Us) {
  const [t0, t1, t2] = [t0Us, t1Us, t2Us].map((value) => typeof value === 'bigint' ? value : BigInt(value));
  return { rttUs: t2 - t0, offsetUs: t1 - (t0 + t2) / 2n };
}
