// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The web-app route: putting this on a phone without any .ipa, certificate, or Mac.
//
// A home-screen web app is the only install path available to somebody who cannot sign, so it gets
// tested instead of being asserted. These are the checks that bite in practice: the pairing token
// surviving into `start_url` (an installed icon that opens with no token is a dead shortcut), icons
// that resolve and are the size the manifest claims (a stale or mislabeled PNG is invisible in a
// diff), and no absolute host baked in, because the relay is reached by LAN address, not by
// "localhost" on the phone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3145;
const TOKEN = 'pwa-test-token';
const origin = `http://127.0.0.1:${PORT}`;

// The two surfaces a phone can install, and the page each one is linked from.
const SURFACES = [
  { page: '/receiver', manifest: '/receiver/manifest.webmanifest', label: 'head unit' },
  { page: '/input', manifest: '/input/manifest.webmanifest', label: 'device' },
];

let relay;

test.before(async () => {
  relay = spawn('node', [join(ROOT, 'src/cli.js'), '--port', String(PORT), '--token', TOKEN, '--source', 'none'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const probe = await fetch(`${origin}/version`);
      if (probe.ok) return;
    } catch {
      /* still starting */
    }
    await sleep(150);
  }
  throw new Error('the relay never came up for the web-app tests');
});

test.after(() => {
  try {
    process.kill(-relay.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
});

async function text(path) {
  const response = await fetch(`${origin}${path}`);
  assert.ok(response.ok, `${path} → ${response.status}`);
  return response.text();
}

async function json(path) {
  const response = await fetch(`${origin}${path}`);
  assert.ok(response.ok, `${path} → ${response.status}`);
  return { body: await response.json(), type: response.headers.get('content-type') ?? '' };
}

test('each installable page links a manifest, served as a manifest', async () => {
  for (const surface of SURFACES) {
    const html = await text(surface.page);
    assert.ok(
      html.includes(`href="${surface.manifest}"`),
      `${surface.page} should link ${surface.manifest}; nothing a browser cannot find is installed`,
    );

    const { body, type } = await json(surface.manifest);
    assert.match(type, /^application\/manifest\+json/, `${surface.manifest} is served as ${type}`);
    assert.match(body.name, new RegExp(surface.label, 'i'), `the installed app must be called after what it does: ${body.name}`);
    assert.equal(body.display, 'standalone', 'an installed projection viewer that opens inside browser chrome is not installed');
    assert.equal(body.scope, '/', 'the scope has to cover the socket and the state endpoints');
    assert.ok(Array.isArray(body.icons) && body.icons.length >= 2, 'a manifest without usable icons is decoration');
    assert.equal(body.short_name.length <= 12, true, `short_name is what fits under an icon: "${body.short_name}"`);
  }
});

test('the pairing token survives into start_url, which is the point of generating it', async () => {
  for (const surface of SURFACES) {
    const { body } = await json(surface.manifest);
    assert.ok(body.start_url.startsWith(surface.page), `start_url ${body.start_url} should open ${surface.page}`);
    const query = new URLSearchParams(body.start_url.split('?')[1] ?? '');
    assert.equal(query.get('token'), TOKEN, 'a home-screen app that opens unpaired is a dead shortcut');
    assert.equal(query.get('installed'), '1', 'the page has to be able to tell it was launched from the home screen');
  }
});

test('nothing in a manifest hard-codes where the relay lives', async () => {
  for (const surface of SURFACES) {
    const raw = await text(surface.manifest);
    assert.doesNotMatch(raw, /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i, `${surface.manifest} names a host; a phone on the LAN would follow it into nowhere`);
    const { body } = await json(surface.manifest);
    for (const field of [body.start_url, body.scope, ...body.icons.map((icon) => icon.src)]) {
      assert.ok(field.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(field) === false || field.startsWith('/'), `${field} must be relative`);
    }
  }
});

test('every icon the manifest advertises exists, is a PNG, and is the size it claims', async () => {
  const { body } = await json(SURFACES[0].manifest);
  for (const icon of body.icons) {
    const match = /^(\d+)x(\d+)$/.exec(icon.sizes);
    assert.ok(match, `sizes should read like 512x512, got "${icon.sizes}"`);
    const response = await fetch(`${origin}${icon.src}`);
    assert.equal(response.status, 200, `${icon.src} is advertised but not served`);
    assert.match(response.headers.get('content-type') ?? '', /image\/png/, `${icon.src} is not a PNG`);

    // IHDR is the only honest statement of what an image is: width and height, big-endian, at 16 and 20.
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${icon.src} is not a PNG file`);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.equal(width, Number(match[1]), `${icon.src} is ${width}px wide but advertised ${match[1]}x${match[2]}`);
    assert.equal(height, Number(match[2]), `${icon.src} is ${height}px tall but advertised ${match[1]}x${match[2]}`);
  }
});

test('the icon iOS actually uses is linked from the page, not only listed in the manifest', async () => {
  // iPhone home screens take apple-touch-icon from HTML and ignore the manifest's icon list, so a
  // manifest-only setup installs as a blank square and looks like a broken app rather than a partial
  // one.
  for (const surface of SURFACES) {
    const html = await text(surface.page);
    const link = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html);
    assert.ok(link, `${surface.page} has no apple-touch-icon link`);
    const response = await fetch(`${origin}${link[1]}`);
    assert.equal(response.status, 200, `${link[1]} is linked but not served`);
    assert.match(html, /viewport-fit=cover/, 'a notched phone whose safe area is ignored puts the picture and the taps out of register');
  }
});

test('the landing page tells a person what to do with a phone, in order', async () => {
  const html = await text('/');
  assert.match(html, /home screen/i, 'installing on iPhone is the no-signing path; the page that nobody reads is the page that does not exist');
  assert.match(html, /Safari/i, 'iOS installs from Safari, so the instruction has to say so');
  assert.match(html, /Add to Home Screen|添加到主屏幕/i);
});
