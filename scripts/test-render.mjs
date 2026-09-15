// The terminal renderer, against a real surface.
//
// Rows are merged into runs and styled by class rather than one span per word,
// which is worth ~7x a repaint — and is exactly the kind of change that can
// silently tint a space or swallow an underline without anyone noticing until a
// screenshot looks wrong. So this compares the new renderer against the old one
// character by character: same text, same computed colour, weight, slant and
// decoration in every cell. Not "looks fine" — equal.
//
//   node scripts/test-render.mjs [surface-id]
//
// With no surface it takes the first terminal it finds. Needs the server up.

import { launch } from './lib/cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4488';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failures += 1;
}

let surface = process.argv[2];
if (!surface) {
  const state = await fetch(`${BASE}/api/state`).then((r) => r.json());
  surface = state.workspaces.flatMap((w) => w.surfaces).find((s) => s.type === 'terminal')?.id;
  if (!surface) {
    console.error('no terminal surface found — open one in cmux');
    process.exit(1);
  }
}
console.log(`surface ${surface}`);

const b = await launch();
try {
  await b.goto(`${BASE}/`);
  await sleep(3000);

  const report = await b.evaluate(`(async () => {
    const g = await fetch('/api/grid?surface=${surface}&fit=120').then((r) => r.json());
    const total = g.scrollbackRows + g.rows;
    const model = Array.from({ length: total }, () => []);
    for (const s of g.scrollback) model[s.row]?.push(s);
    for (const s of g.viewport) model[g.scrollbackRows + s.row]?.push(s);
    for (const r of model) r.sort((a, b) => a.column - b.column);

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const w = (s) => s.cell_width || [...s.text].length;

    // ---- the renderer as it was: one span per span, inline style ----
    const oldLine = (spans) => {
      let col = 0, line = '';
      for (const s of spans) {
        if (s.column > col) line += ' '.repeat(s.column - col);
        const st = g.styles[s.style_id] || {};
        let fg = st.fg || g.fg, bg = st.bg;
        if (st.inverse) { const t = fg; fg = bg || g.bg; bg = t; }
        let css = 'color:' + fg + ';';
        if (bg && bg.toLowerCase() !== g.bg.toLowerCase()) css += 'background:' + bg + ';';
        if (st.bold) css += 'font-weight:700;';
        if (st.faint) css += 'opacity:.6;';
        if (st.italic) css += 'font-style:italic;';
        const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
        if (deco) css += 'text-decoration:' + deco + ';';
        line += '<span style="' + css + '">' + esc(s.text) + '</span>';
        col = s.column + w(s);
      }
      return line || ' ';
    };

    // ---- the renderer as it is now (mirrors app.js) ----
    const fgDefault = String(g.fg || '').toLowerCase();
    const bgDefault = String(g.bg || '').toLowerCase();
    const plain = new Set(), gapSafe = new Set(), rules = [];
    for (const key of Object.keys(g.styles || {})) {
      const st = g.styles[key] || {};
      let fg = st.fg || g.fg, bg = st.bg;
      if (st.inverse) { const t = fg; fg = bg || g.bg; bg = t; }
      const paintsBg = !!bg && String(bg).toLowerCase() !== bgDefault;
      const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
      if (!paintsBg && !deco) gapSafe.add(Number(key));
      let css = 'color:' + fg + ';';
      if (paintsBg) css += 'background:' + bg + ';';
      if (st.bold) css += 'font-weight:700;';
      if (st.faint) css += 'opacity:.6;';
      if (st.italic) css += 'font-style:italic;';
      if (deco) css += 'text-decoration:' + deco + ';';
      if (!paintsBg && !deco && !st.bold && !st.faint && !st.italic
        && String(fg).toLowerCase() === fgDefault) plain.add(Number(key));
      rules.push('#nu .tc' + key + '{' + css + '}');
    }
    const newLine = (spans) => {
      let out = '', col = 0, runId = -1, run = '';
      const flush = () => { if (!run) return;
        out += plain.has(runId) ? esc(run) : '<span class="tc' + runId + '">' + esc(run) + '</span>'; run = ''; };
      for (const s of spans) {
        const gap = s.column > col ? s.column - col : 0;
        if (s.style_id === runId && run && (!gap || gapSafe.has(runId))) run += ' '.repeat(gap);
        else { flush(); if (gap) out += ' '.repeat(gap); runId = s.style_id; }
        run += s.text;
        col = s.column + w(s);
      }
      flush();
      return out || ' ';
    };

    const sheet = document.createElement('style');
    // colour/background on the host, exactly as paintGrid sets them on #screen —
    // it is what unwrapped text inherits, so without it the comparison is
    // against a pane that does not exist.
    sheet.textContent = rules.join('')
      + '#old,#nu{position:absolute;left:-9999px;font:9.5px/1.35 ui-monospace,monospace;'
      + 'color:' + g.fg + ';background:' + g.bg + '}'
      + '#old .tl,#nu .tl{white-space:pre;min-height:1.35em}';
    document.head.appendChild(sheet);
    const mk = (id, html) => { const d = document.createElement('div'); d.id = id; d.innerHTML = html; document.body.appendChild(d); return d; };
    const oldHost = mk('old', model.map((r) => '<div class="tl">' + oldLine(r) + '</div>').join(''));
    const newHost = mk('nu', model.map((r) => '<div class="tl">' + newLine(r) + '</div>').join(''));

    // Per character: the style actually computed for the cell it lands in.
    // A blank cell is compared only on what a blank cell can show — a
    // background, an underline, a strikethrough. Its colour, weight and slant
    // are unobservable, and merging a run across a gap necessarily adopts the
    // run's colour for the spaces inside it. That is the whole licence gapSafe
    // grants, so the test grants exactly it and nothing more.
    const cells = (row) => {
      const out = [];
      const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())) {
        const cs = getComputedStyle(n.parentElement);
        const full = [cs.color, cs.backgroundColor, cs.fontWeight, cs.fontStyle,
          cs.textDecorationLine, cs.opacity].join('|');
        const blank = [cs.backgroundColor, cs.textDecorationLine].join('|');
        for (const ch of n.nodeValue) out.push(ch + '\\u0000' + (ch === ' ' ? blank : full));
      }
      return out;
    };

    let textMismatch = null, styleMismatch = null, cellsChecked = 0;
    for (let i = 0; i < total && !styleMismatch; i++) {
      const a = oldHost.children[i], c = newHost.children[i];
      if (!textMismatch && a.textContent !== c.textContent) {
        textMismatch = 'row ' + i + '\\n  old: ' + JSON.stringify(a.textContent.slice(0, 90))
          + '\\n  new: ' + JSON.stringify(c.textContent.slice(0, 90));
      }
      const ca = cells(a), cc = cells(c);
      for (let j = 0; j < Math.max(ca.length, cc.length); j++) {
        cellsChecked++;
        if (ca[j] !== cc[j]) {
          styleMismatch = 'row ' + i + ' col ' + j + '\\n  old: ' + ca[j] + '\\n  new: ' + cc[j];
          break;
        }
      }
    }

    const count = (host) => host.querySelectorAll('span').length;
    return JSON.stringify({
      rows: total, cellsChecked, textMismatch, styleMismatch,
      oldSpans: count(oldHost), newSpans: count(newHost),
      oldBytes: oldHost.innerHTML.length, newBytes: newHost.innerHTML.length,
    });
  })()`);

  const r = JSON.parse(report);
  console.log(`  ${r.rows} rows, ${r.cellsChecked} cells compared`);
  check('every row renders the same text', !r.textMismatch, r.textMismatch || '');
  check('every cell computes the same style', !r.styleMismatch, r.styleMismatch || '');
  check('and it does it with fewer elements',
    r.newSpans < r.oldSpans,
    `${r.oldSpans} spans -> ${r.newSpans} (${Math.round(100 - (r.newSpans / r.oldSpans) * 100)}% fewer), `
    + `${Math.round(r.oldBytes / 1024)}KB -> ${Math.round(r.newBytes / 1024)}KB of HTML`);
  console.log(`        ${r.oldSpans} spans -> ${r.newSpans}, `
    + `${Math.round(r.oldBytes / 1024)}KB -> ${Math.round(r.newBytes / 1024)}KB`);

  const bad = b.problems.filter((p) => !/Failed to (load|fetch)|net::|EventSource/i.test(p));
  check('no console errors', bad.length === 0, bad.join('\n        '));
} finally {
  await b.close();
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
