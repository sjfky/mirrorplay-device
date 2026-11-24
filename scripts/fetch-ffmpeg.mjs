// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Fetch a static ffmpeg build into bin/, which is what the synthetic source and the browser check
// use. ffmpeg is a separate program run as a child process over pipes; nothing in this repository
// links against it, and it stays under its own license.
//
//   npm run ffmpeg:get

import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { existsSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const target = join(HERE, '..', 'bin', 'ffmpeg');
const platform = `${process.platform}-${process.arch}`;
const urls = {
  'linux-x64': 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64',
  'linux-arm64': 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-arm64',
  'darwin-arm64': 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-arm64',
  'darwin-x64': 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-x64',
  'win32-x64': 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64',
};

if (existsSync(target)) {
  const version = spawnSync(target, ['-version'], { encoding: 'utf8' });
  console.log(`bin/ffmpeg is already here: ${version.stdout?.split('\n')[0] ?? version.error?.message}`);
  process.exit(0);
}

const url = urls[platform];
if (!url) {
  console.error(`no known static build for ${platform}; install ffmpeg and pass --ffmpeg <path> to the relay`);
  process.exit(1);
}

console.log(`downloading ${url}`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok || !response.body) {
  console.error(`download failed (${response.status}); install ffmpeg yourself and pass --ffmpeg <path>`);
  process.exit(1);
}
const stream = createWriteStream(`${target}.part`);
response.body.pipeTo(stream);
await new Promise((ok, fail) => {
  stream.on('finish', ok);
  stream.on('error', fail);
});
chmodSync(`${target}.part`, 0o755);
renameSync(`${target}.part`, target);
const check = spawnSync(target, ['-version'], { encoding: 'utf8' });
console.log(`ready: ${check.stdout?.split('\n')[0] ?? check.stderr}`);
