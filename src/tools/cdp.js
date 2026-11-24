// SPDX-FileCopyrightText: 2026 mirrorplay contributors
// SPDX-License-Identifier: AGPL-3.0-only
// The small slice of the Chrome DevTools Protocol these tools need: start a headless Chromium, open
// a page, run an expression in it, take a screenshot, close. Written against CDP directly so the
// prototype has no test framework and no driver dependency beyond `ws`.
//
// Both browser-check.js and screenshot.js use this. Expressions are the body of an async function
// and have to `return` whatever the caller wants; anything thrown inside the page comes back as an
// error with the page's own text, and page exceptions are collected as diagnostics.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome',
  '/opt/playwright-browsers/chromium-1208/chrome-linux64/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findChrome(explicit) {
  for (const candidate of [explicit, ...CHROME_CANDIDATES]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const BASE_ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--remote-allow-origins=*',
  '--autoplay-policy=no-user-gesture-required',
];

export async function connect(chrome, { debugPort = 0, args = [], port = null } = {}) {
  const chosenPort = port ?? await freePort();
  const child = spawn(chrome, [...BASE_ARGS, `--remote-debugging-port=${chosenPort}`, ...args], { stdio: 'ignore' });
  const endpoint = await waitForDevtools(chosenPort, child);
  const ws = new WebSocket(endpoint);
  await new Promise((ok, fail) => {
    ws.on('open', ok);
    ws.on('error', fail);
  });
  return new Browser(ws, child, chosenPort);
}

class Browser {
  constructor(ws, child, port) {
    this.ws = ws;
    this.child = child;
    this.port = port;
    this.next = 1;
    this.waiters = new Map();
    this.pages = [];
    this.diagnostics = [];
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method) {
        if (message.method === 'Runtime.exceptionThrown') {
          this.diagnostics.push(`exception: ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text}`);
        } else if (message.method === 'Log.entryAdded' && message.params.entry?.level === 'error') {
          this.diagnostics.push(`${message.params.entry.source}: ${message.params.entry.text}`);
        }
        return;
      }
      const pending = this.waiters.get(message.id);
      if (!pending) return;
      this.waiters.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async openPage(url, { width = 1280, height = 800 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    this.pages.push(page);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable').catch(() => {});
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.navigate(url);
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await page.evaluate('return document.readyState').catch((error) => {
        this.diagnostics.push(`evaluate failed: ${error.message}`);
        return null;
      });
      if (state === 'complete') return page;
      await sleep(100);
    }
    throw new Error(`${url} never finished loading\n  ${this.diagnostics.slice(-5).join('\n  ')}`);
  }

  async close() {
    await this.send('Browser.close').catch(() => {});
    this.ws.close();
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  /** The expression is an async function body: it must `return` the value the caller wants. */
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression: `(async () => {\n${expression}\n})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
      this.browser.diagnostics.push(detail);
      throw new Error(detail);
    }
    return response.result?.value;
  }

  async text(selector) {
    return this.evaluate(`return document.querySelector(${JSON.stringify(selector)})?.textContent ?? null;`);
  }

  async click(selector) {
    return this.evaluate(`
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return 'missing';
      node.click();
      return true;
    `);
  }

  async waitFor(expression, what = 'condition', timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression).catch((error) => `error: ${error.message}`);
      if (last) return last;
      await sleep(250);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (last value: ${JSON.stringify(last)})`);
  }

  /** Move this tab somewhere else, at whatever size the caller set. */
  async navigate(url) {
    await this.send('Page.navigate', { url });
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await this.evaluate('return document.readyState').catch(() => null);
      if (state === 'complete') return true;
      await sleep(100);
    }
    throw new Error(`${url} never finished loading`);
  }

  screenshot() {
    return this.send('Page.captureScreenshot', { format: 'png' });
  }
}

async function waitForDevtools(port, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`chromium exited early (code ${child.exitCode})`);
    try {
      const info = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch {
      /* the browser is still starting */
    }
    await sleep(150);
  }
  throw new Error('chromium did not open its DevTools endpoint');
}

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}
