// Scrolling behaviour of the terminal pane, driven with real touch gestures in
// headless Chromium. The pane repaints every 150ms, so anything it does to the
// scroll position on repaint shows up here within a second.
//
//   node scripts/test-scroll.mjs <workspace-id>

import { launch } from './lib/cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4488';
const WS = process.argv[2];
if (!WS) {
  console.error('usage: node scripts/test-scroll.mjs <workspace-id>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch();

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const state = () => b.evaluate(`(() => {
  const el = document.getElementById('screen');
  return {
    left: el.scrollLeft, top: el.scrollTop,
    maxLeft: el.scrollWidth - el.clientWidth,
    maxTop: el.scrollHeight - el.clientHeight,
    live: document.getElementById('jump-live').hidden,
  };
})()`);

const box = () => b.evaluate(`(() => {
  const r = document.getElementById('screen').getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);

try {
  await b.goto(`${BASE}/#/ws/${WS}`);
  await sleep(6000);
  const start = await state();
  check('the terminal pane scrolls in both axes', start.maxLeft > 50 && start.maxTop > 50,
    `maxLeft=${start.maxLeft} maxTop=${start.maxTop}`);
  check('it opens at the bottom, in live mode', start.live && start.top >= start.maxTop - 40,
    `top=${start.top}/${start.maxTop} live=${start.live}`);

  // --- sideways ------------------------------------------------------------
  const at = await box();
  await b.scroll(at.x, at.y, -160, 0); // negative x = scroll right
  await sleep(400);
  const scrolled = await state();
  await sleep(2000); // several repaints — this is when it used to snap back
  const settled = await state();
  check('scrolling sideways moves the pane', scrolled.left > 40, `left=${scrolled.left}`);
  check('the column survives the repaints', settled.left === scrolled.left,
    `left ${scrolled.left} -> ${settled.left}`);
  check('scrolling sideways does not leave live mode', settled.live, `live=${settled.live}`);

  // --- a small scroll up ---------------------------------------------------
  await b.scroll(at.x, at.y, 0, 120); // positive y = scroll up
  await sleep(2500); // the scrollback arrives and the rows are rebuilt
  const up = await state();
  check('scrolling up enters scrollback', !up.live, `live=${up.live}`);
  check('it does not jump to the top of the scrollback', up.top > up.maxTop * 0.5,
    `top=${up.top}/${up.maxTop}`);
  check('the column survives entering scrollback', up.left === settled.left,
    `left ${settled.left} -> ${up.left}`);

  // --- back to live --------------------------------------------------------
  await b.evaluate("document.getElementById('jump-live').click()");
  await sleep(1500);
  const back = await state();
  check('back-to-live returns to the bottom and the left edge',
    back.live && back.left === 0 && back.top >= back.maxTop - 40,
    `left=${back.left} top=${back.top}/${back.maxTop} live=${back.live}`);

  if (b.problems.length) {
    failures += 1;
    console.log(`\nconsole problems:\n${b.problems.join('\n')}`);
  }
} finally {
  b.close();
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
