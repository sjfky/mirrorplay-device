// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The .ipa container step, tested against bundles of every shape.
//
// Packaging is the one part of the iOS leg whose correctness can be established without an Apple
// toolchain, so it gets the same treatment as the wire codec — refusals included, because a refusal
// is what stops somebody shipping an .ipa that dies at launch on a phone that had to be driven to a
// car.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'device-ios', 'package-ipa.sh');
const SANDBOX = join(HERE, '..', '.ipa-test');

// What real build products start with: a 64-bit Mach-O header, or a fat archive header.
const MACHO64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

function have(tools) {
  const probe = spawnSync('/bin/sh', ['-c', `command -v ${tools.join(' ')}`], { encoding: 'utf8' });
  return probe.status === 0;
}

function bundle(name, { executable = 'Demo', binary = null, named = null } = {}) {
  const path = join(SANDBOX, `${name}.app`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const keys = [
    `<key>CFBundleIdentifier</key><string>org.example.${name.toLowerCase()}</string>`,
    '<key>CFBundleShortVersionString</key><string>0.1.0</string>',
  ];
  if (executable) keys.unshift(`<key>CFBundleExecutable</key><string>${executable}</string>`);
  keys.sort();
  writeFileSync(join(path, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${keys.join('')}</dict></plist>`);
  if (binary) {
    // `named` lets a bundle hold a binary under a different filename than Info.plist claims, which is
    // its own failure mode: something to sign, but not the thing the plist points at.
    const target = join(path, named ?? executable);
    writeFileSync(target, binary);
    chmodSync(target, 0o755);
  }
  return { path, out: join(SANDBOX, `${name}.ipa`) };
}

function packager({ path, out, expect, env = {} }) {
  rmSync(out, { force: true });
  const run = spawnSync('/bin/sh', [SCRIPT, path, out], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, expect, `expected exit ${expect}, got ${run.status}\n${text}`);
  return text;
}

function listing(out) {
  const run = spawnSync('unzip', ['-Z1', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, `unzip -Z1 failed: ${run.stderr}`);
  return run.stdout.trim().split('\n');
}

test('a 64-bit Mach-O build product becomes a Payload-only archive', (t) => {
  if (!have(['zip', 'unzip', 'od', 'awk', 'du'])) return t.skip('needs zip, unzip, od, awk, du');
  const app = bundle('Good', { binary: Buffer.concat([MACHO64, Buffer.from([0x0c, 0, 0, 0x10, 0, 0, 0, 0]), Buffer.alloc(64)]) });

  const report = packager({ ...app, expect: 0 });
  assert.match(report, /64-bit Mach-O/);
  assert.match(report, /org\.example\.good/);
  assert.match(report, /unsigned/);

  const entries = listing(app.out);
  assert.ok(entries.length >= 3, `the bundle contents must be inside, saw ${entries.length} entries`);
  assert.ok(entries.every((entry) => entry === 'Payload' || entry.startsWith('Payload/')), `everything sits under Payload/: ${entries.join(' ')}`);
  assert.ok(entries.includes('Payload/Good.app/Demo'), 'the executable itself survived the copy');
  assert.ok(existsSync(app.out), 'the .ipa was written');
});

test('a fat archive is accepted, and is not described using file(1)', (t) => {
  if (!have(['zip', 'unzip', 'od', 'awk', 'du'])) return t.skip('needs zip, unzip, od, awk, du');
  const app = bundle('Fat', { binary: Buffer.concat([FAT, Buffer.alloc(36)]) });
  const report = packager({ ...app, expect: 0 });
  assert.match(report, /fat archive/);
  // file(1) reads 0xcafebabe as Java class data. Quoting that about an app binary would read as a
  // wrong answer about the artifact rather than as a limitation of the tool.
  assert.doesNotMatch(report, /Java class/i, report);
});

test('a bundle without a real binary is refused and leaves nothing behind', (t) => {
  if (!have(['zip', 'unzip', 'od', 'awk', 'du', 'file'])) return t.skip('needs zip, unzip, od, awk, du, file');

  const placeholder = bundle('Placeholder', { binary: Buffer.from('# written by hand, not compiled\n') });
  const first = packager({ ...placeholder, expect: 1 });
  assert.match(first, /does not begin with a Mach-O magic/);
  assert.ok(!existsSync(placeholder.out), 'a refused bundle must not leave an .ipa behind');

  const noBinary = bundle('NoBinary');
  assert.match(packager({ ...noBinary, expect: 1 }), /names a file that is not in the bundle/);

  const noName = bundle('NoExecutable', { executable: '' });
  assert.match(packager({ ...noName, expect: 1 }), /no CFBundleExecutable/);

  // Info.plist names Ghost while the bundle holds Demo: a real mismatch, and the file that exists is
  // not the one a signature would cover.
  const wrongName = bundle('WrongName', { executable: 'Ghost', named: 'Demo', binary: Buffer.concat([MACHO64, Buffer.alloc(16)]) });
  const report = packager({ ...wrongName, expect: 1 });
  assert.match(report, /names a file that is not in the bundle: Ghost/, report);
});

test('a directory that is not a bundle is refused before anything is read', (t) => {
  const strays = [
    { name: 'Sources', mkdir: true },
    { name: 'Absent', mkdir: false },
  ];
  for (const { name, mkdir } of strays) {
    const path = join(SANDBOX, `${name}.app`);
    rmSync(path, { recursive: true, force: true });
    if (mkdir) mkdirSync(path, { recursive: true });
    const out = join(SANDBOX, `${name}.ipa`);
    const report = packager({ path, out, expect: 2 });
    assert.match(report, mkdir ? /has no Info\.plist/ : /no such \.app bundle/, report);
    assert.ok(!existsSync(out), `${name}: a refusal must not write an archive`);
  }
});

test('a plist reader is believed only when it answers like one', () => {
  // Two PATH shapes, because two real machines differ exactly this way. A Mac's plutil understands
  // `-extract` and is used. The plutil bundled inside the Swift-for-Linux toolchain is on PATH, has no
  // `-extract`, and answers with its own usage text — which, taken at face value, becomes the bundle
  // identifier. That is not a hypothetical: three tests here started failing only when that toolchain
  // happened to be on PATH, so the behaviour is pinned instead of explained.
  const hostile = join(HERE, 'fixtures', 'hostile-bin');
  assert.ok(existsSync(join(hostile, 'plutil')), 'the fixture plutil must exist or this test means nothing');

  const plain = bundle('Plain', { binary: Buffer.concat([MACHO64, Buffer.alloc(24)]) });
  const normal = packager({ ...plain, expect: 0 });
  assert.match(normal, /org\.example\.plain/, 'the identifier comes out of the plist, not out of a tool');
  assert.doesNotMatch(normal, /unrecognized option/i, normal);

  const lied = bundle('Lied', { binary: Buffer.concat([MACHO64, Buffer.alloc(24)]) });
  const rescued = packager({ ...lied, expect: 0, env: { PATH: `${hostile}:${process.env.PATH}` } });
  assert.match(rescued, /does not understand -extract/, 'the fallback is announced rather than swallowed');
  assert.match(rescued, /org\.example\.lied/, 'and the bundle still gets the identifier the plist holds');

  // No reader at all: refuse, because an unverifiable bundle is not something to hand to a signing step.
  const blind = bundle('Blind', { binary: Buffer.concat([MACHO64, Buffer.alloc(24)]) });
  const text = packager({ ...blind, expect: 3, env: { PATH: join(HERE, 'fixtures', 'empty-bin') } });
  assert.match(text, /cannot be read|neither/, text);
  assert.ok(!existsSync(blind.out), 'an unverifiable bundle must not leave an .ipa behind');
});

test('the script exists where the docs say it is', () => {
  assert.ok(existsSync(SCRIPT), `${SCRIPT} is missing; README and CI both point at it`);
});
