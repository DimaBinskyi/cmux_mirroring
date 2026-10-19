// The app with no Mac behind it. Every one of these used to end on an empty
// dark pane that said nothing, which on a phone is indistinguishable from a
// crash — and two of them (a hanging link, a cmux that has quit) are the normal
// way this app fails, not the exotic way.
//
//   node scripts/test-status.mjs
//
// Needs the server running; drives the headless Chromium over CDP.

import { launch } from './lib/cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4488';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failures += 1;
}

const b = await launch();
const viewText = () => b.evaluate("document.getElementById('view').innerText.replace(/\\s+/g, ' ').trim()");

// Poll instead of sleeping a fixed time: these transitions are driven by
// timeouts inside the app, and pinning the test to them would make it a
// restatement of the constants rather than a test of the behaviour.
async function waitFor(pred, ms, step = 250) {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    last = await viewText();
    if (pred(last)) return { ok: true, text: last };
    await sleep(step);
  }
  return { ok: false, text: last };
}

// Modes for the request interceptor. 'off' is not the same as no interception:
// Fetch stays enabled so the mode can change without reloading.
let mode = 'off';
let stallCount = 0;

try {
  await b.send('Network.enable');
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  b.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const path = new URL(request.url).pathname;
    if (mode === 'stall-all') {
      stallCount += 1;
      return; // never resumed: a Mac that is asleep swallows the connection
    }
    if (mode === 'no-app' && /\.(js|mjs)$/.test(path)) {
      await b.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
      return;
    }
    if (mode === 'no-cmux' || mode === 'cmux-stalled') {
      // The server is up and answering; cmux behind it is not — closed, or
      // running but timing out.
      if (path === '/api/stream') return; // stall, so the SSE cannot contradict us
      if (path === '/api/state') {
        const body = JSON.stringify({
          online: false, stalled: mode === 'cmux-stalled', lastOkAt: Date.now() - 300_000, groups: [], workspaces: [],
        });
        await b.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(body).toString('base64'),
        });
        return;
      }
    }
    await b.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });

  // ---------------------------------------------------------------- healthy
  await b.goto(`${BASE}/`);
  const healthy = await waitFor((t) => t && !/Connecting|Can't reach|isn't running/.test(t), 15_000);
  check('connected: the session list renders, no status screen', healthy.ok, healthy.text);
  await b.evaluate('navigator.serviceWorker.ready.then(() => 1)');
  await sleep(1500); // let the shell finish landing in the cache

  // --------------------------------------------------- the Mac is not there
  await b.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await b.send('Page.reload');
  const gone = await waitFor((t) => /Can't reach the Mac/.test(t), 15_000);
  check('offline: says the Mac cannot be reached, from cache', gone.ok, gone.text);
  check('offline: the status screen suggests what to check', /tailnet|Tailscale/.test(gone.text), gone.text);

  // ------------------------------------------------------- and comes back
  await b.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  const back = await waitFor((t) => !/Can't reach the Mac/.test(t), 30_000);
  check('recovery: the status screen clears itself, with no tap', back.ok, back.text);

  // ------------------------------------------- the Mac is there, cmux is not
  mode = 'no-cmux';
  await b.send('Page.reload');
  const noCmux = await waitFor((t) => /isn't running/.test(t), 20_000);
  check('cmux down: says so, rather than showing an empty list', noCmux.ok, noCmux.text);

  // cmux is the only way back from here, so the screen has to offer it. The
  // launch itself is not driven — it would start a second cmux on the machine
  // running the test — only that the buttons are wired and say what they do.
  const buttons = await b.evaluate(`JSON.stringify(
    [...document.querySelectorAll('#view button')].map((el) => ({ id: el.id, text: el.innerText.trim() }))
  )`);
  const btns = JSON.parse(buttons);
  check('cmux down: offers to start cmux', btns.some((x) => x.id === 'status-launch'), buttons);
  check('cmux down: offers a new workspace too', btns.some((x) => x.id === 'status-new-ws'), buttons);
  // The label is read in the same turn as the click: withProgress sets it before
  // its first await, and the launch route answers immediately here (cmux is
  // already up on this machine), so a later read would race the reset.
  const clicked = await b.evaluate(`(() => {
    const seen = [];
    const real = window.fetch;
    window.fetch = (u, o) => { seen.push(String(u) + ' ' + ((o && o.method) || 'GET')); return real(u, o); };
    const btn = document.getElementById('status-launch');
    btn.click();
    const label = btn.innerText.trim();
    return new Promise((r) => setTimeout(() => r(JSON.stringify({ seen, label })), 600));
  })()`);
  const { seen, label } = JSON.parse(clicked);
  check('cmux down: the start button calls the launch route',
    seen.some((s) => /\/api\/cmux-launch POST/.test(s)), clicked);
  check('cmux down: the button says it is working', /Starting/.test(label), clicked);
  await sleep(2000);

  // ------------------------------------- cmux is there, but not answering
  // What a shut lid looks like: App Nap throttles cmux until its calls time
  // out. It used to read as "cmux isn't running" and offer to start it.
  mode = 'cmux-stalled';
  await b.send('Page.reload');
  const stalled = await waitFor((t) => /isn't answering/.test(t), 20_000);
  check('cmux stalled: says it is not answering, not that it is closed', stalled.ok && !/isn't running/.test(stalled.text), stalled.text);
  check('cmux stalled: names the lid as the likely cause', /lid/.test(stalled.text), stalled.text);
  const stalledBtns = await b.evaluate(`JSON.stringify([...document.querySelectorAll('#view button')].map((el) => el.id))`);
  check('cmux stalled: does not offer to start a cmux that is running',
    !JSON.parse(stalledBtns).includes('status-launch') && JSON.parse(stalledBtns).includes('status-retry'), stalledBtns);

  // ------------------------------------------------- a link that hangs open
  // The one that produced the black screen: network-first with no deadline
  // meant /app.js never arrived and the shell had nothing in it at all.
  mode = 'stall-all';
  stallCount = 0;
  await b.send('Page.reload');
  const hung = await waitFor((t) => /Connecting|Can't reach the Mac/.test(t), 15_000);
  check('hanging link: the app still paints, served from cache', hung.ok, hung.text);
  check('hanging link: requests really were hung, not refused', stallCount > 0, `${stallCount} stalled`);
  const explained = await waitFor((t) => /Can't reach the Mac/.test(t), 20_000);
  check('hanging link: settles on the real reason', explained.ok, explained.text);

  // ------------------------------------------------- the app itself is broken
  // Nothing below the <script> tag runs, so this one is caught by the watchdog
  // in index.html rather than by anything in app.js. Last, because it throws
  // away the cache the cases above depend on.
  mode = 'off';
  await b.send('Page.reload');
  await waitFor((t) => t && !/Connecting/.test(t), 15_000);
  await b.evaluate(`(async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    return 1;
  })()`);
  mode = 'no-app';
  await b.send('Page.reload');
  const broken = await waitFor((t) => /didn't load|Can't reach/.test(t), 20_000);
  check("app.js missing: the shell explains itself instead of showing nothing", broken.ok, broken.text);
  check('app.js missing: blames the app, not the link', /didn't load/.test(broken.text), broken.text);

  const bad = b.problems.filter((p) => !/Failed to (load|fetch)|net::|FetchEvent|EventSource|503|504|Importing a module script failed/i.test(p));
  check('no unexpected console errors', bad.length === 0, bad.join('\n        '));
} finally {
  await b.close();
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
