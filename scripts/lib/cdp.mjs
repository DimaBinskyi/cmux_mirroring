// Minimal Chrome DevTools Protocol client: launches the headless Chromium that
// ships with Playwright and talks to it over the WebSocket built into Node.
// Enough to load a page, run JS in it, synthesize real scroll gestures, and
// collect console errors — no browser automation dependency.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, width = 430, height = 900 } = {}) {
  const shell = fs.globSync(`${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell`)
    .sort().pop();
  if (!shell) throw new Error('no headless chromium found (install Playwright browsers)');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cmux-cdp-'));
  const child = spawn(shell, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-sandbox', '--disable-gpu', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 50 && !wsUrl; i += 1) {
    await sleep(200);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {
      /* still starting */
    }
  }
  if (!wsUrl) throw new Error('devtools never came up');

  const ws = new WebSocket(wsUrl);
  await new Promise((res) => { ws.onopen = res; });

  let seq = 0;
  const waiting = new Map();
  const problems = [];

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg.result);
      waiting.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`exception: ${d.exception?.description || d.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  };

  const send = (method, params = {}) => new Promise((res) => {
    seq += 1;
    waiting.set(seq, res);
    ws.send(JSON.stringify({ id: seq, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  return {
    send,
    evaluate,
    problems,
    goto: (url) => send('Page.navigate', { url }),
    // xDistance/yDistance are positive to scroll left / up, per CDP.
    scroll: (x, y, xDistance, yDistance, speed = 800) => send('Input.synthesizeScrollGesture', {
      x, y, xDistance, yDistance, speed, gestureSourceType: 'touch', repeatCount: 0,
    }),
    close: () => {
      ws.close();
      child.kill();
      // The browser keeps writing to its profile for a moment after the kill.
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
