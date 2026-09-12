# cmux mirroring

Phone PWA that mirrors cmux — live colored terminal, agent chat, two-way input, Web Push —
served over Tailscale. No build step, no framework, one dependency (`web-push`).
README.md covers setup; `docs/DESIGN.md` is the original design, written under the project's
old name "cmux-push".

## Commands

```bash
npm start                                                     # node server.mjs, binds 127.0.0.1:4488
launchctl kickstart -k gui/$(id -u)/com.dmytro.cmux-mirroring # restart the installed agent
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
node scripts/test-scroll.mjs <workspace-id>      # touch scrolling, headless Chromium
node scripts/smoke-browser.mjs <workspace-id> --type   # app loads; typing reaches the pty
node scripts/dump-grid.mjs <surface-id>          # print the rows the parser sees
```

The composer test types into the session you name and clears it afterwards, so never aim it at
a session you care about. Browser tests drive the headless Chromium that ships with Playwright
over CDP (`scripts/lib/cdp.mjs`) — no extra dependency.

## Layout

| Path | Role |
|------|------|
| `server.mjs` | HTTP + SSE; every `/api/*` route is in `handleApi` |
| `lib/cmux.mjs` | cmux control socket (persistent, ~2ms/call) with a CLI fallback |
| `lib/state.mjs` | workspace/lane snapshot pushed to the phone over SSE |
| `lib/transcripts.mjs` | `~/.claude/projects/*.jsonl` → the chat view |
| `lib/push.mjs` | VAPID keys, subscriptions, notification feed |
| `public/app.js` | the whole client: routing, rendering, polling |
| `public/term-input.mjs` | pure functions — grid → input line, field edit → pty ops |
| `hooks/cmux-notify.py` | cmux notification hook → `/api/notify`; registered in `~/.config/cmux/cmux.json` |

## Gotchas

- **cmux socket control must be in password mode.** `~/.config/cmux/cmux.json` needs
  `automation.socketControlMode: "password"`; the default `cmuxOnly` only accepts cmux
  descendants, so the launchd agent and its CLI fallback are both rejected and
  `/api/status` reports `cmuxOnline: false` with an empty sidebar. Running the server by
  hand from a cmux terminal hides this — that process *is* a descendant.
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
- **The launchd label installed here is `com.dmytro.cmux-mirroring`**, not the
  `com.cmux-mirroring` used in `cmux-mirroring.plist.example` and the README.
- `data/` is gitignored and holds the VAPID keys, push subscriptions and uploads. Deleting it
  re-keys push, and every phone has to subscribe again. `data/uploads/` is swept on a 30-day
  TTL (`sweepUploads`, at startup and daily), so paths in older transcripts stop resolving.

## Style

Plain ES modules, 2-space indent, semicolons, no TypeScript, no build step. Comments explain
why something is the way it is, not what the line does.
