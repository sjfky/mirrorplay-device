#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Render the icons the phone actually installs from src/web/icons/app-icon.svg, at the sizes iOS
// asks for, and write the PNGs next to the source.
//
//   npm run icons        # needs a Chromium/Chrome; --chrome <path> or CHROME_PATH to point at one
//
// Why a generator at all: iOS refuses SVG touch icons, so the PNGs have to exist. They are committed,
// because a repository whose test suite fails until somebody runs a rendering step is a repository
// that ships a broken default — and 24 KiB of icons is not a blob worth that trade. The SVG stays the
// source of truth: edit it, re-run this, and test/pwa.test.js will complain if what is served no
// longer matches what a manifest advertises.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, findChrome } from '../src/tools/cdp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values: flags } = parseArgs({
  options: {
    chrome: { type: 'string' },
    out: { type: 'string', default: join(ROOT, 'src', 'web', 'icons') },
    sizes: { type: 'string', default: '180,192,512' },
  },
});

// iOS looks for `apple-touch-icon.png` (180×180 on modern iPhones) when a web page is added to the
// home screen. The manifest sizes are for the case where a real app wrapper does exist.
const requested = flags.sizes.split(',').map((n) => Number.parseInt(n, 10)).filter((n) => n > 0);
if (!requested.length) {
  console.error('--sizes wants a comma list, e.g. 180,192,512');
  process.exit(2);
}

const chrome = findChrome(flags.chrome);
if (!chrome) {
  console.error('no Chromium found: --chrome <path>, or set CHROME_PATH');
  process.exit(2);
}

const pageUrl = `file://${join(ROOT, 'src', 'web', 'icon.html')}`;
if (!existsSync(join(ROOT, 'src', 'web', 'icon.html'))) {
  console.error(`missing ${pageUrl}`);
  process.exit(2);
}

const browser = await connect(chrome);
let failures = 0;
try {
  for (const size of requested) {
    const page = await browser.openPage('about:blank');
    // The page fills the viewport with the icon, so the viewport *is* the icon size.
    await page.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    await page.navigate(pageUrl);
    // waitFor treats its argument as an async function body: without `return` it yields undefined,
    // waits the whole timeout, and looks like a broken renderer rather than a missing keyword.
    await page.waitFor(`
      const image = document.images[0];
      return Boolean(image && image.complete && image.naturalWidth > 0);
    `, `${size}px icon rendered`, 15000);
    const shot = await page.screenshot();
    const png = Buffer.from(shot.data, 'base64');
    const target = join(flags.out, `mirrorplay-${size}.png`);
    writeFileSync(target, png, { mode: 0o644 });
    // Reading the header back is the only way to know the renderer produced the geometry asked for;
    // a file that merely exists is not evidence of anything.
    const signature = png.subarray(0, 8).toString('hex');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const ok = signature === '89504e470d0a1a0a' && width === size && height === size;
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${target} ${width}x${height} ${(png.length / 1024).toFixed(1)} KiB`);
  }
  if (requested.includes(180)) {
    const source = join(flags.out, 'mirrorplay-180.png');
    const touch = join(flags.out, 'apple-touch-icon.png');
    readFileSync(source);
    writeFileSync(touch, readFileSync(source));
    console.log(`✓ ${touch} (iOS 添加到主屏幕用的正是这个文件名)`);
  }
} finally {
  await browser.close();
}

if (failures) {
  console.error(`${failures} icon(s) did not come out at the requested size`);
  process.exit(1);
}
