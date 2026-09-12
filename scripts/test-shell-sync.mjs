// Checks the other half of the two-way binding: a plain shell prompt (not the
// Claude composer). Creates a scratch cmux tab, types into the shell, recalls
// history with Up, and closes the tab again.
//
//   node scripts/test-shell-sync.mjs <workspace-id>

import { buildRowsModel, parseInput, computeEdit, lineText } from '../public/term-input.mjs';

const BASE = 'http://127.0.0.1:4488';
const WS = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, body) => {
  const r = await fetch(BASE + p, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
};

const before = new Set((await api('/api/state')).workspaces
  .find((w) => w.id === WS).surfaces.map((s) => s.id));
await api('/api/ws-action', { action: 'newTab', workspace_id: WS });
await sleep(2500);
const surface = (await api('/api/state')).workspaces
  .find((w) => w.id === WS).surfaces.map((s) => s.id).find((id) => !before.has(id));
if (!surface) throw new Error('new tab never appeared');
console.log('scratch surface', surface);

// When a case fails, `node scripts/dump-grid.mjs <surface>` shows the rows the
// parser was looking at.
const read = async () => {
  const g = await api(`/api/grid?surface=${encodeURIComponent(surface)}`);
  return parseInput(g, buildRowsModel(g));
};

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) console.log(`       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
};

// A fresh tab prints its login banner late; typing before that lands in the
// middle of it, so wait until an empty prompt is actually on screen.
async function waitForPrompt() {
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const p = await read().catch(() => null); // the grid appears a beat after the tab
    if (p && p.kind === 'shell' && p.text === '') return;
  }
  throw new Error('shell prompt never appeared');
}

try {
  await waitForPrompt();
  const { ops } = computeEdit('', 'echo hello-from-phone', 0, { lineBreak: 'escape' });
  for (const op of ops) await api('/api/send', { surface_id: surface, text: op.v });
  await sleep(1200);
  check('shell input is mirrored into the field', (await read())?.text, 'echo hello-from-phone');

  await api('/api/key', { surface_id: surface, key: 'enter' });
  await sleep(1500);
  check('an empty prompt reads as empty', (await read())?.text, '');

  await api('/api/key', { surface_id: surface, key: 'up' }); // history recall
  await sleep(1200);
  check('history recall is mirrored into the field', (await read())?.text, 'echo hello-from-phone');

  // A shell does not speak shift+enter — it would land as ";2;13~" in the
  // command line — so a line break here has to go out as backslash+CR.
  await api('/api/key', { surface_id: surface, key: 'ctrl-c' });
  await sleep(1200);
  const edit = computeEdit('', 'echo one\n', 0, { lineBreak: 'escape' });
  for (const op of edit.ops) await api('/api/send', { surface_id: surface, text: op.v });
  await sleep(1500);
  const g = await api(`/api/grid?surface=${encodeURIComponent(surface)}`);
  const model = buildRowsModel(g);
  const screen = Array.from({ length: g.rows }, (_, i) => lineText(model[g.scrollbackRows + i] || [])).join('\n');
  check('a line break at a shell prompt is a continuation, not a key sequence',
    { leakedKeySequence: /;2;13~/.test(screen), continuation: /echo one\\/.test(screen) },
    { leakedKeySequence: false, continuation: true });

  await api('/api/key', { surface_id: surface, key: 'ctrl-c' });
  await sleep(500);
} finally {
  await api('/api/ws-action', { action: 'closeTab', surface_id: surface, workspace_id: WS });
  console.log('scratch tab closed');
}
process.exit(failures ? 1 : 0);
