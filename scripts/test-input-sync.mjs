// End-to-end test for the phone's input field <-> terminal two-way binding.
//
// It drives a REAL cmux surface the way public/app.js does — field edit ->
// computeEdit -> /api/send -> read the grid back -> parseInput -> field — and
// checks the text survives the round trip. The cases here (multi-line input
// with blank lines, trailing spaces, caret moves, an open menu) only misbehave
// against a real Claude Code composer, which is why this talks to one.
//
//   node scripts/test-input-sync.mjs <surface-id>
//
// Pick an IDLE surface: the test types into its composer and clears it again,
// and never presses Enter except to open the model picker (escaped right after).

import { buildRowsModel, parseInput, computeEdit, normalizeLines } from '../public/term-input.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4488';
const SURFACE = process.argv[2];
if (!SURFACE) {
  console.error('usage: node scripts/test-input-sync.mjs <surface-id>');
  process.exit(2);
}

const RIGHT = `${String.fromCharCode(27)}[C`;
const DEL = String.fromCharCode(127);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ---------------------------------------------------------------- fake client
// Mirrors the state public/app.js keeps for the terminal input field.
const client = { value: '', prev: '', caret: 0 };

function reopen() { // what a fresh app launch starts from
  client.value = '';
  client.prev = '';
  client.caret = 0;
}

async function readInput() {
  const g = await api(`/api/grid?surface=${encodeURIComponent(SURFACE)}`);
  return parseInput(g, buildRowsModel(g));
}

// The pty renders asynchronously; wait for two identical reads in a row.
async function settle(tries = 25) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    await sleep(120);
    const now = JSON.stringify(await readInput());
    if (now === last) return;
    last = now;
  }
}

async function typeInField(next) {
  const { ops, caret } = computeEdit(client.prev, next, client.caret, { lineBreak: 'key' });
  client.value = next;
  client.prev = next;
  client.caret = caret;
  for (const op of ops) {
    if (op.t === 'text') await api('/api/send', { surface_id: SURFACE, text: op.v });
    else await api('/api/key', { surface_id: SURFACE, key: op.v });
  }
  await settle();
}

const pressKey = async (key) => {
  await api('/api/key', { surface_id: SURFACE, key });
  await settle();
};

// app.js: syncSet() — the terminal is the source of truth except for trailing
// whitespace on a line, which the grid cannot represent.
function applySync(parsed) {
  if (!parsed || parsed.kind === 'busy') return parsed;
  if (normalizeLines(parsed.text) !== normalizeLines(client.value)) {
    client.value = parsed.text;
    client.prev = parsed.text;
    client.caret = Math.max(0, [...parsed.text].length - parsed.tail);
  } else {
    client.caret = Math.max(0, [...client.value].length - parsed.tail);
  }
  return parsed;
}

async function clearComposer() {
  for (let i = 0; i < 8; i += 1) {
    const parsed = await readInput();
    const len = parsed && parsed.text ? [...parsed.text].length : 0;
    if (!len) return;
    await api('/api/send', { surface_id: SURFACE, text: RIGHT.repeat(len + 2) + DEL.repeat(len + 2) });
    await settle();
  }
  throw new Error('could not clear the composer');
}

// -------------------------------------------------------------------- harness
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) console.log(`       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
}

async function test(name, fn) {
  await clearComposer();
  reopen();
  try {
    await fn(name);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

await test('multi-line input with a blank line survives an app restart', async (name) => {
  const text = 'first line\n\nthird line';
  await typeInField(text);
  reopen(); // closing and reopening the app: the field starts empty
  const parsed = applySync(await readInput());
  check(name, { kind: parsed?.kind, value: client.value }, { kind: 'composer', value: text });
});

await test('caret moved up with the arrow keys keeps the whole text', async (name) => {
  const text = 'first line\n\nthird line';
  await typeInField(text);
  await pressKey('up');
  await pressKey('up');
  const parsed = applySync(await readInput());
  check(name, { kind: parsed?.kind, value: client.value }, { kind: 'composer', value: text });
});

await test('a space at the end of the text stays in the field', async (name) => {
  await typeInField('abc');
  await typeInField('abc ');
  applySync(await readInput());
  check(name, client.value, 'abc ');
});

// A space at the end of a line the user is not on is padding as far as the grid
// is concerned. Dropping it used to cost the space twice over: gone from the
// field, and sent again the next time the user retyped it.
await test('a space at the end of a middle line is kept, and not sent twice', async (name) => {
  await typeInField('abc\ndef');
  await typeInField('abc \ndef');
  applySync(await readInput());
  check(`${name} — kept`, client.value, 'abc \ndef');
  await typeInField('abc x\ndef');
  check(`${name} — not doubled`, applySync(await readInput())?.text, 'abc x\ndef');
});

// Newlines used to be withheld from the terminal whenever the line started with
// a slash, on the theory that sending one would run the command. It does not —
// the backslash in the line-break sequence closes the command menu first — and
// withholding it left the field and the terminal disagreeing.
await test('a line break after a slash command reaches the terminal', async (name) => {
  await typeInField('/model');
  await typeInField('/model\nsecond line');
  const parsed = applySync(await readInput());
  check(name, { kind: parsed?.kind, terminal: parsed?.text }, { kind: 'composer', terminal: '/model\nsecond line' });
});

// The cursor sits on the new empty row, which must not be trimmed off as screen
// padding — doing that put the cursor outside the composer block, and the field
// stopped syncing entirely.
await test('a line break at the very end keeps the field in sync', async (name) => {
  await typeInField('one line');
  await typeInField('one line\n');
  const parsed = applySync(await readInput());
  check(name, { kind: parsed?.kind, terminal: parsed?.text }, { kind: 'composer', terminal: 'one line\n' });
});

await test('a wrapped long line comes back as one line', async (name) => {
  const text = `start ${'word '.repeat(60)}end`;
  await typeInField(text);
  reopen();
  applySync(await readInput());
  check(name, client.value, text);
});

await test('an open menu never writes into the field', async (name) => {
  await api('/api/send', { surface_id: SURFACE, text: '/model' });
  await settle();
  await pressKey('enter'); // opens the model picker
  await sleep(900);
  client.value = 'my draft';
  client.prev = 'my draft';
  const parsed = applySync(await readInput());
  await pressKey('down'); // navigating the menu must not leak into the field
  const parsed2 = applySync(await readInput());
  await pressKey('escape');
  await sleep(800);
  check(name, { a: parsed?.kind, b: parsed2?.kind, value: client.value }, { a: 'busy', b: 'busy', value: 'my draft' });
});

await clearComposer();
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
