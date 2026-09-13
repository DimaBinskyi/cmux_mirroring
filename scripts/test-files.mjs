// Browser test for the file browser: loads the PWA in headless Chromium, walks
// a directory, opens a text file and an image, and checks the locked state when
// the key is wrong. Like the other browser tests here it drives the real server,
// so the listing it walks is the real home directory.
//
//   node scripts/test-files.mjs [workspace-id]
//
// Read-only, except that a workspace id additionally exercises "＋ path", which
// types into that session's terminal and clears it again — point it at an idle
// one, the same rule as the other browser tests.

import fs from 'node:fs';
import { launch } from './lib/cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4488';
const KEY = fs.readFileSync(new URL('../data/fs-key', import.meta.url), 'utf8').trim();
const DIR = '~/Documents/dev/cmux_mirroring';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const b = await launch();

// Tap the row with this exact name, the way a finger would.
const clickRow = (name) => b.evaluate(`(() => {
  const row = [...document.querySelectorAll('.fb-row')]
    .find((r) => r.querySelector('.fb-name').textContent.trim() === ${JSON.stringify(name)});
  if (!row) return false;
  row.click();
  return true;
})()`);

try {
  await b.goto(BASE);
  await sleep(2500);
  await b.evaluate(`localStorage.setItem('cmux-fs-key', ${JSON.stringify(KEY)})`);

  // ---------------------------------------------------------------- listing
  await b.goto(`${BASE}/#/files/${encodeURIComponent(DIR)}`);
  await sleep(2500);
  const listing = await b.evaluate(`(() => ({
    rows: document.querySelectorAll('.fb-row').length,
    crumbs: [...document.querySelectorAll('[data-crumb]')].map((c) => c.textContent),
    names: [...document.querySelectorAll('.fb-name')].map((n) => n.textContent.trim()),
    dimmed: [...document.querySelectorAll('.fb-row.dim .fb-name')].map((n) => n.textContent.trim()),
  }))()`);
  check('directory listed', listing.rows > 5, `${listing.rows} rows`);
  check('breadcrumb built', listing.crumbs.join('/') === '~/Documents/dev/cmux_mirroring', listing.crumbs.join('/'));
  check('dirs sort before files', listing.names.indexOf('lib') < listing.names.indexOf('README.md'));
  check('node_modules dimmed', listing.dimmed.includes('node_modules'));
  check('dotfiles hidden by default', !listing.names.some((n) => n.startsWith('.')));

  // ------------------------------------------------------------------ filter
  await b.evaluate(`(() => {
    const f = document.getElementById('fb-filter');
    f.value = 'server';
    f.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);
  const filtered = await b.evaluate(`[...document.querySelectorAll('.fb-name')].map((n) => n.textContent.trim())`);
  check('filter narrows the list', filtered.length === 1 && filtered[0] === 'server.mjs', filtered.join(','));
  await b.evaluate(`(() => {
    const f = document.getElementById('fb-filter');
    f.value = '';
    f.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);

  // -------------------------------------------------------------- dotfiles
  await b.evaluate(`document.getElementById('fb-hidden').click()`);
  await sleep(900);
  const withDots = await b.evaluate(`[...document.querySelectorAll('.fb-name')].map((n) => n.textContent.trim())`);
  check('dotfile toggle reveals them', withDots.some((n) => n.startsWith('.')), `${withDots.length} rows`);
  await b.evaluate(`document.getElementById('fb-hidden').click()`);
  await sleep(900);

  // ------------------------------------------------------------ navigation
  await clickRow('lib');
  await sleep(1200);
  const inLib = await b.evaluate(`(() => ({
    crumbs: [...document.querySelectorAll('[data-crumb]')].map((c) => c.textContent).join('/'),
    hash: location.hash,
    names: [...document.querySelectorAll('.fb-name')].map((n) => n.textContent.trim()),
  }))()`);
  check('tapping a directory descends', inLib.names.includes('files.mjs'), inLib.crumbs);
  check('the hash follows', decodeURIComponent(inLib.hash).endsWith('/lib'), inLib.hash);

  // ----------------------------------------------------------- text viewer
  await clickRow('files.mjs');
  await sleep(1500);
  const doc = await b.evaluate(`(() => ({
    lines: document.querySelectorAll('.vw-text .l').length,
    first: document.querySelector('.vw-text .l')?.textContent.slice(0, 40),
    name: document.querySelector('.vw-name')?.textContent,
    more: document.getElementById('vw-more')?.textContent,
  }))()`);
  check('text file renders', doc.lines > 50, `${doc.lines} lines`);
  check('first line is the file itself', String(doc.first).startsWith('// Read-only file browsing'), doc.first);
  check('footer reports the end', /end of file/.test(doc.more || ''), doc.more);

  // wrap toggle
  await b.evaluate(`document.getElementById('vw-wrap').click()`);
  await sleep(200);
  check('wrap toggles', await b.evaluate(`document.getElementById('vw-text').classList.contains('wrap')`));
  await b.evaluate(`document.getElementById('vw-close').click()`);
  await sleep(300);

  // ---------------------------------------------------------- image viewer
  await b.goto(`${BASE}/#/files/${encodeURIComponent(`${DIR}/public`)}`);
  await sleep(1800);
  await clickRow('icon-192.png');
  await sleep(1800);
  const img = await b.evaluate(`(() => {
    const el = document.querySelector('#viewer img');
    return el ? { src: el.src, w: el.naturalWidth } : null;
  })()`);
  check('image loads through the key', img?.w === 192, img ? `${img.w}px` : 'no <img>');
  await b.evaluate(`document.getElementById('vw-close').click()`);

  // ------------------------------------------------------------ wrong key
  await b.evaluate(`localStorage.setItem('cmux-fs-key', 'nope')`);
  await b.goto(`${BASE}/#/files/${encodeURIComponent(DIR)}`);
  await sleep(2000);
  const locked = await b.evaluate(`document.getElementById('fb-settings') ? document.querySelector('.cfg-label').textContent : null`);
  check('a bad key locks the view', locked === 'Locked', String(locked));

  // ----------------------------------------------------- "＋ path", in a session
  const WS = process.argv[2];
  if (WS) {
    await b.evaluate(`localStorage.setItem('cmux-fs-key', ${JSON.stringify(KEY)})`);
    await b.goto(`${BASE}/#/ws/${WS}`);
    await sleep(5000);
    await b.evaluate(`document.querySelector('[data-tab="files"]').click()`);
    await sleep(2500);
    // The tab opens at the workspace's cwd, which is not necessarily this repo.
    if (!await b.evaluate(`!!document.querySelector('.fb-name')`)) throw new Error('files tab never listed');
    if (await clickRow('cmux_mirroring')) await sleep(1500);
    const opened = await clickRow('package.json');
    await sleep(1500);
    await b.evaluate(`document.getElementById('vw-insert')?.click()`);
    await sleep(1200);
    const after = await b.evaluate(`(() => ({
      body: document.body.className,
      field: document.getElementById('terminput')?.value || '',
      viewerOpen: !document.getElementById('viewer').hidden,
    }))()`);
    check('＋ path lands in the terminal field', opened && after.field.includes('package.json'), JSON.stringify(after));
    check('＋ path takes you to the Term tab', after.body === 'ws term' && !after.viewerOpen, after.body);
    // Put the session back the way we found it.
    await b.evaluate(`(() => {
      const ti = document.getElementById('terminput');
      if (!ti) return;
      ti.value = '';
      ti.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1500);
  }

  // ------------------------------------------------- unlocking from Settings
  await b.goto(`${BASE}/#/settings`);
  await sleep(2000);
  await b.evaluate(`(() => {
    document.getElementById('fs-key').value = ${JSON.stringify(KEY)};
    document.getElementById('fs-save').click();
  })()`);
  await sleep(1500);
  const saved = await b.evaluate(`document.getElementById('fs-result').textContent`);
  check('Settings unlocks it again', /unlocked/.test(saved), saved);

  console.log(b.problems.length ? `\nproblems:\n${b.problems.join('\n')}` : '\nno console errors');
} finally {
  b.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || b.problems.length ? 1 : 0);
