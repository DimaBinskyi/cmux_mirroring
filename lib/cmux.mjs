// Thin wrapper around the cmux CLI: JSON RPCs, raw CLI calls, and a supervised
// `cmux events` child that survives crashes and resumes from a cursor file.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const BUNDLED = '/Applications/cmux.app/Contents/Resources/bin/cmux';
export const CMUX_BIN = process.env.CMUX_BIN || (fs.existsSync(BUNDLED) ? BUNDLED : 'cmux');

const ENV = {
  ...process.env,
  CMUX_QUIET: '1',
  CMUX_SOCKET_PATH:
    process.env.CMUX_SOCKET_PATH || path.join(os.homedir(), '.local/state/cmux/cmux.sock'),
};

export function cli(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(CMUX_BIN, args, { env: ENV, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`cmux ${args[0]}: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

export async function rpc(method, params = {}) {
  const out = await cli(['rpc', method, JSON.stringify(params)]);
  const text = out.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Try a list of param shapes until one succeeds — used for RPCs whose exact
// signature isn't documented (feed replies, prompt_submit).
export async function rpcTry(method, shapes) {
  let lastErr;
  for (const params of shapes) {
    try {
      return await rpc(method, params);
    } catch (err) {
      lastErr = err;
      if (!/invalid_params|Unknown|missing/i.test(err.message)) throw err;
    }
  }
  throw lastErr;
}

export function readScreen(surfaceId, { scrollback = false, lines = 200 } = {}) {
  const args = ['read-screen', '--surface', surfaceId, '--lines', String(lines)];
  if (scrollback) args.push('--scrollback');
  return cli(args);
}

export function sendText(surfaceId, text) {
  return cli(['send', '--surface', surfaceId, text]);
}

export function sendKey(surfaceId, key) {
  return cli(['send-key', '--surface', surfaceId, key]);
}

export function watchEvents(cursorFile, onEvent, onError = () => {}) {
  let child = null;
  let stopped = false;

  function start() {
    if (stopped) return;
    child = spawn(CMUX_BIN, ['events', '--reconnect', '--cursor-file', cursorFile], {
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event && event.name) onEvent(event);
    });
    child.stderr.on('data', (d) => onError(String(d).trim()));
    child.on('exit', (code) => {
      child = null;
      if (!stopped) {
        onError(`events stream exited (${code}), restarting in 2s`);
        setTimeout(start, 2000);
      }
    });
  }

  start();
  return () => {
    stopped = true;
    if (child) child.kill();
  };
}
