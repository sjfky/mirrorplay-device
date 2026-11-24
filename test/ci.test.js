// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The CI workflows, checked without a Mac.
//
// A workflow file is executable text. Every inline script in it is extracted and syntax-checked here,
// and each command it invokes must appear in a list of tool names assembled by looking them up rather
// than half-remembering them: `xcodebuild` mistyped as `xcodecodebuild` never fails a review, it
// fails on a paid macOS runner twelve minutes in, with a message nobody reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

// Shell builtins and control words, then every external program these pipelines may call. Anything
// else is treated as a typo until somebody adds it with a reason.
const KNOWN = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac',
  'set', 'unset', 'export', 'local', 'readonly', 'trap', 'return', 'exit', 'break', 'continue',
  'test', 'true', 'false', 'echo', 'printf', 'read', 'shift', 'cd', 'source',
  'awk', 'base64', 'basename', 'cat', 'command', 'cp', 'cut', 'du', 'find', 'grep', 'install', 'ls',
  'mkdir',   'mktemp', 'mv', 'od', 'rm', 'rmdir', 'sed', 'sh', 'sort', 'tail', 'tar', 'tr', 'uniq', 'wc',
  'zip', 'unzip', 'file', 'curl', 'python3', 'node', 'npm', 'git', 'sudo', 'apt-get',
  'xcodebuild', 'xcodegen', 'xcrun', 'swift', 'plutil', 'codesign', 'security', 'lipo', 'defaults',
  'brew',
]);

function workflowFiles() {
  return readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
}

/**
 * Pull out every `run: |` block, dedented. Deliberately line-based: a YAML parser would be a second
 * dependency for the test suite, and block scalars are the only place shell lives in these files.
 */
function inlineScripts(text) {
  const lines = text.split('\n');
  const scripts = [];
  for (let index = 0; index < lines.length; index++) {
    const header = /^(\s*)run:\s*[|>][-+]?\s*$/.exec(lines[index]);
    if (!header) continue;
    const parent = header[1].length;
    const body = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() === '') {
        body.push('');
        cursor++;
        continue;
      }
      const indent = /^\s*/.exec(line)[0].length;
      if (indent <= parent) break;
      body.push(line.slice(parent + 2));
      cursor++;
    }
    while (body.length && body.at(-1) === '') body.pop();
    if (body.length) scripts.push({ at: index + 1, text: body.join('\n') });
    index = cursor - 1;
  }
  return scripts;
}

function parseAsShell(script, file, line) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-shell-'));
  const path = join(dir, 'script.sh');
  writeFileSync(path, `${script}\n`);
  const run = spawnSync('/bin/sh', ['-n', path], { encoding: 'utf8' });
  const message = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  assert.equal(run.status, 0, `${file} (run block near line ${line}) is not valid shell:\n${message}\n---\n${script}`);
}

function commandsIn(script) {
  const found = new Set();
  const lines = script.split('\n');
  for (let index = 0; index < lines.length; index++) {
    let line = (lines[index] ?? '').trim();
    if (!line || line.startsWith('#')) continue;
    // A backslash continuation is one statement: `build archive` on its own line under `xcodebuild …`
    // is that tool's argument list, not a program called "build".
    while (line.endsWith('\\') && index + 1 < lines.length) {
      line = `${line.slice(0, -1).trim()} ${(lines[++index] ?? '').trim()}`;
    }
    // A heredoc body is data. Its terminator (`PLIST`) is not a command, and nothing inside it is.
    const here = /<<[-~]?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(line);
    if (here) {
      let cursor = index + 1;
      while (cursor < lines.length && (lines[cursor] ?? '').trim() !== here[1]) cursor++;
      index = cursor;
    }
    for (const segment of line.split(/\|{1,2}|&&|;/)) {
      const token = (segment.trim().split(/\s+/)[0] ?? '').replace(/[()"'`$]/g, '');
      if (!token || token.startsWith('-') || token.includes('=')) continue;
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(token)) continue;
      found.add(token);
    }
  }
  return [...found];
}

test('the iOS workflow is where the docs say it is', () => {
  const files = workflowFiles();
  assert.ok(files.includes('ios-device.yml'), `expected ios-device.yml, found: ${files.join(', ') || 'nothing'}`);
});

test('every inline CI script parses as shell', () => {
  for (const file of workflowFiles()) {
    const scripts = inlineScripts(readFileSync(join(WORKFLOWS, file), 'utf8'));
    assert.ok(scripts.length >= 2, `${file} should hold several run blocks, found ${scripts.length}`);
    for (const script of scripts) parseAsShell(script.text, file, script.at);
  }
});

test('every CI command is a real tool name', () => {
  const offenders = [];
  for (const file of workflowFiles()) {
    for (const script of inlineScripts(readFileSync(join(WORKFLOWS, file), 'utf8'))) {
      for (const command of commandsIn(script.text)) {
        if (!KNOWN.has(command)) offenders.push(`${file} (line ~${script.at}): ${command}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `unknown commands (typo, or add to KNOWN with a reason):\n  ${offenders.join('\n  ')}`);
});

test('the unsigned container is unconditional, and signing is gated on credentials', () => {
  const text = readFileSync(join(WORKFLOWS, 'ios-device.yml'), 'utf8');
  const packaging = /[ ]*- name: ([^\n]*[Uu]nsigned[^\n]*)\n/.exec(text);
  assert.ok(packaging, 'a step that packages the unsigned Payload archive must exist');
  // Up to the next step, not a fixed window: the window used to run past this step and read the
  // gating of the *signing* step as if it belonged to packaging.
  const after = text.indexOf('- name:', packaging.index + packaging[0].length);
  const block = text.slice(packaging.index, after === -1 ? text.length : after);
  assert.match(block, /package-ipa\.sh/, 'that step must call the script the rest of this suite tests');
  assert.doesNotMatch(block, /\n\s*if:/, 'the unsigned archive is produced whether or not a Team ID was given');

  assert.match(text, /if:\s*\$\{\{\s*inputs\.team_id != ''\s*\}\}/, 'the signed export must be gated on inputs.team_id');
  assert.match(text, /IOS_SIGNING_CERT_P12_BASE64/, 'and it must stop when the certificate secret is missing rather than call an unsigned file signed');
});
