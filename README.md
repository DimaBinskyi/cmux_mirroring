# cmux mirroring

A phone-friendly mirror of [cmux](https://cmux.io) as an installable PWA — no Apple
Developer account, no App Store, no weekly re-signing. Built for iPhone (iOS 16.4+),
works in any browser.

## What it does

- **Home = the cmux sidebar**: every workspace with live status (🚨 needs input /
  ⚙️ working / ✅ done / 💤 idle), current activity, groups with worst-status
  roll-up, ✕ to close a workspace in place, ＋ to create one.
- **Link state and the Mac's battery, in the title bar**: one dot — green
  *Connected*, amber *cmux offline* (the Mac answers, cmux is not running), red
  *Disconnected* — next to the Mac's own battery, percent and whether it is
  charging, which is the one thing that can end every session at once while you
  are away from it. Inside a session the tabs need the room, so only the dot
  stays. Read from `pmset` once a minute and pushed over SSE when it changes.
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
- **Attachments**: 📎 picks anything on the phone — camera, library or Files —
  uploads it to the Mac (`data/uploads/`) with a progress bar, and inserts the
  file path into the prompt for the agent. HEIC is transcoded on arrival, since
  Claude cannot read it; what it still cannot open is marked "stored only".
  Hold 📎 (or Settings → Browse uploads) to look through everything uploaded —
  tap to view it full-screen, ＋ to reuse its path, 🗑 to delete it, hold a row
  to select several and delete them in one go — and any uploaded path in the
  Chat view is a tappable chip that opens the file.
  Uploads are swept after 30 days, so the camera roll doesn't accumulate in
  `data/`.
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

Assumes nothing is installed. Steps are in dependency order, and the ones that
can fail quietly end with the check that catches it — do the check before moving
on, because a missed step here shows up later as an app that loads but stays
empty, or notifications that never arrive.

What the phone needs, once: an iPhone on **iOS 16.4+** (older iOS cannot do Web
Push at all) with the **Tailscale** app signed in to the same tailnet as the Mac.

### 1. Toolchain

```sh
xcode-select --install    # git, and the /usr/bin/python3 the notify hook uses
brew install node         # Node 20+ (the browser tests in ## Tests want 22+)
```

Homebrew itself: [brew.sh](https://brew.sh). Any other Node install works too.

### 2. cmux, with socket control opened up — everything else depends on this

Install [cmux](https://cmux.io) and launch it once; first launch writes
`~/.config/cmux/cmux.json`. Turn on **Open at Login** for it (System Settings →
General → Login Items) — the server survives a reboot, but with cmux not running
the phone has nothing to mirror.

Out of the box cmux runs `socketControlMode: "cmuxOnly"`, which only lets
processes *descended from cmux itself* drive the control socket. This server
runs under launchd, so it is not one of them — and neither is the `cmux` CLI it
falls back to. Left alone, the app installs fine and then shows an empty sidebar
forever. Switch to password mode:

1. `cmux settings open automation` → set a **socket control password**. cmux
   mirrors it to `~/.local/state/cmux/socket-control-password`, which is where
   the server reads it from; nothing gets copied into this repo's config.
2. Add the mode to `~/.config/cmux/cmux.json` (it is JSONC — comments allowed):

   ```jsonc
   "automation": {
     "socketControlMode": "password"
   }
   ```

3. `cmux config check` — confirms the file still parses and lists the keys it
   picked up — then `cmux reload-config`. No restart needed.

Check: `ls -l ~/.local/state/cmux/socket-control-password` exists and is mode
`600`. (If you would rather not keep it on disk, put the same password in the
launchd plist as `CMUX_SOCKET_PASSWORD` instead — see the table in step 8.)

Worth knowing, because it hides the mistake: running the server by hand from a
cmux terminal works *without* any of this, since that process is a cmux
descendant. It breaks the moment you install it under launchd in step 4.

### 3. The app

```sh
git clone https://github.com/DimaBinskyi/cmux_mirroring && cd cmux_mirroring
npm install
node server.mjs     # cmux mirroring listening on http://127.0.0.1:4488
```

Clone it straight into your home folder. Under `~/Documents`, `~/Desktop` or
`~/Downloads` the launchd agent from step 4 meets macOS's per-folder privacy
protection and may need an extra permission grant to read its own repo.

Check, from another terminal:

```sh
curl -s localhost:4488/api/status
# {"subscriptions":0,"feed":0,"cmuxOnline":true,"uptimeSec":3}
```

`"cmuxOnline": false` means step 2 did not take (wrong mode, missing password
file, or cmux is not running). Fix it here — every step below assumes it is true.

### 4. Keep it running (launchd)

```sh
mkdir -p ~/Library/LaunchAgents      # absent on a Mac that has never had one
cp cmux-mirroring.plist.example ~/Library/LaunchAgents/com.cmux-mirroring.plist
# edit both placeholders inside: /path/to/node (`which node`) and
# /path/to/cmux_mirroring (`pwd`)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cmux-mirroring.plist
```

Stop the foreground `node server.mjs` from step 3 first, or the launchd agent
cannot bind the port. Check: `curl -s localhost:4488/api/status` still answers
with `"cmuxOnline": true`, and
`launchctl print gui/$(id -u)/com.cmux-mirroring | grep state` says running.
Logs go to `data/stdout.log` and `data/stderr.log`.

`cmuxOnline` flipping to `false` exactly here — true in step 3, false once
launchd owns the process — is step 2 undone: the hand-started server was allowed
in as a cmux descendant, the launchd one is not.

If cmux is *not* at `/Applications/cmux.app`, also set `CMUX_BIN` in the plist:
launchd hands the agent a bare `/usr/bin:/bin:/usr/sbin:/sbin` PATH, so a `cmux`
CLI installed anywhere else will not be found.

### 5. Stop the Mac from sleeping

A sleeping Mac serves nothing — no mirror, no notifications.

```sh
sudo pmset -a sleep 0    # never sleep on idle (the display may still sleep)
```

On a MacBook that holds while the lid is open. Closing the lid sleeps it anyway
unless it is on power with an external display attached.

### 6. HTTPS on the tailnet

Install [Tailscale](https://tailscale.com/download/mac) — the standalone build,
which is what this is verified against (1.102.3) — and sign in on both devices.
Its CLI lives inside the app bundle and is not on your PATH; add a shim:

```sh
sudo mkdir -p /usr/local/bin          # does not exist on a clean macOS install
sudo tee /usr/local/bin/tailscale >/dev/null <<'EOF'
#!/bin/sh
exec /Applications/Tailscale.app/Contents/MacOS/Tailscale "$@"
EOF
sudo chmod +x /usr/local/bin/tailscale
```

Then, one time, enable **MagicDNS** and **HTTPS certificates** in the Tailscale
admin console — `tailscale serve` prints the exact enable link if they are off:

```sh
tailscale serve --bg 4488
tailscale serve status   # https://<mac>.<tailnet>.ts.net → http://127.0.0.1:4488
```

The app is now at `https://<mac-name>.<tailnet>.ts.net`, reachable only from
your own devices. The mapping survives reboots.

### 7. Notifications from cmux

The server pushes whatever is POSTed to `/api/notify`; `hooks/cmux-notify.py`
in this repo is what turns cmux's own notifications into those POSTs. Without
this step everything else works and the phone simply stays silent. Register it
in `~/.config/cmux/cmux.json` — the same file as step 2, alongside `automation`:

```jsonc
"notifications": {
  "hooks": [
    {
      "id": "cmux-mirroring-push",
      "command": "/usr/bin/python3 ~/cmux_mirroring/hooks/cmux-notify.py",
      "timeoutSeconds": 10
    }
  ]
}
```

Point the path at your clone (`~` is expanded); the block sits at the top level
of the same object as `automation`. Then `cmux config check` and
`cmux reload-config`.

The hook classifies each notification by its text, prefixes the title with
🚨 needs-input / ⚠️ error / ✅ finished / 🤖 background — that emoji is what the
per-category mutes in Settings key off — deep-links the push to the session that
raised it, and stays quiet while you are actually at the Mac (cmux frontmost
*and* keyboard/mouse input in the last 30s; a locked or abandoned-but-focused
Mac still pushes). It never modifies cmux's own notification policy.

Two things upstream of the hook have to be in place, both one-time: macOS asks
on cmux's first notification whether to allow them (decline it and cmux raises
none at all, so the hook never runs — System Settings → Notifications → cmux),
and cmux produces them through its Claude Code integration, which is on by
default in Settings → Automation.

Anything else on the Mac can push the same way:

```bash
curl -m 5 -H 'Content-Type: application/json' \
  -d '{"title":"🚨 Claude needs input","body":"...","url":"/#/ws/<workspace-uuid>"}' \
  http://127.0.0.1:4488/api/notify
```

### 8. On the phone

1. Safari → `https://<mac-name>.<tailnet>.ts.net` → Share → **Add to Home Screen**.
2. Open it from the icon — iOS only grants Web Push to installed home-screen apps,
   never to a tab.
3. Settings tab → **Enable notifications** → Allow → **Send test push**.

Check: trigger something in cmux that notifies (let an agent finish a task) and
the push should arrive on its own. If the test push works but real ones never
come, step 7 is the one to revisit.

Optional environment overrides, set in the launchd plist or the shell:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4488` | HTTP port the server binds |
| `HOST` | `127.0.0.1` | Bind address (keep loopback; Serve does HTTPS) |
| `VAPID_SUBJECT` | repo URL | Push-sender contact (https: or mailto:) |
| `CMUX_BIN` | app bundle path | cmux CLI binary |
| `CMUX_SOCKET_PATH` | `~/.local/state/cmux/cmux.sock` | control socket |
| `CMUX_SOCKET_PASSWORD` | read from password file | socket auth |
| `CMUX_MIRRORING_URL` | `http://127.0.0.1:4488` | where `hooks/cmux-notify.py` posts |

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
submits. The browser tests drive Playwright's headless Chromium over CDP
(`scripts/lib/cdp.mjs`) — no npm dependency, but the browser binary itself is a
one-time download that a fresh Mac does not have:

```sh
npx playwright install chromium-headless-shell
```

## Notes

- The server binds to 127.0.0.1 only; Tailscale Serve terminates HTTPS and proxies
  to it, so exposure is tailnet-only. There is no auth of its own — anyone on your
  tailnet can control your terminals, so keep the tailnet personal.
- VAPID keys are generated on first start into `data/` (gitignored), along with
  push subscriptions, notification history, preferences, and uploads. Deleting
  `data/` re-keys push, and every phone has to subscribe again.
- The PWA icons are committed; `npm run icons` regenerates them (no image
  library — raw PNG encoding) if you change the glyph.
- Colored scrollback is limited to what cmux's render grid retains (~240 rows);
  the "▲ All" view loads up to 10k lines of plain-text history.
