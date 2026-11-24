#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Browser verification against a relay that is already running. This drives a real Chromium over
// CDP, the way a car browser would be driven, and checks the parts only a browser can prove:
// WebCodecs decodes what the relay sends, a tap leaves the head unit, a device taking over does not
// break the receiver, and the self-check page really decodes a frame.
//
//   node src/cli.js --port 3000 --token demo --source ffmpeg &
//   node src/tools/browser-check.js --relay-port 3000 --token demo
//
// The device leg uses Chromium's fake camera, so it runs unattended. Where a step needs the *page's*
// touch handler, it is exercised on the relay's counters after a real dispatched pointer event; where
// it needs the leg from the relay back to the device, a scripted head unit sends the touch instead,
// because a background tab in headless Chromium does not always deliver synthetic pointer events to
// the page. That difference is noted on the check itself.

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { connect, findChrome } from './cdp.js';
import { FakeHeadUnit } from './fake-head-unit.js';

const { values: flags } = parseArgs({
  options: {
    'relay-port': { type: 'string', default: '3000' },
    token: { type: 'string', default: 'mirrorplay' },
    chrome: { type: 'string' },
    'fake-camera': { type: 'boolean', default: true },
  },
});

const origin = `http://127.0.0.1:${flags['relay-port']}`;
const wsOrigin = `ws://127.0.0.1:${flags['relay-port']}`;
const query = `token=${encodeURIComponent(flags.token)}`;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const chrome = findChrome(flags.chrome);
if (!chrome) {
  console.error('no Chromium found: pass --chrome <path> or set CHROME_PATH');
  process.exit(2);
}

const browser = await connect(chrome, {
  args: flags['fake-camera'] ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : [],
});
console.log(`chromium: ${chrome}`);
console.log(`relay:    ${origin} (token ${flags.token})\n`);

let exitCode = 0;
try {
  // ── 1 · the head unit watches the synthetic source ───────────────────────────
  const receiver = await browser.openPage(`${origin}/receiver?${query}`, { width: 1280, height: 800 });
  check('head unit page loads', true, await receiver.text('#phase'));

  const frames = await receiver
    .waitFor(`
      const n = Number(document.getElementById('frames')?.textContent ?? '0');
      return n >= 25 ? n : false;
    `, 'decoded frames', 30000)
    .catch((error) => error.message);
  check('head unit decodes the synthetic source', typeof frames === 'number', `${frames} frames in`);

  const announced = await receiver.evaluate('return document.getElementById("announced")?.innerText ?? "";');
  check('the announced format is H.264 with audio and a view-area', /avc1\./.test(announced) && /AAC_LC/.test(announced) && /view area/.test(announced), announced.replace(/\s+/g, ' ').slice(0, 220));

  const painted = await receiver.evaluate(`
    const canvas = document.querySelector('canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 400) if (data[i] + data[i + 1] + data[i + 2] > 40) lit++;
    return { lit, samples: Math.floor(data.length / 400) };
  `);
  check('the canvas has picture on it', painted.lit > painted.samples * 0.05, `${painted.lit}/${painted.samples} sampled pixels lit`);

  const behind = await receiver.waitFor(
    `
      const ms = window.__state?.latencyMs;
      return ms !== null && ms !== undefined && ms >= 0 && ms < 2000 ? { ms, text: document.getElementById('behind')?.textContent } : false;
    `,
    'a plausible delay against live',
    20000,
  ).catch((error) => ({ error: error.message }));
  check('the receiver measures delay against live', behind.ms !== undefined, JSON.stringify(behind));

  const errors = await receiver.evaluate('return window.__errors ?? [];');
  check('no page errors on the receiver', Array.isArray(errors) && errors.length === 0, JSON.stringify(errors));

  // ── 2 · touch leaves the head unit and reaches the source ────────────────────
  const sceneBefore = (await fetch(`${origin}/state.json`).then((response) => response.json())).options.scene;
  await receiver.evaluate(`
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: rect.left + rect.width * 0.985, clientY: rect.top + rect.height * 0.5, bubbles: true, pointerId: 11, isPrimary: true,
    }));
    canvas.dispatchEvent(new PointerEvent('pointerup', {
      clientX: rect.left + rect.width * 0.985, clientY: rect.top + rect.height * 0.5, bubbles: true, pointerId: 11,
    }));
    return true;
  `);
  await sleep(2500);
  const afterTap = await fetch(`${origin}/state.json`).then((response) => response.json());
  check('a tap on the head unit reaches the relay', afterTap.projection.stats.touchEvents > 0, `${afterTap.projection.stats.touchEvents} touch events counted`);
  check('and the synthetic source reacts to it', afterTap.options.scene !== sceneBefore, `scene ${sceneBefore} → ${afterTap.options.scene}`);

  const modes = await receiver.evaluate(`
    const click = (name) => document.querySelector(\`[data-mode="\${name}"]\`)?.click();
    click('SPEED');
    const speed = window.__state?.mode?.name;
    click('QUALITY');
    const quality = window.__state?.mode?.name;
    click('SMART');
    return { speed, quality, back: window.__state?.mode?.name };
  `);
  check('all three readout modes switch', modes.speed === 'SPEED' && modes.quality === 'QUALITY' && modes.back === 'SMART', JSON.stringify(modes));

  // ── 3 · a device replaces the synthetic source ───────────────────────────────
  const device = await browser.openPage(`${origin}/input?${query}`, { width: 1280, height: 800 });
  await device.click('#camera');
  const encoded = await device
    .waitFor(`
      const packets = window.__deviceState?.packets ?? 0;
      return packets > 10 ? packets : false;
    `, 'the device encoder to produce', 30000)
    .catch((error) => error.message);
  check('the device encodes a real capture', typeof encoded === 'number', `${encoded} frames from the device`);

  const before = Number(await receiver.evaluate('return document.getElementById("frames")?.textContent ?? "0";'));
  const kept = await receiver
    .waitFor(`
      const n = Number(document.getElementById('frames')?.textContent ?? '0');
      return n > ${before} + 15 ? n : false;
    `, 'the head unit to keep playing', 30000)
    .catch((error) => error.message);
  check('the head unit keeps playing from the new source', typeof kept === 'number', `${kept} frames after the swap`);

  const geometry = await receiver.evaluate('return window.__state?.video?.width ?? null;');
  const deviceGeometry = await device.evaluate('return window.__deviceState?.size ?? null;');
  check('and it picked up the device geometry', geometry !== null && String(deviceGeometry ?? '').startsWith(String(geometry)), `receiver ${geometry} px · device ${deviceGeometry}`);

  // The relay → device leg, with a scripted head unit: a background tab in headless Chromium does
  // not reliably deliver synthetic pointer events to the page's own handler (the leg above did, in a
  // focused tab), and what matters here is that the envelope arrives unchanged.
  const unit = new FakeHeadUnit({ url: `${wsOrigin}/wire`, token: flags.token });
  await unit.connect();
  await unit.until((watcher) => watcher.received.video > 0, 'the scripted head unit catching up');
  unit.touch([{ id: 4, pressed: true, x: 0.25, y: 0.35 }]);
  await sleep(1200);
  const echoed = await device.evaluate(`
    const line = (document.getElementById('log')?.textContent ?? '').split(String.fromCharCode(10)).find((each) => each.includes('touch'));
    return JSON.stringify({ line: line ?? null, contacts: window.__deviceState?.contacts ?? 0 });
  `);
  const seen = JSON.parse(echoed);
  check('the device draws a head unit touch into its own picture', seen.contacts > 0 && /#4 /.test(seen.line ?? ''), `${seen.line ?? 'no touch line'} · contacts ${seen.contacts}`);
  await unit.close();

  // ── 4 · the capability page, the honest answer to "will my screen work" ──────
  const probe = await browser.openPage(`${origin}/check?${query}`, { width: 1280, height: 900 });
  const verdict = await probe.waitFor(
    `
      const text = document.getElementById('verdict')?.textContent ?? '';
      return /can show the projection|cannot|no WebCodecs/.test(text) ? text : false;
    `,
    'the self-check verdict',
    30000,
  ).catch((error) => error.message);
  const decodeRows = await probe.evaluate(`
    return [...document.querySelectorAll('#decode td')].map((td) => td.textContent).join(' | ').slice(0, 200);
  `);
  check('the self-check decodes a frame from this relay', /can show the projection/.test(String(verdict)), decodeRows);

  const failed = results.filter((result) => !result.ok);
  if (browser.diagnostics.length) console.log(`\npage diagnostics:\n  ${browser.diagnostics.slice(-10).join('\n  ')}`);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
}

process.exit(exitCode);
