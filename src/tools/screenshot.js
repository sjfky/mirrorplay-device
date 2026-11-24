#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Save a PNG of one of the relay's pages, for the README and for a quick look at what a receiver is
// showing right now. Drives Chromium over CDP, the same way browser-check.js does, and waits until
// the page reports it has picture rather than sleeping a guessed number of seconds.
//
//   node src/tools/screenshot.js --url http://127.0.0.1:3000/receiver --out docs/images/receiver.png
//   node src/tools/screenshot.js --url http://127.0.0.1:3000/admin --out docs/images/admin.png --wait-for "document.querySelectorAll('table tr').length > 6"

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { connect, findChrome } from './cdp.js';

const { values: flags } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    'wait-for': { type: 'string', default: 'document.body !== null' },
    timeout: { type: 'string', default: '20000' },
    chrome: { type: 'string' },
  },
});

if (!flags.url || !flags.out) {
  console.error('usage: node src/tools/screenshot.js --url <page> --out <file.png> [--wait-for <js>]');
  process.exit(2);
}

const chrome = findChrome(flags.chrome);
if (!chrome) {
  console.error('no Chromium found: pass --chrome <path> or set CHROME_PATH');
  process.exit(2);
}

const browser = await connect(chrome, {
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
  const page = await browser.openPage(flags.url, { width: Number(flags.width), height: Number(flags.height) });
  const deadline = Date.now() + Number(flags.timeout);
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate(`return (${flags['wait-for']}) ? true : false;`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  const shot = await page.screenshot();
  const target = resolve(flags.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(shot.data, 'base64'));
  console.log(`${ready ? 'captured' : 'captured without the wait condition being met'}: ${target}`);
} finally {
  await browser.close();
}
