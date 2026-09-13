# cmux mirroring

Phone PWA that mirrors cmux — live colored terminal, agent chat, two-way input, Web Push,
a read-only file browser and phone→Mac attachments — served over Tailscale. No build step,
no framework, one dependency (`web-push`).
README.md covers setup; `docs/DESIGN.md` is the original design, written under the project's
old name "cmux-push".

## Commands

```bash
npm start                                                     # node server.mjs, binds 127.0.0.1:4488
launchctl kickstart -k gui/$(id -u)/com.dmytro.cmux-mirroring # restart the installed agent
tail -f data/stderr.log                                       # the agent's only output; launchd swallows it otherwise
curl -s localhost:4488/api/state                              # workspace + surface ids
```

Files under `public/` are read from disk per request, so client edits need no restart.
Changes to `server.mjs` or `lib/` do.

## Tests

They drive a **real cmux surface** — no mocks, because every bug in this app has been in how
a rendered terminal reads back, which only reproduces against a live one. The server must be
running, and ids come from `/api/state`.

```bash
node scripts/test-input-sync.mjs <surface-id>    # composer <-> field; point at an IDLE session
node scripts/test-shell-sync.mjs <workspace-id>  # shell prompt; creates and closes a scratch tab
node scripts/test-files.mjs [workspace-id]       # file browser: listing, viewer, locked state
node scripts/test-scroll.mjs <workspace-id>      # touch scrolling, headless Chromium
node scripts/smoke-browser.mjs <workspace-id> --type   # app loads; typing reaches the pty
node scripts/dump-grid.mjs <surface-id>          # print the rows the parser sees
```

The composer test types into the session you name and clears it afterwards, so never aim it at
a session you care about. Browser tests drive the headless Chromium that ships with Playwright
over CDP (`scripts/lib/cdp.mjs`) — no extra dependency.

Passing `test-files.mjs` a workspace id unlocks a second half — the Files tab *inside* a
session, and the viewer's insert button. Without it those never run and it still passes.
`BASE=http://127.0.0.1:<port>` points any script at another instance; `dump-grid.mjs` takes
a row count as its second argument (default 14).

## Layout

| Path | Role |
|------|------|
| `server.mjs` | HTTP + SSE; every `/api/*` route is in `handleApi` |
| `lib/cmux.mjs` | cmux control socket (persistent, ~2ms/call) with a CLI fallback |
| `lib/state.mjs` | workspace/lane snapshot pushed to the phone over SSE |
| `lib/transcripts.mjs` | `~/.claude/projects/*.jsonl` → the chat view |
| `lib/push.mjs` | VAPID keys, subscriptions, notification feed |
| `lib/files.mjs` | file browser: home confinement, deny-list, text paging, its key |
| `public/app.js` | the whole client: routing, rendering, polling |
| `public/files.mjs` | the file browser view — listing, breadcrumbs, text/media viewer |
| `public/term-input.mjs` | pure functions — grid → input line, field edit → pty ops |
| `hooks/cmux-notify.py` | cmux notification hook → `/api/notify`; registered in `~/.config/cmux/cmux.json` |

## Gotchas

- **cmux socket control must be in password mode.** `~/.config/cmux/cmux.json` needs
  `automation.socketControlMode: "password"`; the default `cmuxOnly` only accepts cmux
  descendants, so the launchd agent and its CLI fallback are both rejected and
  `/api/status` reports `cmuxOnline: false` with an empty sidebar. Running the server by
  hand from a cmux terminal hides this — that process *is* a descendant.
- **launchd gives the agent a bare PATH**, so `lib/cmux.mjs`'s CLI fallback finds nothing
  unless cmux is at `/Applications/cmux.app`. Set `CMUX_BIN` in the plist for any other
  install. Same symptom as the socket-mode gotcha above, and again invisible when you run
  the server by hand from a shell that has a real PATH.
- **Shipping a client change** means bumping `APP_VERSION` in `public/app.js` *and* `CACHE` in
  `public/sw.js`, and adding any new `public/` file to that file's `SHELL` list.
- **A new file extension needs a MIME entry in `server.mjs`.** Browsers reject a module served
  as `application/octet-stream`, and the app fails to boot with no obvious cause. Uploads have
  their own table (`UPLOAD_MIME`) — a type missing there just won't preview.
- **A stale headless Chromium silently invalidates every browser test.** `scripts/lib/cdp.mjs`
  takes whatever is on port 9333, so a leftover shell from an earlier run answers instead, with
  its old service-worker cache: tests then pass or fail against a build you are not editing.
  `pkill -f chrome-headless-shell` first; the app version in Settings tells you which build ran.
- **Never put literal ESC or DEL bytes in source** — write `\u001B` / `\u007F`. Literal control
  characters are invisible in diffs and break exact-match editing.
- **Newlines are terminal-specific.** The Claude composer wants `shift+enter`; a shell wants
  backslash+CR and leaks `;2;13~` into the command line if sent `shift+enter`. `computeEdit`'s
  `lineBreak` option chooses, driven by the `kind` that `parseInput` reports.
- **The input field is reconstructed from what is on screen,** so it is lossy by nature: a typed
  trailing space is indistinguishable from an erased cell, and the composer word-wraps at
  `columns - 2`. Only change `public/term-input.mjs` with the tests running.
- **Repaints must not fight the user's scroll.** The pane repaints every 150ms; anything that
  writes `scrollTop`/`scrollLeft` on repaint will yank the view. Programmatic scrolls are
  identified by exact position (`autoScrollTop`), never by a time window — a window is always
  open while output is flowing, which silently disables scrolling up.
- **The file browser is the one route worth more than the tailnet boundary.** `/api/fs/*`
  needs the key in `data/fs-key` (header `X-Fs-Key`, or `?key=` on `/api/fs/file`, which goes
  into `<img>`/`<video>` src and cannot carry a header). Reads are confined to `$HOME` after
  `realpath` — a symlink cannot walk out — and `~/Library`, `.ssh`, `*.pem`, `.env*` and the
  rest of the deny-list in `lib/files.mjs` are refused inside it. **Anything that is not media
  is served as `text/plain` + `nosniff`, `.html` and `.svg` included**: these routes are
  same-origin with the app, so a file rendered as itself would script the app's origin and
  could call every other route. Add media types to `MEDIA_MIME` there, never HTML or SVG.
- **A TCC-protected folder hangs the call, it does not fail it.** `~/Desktop`,
  `~/Downloads` and `~/Documents` are gated by macOS privacy, and a launchd agent that has
  not been granted them blocks inside `readdir`/`stat` forever, holding a libuv thread —
  four of those and every async fs operation in the server is stuck behind them (the
  symptom is unrelated requests hanging too). Everything in `lib/files.mjs` goes through
  `leash()`: a 4s timeout, then that top-level folder is refused instantly until
  `clearStall` (the client's "Try again" sends `retry=1`). Never add a `*Sync` fs call to
  that path — it would block the event loop instead of a pool thread. The real fix for a
  user is Full Disk Access for the node binary; `UV_THREADPOOL_SIZE=16` buys headroom.
- **The launchd label installed here is `com.dmytro.cmux-mirroring`**, not the
  `com.cmux-mirroring` used in `cmux-mirroring.plist.example` and the README.
- `data/` is gitignored and holds the VAPID keys, the file-browser key, push subscriptions,
  `prefs.json`, the notification `feed.json`, `events-cursor`, the agent's `stdout.log` /
  `stderr.log`, and uploads. Deleting it
  re-keys push, and every phone has to subscribe again. `data/uploads/` is swept on a 30-day
  TTL (`sweepUploads`, at startup and daily), so paths in older transcripts stop resolving.

## Style

Plain ES modules, 2-space indent, semicolons, no TypeScript, no build step. Comments explain
why something is the way it is, not what the line does.
