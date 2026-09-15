# Handoff: Status screens instead of a black screen, workspace creation with no window, grid renderer 6.6x (v62→v64)

## Session Metadata
- Created: 2026-09-15 12:01:06
- Project: /Users/admin/Documents/dev/cmux_mirroring
- Branch: main
- Session duration: ~2 days of wall clock across two sittings (2026-09-14 and 2026-09-15)

### Recent Commits (for context)
  - 6c66f92 Render the grid in runs, not one element per word
  - a096545 Say what is wrong instead of showing a black screen
  - 29ede09 Show every command the slash menu is offering, not just the first
  - 8a9f502 Check CLAUDE.md against the code it describes
  - 9df7565 Read the Mac's files from the phone, behind a key of their own

## Handoff Chain

- **Continues from**: [2026-09-12-132754-input-binding-and-scroll-fixes.md](./2026-09-12-132754-input-binding-and-scroll-fixes.md)
  - Previous title: Input binding rebuilt, terminal scrolling fixed (v40→v42)
- **Supersedes**: None — the two earlier handoffs still describe live parts of the app.

> Review the previous handoff for full context before filling this one.

## Current State Summary

Two commits landed on `main`, both fully tested, working tree clean. The first fixed the app
showing a featureless dark screen when the Mac was unreachable, and — as a consequence of finally
being able to *see* that state — fixed `＋ New workspace` doing nothing once every workspace was
closed, plus added a way to start cmux from the phone. The second made the terminal repaint 6.6x
cheaper after measuring where a frame's time actually goes. **`main` is 2 commits ahead of
`origin/main` and has NOT been pushed** — the user has not asked for it. The session ended
mid-discussion: the user had been offered a menu of further speed-ups, chose the rendering ones,
and those are now done; the rest of that menu is still open and listed under Deferred Items.

## Codebase Understanding

### Architecture Overview

The terminal path, which is where nearly all of this session's work happened:

```
cmux ──terminal.replay (control socket, lib/cmux.mjs)──▶ server.mjs /api/grid
     builds 270-540KB every call, ALWAYS the whole surface
                                             │ filters to `fit` rows, narrows styles,
                                             │ computes per-row keys for deltas, gzips
                                             ▼
                              phone: 5.9KB gz live / 46KB gz scrolled up
                                             │
       pollGrid ──▶ grid + rowsModel ──▶ paintGrid ──▶ lineHtml ──▶ #screen .tl divs
```

Measured per-frame budget (120-row pane, real surface) — this is the single most useful thing
learned this session:

| Phase | Cost |
|---|---|
| cmux builds `render_grid` | **52 ms idle · 150–476 ms busy · up to 15 s stalled** |
| server transform (assemble/sort/keys/stringify/gzip) | **0.67 ms** |
| wire to phone | 5.9 KB gz live · 46 KB gz `full=1` |
| client render (was) | 2.65 ms → **0.40 ms now** |

Everything we control is ~4 ms of a 50–500 ms frame. **cmux dominates and we cannot make it
cheaper** — `terminal.replay` ignores every limiting parameter (probed `scrollback:false`,
`lines:40`, `scrollback_rows:0`, `include_scrollback:false`, `max_scrollback_rows:0`; all five
returned byte-identical payloads).

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `public/app.js` | whole client | `connStatus`/`statusHtml`/`paintStatus`, `syncStyleSheet`, `lineHtml`, `paintGrid`, `pollGrid`, `refreshSnapshot` retry loop |
| `public/sw.js` | service worker | `SHELL_TIMEOUT_MS` race — the black-screen fix lives here |
| `public/index.html` | shell + all CSS | boot watchdog script, `.status` CSS, `#screen .tl` content-visibility |
| `server.mjs` | HTTP/SSE | `/api/grid` (464), `createWorkspace`/`startCmux` (~line 110), `/api/cmux-launch`, `/api/ws-action` |
| `lib/cmux.mjs` | control socket + CLI fallback | `launchApp()`, `appPath()` added this session |
| `lib/state.mjs` | workspace snapshot | `online` can now go false; `OFFLINE_GRACE_MS`, `lastOkAt` |
| `public/term-input.mjs` | grid → input line | **reads `rowsModel`** — constrains the renderer, see Gotchas |
| `scripts/test-status.mjs` | new, 15 checks | offline/hanging/no-cmux/no-app-js |
| `scripts/test-render.mjs` | new | cell-by-cell renderer equivalence |
| `scripts/lib/cdp.mjs` | CDP client | gained `on(method, fn)` for `Fetch.requestPaused` |

### Key Patterns Discovered

- **cmux emits one span per *word*, split by column gaps, not by style.** Two adjacent spans
  routinely share a `style_id` with a blank column between them. This is why run-merging works
  and why it must refill gaps with literal spaces.
- **A repaint costs element count, not colour.** CSS classes alone bought ~3%; cutting 1015
  elements to 137 bought 2.6x; skipping off-screen layout bought the rest.
- **The Mac fails by hanging, not refusing.** Asleep or off the tailnet it swallows the
  connection; nothing settles. Every deadline in this codebase exists because of that.
- **Testing outages needs CDP's `Fetch` domain, not offline emulation.** Offline fails *fast*,
  which is the half that already worked. Stalling a paused request without resuming reproduces
  the real failure.

## Work Completed

### Tasks Finished

- [x] Found and fixed the black screen: `sw.js` was network-first with no deadline
- [x] Status screens for "can't reach the Mac" / "cmux isn't running" / "connecting", self-retrying
- [x] Boot watchdog in `index.html` for when `app.js` itself never runs
- [x] `state.online` can return to false, with a 15 s grace so one dropped RPC is not an outage
- [x] Fixed `＋ New workspace` failing when no workspace (and therefore no window) exists
- [x] `POST /api/cmux-launch` + buttons to start cmux from the phone
- [x] Diagnosed the slow/blank terminal with measurements (not guesses)
- [x] Renderer: run-merging, stylesheet classes, dropped default wrappers, content-visibility
- [x] Two new test scripts; CLAUDE.md updated with four new gotchas

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `public/sw.js` | `SHELL_TIMEOUT_MS = 2500` race vs cache; only cache `resp.ok` | a hanging fetch meant `/app.js` never arrived → the black screen |
| `public/index.html` | `.status` CSS, `#boot` placeholder, watchdog script, `#screen .tl` content-visibility + `--term-cols` width | shell must explain itself; off-screen rows must not be laid out |
| `public/app.js` | status model + screens + retry loop; `api()` `timeoutMs`; `syncStyleSheet`/`lineHtml` replacing `spanHtml`; boot paints before fetching | see commits |
| `server.mjs` | `startCmux`, `createWorkspace`, `/api/cmux-launch`, `cmuxLastOkAt` | launching cmux and creating a workspace with no window |
| `lib/cmux.mjs` | `appPath()`, `launchApp()` | the socket cannot start the app that owns it |
| `lib/state.mjs` | `online` → false after `OFFLINE_GRACE_MS`; `lastOkAt` | flag was write-once-true; green dot over dead sessions |
| `scripts/lib/cdp.mjs` | `on(method, fn)` event subscription | needed to stall requests via `Fetch.requestPaused` |
| `scripts/test-status.mjs` | new, 15 checks | all four failure modes against a real surface |
| `scripts/test-render.mjs` | new | renders both ways, compares every cell's computed style |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Merge spans at **render time**, not in `rowsModel` or on the server | server-side (also shrinks the wire) | `term-input.mjs` derives per-char width from `cell_width / text.length`; merging across a wide glyph falsifies it and breaks input sync. Merging inside `lineHtml` costs nothing measurable. |
| `gapSafe` guard on absorbing gaps | absorb all gaps | a run with a background/underline/strike would paint decoration across cells cmux never described |
| State row width as `calc(var(--term-cols) * 1ch)` | drop content-visibility; guess an intrinsic width | a skipped row reports no width → horizontal scroll collapsed to 0 (caught by `test-scroll.mjs`). 1ch is exactly one cell in a monospace font; `scrollWidth` verified identical. |
| `timeoutMs` opt-in on `api()`, not a default | global default timeout | a slow large file read is allowed to be slow; only calls that decide what the screen says need a deadline |
| 15 s grace before declaring cmux offline | flip immediately | the log shows 253 transient RPC timeouts; flipping instantly would flash "cmux isn't running" wrongly |
| Bare `cmux <path>` as the no-window fallback | `new-window` then `new-workspace` | a fresh window arrives *with* a workspace, so the two-step leaves a stray one; the bare form makes window+workspace+cwd together and starts cmux if needed |
| `path.resolve` the requested cwd | pass through | a relative cwd would be read as a cmux subcommand by the bare form — verified `cwd:"ping"` lands in `~/ping`, not `cmux ping` |
| Single commit for the first task | split status work from workspace work | `app.js`/`server.mjs`/`CLAUDE.md` each carried both, and the buttons depend on the status screen; splitting meant a broken intermediate commit |

## Pending Work

### Immediate Next Steps

1. **Nothing is pushed.** `main` is 2 ahead of `origin/main`. Ask before pushing — the user has
   not requested it.
2. **Get the user to verify the zero-window fix.** Close every workspace on the Mac, then tap
   `＋ New workspace` on the phone. This is the one code path that could not be tested (see
   Blockers). If it fails, the fallback branch is `cli([dir])` in `createWorkspace`.
3. **Confirm the phone picked up v64.** Open the app once while the Mac is reachable, then check
   Settings shows `app v64`. Until then the phone still runs the old service worker.

### Blockers/Open Questions

- [ ] **The zero-window branch of `createWorkspace` is reasoned, not executed.** Reaching zero
      windows means closing the user's two live agent sessions. Established by experiment: a cmux
      window dies with its last workspace, so zero workspaces ⟺ zero windows. Every *other* step
      is verified (explicit `--window`, cwd handling, the bare-path form creating a workspace,
      `open -a`, the socket wait).
- [ ] **What makes `terminal.replay` swing 52 ms → ~500 ms is not isolated.** It is Mac-side, and
      concurrency multiplies it (4 in flight took `workspace.list` from 4 ms to 700 ms). An
      attempt to reproduce it with 4,000 lines of plain output gave 2–7 ms — plain text makes few
      spans, so it did not reproduce.
- [ ] `test-files.mjs` fails 2 of 18 checks (the viewer's `＋` insert button). **Pre-existing** —
      verified identical on `main` with this session's work stashed. Untouched, not investigated.

### Deferred Items

The user was shown a menu of speed-ups and chose the rendering ones. Still on the table, roughly
in order of value:

- **Coalesce concurrent `/api/grid` calls** per surface + ~250 ms cache. The server has no
  in-flight dedupe (`gridCache` is delta-only), so a keystroke refresh landing on the poll loop,
  or a second device, triggers another full 270 KB build. Also: the delta cache holds one
  generation, so two phones on one surface knock each other off the delta path.
- **Adaptive poll interval.** Fixed at 150 ms (`app.js` ~line 1013) while frames take 150–500 ms,
  so the socket never idles. The loop *is* chained, so nothing piles up from it.
- **Stop re-polling full scrollback when scrolled up.** `full=1` ships 46 KB gz every poll. The
  only change that would help the phone's link rather than the Mac.
- **A second cmux socket for state/feed**, so grid polls cannot starve them. Targets the 253
  timeouts in `data/stderr.log` (174 `feed.list`, 78 `workspace.list`), which cause stale sidebars
  and false "cmux offline". Does not make the terminal faster.
- **Paint from the last known frame on open** (client-side per-surface cache) — removes the
  perceived wait entirely without making anything faster.
- **Report upstream to cmux**: a row-limited `terminal.replay` is the real fix and the only 10x
  available. `cmux feedback` exists.

## Context for Resuming Agent

### Important Context

**The user is working from their phone and cares about felt behaviour, not benchmarks.** Every
task this session started from something they saw — a black screen, a button that did nothing, a
blank terminal pane. They ask for evidence and they push back on hand-waving; twice they asked to
discuss rather than be handed a menu of options. Measure before proposing.

**Never destroy their cmux state.** There are two live agent sessions (`workspace:61` Koolzone,
`workspace:63` this work). Experiments this session were done by creating a scratch window or tab
and closing only what was created. `test-input-sync.mjs` types into whatever session you name —
do not aim it at a real one; `test-shell-sync.mjs` makes its own scratch tab and covers the same
`term-input.mjs` path.

**Two corrections were issued to the user this session; do not silently re-assert the retracted
claims.** (1) CSS classes were presented as a meaningful render speed-up — measured, they are
worth ~3%; element count is what matters. (2) A first span-merge test showed almost no reduction
(1015→1005) because it did not fill column gaps; done properly it is 1015→137.

**The renderer changes do not address why the terminal is slow to appear** and the user has been
told so explicitly. They are main-thread work during streaming output — scroll smoothness and
battery. Do not let a future summary imply otherwise.

### Assumptions Made

- `1ch` equals exactly one terminal cell in `ui-monospace`. Verified indirectly: `scrollWidth`
  came out identical (1047 px) before and after, and `test-scroll.mjs` reports `maxLeft=645` vs
  646 previously — a 1 px difference judged negligible.
- Style ids are stable within a grid, so a delta only needs to dirty the stylesheet when it
  carries an id we do not know or whose definition differs (`sameStyle`).
- `open -a` from a `gui/` launchd agent can start cmux. `appPath()` derives the bundle from
  `CMUX_BIN`; `CMUX_APP` overrides. Only tested with cmux already running (returns immediately).

### Potential Gotchas

- **`pkill -f chrome-headless-shell` before every browser test.** A stale instance answers on
  port 9333 with its old service-worker cache and tests pass against a build you are not editing.
- **`launchctl kickstart -k gui/$(id -u)/com.dmytro.cmux-mirroring`** after any `server.mjs` or
  `lib/` change. Files under `public/` are read per request and need no restart.
- **Bump both `APP_VERSION` in `public/app.js` and `CACHE` in `public/sw.js`** for any client
  change. Currently v64 / v39.
- **`rowsModel` must keep cmux's original spans.** `term-input.mjs` (`rowCells`) derives
  per-character width from `cell_width / text.length`. Any merging belongs in `lineHtml`.
- **`content-visibility` interacts with scroll geometry.** If you touch `#screen .tl` or
  `--term-cols`, re-run `test-scroll.mjs` — it is what caught `maxLeft=0`.
- **`AskUserQuestion` was declined twice** in favour of open discussion. Prefer laying out
  findings and letting the user respond.
- The `data/stderr.log` timeouts are ambient, not caused by this session's changes.

## Environment State

### Tools/Services Used

- **Server**: launchd agent `com.dmytro.cmux-mirroring`, binds `127.0.0.1:4488`. Logs to
  `data/stderr.log`.
- **cmux**: `/Applications/cmux.app/Contents/Resources/bin/cmux`. Socket control must be in
  password mode. `CMUX_QUIET=1` silences the legacy-alias notices on every CLI call.
- **Tailscale**: fronts the app over HTTPS; get the URL with `tailscale serve status`. Measured
  overhead ~13 ms.
- **Headless Chromium**: Playwright's `chrome-headless-shell`, driven over CDP by
  `scripts/lib/cdp.mjs`. No Playwright API dependency.

### Active Processes

- The launchd agent is running (restarted several times this session; healthy at handoff,
  `cmuxOnline: true`).
- cmux is running with 1 window and 2 workspaces — `workspace:61` (Koolzone) and `workspace:63`
  (this work). Leave both alone.

### Environment Variables

Names only — values live on the Mac and in `data/`, never here.

- `CMUX_BIN`, `CMUX_APP`, `CMUX_SOCKET_PATH`, `CMUX_SOCKET_PASSWORD`, `CMUX_QUIET`
- `UV_THREADPOOL_SIZE`, `HOST`, `PORT`, `VAPID_SUBJECT`, `BASE` (test scripts)

## Related Resources

- `CLAUDE.md` — updated this session with four new gotchas (hanging vs refusing, `state.online`,
  window-dies-with-last-workspace, element count vs colour, content-visibility width)
- `docs/DESIGN.md` — original design, under the old name "cmux-push"
- cmux CLI contract: `https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md`
  (does **not** document `terminal.replay` parameters — probed by hand instead)
- Commits `a096545` and `6c66f92` have long messages carrying the reasoning in full

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
