# Handoff: cmux mirroring — iPhone PWA client for cmux

## Session Metadata
- Created: 2026-09-12 11:33:19
- Project: /Users/admin/Documents/dev/cmux_mirroring
- Branch: main (pushed to git@github.com:DimaBinskyi/cmux_mirroring.git)
- Session duration: ~2 days of iterative work (design → v39)

### Recent Commits (for context)
  - 8eda5e4 Single-tap return to live; relax wrap detection
  - 731210b Preserve composer line breaks; live button also returns to the left edge
  - 77341b0 Explain empty scrollback, icon-only live button, sturdier composer
  - e324810 Rename workspaces and tabs by long-press
  - 8720f6f Let the browser define the bottom edge (inset:0, no height)

## Handoff Chain

- **Continues from**: None (fresh start)
- **Supersedes**: None

> This is the first handoff for this task.

## Current State Summary

The app is **built, running, installed on the user's iPhone, and in active daily use**. It is a
home-screen PWA that mirrors cmux: workspace list with live status, a colour-accurate terminal
view with two-way bound input, a Claude-conversation chat view, Web Push notifications, and
workspace/tab management. The server runs 24/7 on the Mac via launchd and is reachable from the
phone over Tailscale HTTPS. Work is currently a tight feedback loop: the user tests on the phone,
reports issues (often with screenshots uploaded through the app's own 📎 feature into
`data/uploads/`), and fixes ship as new versions. Latest shipped version is **v39**. The one
long-standing unresolved item is a visual gap at the bottom of the screen in the installed PWA,
which the user has explicitly asked to stop working on for now.

## Codebase Understanding

### Architecture Overview

Three pieces, no build step, one npm dependency (`web-push`):

1. **Node server on the Mac** (`server.mjs` + `lib/`), bound to `127.0.0.1:4488`, launchd agent
   `com.dmytro.cmux-mirroring`. Holds a **persistent connection to the cmux control socket** and
   exposes a small HTTP API to the phone.
2. **Vanilla-JS PWA** (`public/`): `index.html` (all CSS), `app.js` (all logic, ~1300 lines),
   `sw.js` (service worker: offline shell + push). No framework, no bundler.
3. **Tailscale Serve** terminates HTTPS on the tailnet and proxies to the loopback server, so the
   phone reaches it from anywhere and nothing is exposed publicly.

Data flow: cmux events → server state model → SSE (`/api/stream`) → phone UI; phone actions →
HTTP POST → cmux socket RPCs. Push: notify hook → `/api/notify` → Apple → service worker.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `server.mjs` | HTTP API, grid deltas, uploads, topology actions, push, watcher suppression | Primary backend |
| `lib/cmux.mjs` | cmux transport: persistent socket client (auth handshake) + CLI fallback | All cmux I/O |
| `lib/state.mjs` | Live model of workspaces/tabs/status lanes, ws↔Claude-session mapping | Home screen data |
| `lib/transcripts.mjs` | Parses `~/.claude/projects/**/*.jsonl` into chat messages | Chat tab |
| `lib/push.mjs` | VAPID keys, subscriptions, feed history, broadcast | Notifications |
| `public/app.js` | Entire client: routing, terminal render, 2-way input sync, settings | Most edits land here |
| `public/index.html` | All styles + DOM skeleton | Layout changes |
| `docs/DESIGN.md` | Original design decisions | Background |
| `README.md` | Fresh-device setup, env vars, updating, install steps | User-facing docs |

### Key Patterns Discovered

- **cmux control socket protocol** (undocumented, reverse-engineered): newline-delimited JSON
  `{id, method, params}` → `{id, ok, result|error}`, preceded by a literal line `auth <password>`.
  Password file: `~/.local/state/cmux/socket-control-password` (mode 600). Socket:
  `~/.local/state/cmux/cmux.sock`. Socket calls ≈2 ms vs ≈145 ms per CLI spawn.
- **Terminal rendering** uses `terminal.replay` → `render_grid`: `row_spans` + `scrollback_spans`
  (span = `{row, column, text, style_id, cell_width}`) plus a `styles` table. The server converts
  this to rows and sends **row-level deltas** when the client is one revision behind.
- **Change detection**: `state_seq` is ALWAYS 0 — use `render_epoch/render_revision/row_space_revision`.
- **Versioning discipline**: `APP_VERSION` in `app.js` and `CACHE` in `sw.js` are bumped together
  every release; the version is displayed in Settings and on the home screen metrics line. This
  exists because iOS silently resumes stale suspended pages — several "bug reports" were stale builds.
- **Testing loop**: `cmux browser open <url> --json` → `cmux browser <surface> eval '<js>'` drives
  the real UI headlessly; scratch workspaces (`zz-*`) are created and closed for isolation.

## Work Completed

### Tasks Finished

- [x] Planning/design phase (brainstorming skill, visual companion mockups) → `docs/DESIGN.md`
- [x] Server with persistent cmux socket transport + CLI fallback
- [x] Home screen: workspace list, status lanes, groups, close ✕, ＋ new workspace
- [x] Terminal view: full-colour render grid, viewport-only live mode, row deltas, gzip
- [x] Scrollback: live while scrolled, search with ▲/▼ navigation, "▲ All" plain-text history
- [x] Two-way bound input: local echo, batched sends, cursor-aware diff editing, multi-line
- [x] Chat view: transcript rendering, permission cards, slash suggestions mirrored from Claude
- [x] Web Push: VAPID, categories + mutes, deep links, suppression while viewing a session
- [x] Tabs-only model: chips with ✕ and ＋, live updates from the Mac
- [x] Rename workspaces/tabs via long-press
- [x] Attachments (photo/video → Mac → path inserted into prompt)
- [x] Settings: server address, notification prefs, terminal font size, version/metrics
- [x] Repo de-personalised, README rewritten for fresh installs, pushed to GitHub

### Files Modified

All files in the repo were created/modified during this session (initial commit through v39).
The hot files are `public/app.js`, `public/index.html`, `server.mjs`.

External file modified outside the repo:
`~/.claude/hooks/cmux-child-notify-filter.py` — sends each cmux notification to BOTH the local
Web Push endpoint (`http://127.0.0.1:4488/api/notify`, with `url: /#/ws/<workspace-uuid>` deep
link and `tag` = workspace id) and the pre-existing Telegram bot.

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| PWA instead of native app | Swift / Flutter / React Native / Expo | Free Apple account cannot ship push (no APNs entitlement) and binaries expire after 7 days; home-screen PWAs are Apple's only free path to real push |
| Terminal-first UI | chat-first, terminal-first, both | User explicitly prefers the terminal view as default; Chat is one tap away |
| Tabs only, no splits | mirror cmux splits | Splits are meaningless on a phone; cmux splits are flattened into tab chips |
| Persistent socket transport | CLI per call | 145 ms → 2 ms per call; CLI kept as automatic fallback when the socket is down |
| Viewport-only live polling + deltas | full grid each poll | 128 KB → ~1 KB per update, enables 150 ms polling on mobile data |
| Enter = newline, ⏎ button = send | Enter sends | User requirement; slash-command lines keep the newline local so Claude doesn't execute |
| Suppress push for the watched session | always push | Phone reports foreground-viewed workspace (10 s heartbeat, 25 s TTL); event still recorded in Feed |

## Pending Work

### Immediate Next Steps

1. **Wait for user feedback on v39** — specifically: does the ⌄ live button now work in one tap,
   and is the two-way field↔terminal binding behaving on their 183-column terminal after the wrap
   threshold was relaxed (`columns - 3` → `columns - 8`)?
2. **If binding still misbehaves**, instrument the composer parser: log `grid.columns`, each row's
   length and the wrapped/newline decision, and have the user reproduce with a screenshot. The
   suspect code is `syncFieldFromTerminal()` in `public/app.js` (composer block reconstruction).
3. **Consider removing the debug metrics line** from the home screen (`renderHome()`, shows
   `app vNN · win … · screen … · body …`) once layout questions are closed.

### Blockers/Open Questions

- [ ] **Bottom gap in the installed PWA** — user says "forget about it for now". Evidence gathered:
  `window.innerHeight` = `visualViewport.height` = 873 while `screen.height` = 932 on iPhone 15
  Pro Max; forcing the body to 932 pushed the input/nav outside the visible area (regression,
  reverted in v33). Conclusion: the web view itself is shorter than the screen; the strip is not
  paintable by the page. Untried: whether a *fresh* install after the manifest/meta changes fixes
  it (user reinstalled once and reported no change).
- [ ] Terminal size for tabs created from the phone: cmux assigns a default pty size (~99×35) to
  tabs created while unfocused, and **no remote resize API exists** (probed `terminal.viewport`,
  `mobile.terminal.viewport`, `mobile.terminal.set_font` — all no-ops). Resolves itself when the
  tab is viewed on the Mac.
- [ ] The iOS keyboard accessory bar (˄ ˅ ✓) cannot be removed by a web app — hard platform limit.

### Deferred Items

- Retiring the Telegram notification path (kept in parallel until push is fully proven)
- Diff viewer, todos, browser-pane mirroring, starting tasks from the phone
- Dynamic program-aware autocomplete for the chat composer (shell/agent-aware suggestions)
- ANSI-capture recording (`pipe-pane`) to give coloured deep history; cmux only retains ~240
  styled scrollback rows

## Context for Resuming Agent

### Important Context

**The user tests on a real iPhone and reports symptoms; you cannot see their screen.** Two habits
that repeatedly saved time:

1. **Always suspect a stale build first.** iOS resumes suspended PWA pages, so the user can be
   running code from several versions ago. That is why `APP_VERSION` exists and is shown in
   Settings and on the home screen. Ask them to force-quit (swipe away) and confirm the version
   before debugging any report.
2. **Screenshots are the ground truth.** The user uploads them through the app's 📎 button; they
   land in `data/uploads/` and can be read directly with the Read tool. Several "unreproducible"
   bugs were solved by measuring pixel positions and the on-screen metrics line.

**Verification style expected:** every change is tested against the live cmux before claiming it
works — usually by creating a scratch workspace (`cmux new-workspace --name zz-... --focus false`,
optionally `--command claude`), driving the real UI through `cmux browser <surface> eval`, then
closing the scratch workspace. Do not report a fix as verified without doing this.

**Testing gotcha:** when the Mac display is locked, embedded browser panes report
`document.visibilityState === "hidden"`, and the app deliberately pauses polling (battery). Timer-
driven behaviour therefore cannot be tested in that state — force a repaint instead (e.g. switch
tabs, or trigger an action that calls `pollGrid(true)`).

### Assumptions Made

- The user's tailnet is the security boundary: the app has **no authentication of its own**. This
  is documented in the README and was an explicit, accepted trade-off.
- cmux is always running on the Mac; if its socket is down the server falls back to the CLI and
  the UI shows "Mac unreachable" states.
- Claude Code session transcripts live under `~/.claude/projects/<slugified-cwd>/<session>.jsonl`.

### Potential Gotchas

- `hidden` attribute does nothing when CSS sets `display` on the element — pair it with
  `[hidden] { display: none }`.
- `cursor.visible` is `false` on unfocused panes (i.e. always, from the phone) — never gate on it.
- `close-surface` requires `--workspace` scope or it fails with "Surface not found".
- Claude's composer uses `❯` followed by a **non-breaking space** (` `).
- Panes running full-screen TUIs report `active_screen: "alternate"` and `history_rows: 0` — they
  genuinely have no scrollback; the UI now says so instead of appearing broken.
- Ctrl+C does not interrupt Claude Code (that is **esc**); `^C` is correct for shells.
- Writing literal control characters (DEL ``, ESC ``) into `app.js` via the Edit tool
  is error-prone — use `\uXXXX` escapes.

### Environment State

### Tools/Services Used

- cmux (control socket + CLI at `/Applications/cmux.app/Contents/Resources/bin/cmux`)
- Tailscale, with Serve enabled: `https://<mac>.<tailnet>.ts.net` → `127.0.0.1:4488`
- launchd agent `com.dmytro.cmux-mirroring` (plist in `~/Library/LaunchAgents/`; a generic
  template lives in the repo as `cmux-mirroring.plist.example`)
- Node v24 (via nvm)

### Active Processes

- The cmux-mirroring server (restart with
  `launchctl kickstart -k gui/$(id -u)/com.dmytro.cmux-mirroring`)
- cmux itself, plus the user's Claude Code sessions

### Environment Variables

Names only (all optional, defaults in README): `PORT`, `HOST`, `VAPID_SUBJECT`, `CMUX_BIN`,
`CMUX_SOCKET_PATH`, `CMUX_SOCKET_PASSWORD`.

Secrets live outside the repo and are gitignored: `data/vapid.json`, `data/subscriptions.json`,
`data/prefs.json`, `data/feed.json`, `data/uploads/`.

## Related Resources

- Repo: https://github.com/DimaBinskyi/cmux_mirroring
- `README.md` — fresh-device setup (Mac + phone), env table, updating, security note
- `docs/DESIGN.md` — architecture and the original design decisions
- cmux CLI contract: https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md
- Long-term memory: `~/.claude/projects/-Users-admin-Documents-dev/memory/cmux-phone-remote.md`

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
