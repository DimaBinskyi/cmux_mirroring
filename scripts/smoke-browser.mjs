// Browser smoke test: loads the PWA in headless Chromium, opens a workspace's
// terminal view, and reports console errors plus what the input field ended up
// holding. Catches the things a syntax check cannot — a module that fails to
// load, a throw inside the repaint loop, a field that never fills in.
//
//   node scripts/smoke-browser.mjs <workspace-id> [--type]
//
// --type also types into the field and checks the text reaches the pty, which
// exercises the whole path the phone uses. It clears the composer afterwards
// and never submits, but it does type into a live session — point it at an idle
// one.

import { launch } from './lib/cdp.mjs';
import { buildRowsModel, parseInput } from '../public/term-input.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4488';
const WS = process.argv[2];
if (!WS) {
  console.error('usage: node scripts/smoke-browser.mjs <workspace-id> [--type]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch();
let roundTrip = null;
let report = null;

const setField = (value) => b.evaluate(`(() => {
  const ti = document.getElementById('terminput');
  ti.value = ${JSON.stringify(value)};
  ti.dispatchEvent(new Event('input', { bubbles: true })); // same event a keystroke fires
})()`);

try {
  await b.goto(`${BASE}/#/ws/${WS}`);
  await sleep(6000);

  report = await b.evaluate(`(() => {
    const ti = document.getElementById('terminput');
    return {
      rows: document.querySelectorAll('#screen .tl').length,
      field: ti ? ti.value : null,
      title: document.getElementById('title')?.textContent,
    };
  })()`);
  console.log('terminal rows painted:', report?.rows);
  console.log('workspace title:', JSON.stringify(report?.title));
  console.log('input field:', JSON.stringify(report?.field));

  if (process.argv.includes('--type')) {
    // Two lines: the line break goes out as its own key event, so this covers
    // the whole diff -> queue -> pty path and not just plain text.
    const typed = 'hello from the browser\nsecond line';
    await setField(typed);
    await sleep(2500);
    const surface = await b.evaluate('document.querySelector(".chip.active [data-surf]")?.dataset.surf');
    const grid = await fetch(`${BASE}/api/grid?surface=${encodeURIComponent(surface)}`).then((r) => r.json());
    const pty = parseInput(grid, buildRowsModel(grid))?.text;
    roundTrip = pty === typed;
    console.log(`typed into the field -> pty holds ${JSON.stringify(pty)} ${roundTrip ? '(match)' : '(MISMATCH)'}`);
    await setField('');
    await sleep(1500);
  }

  console.log(b.problems.length ? `\nproblems:\n${b.problems.join('\n')}` : '\nno console errors');
} finally {
  b.close();
}

process.exit(b.problems.length || !report?.rows || roundTrip === false ? 1 : 0);
