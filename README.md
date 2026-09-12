# cmux mirroring

A phone-friendly mirror of [cmux](https://cmux.io) as an installable PWA — no Apple
Developer account, no App Store, no weekly re-signing. Built for iPhone (iOS 16.4+),
works in any browser.

## What it does

- **Home = the cmux sidebar**: every workspace with live status (🚨 needs input /
  ⚙️ working / ✅ done / 💤 idle), current activity, groups with worst-status
  roll-up, ✕ to close a workspace in place, ＋ to create one.
- **Terminal view (default)**: the real pane rendered with full colors via cmux's
  render grid. Live mode carries only the visible screen (~20KB full, ~1KB row
  deltas, 150ms adaptive polling); scrolling up pulls in the styled scrollback and
  keeps updating, holding your reading position. Repaints pause while you are
  actually scrolling or selecting, and the column you scroll to sideways is yours
  until ⌄ takes you back to live. 🔍 search across scrollback with ▲/▼ hit
  navigation; "▲ All" loads up to 10k lines of plain-text history.
- **Tabs, not splits**: every cmux tab *and* split shows as a chip. Chips update
  live when tabs are created/closed on the Mac, each has its own ✕ (with
  confirmation), and ＋ opens a new tab and switches to it.
- **Two-way bound input**: a multi-line textarea mirrors the terminal's input line
  in both directions. Typing echoes locally and streams to the pty (batched,
  cursor-aware — mid-line edits, word-delete, selection replace, paste all land
  exactly where the terminal cursor is). ↑ recalls history into both. Enter adds
  a newline in both, sent the way that terminal wants one (`shift+enter` in the
  Claude composer, backslash+CR at a shell prompt); only the ⏎ button submits.
  While a menu or dialog owns the keyboard — `/model`, a permission prompt — the
  field holds your draft instead of filling with what's on screen.
- **Key bar**: esc ⇥ ⇧⇥ arrows ^C ⏎, plus ⌄⌨ to hide the keyboard.
- **Chat view**: the Claude Code conversation rendered as chat — markdown,
  collapsed tool calls, permission prompts as Allow/Deny cards, composer with
  slash-command suggestions.
- **Attachments**: 📎 picks a photo/video on the phone, uploads it to the Mac
  (`data/uploads/`), and inserts the file path into the prompt for the agent.
- **Web Push notifications**: urgency-mapped (🚨 needs input / ⚠️ error /
  ✅ finished / 🤖 background) with per-category toggles in Settings; pushes
  deep-link into the pinging session and arrive even off the tailnet.
- **Settings**: server address (host:port) and notification preferences.

## Architecture

```
iPhone PWA (installed from Safari)
 ├─ HTTPS + SSE ── Tailscale ──▶ Node server (Mac, 127.0.0.1:4488, launchd)
 │                                ├─ cmux control socket (persistent, ~2ms/call;
 │                                │   newline-JSON protocol, CLI fallback)
 │                                └─ ~/.claude/projects/*.jsonl (chat transcripts)
 └─ Web Push ◀── Apple ◀───────── same server
```

No build step, no framework, one dependency (`web-push`). See `docs/DESIGN.md`.

## Fresh setup — everything a brand-new Mac + phone needs

Prerequisites on the Mac:

- [cmux](https://cmux.io) installed and running (the server talks to its control
  socket at `~/.local/state/cmux/cmux.sock`; the socket password is read
  automatically from `~/.local/state/cmux/socket-control-password`).
- Node.js 20+ (the browser tests below need 22+: `fs.globSync` and a global `WebSocket`).
- [Tailscale](https://tailscale.com) (free tier is fine), signed in.

Prerequisites on the phone:

- iPhone with iOS 16.4+ (Web Push requirement).
- Tailscale app, signed in to the **same tailnet** as the Mac.

Steps on the Mac:

1. `git clone https://github.com/DimaBinskyi/cmux_mirroring && cd cmux_mirroring`
2. `npm install && node scripts/gen-icons.mjs`
3. Start it: `node server.mjs` — you should see
   `cmux mirroring listening on http://127.0.0.1:4488`.
   For a permanent install, copy `cmux-mirroring.plist.example` to
   `~/Library/LaunchAgents/com.cmux-mirroring.plist`, fix the node and repo
   paths inside, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cmux-mirroring.plist`.
4. HTTPS on the tailnet (one-time): in the Tailscale admin console enable
   **MagicDNS** and **HTTPS certificates** (running `tailscale serve` prints the
   exact enable link if they're off), then:
   `tailscale serve --bg 4488`
   Your app is now at `https://<mac-name>.<tailnet>.ts.net`, tailnet-only.
5. Optional environment overrides (set in the launchd plist or shell):
   | Variable | Default | Purpose |
   |---|---|---|
   | `PORT` | `4488` | HTTP port the server binds |
   | `HOST` | `127.0.0.1` | Bind address (keep loopback; Serve does HTTPS) |
   | `VAPID_SUBJECT` | repo URL | Push-sender contact (https: or mailto:) |
   | `CMUX_BIN` | app bundle path | cmux CLI binary |
   | `CMUX_SOCKET_PATH` | `~/.local/state/cmux/cmux.sock` | control socket |
   | `CMUX_SOCKET_PASSWORD` | read from password file | socket auth |

Steps on the phone:

1. Safari → `https://<mac-name>.<tailnet>.ts.net` → Share → **Add to Home Screen**.
2. Open from the icon (iOS only grants Web Push to installed home-screen apps).
3. Settings tab → **Enable notifications** → Allow → **Send test push**.

Feeding notifications: anything on the Mac can push to every subscribed phone by
POSTing to the local API (wire it from a cmux/Claude Code notification hook):

```bash
curl -m 5 -H 'Content-Type: application/json' \
  -d '{"title":"🚨 Claude needs input","body":"...","url":"/#/ws/<workspace-uuid>"}' \
  http://127.0.0.1:4488/api/notify
```

Titles containing 🚨/⚠️/✅ map to the notification categories that can be muted
per-category in Settings; everything else is treated as silent background info.

## Updating

- **Phone: self-updating.** The app fetches fresh code every launch (network-first
  service worker, `no-cache` static files) — open it and you're on the latest
  version; no reinstall. Only if the manifest identity changes (app name/icons)
  do you need to re-add the icon.
- **Mac:** `git pull && npm install` then restart the server:
  `launchctl kickstart -k gui/$(id -u)/<your-plist-Label>`
  (or restart your `node server.mjs`). The label is whatever `Label` you put in the
  plist — `com.cmux-mirroring` if you copied the example verbatim. `launchctl list
  | grep cmux` will tell you.

Client changes ship only if `APP_VERSION` in `public/app.js` and `CACHE` in
`public/sw.js` are both bumped; a new file under `public/` also needs adding to the
`SHELL` list in `public/sw.js` and a MIME entry in `server.mjs`.

## Tests

Both halves of the terminal view are read back off a live terminal rather than
mocked, because that is the only place their failures appear: the input binding
is parsed out of the rendered grid (a blank line mid-prompt, a trailing space, a
wrapped line, an open `/model` menu each break it differently), and the scroll
behaviour only misbehaves against real repaints and real touch momentum. The
server must be running.

```sh
node scripts/test-input-sync.mjs <surface-id>   # Claude composer; use an IDLE one
node scripts/test-shell-sync.mjs <workspace-id> # shell prompt, in a scratch tab
node scripts/test-scroll.mjs <workspace-id>     # touch scrolling, headless Chromium
node scripts/smoke-browser.mjs <workspace-id> --type  # app loads, typing reaches the pty
node scripts/dump-grid.mjs <surface-id>         # what the parser sees, row by row
```

Surface and workspace ids come from `curl -s localhost:4488/api/state`. The
composer test types into the surface you name and clears it again; it never
submits. The browser tests use the headless Chromium that ships with Playwright,
driven over CDP (`scripts/lib/cdp.mjs`) — no extra dependency.

## Notes

- The server binds to 127.0.0.1 only; Tailscale Serve terminates HTTPS and proxies
  to it, so exposure is tailnet-only. There is no auth of its own — anyone on your
  tailnet can control your terminals, so keep the tailnet personal.
- VAPID keys are generated on first start into `data/` (gitignored), along with
  push subscriptions, notification history, preferences, and uploads.
- Colored scrollback is limited to what cmux's render grid retains (~240 rows);
  the "▲ All" view loads up to 10k lines of plain-text history.
