// cmux transport. Primary path: a persistent connection to the cmux control
// socket (newline-delimited JSON, `auth <password>` handshake) — per-call cost
// is ~1-5ms. Fallback path: spawning the cmux CLI (~145ms/call) whenever the
// socket is down, so a cmux restart degrades gracefully instead of breaking.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const BUNDLED = '/Applications/cmux.app/Contents/Resources/bin/cmux';
export const CMUX_BIN = process.env.CMUX_BIN || (fs.existsSync(BUNDLED) ? BUNDLED : 'cmux');

const SOCKET_PATH = process.env.CMUX_SOCKET_PATH
  || path.join(os.homedir(), '.local/state/cmux/cmux.sock');
const PASSWORD_FILE = path.join(os.homedir(), '.local/state/cmux/socket-control-password');

const ENV = { ...process.env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: SOCKET_PATH };

function readPassword() {
  if (process.env.CMUX_SOCKET_PASSWORD) return process.env.CMUX_SOCKET_PASSWORD;
  try {
    return fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

class CmuxSocket {
  constructor() {
    this.sock = null;
    this.connected = false;
    this.buf = '';
    this.id = 0;
    this.pending = new Map();
    this._retry = null;
    this.connect();
  }

  connect() {
    clearTimeout(this._retry);
    let downHandled = false;
    const onDown = () => {
      if (downHandled) return;
      downHandled = true;
      this.connected = false;
      for (const [, p] of this.pending) p.reject(new Error('cmux socket disconnected'));
      this.pending.clear();
      this._retry = setTimeout(() => this.connect(), 1500);
    };
    try {
      this.sock = net.connect(SOCKET_PATH);
    } catch {
      onDown();
      return;
    }
    this.sock.on('connect', () => {
      this.sock.write(`auth ${readPassword()}\n`);
      this.connected = true; // requests queue behind the auth line in order
    });
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', onDown);
    this.sock.on('close', onDown);
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // e.g. "OK: Authenticated"
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(msg.error?.message || 'cmux rpc error'));
      else p.resolve(msg.result ?? {});
    }
  }

  call(method, params = {}, timeout = 15000) {
    if (!this.connected) return Promise.reject(new Error('cmux socket not connected'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cmux ${method}: timeout`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
}

const socketClient = new CmuxSocket();

export function cli(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(CMUX_BIN, args, { env: ENV, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`cmux ${args[0]}: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

async function cliRpc(method, params) {
  const out = await cli(['rpc', method, JSON.stringify(params)]);
  const text = out.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function rpc(method, params = {}) {
  try {
    return await socketClient.call(method, params);
  } catch (err) {
    if (/not connected|disconnected/.test(err.message)) return cliRpc(method, params);
    throw err;
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

export async function readScreen(surfaceId, { scrollback = false, lines = 200 } = {}) {
  const params = { surface_id: surfaceId };
  if (scrollback) {
    params.scrollback = true;
    params.lines = lines;
  }
  const out = await rpc('surface.read_text', params);
  return out.text || '';
}

export function sendText(surfaceId, text) {
  return rpc('surface.send_text', { surface_id: surfaceId, text });
}

export function sendKey(surfaceId, key) {
  return rpc('surface.send_key', { surface_id: surfaceId, key });
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
