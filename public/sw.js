const CACHE = 'cmux-mirroring-v39';
const SHELL = ['/', '/app.js', '/term-input.mjs', '/files.mjs', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for the shell, but only briefly. A Mac that is asleep or off
// the tailnet does not refuse the connection, it swallows it: an un-raced
// fetch() here hangs until the OS gives up on the socket, around 75s. For all
// that time /app.js never arrives, so the phone shows the bare HTML — an empty
// dark rectangle with no text and no way to retry, which is the one failure the
// app could not explain to itself. 2.5s is far longer than Tailscale needs when
// the Mac is awake, and far shorter than anyone will stare at nothing.
// API calls are left alone (they should fail visibly).
const SHELL_TIMEOUT_MS = 2500;

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const net = fetch(e.request).then((resp) => {
    if (resp.ok) {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return resp;
  });
  net.catch(() => {}); // the race below may settle from cache first
  const slow = new Promise((_, reject) => setTimeout(reject, SHELL_TIMEOUT_MS, new Error('slow')));
  e.respondWith(
    Promise.race([net, slow])
      // Cache miss falls back to the network request still in flight: a first
      // load over a slow link has nothing else to show, and it may yet land.
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || net)),
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'cmux', {
      body: data.body || '',
      tag: data.tag || undefined,
      silent: Boolean(data.silent),
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      for (const client of list) {
        if ('focus' in client) {
          await client.focus();
          // navigate the already-open app to the pinging session
          client.postMessage({ type: 'open', url: target });
          return;
        }
      }
      return clients.openWindow(target);
    }),
  );
});
