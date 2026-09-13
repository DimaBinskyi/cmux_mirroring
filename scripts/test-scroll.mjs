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

  // --- a tap is not a scroll -----------------------------------------------
  // What this pins: touching the pane used to open a two-second window in which
  // any scroll the LAYOUT caused counted as the reader scrolling up, and the
  // pane dropped into scrollback mode — the ⌄ button, a full-scrollback refetch
  // every 150ms and a view off the live edge — with nobody having scrolled.
  await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
  await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  await b.evaluate("(() => { const el = document.getElementById('screen'); el.scrollTop -= 250; })()");
  await sleep(1500);
  const tapped = await state();
  check('a layout scroll after a tap does not enter scrollback', tapped.live, `live=${tapped.live}`);
  check('and the pane is put back on the live edge', tapped.top >= tapped.maxTop - 40,
    `top=${tapped.top}/${tapped.maxTop}`);

  // The real trigger for that scroll: the input field growing a line, which
  // shortens the pane. Resized here directly so the test never types into the
  // session it is pointed at.
  await b.evaluate("document.getElementById('terminput').style.height = '120px'");
  await sleep(1500);
  const grown = await state();
  check('the input field growing does not enter scrollback either',
    grown.live && grown.top >= grown.maxTop - 40,
    `top=${grown.top}/${grown.maxTop} live=${grown.live}`);
  await b.evaluate("document.getElementById('terminput').style.height = ''");

  // --- measuring the input field must not move the pane --------------------
  // autosizeInput() collapses the field to read its content height, which makes
  // this pane taller for the length of the measurement. The browser clamps the
  // scroll position to the taller box, and putting the height back does not put
  // the scroll back — so the pane was left scrolled up by the height of the
  // field (8px at one line, 35px at three) and the next repaint snapped it
  // down, several times a second while typing. Blink hides this by restoring
  // the offset through scroll anchoring, which is what overflow-anchor is
  // turned off here to imitate; WebKit has no such thing. A focus event runs
  // the same sizing path as a keystroke without sending anything to the pty.
  await b.evaluate("document.getElementById('screen').style.overflowAnchor = 'none'");
  const sized = JSON.parse(await b.evaluate(`(() => {
    const ti = document.getElementById('terminput');
    const pane = document.getElementById('screen');
    const out = [];
    for (const n of [1, 2, 3, 4]) {
      ti.value = Array.from({ length: n }, (_, i) => 'line' + i).join('\\n');
      ti.dispatchEvent(new Event('focus'));   // sizes the box
      pane.scrollTop = pane.scrollHeight;     // pinned to the live edge
      const was = Math.round(pane.scrollTop);
      ti.value = ti.value.slice(0, -1);       // deleting is what forces a re-measure
      ti.dispatchEvent(new Event('focus'));   // measures again, same height
      out.push({ n, lost: was - Math.round(pane.scrollTop) });
    }
    ti.value = '';
    ti.dispatchEvent(new Event('focus'));
    return JSON.stringify(out);
  })()`));
  await b.evaluate("document.getElementById('screen').style.overflowAnchor = ''");
  check('measuring the input field does not move the pane', sized.every((r) => r.lost === 0),
    sized.map((r) => `${r.n}-line field: ${r.lost}px`).join(', '));

  if (b.problems.length) {
    failures += 1;
    console.log(`\nconsole problems:\n${b.problems.join('\n')}`);
  }
} finally {
  b.close();
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
