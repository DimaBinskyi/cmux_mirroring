// cmux on the phone — vanilla ES module, no build step.
// Views: #/ (home = sidebar), #/ws/<id> (Term default | Chat), #/feed (push history).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SLASH = ['/compact', '/clear', '/context', '/cost', '/model', '/agents', '/resume', '/rewind', '/todos', '/help'];
const QUICK = ['yes', 'no', 'continue', 'sounds good', 'stop', 'try again'];
const LANE_ORDER = { attention: 0, working: 1, done: 2, idle: 3 };
const LANE_GLYPH = { attention: '🚨', working: '⚙️', done: '✅', idle: '💤' };
const TERM_KEYS = [
  ['escape', 'esc'], ['tab', '⇥'], ['shift+tab', '⇧⇥'],
  ['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'],
  ['ctrl-c', '^C'], ['ctrl-d', '^D'], ['ctrl-z', '^Z'], ['ctrl-l', '^L'], ['ctrl-r', '^R'],
  ['enter', '⏎'],
];

const S = {
  snap: null,
  route: { name: 'home', wsId: null },
  tab: 'term',
  surface: null,
  chat: null,
  search: '',
  searchOpen: false,
  es: null,
  termTimer: null,
};

let grid = null;
let stickBottom = true;
let historyMode = false; // full plain-text history loaded instead of the live styled grid

// Custom server address (Settings): empty = the origin the app was loaded from.
const BASE = (localStorage.getItem('cmux-server') || '').replace(/\/+$/, '');

function api(path, opts = {}) {
  return fetch(BASE + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  });
}

function relTime(ts) {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(t).toLocaleDateString();
}

function ws() {
  return S.snap?.workspaces.find((w) => w.id === S.route.wsId || w.ref === S.route.wsId) || null;
}

// ------------------------------------------------------------------ routing
function parseHash() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/ws\/(.+)$/);
  if (m) return { name: 'ws', wsId: decodeURIComponent(m[1]) };
  if (h === '#/feed') return { name: 'feed', wsId: null };
  if (h === '#/settings') return { name: 'settings', wsId: null };
  return { name: 'home', wsId: null };
}

window.addEventListener('hashchange', () => {
  S.route = parseHash();
  S.tab = 'term';
  S.chat = null;
  S.surface = null;
  S.search = '';
  S.searchOpen = false;
  S.chatLimit = 150;
  grid = null;
  stickBottom = true;
  historyMode = false;
  render();
});

// --------------------------------------------------------------------- SSE
let chatRefetchTimer = null;

function setDot(on) {
  const dot = $('dot');
  if (dot) dot.classList.toggle('on', !!on);
}

function connectSSE() {
  if (S.es) S.es.close();
  S.es = new EventSource(`${BASE}/api/stream`);
  S.es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'state') {
      S.snap = msg.snapshot;
      setDot(msg.snapshot.online);
      if (S.route.name === 'home') renderHome();
      if (S.route.name === 'ws' && S.tab === 'chat') {
        clearTimeout(chatRefetchTimer);
        chatRefetchTimer = setTimeout(fetchChat, 800);
      }
      updateNavBadge();
    } else if (msg.type === 'push' && S.route.name === 'feed') {
      renderFeed();
    }
  };
  S.es.onerror = () => setDot(false);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!S.es || S.es.readyState === EventSource.CLOSED) connectSSE();
    refreshSnapshot();
  }
});

async function refreshSnapshot() {
  try {
    S.snap = await api('/api/state');
    setDot(S.snap.online);
    render();
  } catch {
    setDot(false);
  }
}

// ------------------------------------------------------------------- render
function render() {
  clearInterval(S.termTimer);
  document.body.className = S.route.name === 'ws' ? `ws ${S.tab}` : '';
  $('topbar').className = S.route.name === 'ws' ? 'ws' : '';
  $('nav-sessions').classList.toggle('active', S.route.name === 'home');
  $('nav-feed').classList.toggle('active', S.route.name === 'feed');
  $('nav-settings').classList.toggle('active', S.route.name === 'settings');

  if (S.route.name === 'home') {
    $('title').innerHTML = `cmux mirroring <span id="dot" class="${S.snap?.online ? 'on' : ''}"></span>`;
    renderHome();
  } else if (S.route.name === 'feed') {
    $('title').innerHTML = `Feed <span id="dot" class="${S.snap?.online ? 'on' : ''}"></span>`;
    renderFeed();
  } else if (S.route.name === 'settings') {
    $('title').innerHTML = `Settings <span id="dot" class="${S.snap?.online ? 'on' : ''}"></span>`;
    renderSettings();
  } else {
    renderWs();
  }
  updateNavBadge();
}

function updateNavBadge() {
  const n = (S.snap?.workspaces || []).filter((w) => w.lane === 'attention').length;
  $('nav-sessions').innerHTML = n ? `Sessions <span class="badge">${n}</span>` : 'Sessions';
}

// --------------------------------------------------------------------- home
function wsRow(w) {
  const detail = w.pending[0]?.title || w.laneDetail || w.lastMessage || w.cwd || '';
  const when = relTime(w.laneTs || w.lastSubmittedAt);
  return `<button class="ws-row ${w.lane}" data-ws="${esc(w.id)}">
    <div class="t"><span>${LANE_GLYPH[w.lane] || ''} ${esc(w.title)}</span><span class="when">${when}</span></div>
    <div class="d">${esc(detail)}</div>
  </button>`;
}

function renderHome() {
  if (S.route.name !== 'home') return;
  if (!S.snap) {
    $('view').innerHTML = '<div class="empty">Connecting to Mac…</div>';
    return;
  }
  const grouped = new Set(S.snap.groups.flatMap((g) => g.workspaceIds));
  const byId = new Map(S.snap.workspaces.map((w) => [w.id, w]));
  let html = '';

  for (const g of S.snap.groups) {
    const members = g.workspaceIds.map((id) => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const worst = members.reduce((acc, w) => (LANE_ORDER[w.lane] < LANE_ORDER[acc] ? w.lane : acc), 'idle');
    const needs = members.filter((w) => w.lane === 'attention').length;
    html += `<div class="group-hd"><span>🧩 ${esc(g.title)} (${members.length})</span>
      ${needs ? `<span class="badge">${needs} needs you</span>` : `<span>${LANE_GLYPH[worst]}</span>`}</div>
      <div class="group-kids">${members.map(wsRow).join('')}</div>`;
  }
  const rest = S.snap.workspaces.filter((w) => !grouped.has(w.id));
  html += rest.map(wsRow).join('');
  $('view').innerHTML = html || '<div class="empty">No workspaces.</div>';

  for (const el of $('view').querySelectorAll('[data-ws]')) {
    el.onclick = () => { location.hash = `#/ws/${encodeURIComponent(el.dataset.ws)}`; };
  }
}

// ---------------------------------------------------------------- workspace
function chipsHtml(w) {
  if (w.surfaces.length < 2) return '';
  return `<div class="chips">${w.surfaces.map((s) => `<button data-surf="${esc(s.id)}" class="${s.id === S.surface ? 'active' : ''}">
    ${s.type === 'browser' ? '🌐 ' : ''}${s.hasSession ? '◐ ' : ''}${esc(s.title || s.ref)}</button>`).join('')}</div>`;
}

function bindChips() {
  for (const b of $('view').querySelectorAll('[data-surf]')) {
    b.onclick = () => {
      S.surface = b.dataset.surf;
      grid = null;
      stickBottom = true;
      historyMode = false;
      if (S.tab === 'chat') {
        S.chat = null;
        renderChat();
      } else {
        renderTerm();
      }
    };
  }
}

function renderWs() {
  const w = ws();
  $('title').textContent = w ? w.title : 'Session';
  for (const b of $('tabs').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.tab === S.tab);
  }
  if (!w) {
    $('view').innerHTML = '<div class="empty">Workspace not found (closed?).</div>';
    return;
  }
  if (!S.surface || !w.surfaces.some((s) => s.id === S.surface)) {
    S.surface = w.agentSurfaceId || w.surfaces[0]?.id || null;
  }
  if (S.tab === 'chat') renderChat();
  else renderTerm();
}

// --------------------------------------------------------------------- chat
function pendingCard(item) {
  let buttons = '';
  if (item.kind === 'permission') {
    buttons = `<button class="btn primary" data-reply="allow">Allow</button>
               <button class="btn" data-reply="deny">Deny</button>`;
  } else if (item.kind === 'question' && Array.isArray(item.options)) {
    buttons = item.options.map((o, i) => {
      const label = typeof o === 'string' ? o : (o.label || o.text || `option ${i + 1}`);
      return `<button class="btn" data-reply="${esc(label)}">${esc(label)}</button>`;
    }).join('');
  } else {
    buttons = `<button class="btn primary" data-reply="approve">Approve</button>`;
  }
  const keys = ['1', '2', '3', 'escape', 'enter']
    .map((k) => `<button class="btn" data-key="${k}">${k === 'enter' ? '⏎' : k === 'escape' ? 'esc' : k}</button>`).join('');
  return `<div class="pending-card" data-item="${esc(item.id)}" data-kind="${esc(item.kind)}">
    <div class="k">${esc(item.kind)} · waiting for you</div>
    <div class="b"><b>${esc(item.title)}</b>${item.body ? `\n${esc(item.body)}` : ''}</div>
    <div class="btnrow">${buttons}</div>
    <div class="keysrow">${keys}</div>
  </div>`;
}

function mdLite(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

function renderChat() {
  const w = ws();
  const view = $('view');
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 120;

  let html = chipsHtml(w);
  if (S.chat?.truncated) html += '<div class="note"><button class="btn" id="load-older">▲ Load older messages</button></div>';
  const msgs = S.chat?.messages || [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === 'tool') {
      const lines = [];
      while (i < msgs.length && msgs[i].role === 'tool') {
        const t = msgs[i];
        const mark = t.status === 'error' ? '<span class="err">✗</span>' : t.status === 'ok' ? '✓' : '…';
        lines.push(`🔧 ${esc(t.name)} ${esc(t.detail)} ${mark}`);
        i += 1;
      }
      html += `<div class="tools">${lines.join('<br>')}</div>`;
      continue;
    }
    html += `<div class="msg ${m.role}">${m.role === 'assistant' ? mdLite(m.text) : esc(m.text)}</div>`;
    i += 1;
  }
  if (!msgs.length) html += `<div class="empty">${esc(S.chat?.note || 'Loading conversation…')}</div>`;
  for (const item of w.pending) html += pendingCard(item);
  view.innerHTML = html;
  bindChips();

  const older = $('load-older');
  if (older) {
    older.onclick = () => {
      S.chatLimit = 2000;
      S.chat = null;
      older.textContent = 'Loading…';
      fetchChat();
    };
  }

  for (const card of view.querySelectorAll('.pending-card')) {
    for (const b of card.querySelectorAll('[data-reply]')) {
      b.onclick = () => feedReply(card.dataset.item, card.dataset.kind, b.dataset.reply, card);
    }
    for (const b of card.querySelectorAll('[data-key]')) {
      b.onclick = () => cardKey(b.dataset.key);
    }
  }
  if (nearBottom) view.scrollTop = view.scrollHeight;
  if (!S.chat) fetchChat();
}

async function fetchChat() {
  const w = ws();
  if (!w || S.route.name !== 'ws' || S.tab !== 'chat') return;
  try {
    const surfQ = S.surface ? `&surface=${encodeURIComponent(S.surface)}` : '';
    const data = await api(`/api/chat?workspace=${encodeURIComponent(w.id)}${surfQ}&limit=${S.chatLimit || 150}`);
    const changed = data.mtime !== S.chat?.mtime || data.file !== S.chat?.file
      || (data.messages?.length || 0) !== (S.chat?.messages?.length || 0);
    S.chat = data;
    if (changed) renderChat();
  } catch (err) {
    if (!S.chat) {
      S.chat = { messages: [], note: `Chat unavailable: ${err.message}` };
      renderChat();
    }
  }
}

async function feedReply(id, kind, action, card) {
  try {
    await api('/api/feed-reply', { method: 'POST', body: JSON.stringify({ id, kind, action }) });
    card.style.opacity = '0.4';
    setTimeout(refreshSnapshot, 800);
  } catch {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'Structured reply failed — use the key buttons matching the dialog on screen.';
    card.appendChild(note);
  }
}

// Keys pressed from a pending card go to the agent surface.
async function cardKey(key) {
  const w = ws();
  const surface = w?.agentSurfaceId || S.surface;
  if (!surface) return;
  try {
    if (/^\d$/.test(key)) await api('/api/send', { method: 'POST', body: JSON.stringify({ surface_id: surface, text: key }) });
    else await api('/api/key', { method: 'POST', body: JSON.stringify({ surface_id: surface, key }) });
  } catch (err) {
    alert(`key failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- terminal
function renderTerm() {
  const w = ws();
  const keys = TERM_KEYS.map(([k, label]) => `<button class="btn" data-tkey="${k}">${label}</button>`).join('');
  $('view').innerHTML = `
    ${chipsHtml(w)}
    <div id="term-wrap">
      <div id="screen"></div>
      <button id="jump-live" hidden>⤓ Live</button>
    </div>
    <div id="termbar">
      <div id="searchrow" ${S.searchOpen ? '' : 'hidden'}>
        <input id="termsearch" placeholder="Search scrollback…" autocapitalize="off" autocorrect="off" value="${esc(S.search)}">
        <span id="searchcount"></span>
      </div>
      <div id="keysbar">${keys}<button class="btn" id="search-toggle">🔍</button><button class="btn" id="full-history">${historyMode ? '🎨 Color' : '▲ All'}</button></div>
      <input id="terminput" placeholder="⌨ Type here — mirrors the terminal input line"
        autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
    </div>`;
  bindChips();

  for (const b of $('view').querySelectorAll('[data-tkey]')) {
    const k = b.dataset.tkey;
    if (k === 'enter') b.onclick = submitLine;
    else b.onclick = () => specialKey(k, SYNC_KEYS.has(k));
  }
  $('search-toggle').onclick = toggleSearch;
  $('full-history').onclick = () => (historyMode ? exitHistory() : loadFullHistory());
  $('termsearch').addEventListener('input', () => {
    S.search = $('termsearch').value;
    applySearch();
  });
  $('jump-live').onclick = exitHistory;

  const screen = $('screen');
  screen.onscroll = () => {
    if (historyMode) return; // ⤓ Live stays visible; only it exits history mode
    const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
    if (atBottom !== stickBottom) {
      stickBottom = atBottom;
      $('jump-live').hidden = atBottom;
    }
  };

  bindTermInput();
  prevLines = null;
  pollGrid(true);
  S.termTimer = setInterval(() => {
    if (document.visibilityState === 'visible') pollGrid(false);
  }, 2000);
}

function selectionInScreen() {
  const sel = window.getSelection();
  return sel && !sel.isCollapsed && $('screen')?.contains(sel.anchorNode);
}

async function pollGrid(force) {
  if (S.route.name !== 'ws' || S.tab !== 'term' || !S.surface || historyMode) return;
  // Frozen while reading history, searching, or selecting text to copy.
  if (!force && (!stickBottom || S.searchOpen || selectionInScreen())) return;
  try {
    const g = await api(`/api/grid?surface=${encodeURIComponent(S.surface)}`);
    if (!force && grid && g.seq === grid.seq) return;
    grid = g;
    paintGrid();
  } catch (err) {
    const el = $('screen');
    if (el && !grid) el.innerHTML = `<div class="empty">terminal unavailable: ${esc(err.message)}</div>`;
  }
}

function lineText(spans) {
  let line = '';
  let col = 0;
  for (const s of spans) {
    if (s.column > col) line += ' '.repeat(s.column - col);
    line += s.text;
    col = s.column + (s.cell_width || [...s.text].length);
  }
  return line;
}

function spanHtml(s, g) {
  const st = g.styles[s.style_id] || {};
  let fg = st.fg || g.fg;
  let bg = st.bg;
  if (st.inverse) {
    const tmp = fg;
    fg = bg || g.bg;
    bg = tmp;
  }
  let css = `color:${fg};`;
  if (bg && bg.toLowerCase() !== g.bg.toLowerCase()) css += `background:${bg};`;
  if (st.bold) css += 'font-weight:700;';
  if (st.faint) css += 'opacity:.6;';
  if (st.italic) css += 'font-style:italic;';
  const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) css += `text-decoration:${deco};`;
  return `<span style="${css}">${esc(s.text)}</span>`;
}

let prevLines = null;

function paintGrid() {
  const el = $('screen');
  if (!el || !grid) return;
  el.style.background = grid.bg;
  el.style.color = grid.fg;

  const rows = new Map();
  const add = (r, s) => {
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push(s);
  };
  for (const s of grid.scrollback) add(s.row, s);
  for (const s of grid.viewport) add(grid.scrollbackRows + s.row, s);

  const total = grid.scrollbackRows + grid.rows;
  const lines = [];
  for (let r = 0; r < total; r++) {
    const spans = (rows.get(r) || []).sort((a, b) => a.column - b.column);
    let col = 0;
    let line = '';
    for (const s of spans) {
      if (s.column > col) line += ' '.repeat(s.column - col);
      line += spanHtml(s, grid);
      col = s.column + (s.cell_width || [...s.text].length);
    }
    lines.push(line || ' ');
  }

  // Diff per line: typical updates touch a handful of rows, so patching only
  // those keeps repaints cheap and scroll/selection stable.
  const kids = el.children;
  const canDiff = prevLines && prevLines.length === lines.length
    && kids.length === lines.length && kids[0]?.classList.contains('tl');
  if (canDiff) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== prevLines[i]) kids[i].innerHTML = lines[i];
    }
  } else {
    el.innerHTML = lines.map((l) => `<div class="tl">${l}</div>`).join('');
  }
  prevLines = lines;
  if (stickBottom) el.scrollTop = el.scrollHeight;
  if (S.search) applySearch();
  syncFieldFromTerminal(true);
}

function toggleSearch() {
  S.searchOpen = !S.searchOpen;
  $('searchrow').hidden = !S.searchOpen;
  if (S.searchOpen) {
    // In full-history mode search the loaded history; otherwise freeze the live view.
    const ready = historyMode ? Promise.resolve() : pollGrid(true);
    ready.then(() => {
      stickBottom = false;
      $('jump-live').hidden = false;
      $('termsearch').focus();
    });
  } else {
    S.search = '';
    $('termsearch').value = '';
    applySearch();
    if (!historyMode) {
      stickBottom = true;
      $('jump-live').hidden = true;
      pollGrid(true);
    }
  }
}

// Load the ENTIRE terminal history as plain text (the styled grid only carries
// ~240 rows of scrollback; deeper history is text-only — cmux does not expose
// styling for older rows). "🎨 Color" / "⤓ Live" returns to the styled view.
async function loadFullHistory() {
  const el = $('screen');
  if (!el || !S.surface) return;
  historyMode = true;
  stickBottom = false;
  $('jump-live').hidden = false;
  const toggle = $('full-history');
  if (toggle) toggle.textContent = '🎨 Color';
  el.innerHTML = '<div class="empty">Loading full history…</div>';
  prevLines = null;
  try {
    const { text } = await api(`/api/screen?surface=${encodeURIComponent(S.surface)}&scrollback=1&lines=10000`);
    const lines = text.split('\n');
    el.innerHTML = `<div class="note">full history · ${lines.length} lines · plain text · 🎨 Color returns to live</div>`
      + lines.map((l) => `<div class="tl">${esc(l) || ' '}</div>`).join('');
    el.scrollTop = el.scrollHeight;
    if (S.search) applySearch();
  } catch (err) {
    el.innerHTML = `<div class="empty">history unavailable: ${esc(err.message)}</div>`;
    exitHistory();
  }
}

function exitHistory() {
  historyMode = false;
  stickBottom = true;
  $('jump-live').hidden = true;
  const toggle = $('full-history');
  if (toggle) toggle.textContent = '▲ All';
  if (S.searchOpen) toggleSearch();
  else pollGrid(true);
}

function applySearch() {
  const el = $('screen');
  if (!el) return;
  const q = S.search.trim().toLowerCase();
  let first = null;
  let count = 0;
  for (const line of el.querySelectorAll('.tl')) {
    const hit = q && line.textContent.toLowerCase().includes(q);
    line.classList.toggle('hitline', !!hit);
    if (hit) {
      count += 1;
      if (!first) first = line;
    }
  }
  const counter = $('searchcount');
  if (counter) counter.textContent = q ? `${count} hit${count === 1 ? '' : 's'}` : '';
  if (first) first.scrollIntoView({ block: 'center' });
}

// Terminal input: the field fills locally (instant echo, zero lag) while every
// keystroke is also forwarded to the pty — batched, so a typing burst becomes
// one request instead of one per key. History/completion keys (↑ ↓ ⇥ ^R) sync
// the field back FROM the terminal's cursor line, so a recalled command shows
// up in both places.
const SYNC_KEYS = new Set(['up', 'down', 'tab', 'shift+tab', 'ctrl-r']);
let opQueue = [];
let flushing = false;
let keyRefreshTimer = null;
let lastLocalInputTs = 0;

function scheduleTermRefresh() {
  clearTimeout(keyRefreshTimer);
  keyRefreshTimer = setTimeout(() => pollGrid(true), 60);
}

// Leading-edge: the first keystroke flushes immediately; anything typed while a
// request is in flight coalesces and goes out the moment it completes.
function queueOp(t, v) {
  const last = opQueue[opQueue.length - 1];
  if (t === 'text' && last && last.t === 'text') last.v += v;
  else opQueue.push({ t, v });
  flushOps();
}

async function flushOps() {
  if (flushing || !opQueue.length || !S.surface) return;
  flushing = true;
  const ops = opQueue;
  opQueue = [];
  try {
    for (const op of ops) {
      if (op.t === 'text') {
        await api('/api/send', { method: 'POST', body: JSON.stringify({ surface_id: S.surface, text: op.v }) });
      } else {
        await api('/api/key', { method: 'POST', body: JSON.stringify({ surface_id: S.surface, key: op.v }) });
      }
    }
  } catch (err) {
    console.error('input flush failed', err);
  }
  flushing = false;
  if (opQueue.length) flushOps();
  else scheduleTermRefresh();
}

async function specialKey(key, sync = false) {
  queueOp('key', key);
  if (sync) {
    setTimeout(async () => {
      await pollGrid(true);
      syncFieldFromTerminal();
    }, 250);
  }
}

async function submitLine() {
  // Echo-through means the pty already has every character — Enter is enough.
  await specialKey('enter');
  const ti = $('terminput');
  if (ti) ti.value = '';
}

// Mirror the terminal's current input line into the field.
// Two shapes are recognized:
//  - Claude Code composer: a "❯ " line, possibly wrapped onto indented rows
//    (styled bold, so style-based detection won't work — parse by shape).
//  - Shell prompt: prompt is colored/bold, typed input is default-styled —
//    the input is the trailing run of plainly-styled spans on the cursor row.
// auto=true runs on every repaint (mirrors Mac-side typing / recalls) but
// backs off while the user is typing into the field or a flush is pending.
function setField(ti, text) {
  if (ti.value === text) return;
  ti.value = text;
  try {
    ti.setSelectionRange(text.length, text.length);
  } catch {
    /* not focused */
  }
}

function syncFieldFromTerminal(auto = false) {
  const ti = $('terminput');
  if (!ti || !grid || !grid.cursor) return;
  // Back off only while the user is actively typing here (field focus alone
  // must not gate it — the field keeps focus even while the user types on the
  // Mac). cursor.visible is false on unfocused panes, so it can't gate either.
  if (auto && (opQueue.length || flushing || Date.now() - lastLocalInputTs < 1500)) return;

  const byRow = new Map();
  for (const s of grid.viewport) {
    if (!byRow.has(s.row)) byRow.set(s.row, []);
    byRow.get(s.row).push(s);
  }
  const rowText = (r) => lineText((byRow.get(r) || []).sort((a, b) => a.column - b.column));
  const r = grid.cursor.row;

  // Claude composer block: find the "❯ " row at or above the cursor; rows in
  // between must be indented continuations of the wrapped input.
  let startRow = -1;
  for (let i = r; i >= Math.max(0, r - 8); i -= 1) {
    const t = rowText(i);
    if (/^\s*❯\s?/.test(t)) {
      startRow = i;
      break;
    }
    if (!t.trim()) break;
    if (i !== r && !/^\s/.test(t)) break;
  }
  if (startRow >= 0) {
    const parts = [];
    for (let i = startRow; i <= r; i += 1) {
      parts.push(rowText(i).replace(/\s+$/, '').replace(i === startRow ? /^\s*❯\s?/ : /^\s+/, ''));
    }
    setField(ti, parts.join(' ').replace(/\s+/g, ' ').trim());
    return;
  }
  if (auto) {
    // Shell 2-way binding, guarded so TUI content (vim, dialogs) never leaks
    // into the field: the cursor row must look like a prompt line AND be the
    // last row with content (shells park the cursor at the bottom; TUIs don't).
    const t = rowText(r);
    if (!/[❯➜›»$%#>]/.test(t.slice(0, 40))) return;
    for (let i = grid.rows - 1; i > r; i -= 1) {
      if (rowText(i).trim()) return;
    }
  }

  const spans = (byRow.get(r) || []).sort((a, b) => a.column - b.column);
  if (!spans.length) return;
  const plain = (s) => {
    const st = grid.styles[s.style_id] || {};
    return (!st.fg || st.fg.toLowerCase() === grid.fg.toLowerCase())
      && (!st.bg || st.bg.toLowerCase() === grid.bg.toLowerCase())
      && !st.bold && !st.inverse && !st.italic;
  };
  let start = spans.length;
  while (start > 0 && plain(spans[start - 1])) start -= 1;
  if (start === spans.length) return; // no plain tail — leave the field alone
  const text = lineText(spans.slice(start))
    .replace(/^\s+/, '')
    .replace(/\s+$/, '')
    .replace(/^[❯>$%#]\s?/, '')
    .replace(/\s*│\s*$/, '');
  setField(ti, text);
}

function bindTermInput() {
  const ti = $('terminput');
  ti.addEventListener('beforeinput', (e) => {
    lastLocalInputTs = Date.now();
    const type = e.inputType || '';
    if (type === 'insertLineBreak' || type === 'insertParagraph') {
      e.preventDefault();
      submitLine();
    } else if (type === 'deleteContentBackward' || type.startsWith('delete')) {
      queueOp('key', 'backspace'); // the field deletes locally on its own
    } else if (type.startsWith('insert')) {
      const data = e.data ?? e.dataTransfer?.getData('text') ?? '';
      if (data) queueOp('text', data); // the field fills locally on its own
    }
  });
  ti.addEventListener('keydown', (e) => {
    lastLocalInputTs = Date.now();
    if (e.key === 'Enter') {
      e.preventDefault();
      submitLine();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      specialKey('up', true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      specialKey('down', true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      specialKey('tab', true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      specialKey('escape');
    }
  });
}

// ---------------------------------------------------------------- composer
function renderSuggestions() {
  const val = $('input').value;
  let items = [];
  if (val.startsWith('/')) items = SLASH.filter((s) => s.startsWith(val) && s !== val);
  else if (!val) items = QUICK;
  $('suggest').innerHTML = items.map((s) => `<button data-s="${esc(s)}">${esc(s)}</button>`).join('');
  for (const b of $('suggest').querySelectorAll('button')) {
    b.onclick = () => {
      $('input').value = b.dataset.s;
      $('input').focus();
      renderSuggestions();
    };
  }
}

async function sendPrompt() {
  const w = ws();
  const text = $('input').value.trim();
  if (!w || !text) return;
  $('send').disabled = true;
  try {
    await api('/api/prompt', { method: 'POST', body: JSON.stringify({ workspace_id: w.id, text }) });
    $('input').value = '';
    $('input').style.height = 'auto';
    renderSuggestions();
    setTimeout(fetchChat, 1200);
  } catch (err) {
    alert(`send failed: ${err.message}`);
  } finally {
    $('send').disabled = false;
  }
}

$('send').onclick = sendPrompt;
$('input').addEventListener('input', () => {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  renderSuggestions();
});
$('input').addEventListener('focus', renderSuggestions);

// -------------------------------------------------------------------- feed
async function pushStatus() {
  const standalone = window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (!('serviceWorker' in navigator)) return { text: 'Service worker unsupported.', warn: true };
  if (!('Notification' in window) || !('PushManager' in window)) {
    return {
      text: standalone ? 'Push needs iOS 16.4+.' : 'Install first: Share → Add to Home Screen, then open from the icon.',
      warn: !standalone,
    };
  }
  if (Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      api('/api/subscribe', { method: 'POST', body: JSON.stringify(sub) }).catch(() => {});
      return { text: 'Push enabled on this phone ✓', showTest: true };
    }
  }
  return { text: 'Notifications are off.', showEnable: true, warn: true };
}

async function renderFeed() {
  if (S.route.name !== 'feed') return;
  const status = await pushStatus();
  let feed = [];
  try {
    feed = await api('/api/feed');
  } catch {
    /* offline */
  }

  $('view').innerHTML = `
    ${status.showEnable ? `<div class="card"><div class="hintwarn">${esc(status.text)}</div>
      <button class="bigbtn secondary" onclick="location.hash='#/settings'">Configure in Settings</button></div>` : ''}
    ${feed.map((f) => `<div class="feed-item" ${f.url ? `data-url="${esc(f.url)}"` : ''}>
      <span class="when">${relTime(f.ts)}</span>
      <div class="t">${esc(f.title)}</div>
      <div class="b">${esc(f.body)}</div>
    </div>`).join('') || '<div class="empty">No notifications yet.</div>'}`;

  for (const item of $('view').querySelectorAll('[data-url]')) {
    item.onclick = () => { location.href = item.dataset.url; };
  }
}

// ---------------------------------------------------------------- settings
const NOTIFY_CATS = [
  ['attention', '🚨 Needs input / permission'],
  ['error', '⚠️ Errors and failures'],
  ['done', '✅ Task finished'],
  ['silent', '🤖 Background activity (silent)'],
];

async function renderSettings() {
  if (S.route.name !== 'settings') return;
  const status = await pushStatus();
  let prefs = null;
  let srv = null;
  try {
    [prefs, srv] = await Promise.all([api('/api/prefs'), api('/api/status')]);
  } catch {
    /* server unreachable — still show the server card so it can be fixed */
  }

  $('view').innerHTML = `
    <div class="card">
      <div class="cfg-label">Server</div>
      <div class="muted">Address of the Mac running cmux-push. Leave empty to use this app's own origin (${esc(location.origin)}).</div>
      <input class="cfg-input" id="srv-addr" placeholder="e.g. http://100.81.107.15:4488" value="${esc(BASE)}"
        autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="bigbtn" id="srv-save">Save &amp; test</button>
      <div class="cfg-result" id="srv-result">${srv ? `connected ✓ · cmux ${srv.cmuxOnline ? 'online' : 'offline'} · ${srv.subscriptions} device(s) subscribed · up ${Math.round(srv.uptimeSec / 60)}m` : 'not connected'}</div>
    </div>

    <div class="card">
      <div class="cfg-label">Notifications</div>
      <div class="${status.warn ? 'hintwarn' : 'muted'}">${esc(status.text)}</div>
      ${status.showEnable ? '<button class="bigbtn" id="enable">Enable notifications</button>' : ''}
      ${status.showTest ? '<button class="bigbtn secondary" id="test">Send test push</button>' : ''}
      <div style="margin-top:10px">
        ${prefs ? NOTIFY_CATS.map(([key, label]) => `<label class="togglerow"><span>${label}</span>
          <input type="checkbox" data-cat="${key}" ${prefs.notify[key] !== false ? 'checked' : ''}></label>`).join('')
    : '<div class="muted">Preferences unavailable — server unreachable.</div>'}
      </div>
      <div class="muted" style="margin-top:6px">Muted categories still appear in the Feed — they just don't ping the phone. Telegram is unaffected.</div>
    </div>`;

  $('srv-save').onclick = async () => {
    let addr = $('srv-addr').value.trim().replace(/\/+$/, '');
    if (addr && !/^https?:\/\//.test(addr)) addr = `http://${addr}`;
    const result = $('srv-result');
    result.className = 'cfg-result';
    result.textContent = 'testing…';
    try {
      const r = await fetch(`${addr || location.origin}/api/status`).then((x) => x.json());
      localStorage.setItem('cmux-server', addr);
      result.className = 'cfg-result ok';
      result.textContent = `connected ✓ · cmux ${r.cmuxOnline ? 'online' : 'offline'} — reloading…`;
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      result.className = 'cfg-result bad';
      result.textContent = `cannot reach ${addr || 'origin'}: ${err.message}. Not saved.`;
    }
  };

  const enable = $('enable');
  if (enable) enable.onclick = () => enablePush().then(renderSettings);
  const test = $('test');
  if (test) {
    test.onclick = async () => {
      test.disabled = true;
      await api('/api/notify', {
        method: 'POST',
        body: JSON.stringify({ title: '✅ Test push', body: 'Round trip Mac → Apple → phone works.' }),
      }).catch((err) => alert(err.message));
      test.disabled = false;
    };
  }
  for (const box of $('view').querySelectorAll('[data-cat]')) {
    box.onchange = async () => {
      const notify = {};
      for (const b of $('view').querySelectorAll('[data-cat]')) notify[b.dataset.cat] = b.checked;
      await api('/api/prefs', { method: 'POST', body: JSON.stringify({ notify }) }).catch((err) => alert(err.message));
    };
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/public-key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await api('/api/subscribe', { method: 'POST', body: JSON.stringify(sub) });
  } catch (err) {
    alert(`Enable failed: ${err.message}`);
  }
}

// --------------------------------------------------------------------- boot
$('back').onclick = () => { location.hash = '#/'; };
for (const b of $('bottomnav').querySelectorAll('[data-route]')) {
  b.addEventListener('click', () => { location.hash = b.dataset.route; });
}
for (const b of $('tabs').querySelectorAll('button')) {
  b.onclick = () => {
    S.tab = b.dataset.tab;
    document.body.className = `ws ${S.tab}`;
    clearInterval(S.termTimer);
    renderWs();
  };
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
S.route = parseHash();
refreshSnapshot().then(() => {
  connectSSE();
  render();
});
