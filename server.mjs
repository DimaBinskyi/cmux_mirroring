// cmux mirroring: cmux on your phone. Serves the PWA, streams live cmux state
// over SSE, proxies reads (screen text, chat transcripts) and actions (prompt,
// keys, feed replies) to the cmux socket, and fans out Web Push notifications.
//
// Bound to 127.0.0.1 only; `tailscale serve` terminates HTTPS on the tailnet
// and proxies here. The notify hook posts to /api/notify on localhost.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { rpc, rpcTry, readScreen, sendText, sendKey, cli } from './lib/cmux.mjs';
import { CmuxState } from './lib/state.mjs';
import { resolveTranscript, newestTranscriptForCwd, parseTranscript } from './lib/transcripts.mjs';
import { PushService } from './lib/push.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4488;
// VAPID subject identifies the push sender to Apple/Google (https: or mailto:)
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://github.com/DimaBinskyi/cmux_mirroring';

fs.mkdirSync(DATA_DIR, { recursive: true });

const push = new PushService(DATA_DIR, VAPID_SUBJECT);
const state = new CmuxState(path.join(DATA_DIR, 'events-cursor'), (msg) => console.error(msg));
const gridCache = new Map(); // surface id -> {seq, keys[]} for /api/grid deltas
const watchers = new Map(); // client id -> {wsId, ts} — sessions actively viewed on a phone
const WATCH_TTL = 25_000;

function isBeingViewed(wsId) {
  if (!wsId) return false;
  const now = Date.now();
  for (const [client, w] of watchers) {
    if (now - w.ts > WATCH_TTL) watchers.delete(client);
    else if (w.wsId === wsId) return true;
  }
  return false;
}

// ---------------------------------------------------------------- SSE clients
const sseClients = new Set();

function broadcast(type, data) {
  const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of sseClients) res.write(frame);
}

state.on('state', (snapshot) => broadcast('state', { snapshot }));
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25_000).unref();

// ------------------------------------------------------------------- helpers
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// CORS: the PWA may be configured to call a different host:port than the one
// it was installed from (Settings → server address). Exposure is tailnet-only.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  // Grid payloads are a few hundred KB of JSON; gzip cuts them ~10x for the phone.
  const acceptsGzip = /\bgzip\b/.test(String(res.req?.headers['accept-encoding'] || ''));
  if (body.length > 8192 && acceptsGzip) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...CORS });
    return res.end(zlib.gzipSync(Buffer.from(body)));
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(body);
}

// ------------------------------------------------------------------ prefs
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
let prefs = { notify: { attention: true, error: true, done: true, silent: true } };
try {
  const saved = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
  prefs = { ...prefs, notify: { ...prefs.notify, ...(saved.notify || {}) } };
} catch {
  /* first run */
}

function notifyCategory(title = '') {
  if (title.includes('🚨')) return 'attention';
  if (title.includes('⚠')) return 'error';
  if (title.includes('✅')) return 'done';
  return 'silent';
}

function findWorkspace(id) {
  return state.workspaces.find((w) => w.id === id || w.ref === id);
}

// ----------------------------------------------------------------- API routes
async function handleApi(req, res, url) {
  const q = url.searchParams;

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, 200, state.snapshot());
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS,
    });
    res.write(`data: ${JSON.stringify({ type: 'state', snapshot: state.snapshot() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return undefined;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat') {
    const ws = findWorkspace(q.get('workspace'));
    if (!ws) return sendJson(res, 404, { error: 'workspace not found' });
    // Prefer the session bound to the requested surface (multi-agent workspaces).
    const surface = q.get('surface');
    const session = (surface && state.sessionsBySurface.get(surface)) || state.sessions.get(ws.id);
    let file = session ? resolveTranscript(session.sessionId, session.cwd || ws.current_directory) : null;
    if (!file && ws.current_directory) file = newestTranscriptForCwd(ws.current_directory);
    if (!file) return sendJson(res, 200, { messages: [], note: 'no transcript found for this workspace yet' });
    const limit = Math.min(Number(q.get('limit')) || 150, 2000);
    return sendJson(res, 200, { ...parseTranscript(file, limit), file: path.basename(file) });
  }

  if (req.method === 'GET' && url.pathname === '/api/grid') {
    const surface = q.get('surface');
    if (!surface) return sendJson(res, 400, { error: 'surface required' });
    const out = await rpc('terminal.replay', { surface_id: surface });
    const g = out.render_grid;
    if (!g) return sendJson(res, 502, { error: 'no render grid for surface' });
    const seq = `${g.render_epoch}/${g.render_revision}/${g.row_space_revision}`;
    const since = q.get('since');
    if (since === seq) return sendJson(res, 200, { unchanged: true, seq });

    const styleDef = (id) => {
      const st = (g.styles || []).find((s) => s.id === id);
      if (!st) return null;
      return {
        fg: st.foreground,
        bg: st.background,
        bold: !!st.bold,
        faint: !!st.faint,
        inverse: !!st.inverse,
        italic: !!st.italic,
        underline: !!(st.underline && st.underline !== 'none' && st.underline !== false),
        strike: !!st.strikethrough,
      };
    };

    // Live mode (default) carries only the visible viewport — small and fast.
    // full=1 additionally includes styled scrollback (used as a frozen snapshot
    // when the user scrolls up; it is never live-polled).
    const includeScrollback = q.get('full') === '1';
    const sbRows = includeScrollback ? g.scrollback_rows : 0;
    const total = sbRows + g.rows;
    const rowsArr = Array.from({ length: total }, () => []);
    if (includeScrollback) for (const s of g.scrollback_spans || []) rowsArr[s.row]?.push(s);
    for (const s of g.row_spans || []) rowsArr[sbRows + s.row]?.push(s);
    for (const r of rowsArr) r.sort((a, b) => a.column - b.column);
    const keys = rowsArr.map((r) => JSON.stringify(r.map((s) => [s.column, s.style_id, s.text])));

    // Delta: if the client is exactly one step behind our cache, send only the
    // rows that changed (a status-line clock tick is ~1 row instead of a grid).
    const cacheKey = `${surface}:${includeScrollback ? 'f' : 'v'}`;
    const prev = gridCache.get(cacheKey);
    if (since && prev && prev.seq === since && prev.keys.length === total) {
      const changed = {};
      const usedStyles = new Set();
      let changedCount = 0;
      for (let i = 0; i < total; i += 1) {
        if (keys[i] !== prev.keys[i]) {
          changed[i] = rowsArr[i];
          changedCount += 1;
          for (const s of rowsArr[i]) usedStyles.add(s.style_id);
        }
      }
      gridCache.set(cacheKey, { seq, keys });
      if (changedCount <= total * 0.4) {
        const styles = {};
        for (const id of usedStyles) {
          const def = styleDef(id);
          if (def) styles[id] = def;
        }
        return sendJson(res, 200, { delta: true, seq, cursor: g.cursor, changed, styles });
      }
    } else {
      gridCache.set(cacheKey, { seq, keys });
    }

    const used = new Set();
    for (const s of [...(includeScrollback ? g.scrollback_spans || [] : []), ...(g.row_spans || [])]) used.add(s.style_id);
    const styles = {};
    for (const id of used) {
      const def = styleDef(id);
      if (def) styles[id] = def;
    }
    return sendJson(res, 200, {
      columns: g.columns,
      rows: g.rows,
      scrollbackRows: sbRows,
      fg: g.terminal_foreground,
      bg: g.terminal_background,
      cursor: g.cursor,
      styles,
      viewport: g.row_spans || [],
      scrollback: includeScrollback ? g.scrollback_spans || [] : [],
      seq,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/screen') {
    const surface = q.get('surface');
    if (!surface) return sendJson(res, 400, { error: 'surface required' });
    const scrollback = q.get('scrollback') === '1';
    if (scrollback) {
      const lines = Math.min(Number(q.get('lines')) || 2000, 20000);
      const text = await readScreen(surface, { scrollback: true, lines });
      return sendJson(res, 200, { text });
    }
    const out = await rpc('surface.read_text', { surface_id: surface });
    return sendJson(res, 200, { text: out.text || '' });
  }

  if (req.method === 'POST' && url.pathname === '/api/prompt') {
    const { workspace_id, text } = JSON.parse(await readBody(req));
    if (!workspace_id || !text) return sendJson(res, 400, { error: 'workspace_id and text required' });
    try {
      await rpcTry('workspace.prompt_submit', [
        { workspace_id, text },
        { workspace_id, prompt: text },
        { id: workspace_id, text },
      ]);
      return sendJson(res, 200, { ok: true, via: 'prompt_submit' });
    } catch (err) {
      // Fall back to typing into the agent surface.
      const surface = state.agentSurface(workspace_id);
      if (!surface) return sendJson(res, 500, { error: `prompt_submit failed (${err.message}) and no agent surface found` });
      await sendText(surface, `${text}\n`);
      return sendJson(res, 200, { ok: true, via: 'send' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/send') {
    const { surface_id, text, enter } = JSON.parse(await readBody(req));
    if (!surface_id || typeof text !== 'string') return sendJson(res, 400, { error: 'surface_id and text required' });
    await sendText(surface_id, enter ? `${text}\n` : text);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/key') {
    const { surface_id, key } = JSON.parse(await readBody(req));
    if (!surface_id || !key) return sendJson(res, 400, { error: 'surface_id and key required' });
    await sendKey(surface_id, key);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/feed-reply') {
    const { id, kind, action, text } = JSON.parse(await readBody(req));
    if (!id) return sendJson(res, 400, { error: 'id required' });
    const method = kind === 'question' ? 'feed.question.reply'
      : (kind === 'exitPlan' || kind === 'exit_plan' || kind === 'plan') ? 'feed.exit_plan.reply'
        : 'feed.permission.reply';
    try {
      const result = await rpcTry(method, [
        { id, action, text },
        { id, response: action ?? text },
        { item_id: id, action, text },
        { id, reply: action ?? text },
      ]);
      state._refreshPending();
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      return sendJson(res, 502, { error: err.message, fallback: 'keys' });
    }
  }

  // Topology management from the phone: tabs (surfaces), splits, workspaces.
  if (req.method === 'POST' && url.pathname === '/api/ws-action') {
    const { action, workspace_id, surface_id, cwd, title } = JSON.parse(await readBody(req));
    const name = String(title || '').trim().slice(0, 80);
    const home = os.homedir();
    const actions = {
      newTab: () => workspace_id && ['new-surface', '--workspace', workspace_id, '--focus', 'false'],
      closeTab: () => surface_id && ['close-surface', '--surface', surface_id,
        ...(workspace_id ? ['--workspace', workspace_id] : [])],
      closeWorkspace: () => workspace_id && ['close-workspace', '--workspace', workspace_id],
      newWorkspace: () => ['new-workspace', '--focus', 'false',
        ...(cwd ? ['--cwd', String(cwd).replace(/^~(?=\/|$)/, home)] : [])],
      renameWorkspace: () => workspace_id && name && ['rename-workspace', '--workspace', workspace_id, name],
      renameTab: () => surface_id && name && ['rename-tab', '--surface', surface_id,
        ...(workspace_id ? ['--workspace', workspace_id] : []), name],
    };
    const args = actions[action]?.();
    if (!args) return sendJson(res, 400, { error: 'unknown action or missing target' });
    const out = await cli(args);
    await state.refresh().catch(() => {});
    return sendJson(res, 200, { ok: true, out: out.trim().slice(0, 200) });
  }

  // Photo/video from the phone: raw body → file on the Mac; the client then
  // inserts the saved path into the prompt so the agent can read it.
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const name = String(q.get('name') || 'upload.bin').replace(/[^\w.\-]+/g, '_').slice(-80);
    const dir = path.join(DATA_DIR, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name}`);
    const MAX = 300 * 1024 * 1024;
    let size = 0;
    const stream = fs.createWriteStream(file);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) {
        stream.destroy();
        fs.unlink(file, () => {});
        req.destroy();
      }
    });
    req.pipe(stream);
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      req.on('error', reject);
    });
    return sendJson(res, 200, { ok: true, path: file, size });
  }

  // ------------------------------------------------------------- push (existing)
  if (req.method === 'GET' && url.pathname === '/api/public-key') {
    return sendJson(res, 200, { publicKey: push.publicKey });
  }
  if (req.method === 'GET' && url.pathname === '/api/feed') {
    return sendJson(res, 200, push.feed);
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, {
      subscriptions: push.subscriptions.length,
      feed: push.feed.length,
      cmuxOnline: state.online,
      uptimeSec: Math.round(process.uptime()),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/subscribe') {
    const sub = JSON.parse(await readBody(req));
    if (!sub || typeof sub.endpoint !== 'string') return sendJson(res, 400, { error: 'not a push subscription' });
    return sendJson(res, 200, { ok: true, subscriptions: push.subscribe(sub) });
  }
  if (req.method === 'POST' && url.pathname === '/api/unsubscribe') {
    const { endpoint } = JSON.parse(await readBody(req));
    return sendJson(res, 200, { ok: true, subscriptions: push.unsubscribe(endpoint) });
  }
  // The phone reports which session it's actively viewing (foreground only);
  // pushes for that session are suppressed — the user is already looking at it.
  if (req.method === 'POST' && url.pathname === '/api/watching') {
    const { client, workspace_id } = JSON.parse(await readBody(req));
    if (client) {
      if (workspace_id) watchers.set(String(client), { wsId: String(workspace_id), ts: Date.now() });
      else watchers.delete(String(client));
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/notify') {
    const raw = JSON.parse(await readBody(req));
    const category = notifyCategory(String(raw.title || ''));
    const enabled = prefs.notify[category] !== false;
    const viewing = isBeingViewed(raw.tag ? String(raw.tag) : null);
    const result = await push.notify(raw, { broadcast: enabled && !viewing });
    broadcast('push', { item: push.feed[0] });
    return sendJson(res, 200, { ok: true, category, skipped: !enabled, viewing, ...result });
  }

  if (req.method === 'GET' && url.pathname === '/api/prefs') {
    return sendJson(res, 200, prefs);
  }
  if (req.method === 'POST' && url.pathname === '/api/prefs') {
    const raw = JSON.parse(await readBody(req));
    prefs = { ...prefs, notify: { ...prefs.notify, ...(raw.notify || {}) } };
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
    return sendJson(res, 200, prefs);
  }

  sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
    } else if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(res, url.pathname);
    } else {
      sendJson(res, 405, { error: 'method not allowed' });
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`cmux mirroring listening on http://${HOST}:${PORT} (${push.subscriptions.length} push subscription(s))`);
});
