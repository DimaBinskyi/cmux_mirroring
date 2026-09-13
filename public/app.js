// cmux on the phone — vanilla ES module, no build step.
// Views: #/ (home = sidebar), #/ws/<id> (Term default | Chat | Files),
// #/files/<path> (the Mac's files), #/feed (push history).

import {
  lineText, buildRowsModel, parseInput, computeEdit, normalizeLines, caretInField,
} from './term-input.mjs';
import { createFileBrowser } from './files.mjs';

const APP_VERSION = 'v60'; // keep in sync with sw.js CACHE

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SLASH = ['/compact', '/clear', '/context', '/cost', '/model', '/agents', '/resume', '/rewind', '/todos', '/help'];
const QUICK = ['yes', 'no', 'continue', 'sounds good', 'stop', 'try again'];
const LANE_ORDER = { attention: 0, working: 1, done: 2, idle: 3 };
const LANE_GLYPH = { attention: '🚨', working: '⚙️', done: '✅', idle: '💤' };
const TERM_KEYS = [
  ['escape', 'esc'], ['tab', '⇥'], ['shift+tab', '⇧⇥'],
  ['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'],
  ['ctrl-c', '^C'],
];

const S = {
  snap: null,
  battery: null, // the Mac's, mirrored over SSE — Safari has no battery API of its own
  route: { name: 'home', wsId: null },
  tab: 'term',
  filesPath: null, // where the session's Files tab is standing
  surface: null,
  chat: null,
  search: '',
  searchOpen: false,
  es: null,
  termTimer: null,
};

let grid = null;
let rowsModel = null; // array of per-row span lists; full responses rebuild it, deltas patch it
let lastFullMode = false; // whether the last grid fetch included scrollback
let lastFit = -1; // rows requested last time; a change resizes the model, so no delta
let stickBottom = true;
let historyMode = false; // full plain-text history loaded instead of the live styled grid
let lastGridChangeTs = Date.now();
// The last scroll position we set ourselves. Scroll events that land exactly on
// it are our own repaint talking, not the user — a time window was tried first
// and it silently broke scrolling up while the terminal was producing output,
// because every repaint refreshed the window.
let autoScrollTop = -1;

function setScrollTop(el, top) {
  el.scrollTop = top;
  autoScrollTop = el.scrollTop; // whatever the browser clamped it to
}

// iOS keeps scrolling after the finger lifts. Swapping the rows out mid-flick
// makes the pane jump — the browser drops the scroll position we restore right
// after — so repaints wait for the gesture and its momentum to finish.
let touchActive = false;
let gestureUntil = 0;
let pendingPaint = null;
// Scrolling is only a reading position if the user actually did it. Layout can
// move the pane on its own (web fonts landing after the first paint), and that
// used to drop the view into scrollback the moment it opened.
let lastGestureTs = 0;
// Touching the pane is not scrolling it. Leaving scrollback can trust a plain
// touch — the flick that brought you back to the bottom is still coasting — but
// ENTERING it must not, or a tap on the pane leaves a two-second window in which
// any scroll the layout causes reads as "the user scrolled up". That is what
// dropped the pane into scrollback a second after a tap, on the frame the input
// field grew a line, with the full-scrollback refetch and the jumping that
// follows from it.
let lastMoveTs = 0;
// A pane resize is not a gesture either, and the scroll it settles into can
// arrive a frame or two later, so exact-position matching alone cannot rule it
// out. Resizes are discrete and rare, unlike repaints, so a short window after
// one is safe here in a way a window around every repaint would not be.
let resizeUntil = 0;

const gestureBusy = () => touchActive || Date.now() < gestureUntil;
const userScrolling = () => touchActive || Date.now() - lastGestureTs < 2000;
const userDragging = () => touchActive || Date.now() - lastMoveTs < 2000;

// Every call goes to the origin the app was loaded from. There used to be a
// configurable server address here, from before `tailscale serve` fronted the
// app: the same process serves the PWA and answers /api, so the only address it
// could point at that is not this one is a plain-HTTP fallback the browser
// blocks as mixed content anyway.

// Reading the Mac's files is gated on its own key (data/fs-key on the Mac) —
// the tailnet boundary alone is not what should stand between a browser tab and
// every file in the home directory. Entered once in Settings.
const fsKey = () => localStorage.getItem('cmux-fs-key') || '';

function api(path, opts = {}) {
  const headers = {
    ...(opts.body ? { 'Content-Type': 'application/json' } : null),
    ...(path.startsWith('/api/fs/') ? { 'X-Fs-Key': fsKey() } : null),
  };
  return fetch(path, {
    ...opts,
    headers: Object.keys(headers).length ? headers : undefined,
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
  // The global browser keeps its directory in the hash: deep links work, and in
  // Safari the back gesture walks back up the tree.
  const f = h.match(/^#\/files(?:\/(.*))?$/);
  if (f) return { name: 'files', wsId: null, path: f[1] ? decodeURIComponent(f[1]) : '~' };
  if (h === '#/feed') return { name: 'feed', wsId: null };
  if (h === '#/settings') return { name: 'settings', wsId: null };
  return { name: 'home', wsId: null };
}

window.addEventListener('hashchange', () => {
  const was = S.route;
  S.route = parseHash();
  // Leaving a session drops where its Files tab was standing; moving within the
  // same session (there is nothing that does, today) would keep it.
  if (was.name !== 'ws' || S.route.wsId !== was.wsId) S.filesPath = null;
  S.tab = 'term';
  S.chat = null;
  S.surface = null;
  S.search = '';
  S.searchOpen = false;
  S.chatLimit = 150;
  grid = null;
  rowsModel = null;
  stickBottom = true;
  historyMode = false;
  render();
});

// ------------------------------------------------------------------- status
// Two separate failures the one dot used to blur together: the Mac not
// answering at all (asleep, off the tailnet) and the Mac answering while cmux
// itself is down. They need different things from the user, so they say
// different things here.
let linkUp = false; // the Mac answered us the last time we asked

function connStatus() {
  if (!linkUp) return { cls: 'bad', label: 'Disconnected' };
  if (!S.snap?.online) return { cls: 'warn', label: 'cmux offline' };
  return { cls: 'ok', label: 'Connected' };
}

// Room in the bar is the constraint, so the icon carries the charging state and
// the percent carries the rest. 🔌 is a battery the Mac is holding rather than
// filling ("AC attached; not charging"), which is not the same as charged.
function batteryHtml() {
  const b = S.battery;
  if (!b) return '';
  if (!b.present) return b.ac ? '🔌 AC' : ''; // a Mac with no battery to mirror
  const icon = b.charging ? '⚡️' : b.ac ? '🔌' : '🔋';
  const text = `${icon} ${b.percent}%`;
  return !b.ac && b.percent <= 20 ? `<span class="low">${text}</span>` : text;
}

function setLink(up) {
  linkUp = !!up;
  const { cls, label } = connStatus();
  const dot = $('dot');
  if (dot) dot.className = `dot ${cls}`;
  const note = $('link-note');
  if (note) note.textContent = label;
  const batt = $('hdr-batt');
  if (batt) {
    batt.innerHTML = batteryHtml();
    batt.classList.toggle('stale', !linkUp);
  }
}

// --------------------------------------------------------------------- SSE
let chatRefetchTimer = null;

function connectSSE() {
  if (S.es) S.es.close();
  S.es = new EventSource('/api/stream');
  S.es.onopen = () => setLink(true);
  S.es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'battery') {
      S.battery = msg.battery;
      setLink(true);
      return;
    }
    if (msg.type === 'state') {
      S.snap = msg.snapshot;
      if (msg.snapshot.battery) S.battery = msg.snapshot.battery;
      setLink(true);
      if (S.route.name === 'home') renderHome();
      if (S.route.name === 'ws') {
        updateChips(); // tabs created/closed on the Mac appear live
        if (S.tab === 'chat') {
          clearTimeout(chatRefetchTimer);
          chatRefetchTimer = setTimeout(fetchChat, 800);
        }
      }
      updateNavBadge();
    } else if (msg.type === 'push' && S.route.name === 'feed') {
      renderFeed();
    }
  };
  S.es.onerror = () => setLink(false);
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
    if (S.snap.battery) S.battery = S.snap.battery;
    setLink(true);
    render();
  } catch {
    setLink(false);
  }
}

// --------------------------------------------------------------- topology
// Long-press (touch) / right-click (desktop) without stealing the normal tap.
function onLongPress(el, fn) {
  let timer = null;
  let fired = false;
  const start = () => {
    fired = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) navigator.vibrate(12);
      fn();
    }, 550);
  };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
    if (!fired) fn();
  });
  el.addEventListener('click', (e) => {
    if (fired) {
      e.preventDefault();
      e.stopPropagation();
      fired = false;
    }
  }, true);
}

function renameWorkspacePrompt(id, current) {
  const title = window.prompt('Rename workspace:', current || '');
  if (title !== null && title.trim()) wsAction({ action: 'renameWorkspace', workspace_id: id, title: title.trim() });
}

function renameTabPrompt(surfaceId, current) {
  const title = window.prompt('Rename tab:', current || '');
  if (title !== null && title.trim()) {
    wsAction({ action: 'renameTab', surface_id: surfaceId, workspace_id: ws()?.id, title: title.trim() })
      .then((ok) => { if (ok) setTimeout(refreshSnapshot, 900); });
  }
}

async function wsAction(body, confirmMsg) {
  if (confirmMsg && !window.confirm(confirmMsg)) return false;
  try {
    await api('/api/ws-action', { method: 'POST', body: JSON.stringify(body) });
    setTimeout(refreshSnapshot, 700);
    return true;
  } catch (err) {
    alert(`Action failed: ${err.message}`);
    return false;
  }
}

// ------------------------------------------------------------------- render
function render() {
  clearTimeout(S.termTimer);
  $('switcher').hidden = true;
  document.body.className = S.route.name === 'ws' ? `ws ${S.tab}` : '';
  $('topbar').className = S.route.name === 'ws' ? 'ws' : '';
  $('nav-sessions').classList.toggle('active', S.route.name === 'home');
  $('nav-files').classList.toggle('active', S.route.name === 'files');
  $('nav-feed').classList.toggle('active', S.route.name === 'feed');
  $('nav-settings').classList.toggle('active', S.route.name === 'settings');

  setLink(linkUp); // the bar carries the link state and the battery on every view
  if (S.route.name === 'home') {
    $('title').textContent = 'cmux mirroring';
    renderHome();
  } else if (S.route.name === 'files') {
    $('title').textContent = 'Files';
    $('view').innerHTML = '<div id="fb"></div>';
    globalFiles.mount($('fb'), S.route.path || '~');
  } else if (S.route.name === 'feed') {
    $('title').textContent = 'Feed';
    renderFeed();
  } else if (S.route.name === 'settings') {
    $('title').textContent = 'Settings';
    renderSettings();
  } else {
    renderWs();
  }
  updateNavBadge();
  if (typeof reportWatching === 'function') reportWatching();
}

function updateNavBadge() {
  const n = (S.snap?.workspaces || []).filter((w) => w.lane === 'attention').length;
  $('nav-sessions').innerHTML = n ? `Sessions <span class="badge">${n}</span>` : 'Sessions';
}

// --------------------------------------------------------------------- home
function wsRow(w) {
  const detail = w.pending[0]?.title || w.laneDetail || w.lastMessage || w.cwd || '';
  const when = relTime(w.laneTs || w.lastSubmittedAt);
  return `<div class="ws-row ${w.lane}">
    <button class="ws-open" data-ws="${esc(w.id)}">
      <div class="t"><span>${LANE_GLYPH[w.lane] || ''} ${esc(w.title)}</span><span class="when">${when}</span></div>
      <div class="d">${esc(detail)}</div>
    </button>
    <button class="ws-close" data-close="${esc(w.id)}" data-title="${esc(w.title)}" title="Close workspace">✕</button>
  </div>`;
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
  html += '<button class="bigbtn secondary" id="new-ws">＋ New workspace</button>';
  const bodyRect = document.body.getBoundingClientRect();
  const sab = getComputedStyle(document.documentElement).getPropertyValue('--sab').trim();
  html += `<div class="note">app ${APP_VERSION} · win ${window.innerHeight} · screen ${window.screen.height}
    · body ${Math.round(bodyRect.top)}→${Math.round(bodyRect.bottom)} · doc ${document.documentElement.clientHeight} · sab ${sab || '?'}</div>`;
  $('view').innerHTML = html || '<div class="empty">No workspaces.</div>';

  for (const el of $('view').querySelectorAll('[data-ws]')) {
    el.onclick = () => { location.hash = `#/ws/${encodeURIComponent(el.dataset.ws)}`; };
    const title = byId.get(el.dataset.ws)?.title || '';
    onLongPress(el, () => renameWorkspacePrompt(el.dataset.ws, title));
  }
  for (const el of $('view').querySelectorAll('[data-close]')) {
    el.onclick = () => wsAction(
      { action: 'closeWorkspace', workspace_id: el.dataset.close },
      `Close workspace "${el.dataset.title}"? This kills everything running in it.`,
    );
  }
  const newWs = $('new-ws');
  if (newWs) {
    newWs.onclick = () => {
      const cwd = window.prompt('Folder for the new workspace:', '~/Documents/dev');
      if (cwd !== null) wsAction({ action: 'newWorkspace', cwd: cwd.trim() || undefined });
    };
  }
}

// ---------------------------------------------------------------- workspace
function chipsHtml(w) {
  const chips = w.surfaces.map((s) => `<span class="chip ${s.id === S.surface ? 'active' : ''}">
    <button data-surf="${esc(s.id)}">${s.type === 'browser' ? '🌐 ' : ''}${esc(s.title || s.ref)}</button>
    <button class="chip-x" data-close-surf="${esc(s.id)}" data-title="${esc(s.title || s.ref)}">✕</button>
  </span>`).join('');
  return `<div class="chips">${chips}<button class="chip-add" id="add-tab" title="New tab">＋</button></div>`;
}

function selectSurface(id) {
  S.surface = id;
  grid = null;
  rowsModel = null;
  stickBottom = true;
  historyMode = false;
  if (S.tab === 'chat') {
    S.chat = null;
    renderChat();
  } else {
    renderTerm();
  }
}

async function addTab() {
  const w = ws();
  if (!w) return;
  const before = new Set(w.surfaces.map((s) => s.id));
  const ok = await wsAction({ action: 'newTab', workspace_id: w.id });
  if (!ok) return;
  setTimeout(async () => {
    await refreshSnapshot();
    const fresh = ws()?.surfaces.find((s) => !before.has(s.id));
    if (fresh) selectSurface(fresh.id);
  }, 1000);
}

// Refresh the chips row in place when the topology changes on the Mac —
// without re-rendering the whole view (that would disturb scroll/typing).
let lastChipsKey = '';

function updateChips() {
  const w = ws();
  if (!w || S.route.name !== 'ws') return;
  if (S.surface && !w.surfaces.some((s) => s.id === S.surface)) {
    S.surface = null; // current tab was closed on the Mac
    renderWs();
    return;
  }
  const key = w.surfaces.map((s) => `${s.id}:${s.title}:${s.hasSession}`).join('|') + `@${S.surface}`;
  if (key === lastChipsKey) return;
  lastChipsKey = key;
  const el = $('view').querySelector('.chips');
  if (!el) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = chipsHtml(w);
  el.replaceWith(tmp.firstElementChild);
  bindChips();
}

function bindChips() {
  for (const b of $('view').querySelectorAll('[data-surf]')) {
    b.onclick = () => selectSurface(b.dataset.surf);
    const cur = ws()?.surfaces.find((s) => s.id === b.dataset.surf);
    onLongPress(b, () => renameTabPrompt(b.dataset.surf, cur?.title || ''));
  }
  for (const b of $('view').querySelectorAll('[data-close-surf]')) {
    b.onclick = async () => {
      const w = ws();
      const ok = await wsAction(
        { action: 'closeTab', surface_id: b.dataset.closeSurf, workspace_id: w?.id },
        `Close tab "${b.dataset.title}"?`,
      );
      if (ok && S.surface === b.dataset.closeSurf) S.surface = null;
    };
  }
  const add = $('add-tab');
  if (add) add.onclick = addTab;
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
  else if (S.tab === 'files') renderFilesTab();
  else renderTerm();
}

// The session's own files — no surface chips here, because a working directory
// belongs to the workspace, not to whichever tab is in front.
function renderFilesTab() {
  const w = ws();
  $('view').innerHTML = '<div id="fb"></div>';
  wsFiles.mount($('fb'), S.filesPath || w.cwd || '~');
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
  return linkUploads(esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>'));
}

// A path to something this phone uploaded becomes a chip that opens the file —
// on a phone the full path is a wall of text nobody can check anyway. Upload
// names are sanitized server-side to [\w.-], so they are safe inside the
// attribute without a second escape.
const UPLOAD_PATH = /(?:\/[\w.-]+)*\/data\/uploads\/([\w.-]+)/g;
const linkUploads = (html) => html.replace(
  UPLOAD_PATH,
  (_, name) => `<button class="filelink" data-file="${name}">📎 ${fileLabel(name)}</button>`,
);

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
        lines.push(`🔧 ${esc(t.name)} ${linkUploads(esc(t.detail))} ${mark}`);
        i += 1;
      }
      html += `<div class="tools">${lines.join('<br>')}</div>`;
      continue;
    }
    html += `<div class="msg ${m.role}">${m.role === 'assistant' ? mdLite(m.text) : linkUploads(esc(m.text))}</div>`;
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

  for (const b of view.querySelectorAll('.filelink')) b.onclick = () => openViewer(b.dataset.file);

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
// The pane's bottom edge is the live edge, and it moves while you type: the
// field below grows a line whenever a long command wraps, and iOS resizes the
// visible viewport around the keyboard. Nothing re-pinned the text to that edge
// except the next repaint, up to 150ms later, so the pane first swallowed its
// bottom row and then snapped it back up — measurably ~66ms of the text sitting
// in the wrong place, and that snap is the jump you can see. A ResizeObserver
// runs after layout and before paint, so the correction now lands in the same
// frame as the resize: the bottom row tracks the edge instead of chasing it.
let paneHeight = 0;

const paneResize = new ResizeObserver(() => {
  const el = $('screen');
  if (!el) return;
  const prev = paneHeight;
  paneHeight = el.clientHeight;
  if (!prev || !paneHeight || prev === paneHeight) return; // first sighting, or a hidden pane
  // Everything that follows from this resize — our re-pin, the engine settling
  // after it, the refetch a different row count triggers — is the layout, not a
  // reader. See resizeUntil.
  resizeUntil = Date.now() + 600;
  if (stickBottom && !historyMode) setScrollTop(el, el.scrollHeight);
  else setScrollTop(el, el.scrollTop + (prev - paneHeight)); // same bottom row, shorter pane
});

function renderTerm() {
  const w = ws();
  clearTimeout(pendingPaint); // the pane is about to be replaced
  touchActive = false;
  gestureUntil = 0;
  inputKind = null; // re-detected from this pane's first repaint
  const keys = TERM_KEYS.map(([k, label]) => `<button class="btn" data-tkey="${k}">${label}</button>`).join('');
  $('view').innerHTML = `
    ${chipsHtml(w)}
    <div id="term-wrap">
      <div id="screen"></div>
      <button id="jump-live" title="Back to live" hidden>⌄</button>
    </div>
    <div id="termbar">
      <div id="term-suggest" hidden></div>
      <div id="searchrow" ${S.searchOpen ? '' : 'hidden'}>
        <input id="termsearch" placeholder="Search scrollback…" autocapitalize="off" autocorrect="off" value="${esc(S.search)}">
        <button class="btn" id="search-prev" title="Previous hit">▲</button>
        <button class="btn" id="search-next" title="Next hit">▼</button>
        <span id="searchcount"></span>
      </div>
      <div id="keysbar">
        <div class="keysrow-line"><button class="btn" id="kb-hide" title="Hide keyboard">⌄⌨</button>${keys}</div>
        <div class="keysrow-line"><button class="btn" id="term-attach" title="Attach a photo, video or file — hold to browse uploads">📎</button><button class="btn" id="search-toggle">🔍</button><button class="btn" id="full-history">${historyMode ? '🎨 Color' : '▲ All'}</button><button class="btn" id="send-line" title="Send">⏎</button></div>
      </div>
      <textarea id="terminput" rows="1" placeholder="⌨ Type here — Enter = new line, ⏎ sends"
        autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></textarea>
    </div>`;
  bindChips();

  for (const b of $('view').querySelectorAll('[data-tkey]')) {
    const k = b.dataset.tkey;
    b.onclick = () => {
      specialKey(k, SYNC_KEYS.has(k));
      if (k === 'left') nudgeCaret(-1);
      if (k === 'right') nudgeCaret(1);
    };
  }
  $('send-line').onclick = submitLine;
  $('search-toggle').onclick = toggleSearch;
  $('full-history').onclick = () => (historyMode ? goLive() : loadFullHistory());
  $('kb-hide').onclick = () => document.activeElement?.blur?.();
  $('term-attach').onclick = () => pickAttachment($('term-attach'), insertPath);
  onLongPress($('term-attach'), openGallery); // hold: browse what has been uploaded
  $('termsearch').addEventListener('input', () => {
    S.search = $('termsearch').value;
    applySearch();
  });
  $('termsearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepSearch(e.shiftKey ? -1 : 1);
    }
  });
  $('search-prev').onclick = () => stepSearch(-1);
  $('search-next').onclick = () => stepSearch(1);
  $('jump-live').onclick = goLive;

  const screen = $('screen');
  paneHeight = 0; // a new element: the old height says nothing about this one
  paneResize.disconnect();
  paneResize.observe(screen);
  const enterScrollback = () => {
    if (!stickBottom) return;
    stickBottom = false;
    $('jump-live').hidden = false;
    pollGrid(true); // pull styled scrollback in; updates keep flowing
  };
  let lastScrollTop = screen.scrollTop;
  screen.onscroll = () => {
    // Scrolling sideways is not a mode change: reading a long line must not
    // snap the view back to live.
    const top = screen.scrollTop;
    const movedDown = top !== lastScrollTop;
    lastScrollTop = top;
    if (historyMode || !movedDown) return;
    // Our own repaint scrolling back to the bottom: not a reading position.
    if (top === autoScrollTop) return;
    const off = screen.scrollHeight - top - screen.clientHeight;
    // In live mode the pane belongs on the live edge, so a scroll nobody asked
    // for — the layout settling after a resize, the engine re-clamping — is put
    // back at once instead of leaving the view parked off the bottom until the
    // next content change, which on an idle session can be minutes. Only when it
    // is a real departure: a few pixels of disagreement with the engine must be
    // left alone, or correcting it becomes its own oscillation.
    if (stickBottom && off > 40 && !userDragging()) {
      setScrollTop(screen, screen.scrollHeight);
      return;
    }
    if (!userScrolling()) return;
    // The pane just changed size — this is the layout settling, not a reader.
    if (Date.now() < resizeUntil) return;
    if (!touchActive) gestureUntil = Date.now() + 250; // momentum still running
    const atBottom = off < 40;
    if (!atBottom && stickBottom && userDragging()) enterScrollback();
    else if (atBottom && !stickBottom && !S.searchOpen) {
      stickBottom = true;
      $('jump-live').hidden = true;
      pollGrid(true);
    }
  };
  // When the live viewport barely overflows (or not at all), the scroll
  // handler can't fire — catch the upward intent directly: mouse wheel up
  // near the top, or a touch pull-down at the top.
  screen.addEventListener('wheel', (e) => {
    lastGestureTs = Date.now();
    lastMoveTs = Date.now();
    if (!historyMode && e.deltaY < 0 && screen.scrollTop < 80) enterScrollback();
  }, { passive: true });
  screen.addEventListener('pointerdown', () => { lastGestureTs = Date.now(); }, { passive: true });
  let touchStartY = null;
  screen.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0]?.clientY ?? null;
    touchActive = true;
    lastGestureTs = Date.now();
  }, { passive: true });
  screen.addEventListener('touchmove', (e) => {
    lastGestureTs = Date.now();
    lastMoveTs = Date.now();
    if (touchStartY === null || historyMode) return;
    const dy = (e.touches[0]?.clientY ?? touchStartY) - touchStartY;
    if (dy > 40 && screen.scrollTop <= 0) {
      touchStartY = null;
      enterScrollback();
    }
  }, { passive: true });
  for (const ev of ['touchend', 'touchcancel']) {
    screen.addEventListener(ev, () => {
      touchActive = false;
      gestureUntil = Date.now() + 350; // let the flick coast before repainting
    }, { passive: true });
  }

  bindTermInput();
  autosizeInput();
  prevLines = null;
  pollGrid(true);
  // Adaptive poll: 150ms while the screen is actively changing, easing to 1s
  // when it's been quiet. A poll that changed nothing costs ~60 bytes (an empty
  // delta) and, since pollGrid leaves lastGridChangeTs alone for those, does not
  // hold the loop at the fast rate.
  const loop = () => {
    if (S.route.name !== 'ws' || S.tab !== 'term') return;
    const active = Date.now() - lastGridChangeTs < 10_000;
    S.termTimer = setTimeout(async () => {
      if (document.visibilityState === 'visible') await pollGrid(false);
      loop();
    }, active ? 150 : 1000);
  };
  loop();
}

function selectionInScreen() {
  const sel = window.getSelection();
  return sel && !sel.isCollapsed && $('screen')?.contains(sel.anchorNode);
}

// The control socket re-serialises the cursor with its keys in a different order
// on every call, so comparing the JSON always reports a change. Only row and
// column are ever read — `visible` also flaps with pane focus (see below).
const sameCursor = (a, b) => !!a && !!b && a.row === b.row && a.column === b.column;

// How many panes' worth of rows to keep loaded in live mode. One is what shows;
// the rest sits above it so a scroll up lands on real text immediately. Without
// it the first flick up hits blank rows and waits on the full-scrollback fetch —
// ~141KB over Tailscale against ~62KB for this, and the fetch still starts the
// moment the scroll does, so the spare pane only has to cover that round trip.
const PRELOAD_PANES = 2;

// Rows the pane can show. The pty is usually shorter than the pane on a phone,
// so this is what the server tops up from scrollback — one row more than fits,
// so rounding leaves a part-row to scroll rather than a blank sliver.
function paneFit() {
  const el = $('screen');
  if (!el || !el.clientHeight) return 0;
  const rowH = termFont() * 1.35; // matches #screen's line-height
  return (Math.floor((el.clientHeight - 16) / rowH) + 1) * PRELOAD_PANES; // 16 = the pane's padding
}

async function pollGrid(force) {
  if (S.route.name !== 'ws' || S.tab !== 'term' || !S.surface || historyMode) return;
  // Always live — pause only while searching or selecting text to copy.
  if (!force && (S.searchOpen || selectionInScreen())) return;
  try {
    // At the bottom: viewport plus just enough scrollback to fill the pane.
    // Scrolled up: the whole styled scrollback, and KEEP updating — live everywhere.
    const full = !stickBottom;
    const fit = full ? 0 : paneFit();
    const sameShape = lastFullMode === full && lastFit === fit;
    const since = grid && rowsModel && sameShape ? `&since=${encodeURIComponent(grid.seq)}` : '';
    const g = await api(`/api/grid?surface=${encodeURIComponent(S.surface)}${full ? '&full=1' : `&fit=${fit}`}${since}`);
    if (g.unchanged) {
      // Fresh view (e.g. after a tab switch) with an unchanged revision:
      // repaint from the cached model or the screen stays blank forever.
      if (prevLines === null && rowsModel) paintGrid();
      return;
    }
    let quiet = false;
    if (g.delta && grid && rowsModel && sameShape) {
      // cmux stamps a fresh render_revision on every replay, so a poll where
      // nothing happened still arrives as a delta carrying an empty `changed`
      // — the usual case on an idle surface (24 polls in 25, measured). Counting
      // that as activity pinned the poll loop at 150ms and rebuilt every line
      // string seven times a second for a screen that had not moved.
      quiet = prevLines !== null && !Object.keys(g.changed).length && sameCursor(grid.cursor, g.cursor);
      grid.seq = g.seq;
      grid.cursor = g.cursor;
      Object.assign(grid.styles, g.styles);
      for (const [i, spans] of Object.entries(g.changed)) rowsModel[Number(i)] = spans;
    } else {
      grid = g;
      rowsModel = buildRowsModel(g);
    }
    lastFullMode = full;
    lastFit = fit;
    if (quiet) return;
    lastGridChangeTs = Date.now();
    paintGrid();
  } catch (err) {
    const el = $('screen');
    if (el && !grid) el.innerHTML = `<div class="empty">terminal unavailable: ${esc(err.message)}</div>`;
  }
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

const termFont = () => Math.min(16, Math.max(7, parseFloat(localStorage.getItem('term-font') || '9.5')));

// Rows live in a box inside the pane rather than in the pane itself — see
// #gridrows in index.html for what goes wrong when the scroll container is the
// flex box. Anything that replaces the pane's contents (an error, full history)
// drops it, so it is recreated on demand rather than assumed.
function rowsHost(el) {
  let host = el.firstElementChild;
  if (!host || host.id !== 'gridrows') {
    el.innerHTML = '<div id="gridrows"></div>';
    host = el.firstElementChild;
  }
  return host;
}

function paintGrid() {
  const el = $('screen');
  if (!el || !grid || !rowsModel) return;
  if (gestureBusy()) {
    clearTimeout(pendingPaint);
    pendingPaint = setTimeout(paintGrid, 120);
    return;
  }
  el.style.background = grid.bg;
  el.style.color = grid.fg;
  el.style.fontSize = `${termFont()}px`;

  const lines = rowsModel.map((spans) => {
    let col = 0;
    let line = '';
    for (const s of spans) {
      if (s.column > col) line += ' '.repeat(s.column - col);
      line += spanHtml(s, grid);
      col = s.column + (s.cell_width || [...s.text].length);
    }
    return line || ' ';
  });

  // Diff per line: typical updates touch a handful of rows, so patching only
  // those keeps repaints cheap and scroll/selection stable.
  const host = rowsHost(el);
  const kids = host.children;
  const canDiff = prevLines && prevLines.length === lines.length
    && kids.length === lines.length && kids[0]?.classList.contains('tl');
  if (canDiff) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== prevLines[i]) kids[i].innerHTML = lines[i];
    }
  } else {
    // Full rebuild (e.g. viewport↔scrollback mode switch): replacing the rows
    // resets both axes, so restore the reading position — distance from the
    // bottom vertically, exact offset horizontally.
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const left = el.scrollLeft;
    host.innerHTML = lines.map((l) => `<div class="tl">${l}</div>`).join('');
    if (!stickBottom) setScrollTop(el, Math.max(0, el.scrollHeight - el.clientHeight - Math.max(0, dist)));
    el.scrollLeft = left;
  }
  prevLines = lines;
  // Stay glued to the newest output. The horizontal offset is left alone — it
  // belongs to the user; only "back to live" (⌄) returns to the left edge.
  if (stickBottom) setScrollTop(el, el.scrollHeight);
  if (S.search) applySearch();
  syncFieldFromTerminal(true);
  updateTermSuggest();
}

// Mirror Claude Code's slash-command dropdown: when the composer shows its
// suggestion menu (rows under the cursor like "/clear  Clear…"), surface the
// commands as tappable chips above the input.
function updateTermSuggest() {
  const el = $('term-suggest');
  const ti = $('terminput');
  if (!el || !ti || !grid || !rowsModel) return;
  const val = ti.value;
  const items = [];
  if (val.startsWith('/') && !val.includes('\n')) {
    const seen = new Set();
    const r = grid.cursor.row;
    for (let i = r + 1; i <= Math.min(grid.rows - 1, r + 12); i += 1) {
      const t = lineText(rowsModel[grid.scrollbackRows + i] || []);
      const m = t.match(/^\s*[❯>]?\s*(\/[\w][\w:-]*)(\s|$)/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        items.push(m[1]);
        if (items.length >= 8) break;
      } else if (items.length && !m && t.trim()) break; // menu block ended
    }
  }
  el.hidden = !items.length;
  el.innerHTML = items.map((c) => `<button data-cmd="${esc(c)}">${esc(c)}</button>`).join('');
  for (const b of el.querySelectorAll('[data-cmd]')) {
    b.onclick = () => {
      ti.value = b.dataset.cmd;
      diffAndSend(ti.value); // fills the composer too
      ti.focus();
    };
  }
}

// Back to the bottom + viewport-only live mode; closes history/search state.
function goLive() {
  const screen = $('screen');
  if (screen) {
    screen.scrollLeft = 0; // back to the left edge, not just the bottom
    setScrollTop(screen, screen.scrollHeight);
  }
  historyMode = false;
  const toggle = $('full-history');
  if (toggle) toggle.textContent = '▲ All';
  if (S.searchOpen) {
    S.searchOpen = false;
    S.search = '';
    const row = $('searchrow');
    if (row) row.hidden = true;
    const tsi = $('termsearch');
    if (tsi) tsi.value = '';
    applySearch();
  }
  stickBottom = true;
  $('jump-live').hidden = true;
  prevLines = null;
  pollGrid(true);
}

function toggleSearch() {
  S.searchOpen = !S.searchOpen;
  $('searchrow').hidden = !S.searchOpen;
  if (S.searchOpen) {
    // Load scrollback so search covers it; polls pause while searching.
    const ready = historyMode ? Promise.resolve() : (async () => {
      stickBottom = false;
      $('jump-live').hidden = false;
      await pollGrid(true);
    })();
    ready.then(() => $('termsearch').focus());
  } else if (!historyMode) {
    goLive();
  } else {
    S.search = '';
    $('termsearch').value = '';
    applySearch();
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
    const { text, altScreen } = await api(`/api/screen?surface=${encodeURIComponent(S.surface)}&scrollback=1&lines=10000`);
    const lines = text.split('\n');
    const note = altScreen
      ? 'no scrollback — this pane runs a full-screen app, which keeps its own history'
      : `full history · ${lines.length} lines · plain text`;
    el.innerHTML = `<div class="note">${esc(note)} · 🎨 Color returns to live</div>`
      + lines.map((l) => `<div class="tl">${esc(l) || ' '}</div>`).join('');
    el.scrollTop = el.scrollHeight;
    if (S.search) applySearch();
  } catch (err) {
    el.innerHTML = `<div class="empty">history unavailable: ${esc(err.message)}</div>`;
    goLive();
  }
}

let searchHits = [];
let searchIdx = 0;

function applySearch() {
  const el = $('screen');
  if (!el) return;
  const q = S.search.trim().toLowerCase();
  searchHits = [];
  for (const line of el.querySelectorAll('.tl')) {
    const hit = q && line.textContent.toLowerCase().includes(q);
    line.classList.toggle('hitline', !!hit);
    line.classList.remove('current');
    if (hit) searchHits.push(line);
  }
  searchIdx = 0;
  focusSearchHit(!!q);
}

function focusSearchHit(scroll = true) {
  const counter = $('searchcount');
  if (!searchHits.length) {
    if (counter) counter.textContent = S.search.trim() ? '0' : '';
    return;
  }
  for (const h of searchHits) h.classList.remove('current');
  const cur = searchHits[searchIdx];
  cur.classList.add('current');
  if (scroll) cur.scrollIntoView({ block: 'center' });
  if (counter) counter.textContent = `${searchIdx + 1}/${searchHits.length}`;
}

function stepSearch(d) {
  if (!searchHits.length) return;
  searchIdx = (searchIdx + d + searchHits.length) % searchHits.length;
  focusSearchHit();
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
  keyRefreshTimer = setTimeout(() => pollGrid(true), 30);
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
      syncFieldFromTerminal(false, true);
    }, 160);
  }
}

async function submitLine() {
  // Echo-through means the pty already has every character — Enter is enough.
  await specialKey('enter');
  const ti = $('terminput');
  if (ti) {
    ti.value = '';
    autosizeInput();
  }
  fieldPrev = '';
  ptyCaret = 0;
}

// Bar/hardware ←→ move the pty cursor; mirror the estimate and the field caret.
function nudgeCaret(dir) {
  const ti = $('terminput');
  const len = [...(ti?.value || '')].length;
  ptyCaret = Math.max(0, Math.min(len, ptyCaret + dir));
  try {
    ti.setSelectionRange(ptyCaret, ptyCaret);
  } catch {
    /* not focused */
  }
}

let fieldPrev = ''; // the input-line text the pty currently agrees with

// Keep the composer tall enough to read and easy to tap: grows with content
// (up to ~6 lines) and never collapses below a comfortable 2-line box.
let fieldLen = 0;
let fieldLines = 0;

function autosizeInput() {
  const ti = $('terminput');
  if (!ti) return;
  const len = ti.value.length;
  const nl = (ti.value.match(/\n/g) || []).length;
  // Measuring means collapsing the box to one row and reading it back, which
  // makes the terminal pane above briefly that much taller — the whole field's
  // height, so the taller the field the bigger the disturbance. Only pay for it
  // when the answer can have changed: the text overflows the box (needs to grow)
  // or it lost characters or a line (may need to shrink). An unset inline height
  // means this is the first call for a fresh field, which always measures.
  const mayShrink = len < fieldLen || nl < fieldLines;
  fieldLen = len;
  fieldLines = nl;
  if (ti.style.height && !mayShrink && ti.scrollHeight <= ti.clientHeight) return;
  // Collapsing the box makes the terminal pane above it taller for the duration
  // of the measurement, and the browser clamps the pane's scroll position to
  // that taller box. Putting the height back does NOT put the scroll back:
  // Blink restores it (scroll anchoring), WebKit has no such thing, so on the
  // phone the pane was left scrolled up by exactly the height of the field and
  // the next repaint snapped it down again. That is the jump, and its size is
  // the field's — 8px at one line, 35px at three — which is why more lines made
  // it worse. Restoring here, in the same task, means it never reaches a paint.
  const pane = $('screen');
  const keep = pane ? pane.scrollTop : 0;
  ti.style.height = 'auto';
  ti.style.height = `${Math.min(Math.max(ti.scrollHeight, 46), 132)}px`;
  if (!pane) return;
  // Reading the geometry flushes the layout the line above invalidated, so this
  // is the pane at its real size again, not the collapsed one.
  const restored = Math.min(keep, Math.max(0, pane.scrollHeight - pane.clientHeight));
  if (pane.scrollTop !== restored) setScrollTop(pane, restored);
}

function setField(ti, text) {
  fieldPrev = text; // terminal is the source here — reset the diff baseline
  if (ti.value === text) return;
  ti.value = text;
  autosizeInput();
  try {
    ti.setSelectionRange(text.length, text.length);
  } catch {
    /* not focused */
  }
}

// Where the pty's cursor sits within the input text; arrow keys move it and
// every edit is expressed relative to it.
let ptyCaret = 0;

// What the pane's input line is, last time we could tell — it decides how a
// newline is sent (the composer and a shell want different things; see
// computeEdit). Sticky, because the sync backs off while the user types, and
// reset per pane so a previous tab's answer can't leak. Until it is known the
// shell form is used: it is merely imperfect in the composer, where shift+enter
// in a shell would spray an escape sequence into the command line.
let inputKind = null;

function diffAndSend(newValue) {
  const lineBreak = inputKind === 'composer' ? 'key' : 'escape';
  const { ops, caret } = computeEdit(fieldPrev, newValue, ptyCaret, { lineBreak });
  fieldPrev = newValue;
  ptyCaret = caret;
  for (const op of ops) queueOp(op.t, op.v);
}

// Mirror the terminal's input line into the field (see parseInput for the
// shapes it recognizes). auto=true runs on every repaint — that is what shows
// Mac-side typing and history recalls on the phone — but backs off while the
// user is typing here or a flush is pending.
function syncFieldFromTerminal(auto = false, afterKey = false) {
  const ti = $('terminput');
  if (!ti || !grid || !rowsModel) return;
  // Field focus must not gate this: the field keeps focus even while the user
  // types on the Mac. cursor.visible is false on unfocused panes, so it can't
  // gate it either.
  if (auto && (opQueue.length || flushing || Date.now() - lastLocalInputTs < 1500)) return;
  const parsed = parseInput(grid, rowsModel, { afterKey });
  // 'busy' means a dialog or menu owns the keyboard (/model, a permission
  // prompt, any TUI) — the field must keep whatever the user has drafted.
  if (!parsed || parsed.kind === 'busy') return;
  inputKind = parsed.kind;
  syncSet(ti, parsed.text, parsed.tail);
}

// Erasing repaints old cells as spaces, so the grid cannot tell a typed
// trailing space from an erase artifact. Compare ignoring trailing whitespace
// per line: if field and terminal agree that far the FIELD is authoritative (it
// may hold real trailing spaces) and the user's caret is left alone; otherwise
// the terminal wins and the caret follows its cursor.
function syncSet(ti, text, tail = 0) {
  if (normalizeLines(text) !== normalizeLines(ti.value)) {
    setField(ti, text);
    ptyCaret = Math.max(0, [...text].length - tail);
    try {
      ti.setSelectionRange(ptyCaret, ptyCaret);
    } catch {
      /* not focused */
    }
  } else {
    // Same text, but the field may hold trailing spaces the grid dropped — the
    // caret has to be mapped through them, not counted back from the end.
    ptyCaret = caretInField(ti.value, text, tail);
  }
}

function bindTermInput() {
  const ti = $('terminput');
  fieldPrev = ti.value || '';
  // Enter always inserts a newline in the field; ONLY the ⏎ bar button
  // submits. (On a slash-command line the newline stays local — see
  // diffAndSend — because sending it would make Claude execute the command.)
  ti.addEventListener('input', () => {
    lastLocalInputTs = Date.now();
    autosizeInput();
    diffAndSend(ti.value);
  });
  // Regrow when returning to the field (iOS collapses it on blur/rerender).
  ti.addEventListener('focus', autosizeInput);
  ti.addEventListener('keydown', (e) => {
    lastLocalInputTs = Date.now();
    if (e.key === 'ArrowUp' && !ti.value) {
      e.preventDefault();
      specialKey('up', true); // history recall only from an empty field
    } else if (e.key === 'ArrowDown' && !ti.value) {
      e.preventDefault();
      specialKey('down', true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      specialKey('tab', true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      specialKey('escape');
    }
    // arrows with content move the local caret; edits re-align the pty cursor
  });
}

// -------------------------------------------------------------- attachments
// Anything from the phone — camera, library, Files — uploads to the Mac, then the
// saved file path is inserted into the prompt so the agent can open it. Not every
// type is one Claude can read (see AGENT_READS); the rest just land on the Mac,
// and the gallery says so rather than letting you find out from the agent.
// Tap 📎 to add, hold it to look at what has already gone over.
let attachHandler = null;

const IMAGE_FILE = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i;
const VIDEO_FILE = /\.(mov|mp4|m4v|webm)$/i;
// What the agent can actually open with Read. HEIC and AVIF are images the phone
// previews happily and Claude cannot decode, so they are deliberately absent —
// new uploads get transcoded server-side, but older ones are still in the list.
const AGENT_READS = /\.(jpe?g|png|gif|webp|bmp|pdf|txt|md|json|csv|log|xml|ya?ml|html?|[cm]?js|ts|py|sh|rs|go|java|rb|php|css|toml|ini|env|sql|diff|patch)$/i;
// Uploads are saved as "<epoch-ms>-<original name>"; the stamp is noise to read.
const fileLabel = (name) => String(name).replace(/^\d{10,}-/, '');
const fileUrl = (name) => `/api/upload-file?name=${encodeURIComponent(name)}`;

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

// Tap 📎 and iOS offers library / camera / Files itself; hold it for what has
// already been uploaded. Anything of ours in front of that sheet is a second menu
// on top of a menu — and only the camera could ever have skipped Safari's, which
// is not worth an extra tap on the other two.
function pickAttachment(btn, onPath) {
  attachHandler = { btn, onPath, label: btn.textContent };
  $('attach-file').click();
}

// Drop a path into whichever input the user is looking at.
function insertPath(p) {
  const term = S.route.name === 'ws' && S.tab === 'term';
  const el = term ? $('terminput') : $('input');
  if (!el) return;
  el.value += `${el.value && !el.value.endsWith(' ') ? ' ' : ''}${p} `;
  if (term) {
    el.dispatchEvent(new Event('input', { bubbles: true })); // the diff sends it to the pty
  } else {
    el.focus();
    renderSuggestions();
  }
}

// The sheet doubles as a bulk editor: hold a row to start selecting, tap rows
// to add and drop them, then delete the lot in one request. The listing is kept
// so toggling a selection is a re-render, not a refetch.
let galleryFiles = [];
let gallerySelected = null; // Set of names while selecting, null when not

function closeGallery() {
  $('gallery').hidden = true;
  gallerySelected = null;
}

async function openGallery() {
  const sheet = $('gallery-sheet');
  sheet.innerHTML = '<div class="note">Loading attachments…</div>';
  $('gallery').hidden = false;
  gallerySelected = null;
  try {
    ({ files: galleryFiles } = await api('/api/uploads'));
  } catch (err) {
    sheet.innerHTML = `<div class="note">Attachments unavailable: ${esc(err.message)}</div>`;
    return;
  }
  renderGallery();
}

function renderGallery() {
  const sheet = $('gallery-sheet');
  if (!galleryFiles.length) {
    sheet.innerHTML = '<div class="note">Nothing attached yet — 📎 sends a photo, video or file from this phone.</div>';
    return;
  }
  const picked = gallerySelected;
  // ＋ only where there is a field to insert into — opened from Settings there
  // is none, and a button that silently does nothing is worse than no button.
  const canInsert = !picked && S.route.name === 'ws';
  const head = picked
    ? `<span>${picked.size} selected</span>
       <span class="gl-acts">
         <button class="gl-act" id="gl-all">${picked.size === galleryFiles.length ? 'None' : 'All'}</button>
         <button class="gl-act" id="gl-cancel">Cancel</button>
         <button class="gl-act danger" id="gl-del-sel" ${picked.size ? '' : 'disabled'}>🗑 Delete</button>
       </span>`
    : `<span>Attachments · ${galleryFiles.length}</span><span>kept 30 days · hold to select</span>`;
  sheet.innerHTML = `<div class="gl-hd">${head}</div>`
    + galleryFiles.map((f) => {
      const thumb = IMAGE_FILE.test(f.name)
        ? `<img class="gl-thumb" src="${fileUrl(f.name)}" loading="lazy" alt="">`
        : `<span class="gl-thumb">${VIDEO_FILE.test(f.name) ? '🎞' : '📄'}</span>`;
      // Inserting the path of something the agent cannot open looks identical to
      // inserting one it can, right up until the agent says it cannot read it.
      const tag = AGENT_READS.test(f.name) ? '' : '<span class="gl-tag">stored only</span>';
      const on = !!picked?.has(f.name);
      return `<div class="gl-row${on ? ' sel' : ''}" data-row="${esc(f.name)}">
        <button class="gl-open" data-file="${esc(f.name)}">
          ${picked ? `<span class="gl-check">${on ? '✓' : '○'}</span>` : ''}${thumb}
          <span class="gl-meta"><span class="t">${esc(fileLabel(f.name))}</span>
            <span class="d">${relTime(f.mtime)} · ${fmtSize(f.size)}${tag}</span></span>
        </button>
        ${canInsert ? `<button class="gl-insert" data-insert="${esc(f.path)}" title="Insert path">＋</button>` : ''}
        ${picked ? '' : `<button class="gl-del" data-del="${esc(f.name)}" title="Delete">🗑</button>`}
      </div>`;
    }).join('');

  for (const b of sheet.querySelectorAll('[data-file]')) {
    const { file } = b.dataset;
    b.onclick = () => (gallerySelected ? toggleSelected(file) : openViewer(file));
    onLongPress(b, () => {
      gallerySelected = gallerySelected || new Set();
      gallerySelected.add(file);
      renderGallery();
    });
  }
  for (const b of sheet.querySelectorAll('[data-insert]')) {
    b.onclick = () => {
      insertPath(b.dataset.insert);
      closeGallery();
    };
  }
  for (const b of sheet.querySelectorAll('[data-del]')) b.onclick = () => deleteUploads([b.dataset.del]);
  if (picked) {
    $('gl-cancel').onclick = () => {
      gallerySelected = null;
      renderGallery();
    };
    $('gl-all').onclick = () => {
      gallerySelected = picked.size === galleryFiles.length ? new Set() : new Set(galleryFiles.map((f) => f.name));
      renderGallery();
    };
    $('gl-del-sel').onclick = () => deleteUploads([...picked]);
  }
}

function toggleSelected(name) {
  if (!gallerySelected) return;
  if (!gallerySelected.delete(name)) gallerySelected.add(name);
  renderGallery();
}

// Deleting is only about the copy on the Mac — a path already sent to an agent
// stops resolving, same as it would after the 30-day sweep.
async function deleteUploads(names) {
  if (!names.length) return;
  const what = names.length === 1 ? fileLabel(names[0]) : `${names.length} attachments`;
  if (!window.confirm(`Delete ${what} from the Mac?`)) return;
  const sheet = $('gallery-sheet');
  for (const name of names) {
    const row = sheet.querySelector(`[data-row="${CSS.escape(name)}"]`);
    if (row) row.style.opacity = '0.4';
  }
  try {
    await api('/api/upload-delete', { method: 'POST', body: JSON.stringify({ names }) });
    openGallery(); // re-read, so the count and the empty state stay honest
  } catch (err) {
    renderGallery();
    alert(`Delete failed: ${err.message}`);
  }
}

function openViewer(name) {
  const el = $('viewer');
  const url = fileUrl(name);
  const body = IMAGE_FILE.test(name) ? `<img src="${url}" alt="">`
    : VIDEO_FILE.test(name) ? `<video src="${url}" controls playsinline autoplay></video>`
      : `<div class="note">No preview for this kind of file.<br>${esc(fileLabel(name))}</div>`;
  el.innerHTML = `<div class="vw-bar">
      <button class="btn" id="vw-close">✕</button>
      <span class="vw-name">${esc(fileLabel(name))}</span>
    </div>
    <div class="vw-body">${body}</div>`;
  // A file can be gone — deleted here, or swept after 30 days — while a chat
  // message still names it. Say so instead of showing a blank box.
  const media = el.querySelector('img, video');
  if (media) {
    media.onerror = () => {
      el.querySelector('.vw-body').innerHTML = '<div class="note">This file is no longer on the Mac — uploads are kept 30 days.</div>';
    };
  }
  el.hidden = false;
  $('vw-close').onclick = () => {
    el.hidden = true;
    el.innerHTML = ''; // also stops a playing video
  };
}

$('gallery').onclick = (e) => {
  if (e.target === $('gallery')) closeGallery(); // tap backdrop closes
};
$('chat-attach').onclick = () => pickAttachment($('chat-attach'), insertPath);
onLongPress($('chat-attach'), openGallery);

$('attach-file').onchange = () => {
  const input = $('attach-file');
  const files = [...(input.files || [])];
  input.value = ''; // so picking the same photo twice in a row still fires
  uploadFiles(files);
};

// fetch() gives no upload progress, and these go over Tailscale — a 300 MB video
// with a frozen 📎 and no bar is indistinguishable from a hung app.
function putFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON body → generic error below */ }
      if (xhr.status === 200 && data.path) resolve(data);
      else reject(new Error(data.error || `server said ${xhr.status}`));
    };
    // The server aborts the socket past its 300 MB cap, which lands here rather
    // than as a status — the size is the only explanation worth offering.
    xhr.onerror = () => reject(new Error(file.size > 300 * 1024 * 1024 ? 'over the 300 MB limit' : 'connection lost'));
    xhr.onabort = () => reject(new Error('cancelled'));
    xhr.send(file);
  });
}

// One at a time: parallel uploads from a phone just make every bar crawl, and a
// failure part-way through should still leave the paths that did land in the
// prompt rather than throwing the batch away.
async function uploadFiles(files) {
  if (!files.length || !attachHandler) return;
  const { btn, onPath, label } = attachHandler;
  attachHandler = null;
  const bar = $('uploading');
  const failed = [];
  btn.textContent = '⏳';
  btn.disabled = true;
  bar.hidden = false;
  for (const [i, file] of files.entries()) {
    const count = files.length > 1 ? ` (${i + 1}/${files.length})` : '';
    $('up-name').textContent = file.name + count;
    $('up-pct').textContent = '0%';
    $('up-fill').style.width = '0%';
    try {
      const data = await putFile(file, (frac) => {
        const pct = Math.round(frac * 100);
        $('up-pct').textContent = `${pct}%`;
        $('up-fill').style.width = `${pct}%`;
      });
      onPath(data.path);
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  bar.hidden = true;
  btn.textContent = label;
  btn.disabled = false;
  if (failed.length) alert(`Upload failed —\n${failed.join('\n')}`);
}

// ------------------------------------------------------------ file browser
// Two of them: the Files tab in a session opens at that workspace's cwd and
// keeps its place in memory, while the global one starts at ~ and keeps its
// place in the hash. Both are read-only and both need the key.
// A path picked in the Files tab is something you want to type with, so it goes
// to the terminal field and the app goes there with it. Inserting it without
// switching put it in a field the Files tab covers — which looked exactly like
// the ＋ button closing the file and doing nothing else.
function insertPathFromFiles(p) {
  if (S.route.name !== 'ws') return;
  if (S.tab !== 'term') {
    S.tab = 'term';
    document.body.className = `ws ${S.tab}`;
    clearTimeout(S.termTimer);
    renderWs(); // builds #terminput, which insertPath needs to exist
  }
  insertPath(p);
}

const fileDeps = {
  api,
  esc,
  fmtSize,
  relTime,
  fsKey,
  onLongPress,
  insertPath: insertPathFromFiles,
  inSession: () => S.route.name === 'ws',
  viewer: $('viewer'),
};

const wsFiles = createFileBrowser({ ...fileDeps, onPath: (p) => { S.filesPath = p; } });
const globalFiles = createFileBrowser({ ...fileDeps, hashNav: true });

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
    /* unreachable — the cards still render, and the Server one says so */
  }

  $('view').innerHTML = `
    <div class="card">
      <div class="cfg-label">Server</div>
      <div class="muted">${esc(location.origin)}</div>
      <div class="cfg-result ${srv ? 'ok' : 'bad'}">${srv ? `connected ✓ · cmux ${srv.cmuxOnline ? 'online' : 'offline'} · ${srv.subscriptions} device(s) subscribed · up ${Math.round(srv.uptimeSec / 60)}m` : 'not connected'} · app ${APP_VERSION}</div>
      <div class="muted" style="margin-top:4px">layout: window ${window.innerHeight} · visual ${Math.round(window.visualViewport?.height || 0)} · body ${document.body.style.height || 'auto'} · safe-b ${getComputedStyle(document.documentElement).getPropertyValue('--sab') || 'n/a'}</div>
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
    </div>

    <div class="card">
      <div class="cfg-label">Terminal</div>
      <div class="togglerow"><span>Font size</span>
        <span style="display:flex;gap:10px;align-items:center">
          <button class="btn" id="font-dec">A−</button>
          <span id="font-val" class="muted" style="min-width:44px;text-align:center">${termFont()}px</span>
          <button class="btn" id="font-inc">A＋</button>
        </span>
      </div>
      <div class="muted">Smaller shows more of the terminal at once.</div>
    </div>

    <div class="card">
      <div class="cfg-label">Attachments</div>
      <div class="muted">Photos, videos and files this phone has uploaded to the Mac. Also reachable by holding 📎 in a session.</div>
      <button class="bigbtn secondary" id="open-gallery">📎 Browse uploads</button>
    </div>

    <div class="card">
      <div class="cfg-label">File browser</div>
      <div class="muted">Key for reading the Mac's files (Files tab). The Mac prints it at startup and keeps it in <code>data/fs-key</code>; without it this phone gets nothing. Reading is confined to the home directory, and keys, tokens and ~/Library are blocked outright.</div>
      <input class="cfg-input" id="fs-key" placeholder="paste the key" value="${esc(fsKey())}"
        autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="bigbtn" id="fs-save">Save &amp; test</button>
      <div class="cfg-result" id="fs-result">${fsKey() ? '' : 'not set — the Files tab is locked'}</div>
    </div>`;

  $('open-gallery').onclick = openGallery;

  $('fs-save').onclick = async () => {
    const result = $('fs-result');
    localStorage.setItem('cmux-fs-key', $('fs-key').value.trim());
    result.className = 'cfg-result';
    result.textContent = 'testing…';
    try {
      const home = await api('/api/fs/list?path=~');
      result.className = 'cfg-result ok';
      result.textContent = `unlocked ✓ · ${home.display} has ${home.total} visible items`;
    } catch (err) {
      result.className = 'cfg-result bad';
      result.textContent = err.message;
    }
  };

  const bumpFont = (d) => {
    const v = Math.min(16, Math.max(7, termFont() + d));
    localStorage.setItem('term-font', String(v));
    $('font-val').textContent = `${v}px`;
  };
  $('font-dec').onclick = () => bumpFont(-0.5);
  $('font-inc').onclick = () => bumpFont(0.5);

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
    clearTimeout(S.termTimer);
    renderWs();
  };
}

// Workspace quick-switcher: switching only — no create/close here.
function openSwitcher() {
  const cur = ws();
  const sheet = $('switcher-sheet');
  sheet.innerHTML = (S.snap?.workspaces || []).map((w) => `
    <button class="sw-row ${w.lane === 'attention' ? 'attention' : ''} ${w.id === cur?.id ? 'current' : ''}" data-sw="${esc(w.id)}">
      <span class="t">${LANE_GLYPH[w.lane] || ''} ${esc(w.title)}</span>
      <span class="when">${relTime(w.laneTs || w.lastSubmittedAt)}</span>
    </button>`).join('') || '<div class="empty">No workspaces.</div>';
  for (const b of sheet.querySelectorAll('[data-sw]')) {
    b.onclick = () => {
      $('switcher').hidden = true;
      if (b.dataset.sw !== cur?.id) location.hash = `#/ws/${encodeURIComponent(b.dataset.sw)}`;
    };
  }
  $('switcher').hidden = false;
}

$('switcher-btn').onclick = openSwitcher;
$('switcher').onclick = (e) => {
  if (e.target === $('switcher')) $('switcher').hidden = true; // tap backdrop closes
};

// Pin the app shell to the visible viewport: iOS overlays the keyboard instead
// of resizing the layout, so we resize the (position:fixed) body ourselves —
// the terminal bar and bottom nav stay glued to the visible bottom edge.
if (window.visualViewport) {
  const vv = window.visualViewport;
  let maxH = vv.height;
  let settleTimers = [];
  // Keyboard closed: fill the FULL window (standalone vv.height can exclude
  // the home-indicator strip → the reported bottom gap). Keyboard open: track
  // the visual viewport so the bars ride above the keyboard.
  const kbOpen = () => vv.height < Math.max(window.innerHeight, maxH) - 100;
  let applied = { kb: null, top: 0, h: null };
  // settled=false is the live event; true is the re-apply after iOS has stopped
  // animating. vv.offsetTop spikes for a frame or two whenever iOS nudges the
  // view to keep the caret in sight, and iOS puts it back itself — following
  // that spike moved the whole shell down and straight back up, which is the
  // app twitching as a whole while you type (measured at ±20px in a screen
  // recording, every band on screen moving together). The height is honoured
  // immediately, since the bars have to stay above the keyboard; the offset
  // waits until it has held still.
  const apply = (settled = false) => {
    maxH = Math.max(maxH, vv.height);
    const kb = kbOpen();
    const top = kb ? (settled ? Math.round(vv.offsetTop) : applied.top) : 0;
    const h = kb ? Math.round(vv.height) : 0;
    // Only write when the viewport actually moved. iOS fires resize and scroll
    // several times per keystroke, and every write here resizes the app shell —
    // which the terminal pane absorbs, being the one element that flexes. With
    // the writes held to real changes, a keystroke that did not move the
    // viewport cannot move the pane, whatever iOS reports in between.
    if (kb !== applied.kb || top !== applied.top || h !== applied.h) {
      applied = { kb, top, h };
      if (kb) {
        // keyboard: size to the visible area so the bars ride above it
        document.body.style.height = `${h}px`;
        document.body.style.bottom = 'auto';
        document.body.style.top = `${top}px`;
      } else {
        // Keyboard closed: hand the layout back to CSS (top/bottom inset:0),
        // so the browser picks the real bottom edge instead of a JS guess.
        document.body.style.bottom = '';
        document.body.style.height = '';
        document.body.style.top = '';
      }
      document.body.classList.toggle('kb-open', kb);
    }
    // Undo an iOS scroll that pushed the fixed shell out of frame — but only
    // when there is one: scrollTo is itself a visual-viewport scroll event, so
    // calling it unconditionally kept this handler feeding itself.
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  };
  const fitViewport = () => {
    apply();
    // iOS fires resize mid-animation; re-apply after it settles
    for (const t of settleTimers) clearTimeout(t);
    settleTimers = [250, 600].map((ms) => setTimeout(() => apply(true), ms));
  };
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
  window.addEventListener('focusin', fitViewport);
  window.addEventListener('focusout', fitViewport);
  fitViewport();
  // Watchdog: iOS occasionally swallows the resize event after keyboard
  // close — re-apply periodically; apply() is idempotent.
  setInterval(() => {
    if (kbOpen() !== document.body.classList.contains('kb-open')) fitViewport();
  }, 2000);
}

// Tell the server which session this phone is actively viewing (foreground
// only) so its pushes are suppressed — you're already looking at it.
const CLIENT_ID = Math.random().toString(36).slice(2);
let lastWatchReported;

function reportWatching() {
  const wsId = S.route.name === 'ws' && document.visibilityState === 'visible' ? (ws()?.id || null) : null;
  api('/api/watching', { method: 'POST', body: JSON.stringify({ client: CLIENT_ID, workspace_id: wsId }) })
    .catch(() => {});
  lastWatchReported = wsId;
}

setInterval(() => {
  // heartbeat keeps the watch alive; server expires stale ones in 25s
  if (lastWatchReported && document.visibilityState === 'visible') reportWatching();
}, 10_000);
document.addEventListener('visibilitychange', reportWatching);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
  // Notification tapped while the app is open/suspended: jump to that session.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) {
      const url = String(e.data.url);
      const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '#/';
      if (location.hash !== hash) location.hash = hash;
    }
  });
}
S.route = parseHash();
refreshSnapshot().then(() => {
  connectSSE();
  render();
});
