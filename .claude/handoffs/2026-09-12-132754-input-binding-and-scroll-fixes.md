# Handoff: Input binding rebuilt, terminal scrolling fixed (v40→v42)

## Session Metadata
- Created: 2026-09-12 13:27:54
- Project: /Users/admin/Documents/dev/cmux_mirroring
- Branch: main
- Session duration: ~2 hours, one continuous session

### Recent Commits (for context)
  - f79a091 Rebuild the input binding and fix terminal scrolling
  - f30464b Add session handoff document
  - 8eda5e4 Single-tap return to live; relax wrap detection
  - 731210b Preserve composer line breaks; live button also returns to the left edge
  - 77341b0 Explain empty scrollback, icon-only live button, sturdier composer

## Handoff Chain

- **Continues from**: [2026-09-12-113319-cmux-mirroring-pwa.md](./2026-09-12-113319-cmux-mirroring-pwa.md)
  - Previous title: cmux mirroring — iPhone PWA client for cmux
- **Supersedes**: None. The predecessor is still the best description of the product,
  the push pipeline and the overall architecture; this one covers only the terminal
  view's input binding and scrolling, which it rewrites.

> Review the previous handoff for full context before filling this one.

## Current State Summary

Seven user-reported bugs in the terminal view were diagnosed, fixed, tested and pushed as
one commit (`f79a091`), shipping **v42** (`APP_VERSION` in `public/app.js`, `CACHE`
`cmux-mirroring-v17` in `public/sw.js`). All of them came from two places: the phone's input
field is *reconstructed from the rendered terminal grid*, and the terminal pane repaints every
150 ms while the user is trying to scroll it. The grid-parsing logic was extracted from
`public/app.js` into a new pure module `public/term-input.mjs`, and four test scripts were
added that drive a **real cmux surface** rather than mocks. All suites pass. The server was
restarted so the running deployment matches what was pushed. **The user has not yet reopened
the PWA on the phone to confirm v42 on the real device** — that is the one outstanding
verification.

## Codebase Understanding

### Architecture Overview

Unchanged from the previous handoff (Node server on the Mac → Tailscale Serve → PWA). What
this session added is a seam inside the client:

- `public/app.js` still owns routing, rendering, polling and all DOM work.
- `public/term-input.mjs` is new and **pure** — no DOM, no fetch. It holds the two hard
  algorithms: reading the terminal's current input line back out of the render grid
  (`parseInput`), and turning a field edit into the minimal pty keystrokes (`computeEdit`).
  Being pure is what makes it testable from Node against a live terminal.
- `scripts/lib/cdp.mjs` is a ~90-line Chrome DevTools Protocol client (launches the headless
  Chromium that ships with Playwright, talks over Node's global `WebSocket`). It exists so the
  browser tests need no new dependency in a project that deliberately has one.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `public/term-input.mjs` | grid → input line; field edit → pty ops; all of it pure | **Start here** for any input bug |
| `public/app.js` | `syncFieldFromTerminal`, `syncSet`, `diffAndSend`, `paintGrid`, `renderTerm`'s scroll handlers | Where the module is wired in |
| `public/sw.js` | `CACHE` + `SHELL` list | Must be bumped/extended to ship client changes |
| `server.mjs` | `/api/grid` (deltas), MIME map | Grid shape and static serving |
| `scripts/test-input-sync.mjs` | composer ↔ field, against a live Claude composer | The main regression net |
| `scripts/test-shell-sync.mjs` | shell prompt half; creates and closes its own scratch tab | Covers the non-Claude path |
| `scripts/test-scroll.mjs` | synthesized touch scrolling in headless Chromium | Covers repaint-vs-scroll |
| `scripts/smoke-browser.mjs` | app boots, no console errors, typing reaches the pty | End-to-end through the real UI |
| `scripts/dump-grid.mjs` | prints the rows the parser sees, with faint spans marked | First tool to reach for when a parse is wrong |
| `CLAUDE.md` | new this session; commands, layout, gotchas | Read before working here |

### Key Patterns Discovered

- **Do not reason about the terminal — look at it.** Every wrong assumption this session was
  settled in minutes by `scripts/dump-grid.mjs` against a live surface. Two documented beliefs
  in the code turned out to be false (see Decisions).
- **No mocks for grid parsing.** A fixture captured today would encode today's Claude Code
  rendering. The tests type into a real composer and read it back.
- **Pure core, thin wiring.** Anything that can be a pure function of `(grid, rowsModel)` should
  be, so it can be driven from Node.
- **Throwaway probes are cheap and worth it.** Several one-off `scripts/probe-*.mjs` files were
  written, used to answer one question each, and deleted. Don't be precious about them.

## Work Completed

### Tasks Finished

- [x] Multi-line text vanishing from the field after reopening the app
- [x] Only part of the text appearing when arrow keys moved the caret
- [x] A trailing space disappearing from the field and being sent to the pty twice
- [x] `/model` (and any menu/dialog) filling the field with on-screen junk
- [x] Long wrapped lines coming back corrupted (`wordword`, missing the wrapped space)
- [x] Horizontal scroll snapping back to the left on every repaint
- [x] Scrolling sideways being treated as a mode change (kicked out of scrollback)
- [x] Scrolling up being impossible while the terminal produced output
- [x] The view opening in scrollback by itself (web font landing counted as a user scroll)
- [x] Line breaks never reaching the terminal on slash-command lines
- [x] A trailing line break freezing the field sync entirely
- [x] `CLAUDE.md` written (audited via the claude-md-improver skill: project scored 0/100 — absent)
- [x] README corrected: line-break behaviour, scrollback description, Node version, launchd label
- [x] Committed and pushed to `origin/main`

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `public/term-input.mjs` | **new** — `parseInput`, `computeEdit`, `normalizeLines`, `lineText`, `buildRowsModel` | Pure, testable core |
| `public/app.js` | imports the module; `syncFieldFromTerminal`/`syncSet`/`diffAndSend` rewritten; scroll handling reworked; `APP_VERSION` v39→v42 | Wiring + scroll fixes |
| `public/sw.js` | `CACHE` v14→v17; `public/term-input.mjs` added to the `SHELL` list | Ship the new module |
| `server.mjs` | `.mjs` MIME entry; corrected a stale comment about scrollback not being live-polled | Modules are rejected without the MIME type |
| `README.md` | input/scroll descriptions, Node 22+ for tests, plist-label guidance, release ritual, Tests section | Was wrong in four places |
| `CLAUDE.md` | **new** | No project context existed |
| `scripts/*` | 4 test scripts + `scripts/lib/cdp.mjs` + `dump-grid.mjs` | Regression net |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Extract parsing into a pure module | Keep it inline in `app.js`; add jsdom tests | Only a pure module can be driven from Node against a real terminal, which is the only place these bugs appear |
| Test against a live cmux surface, no fixtures | Captured grid fixtures | Fixtures freeze one Claude Code version; the bugs are about *its* rendering |
| Newline = `shift+enter` in the composer, backslash+CR in a shell | Always backslash+CR (previous behaviour); always `shift+enter` | Measured: backslash+CR is ~50% unreliable right after a slash command (lands as a literal `\`, or wipes the composer); `shift+enter` was 4/4 clean. But a shell leaks `;2;13~` when sent `shift+enter`, so it must be per-pane |
| Default to the shell form when the pane kind is unknown | Default to composer | Wrong-in-composer is merely imperfect; wrong-in-shell sprays an escape sequence into the command line |
| Identify our own scrolls by exact position, not a time window | Keep the 600 ms window | The window was refreshed by every 150 ms repaint, so it was permanently open and silently swallowed every user scroll while output flowed |
| Defer repaints while a touch gesture/momentum runs | Repaint always | Replacing rows mid-flick makes the browser discard the restored scroll position, which is what threw the view to an arbitrary place |
| Keep two-way sync (terminal is the source of truth) rather than persisting the draft locally | `sessionStorage` per surface | Two-way binding is the product feature; local persistence would fight it |
| Commit straight to `main`, no branch | Feature branch + PR | **This working tree is the deployment** — launchd runs the server from this directory, so a side branch means the live app reverts when the branch is left. History is linear solo commits on main |

## Pending Work

### Immediate Next Steps

1. **Ask the user to reopen the PWA and confirm v42 on the phone** — specifically the three
   scroll symptoms and typing a multi-line message. Settings shows the running version.
2. **If "scrolling up jumps to the top" still occurs on the device**, instrument the real phone
   rather than inferring: the headless harness reproduces "thrown back to the bottom" but not
   literally "jumped to the top", because headless momentum is not iOS momentum. Add temporary
   telemetry to `screen.onscroll` and read it from the Mac.
3. **Decide the launchd label mismatch**: the installed agent is `com.dmytro.cmux-mirroring`,
   while `cmux-mirroring.plist.example` and the README's setup step use `com.cmux-mirroring`.
   Either rename the installed agent or change the example. README now says "use your plist's
   Label", which papers over it.

### Blockers/Open Questions

- [ ] Device confirmation is the only thing gating "these bugs are closed". Nothing is blocking
      further work.
- [ ] Open question: should the shell-prompt parser read more than the cursor row? Today a
      multi-line shell continuation only mirrors the last row into the field. Not reported as a
      problem, not attempted.

### Deferred Items

- **The bottom gap in the installed PWA** — long-standing, explicitly parked by the user in the
  previous session. Untouched here.
- **`docs/DESIGN.md` still calls the project "cmux-push v1"** — cosmetic staleness, noted in
  `CLAUDE.md`, not worth a rewrite unless the design doc is being revisited anyway.
- **Splitting `f79a091` into smaller commits** — the changes are interleaved inside `app.js`
  and `term-input.mjs`; splitting was judged error-prone for no benefit in a solo repo.

## Context for Resuming Agent

### Important Context

**The field is reconstructed from pixels.** There is no API that returns "what is typed in the
terminal's input line". `parseInput` finds the Claude composer by its `❯` at **column 0**
(a menu's selection marker is the same glyph but indented — that distinction is the whole fix
for the `/model` bug), bounds the block with the full-width `───` rules, and rebuilds the text
row by row. This is lossy in ways that cannot be fixed, only tolerated:

- A typed trailing space is indistinguishable from an erased cell. Hence `normalizeLines`:
  if field and terminal agree ignoring trailing whitespace **per line**, the *field* wins.
- The composer word-wraps at `columns - 2`. Distinguishing a wrap from a typed newline uses
  three cases: filled to the edge → mid-word break, join with nothing; the next word would not
  have fit → word wrap, join with the space the wrap swallowed; otherwise → a real line break.
- When a dialog owns the keyboard, `parseInput` returns `{kind: 'busy'}` and the caller must
  leave the field completely alone. Returning text there is how junk got into the field.

**Two comments in the code were wrong before this session, and both had been load-bearing.**
`computeEdit` claimed forwarding a newline on a slash line "makes Claude execute the command"
(it does not), and `server.mjs` claimed scrollback "is never live-polled" (it is). If a comment
explains why something is disabled, verify it against a live terminal before trusting it.

**Scroll rule of thumb:** the pane repaints every 150 ms, so anything that writes `scrollTop` or
`scrollLeft` on repaint fights the user. `setScrollTop()` records what it wrote in
`autoScrollTop`; the scroll handler ignores exactly that position and nothing else.

### Assumptions Made

- The phone is an iPhone in an installed PWA; headless Chromium approximates but does not equal
  iOS momentum scrolling. Scroll conclusions are therefore "mechanism fixed and verified in a
  browser", not "verified on the device".
- The user's Claude Code renders the composer without a box border (verified today). If a future
  version boxes it, `parseInput`'s column-0 `❯` anchor and the `───` rule bounds both need
  revisiting — `dump-grid.mjs` will show it immediately.
- cmux's `surface.send_key` supports `shift+enter` and encodes it so Claude Code understands it
  (verified today, 4/4).

### Potential Gotchas

- **Never write literal ESC/DEL bytes into source.** Use `\u001B` / `\u007F`. Literal control
  characters are invisible, and they break exact-string editing tools — this bit three times
  today, including once while writing the warning about it into `CLAUDE.md`.
- **The tests type into a live session and never submit, but they do leave traces.** The
  composer suite runs `/model` and escapes out, which leaves a `❯ /model` → "Kept model as …"
  entry in that session's scrollback. Point them at a session you do not care about. The one
  used today is the idle "✳ Russian conversation" workspace.
- **Surface ids change** whenever tabs are recreated; workspace ids are stabler. Always look
  them up: `curl -s localhost:4488/api/state`.
- **`npm start` will fail or double-bind**: the launchd agent already holds port 4488. Restart
  the agent instead (`launchctl kickstart -k gui/$(id -u)/com.dmytro.cmux-mirroring`).
- **Client changes do not ship** unless `APP_VERSION` (`public/app.js`) *and* `CACHE`
  (`public/sw.js`) are both bumped. A new file under `public/` additionally needs adding to
  `SHELL` in `sw.js` and a MIME entry in `server.mjs`.
- **`scripts/test-scroll.mjs` can be flaky if the target session is churning** — it measures a
  pane whose height depends on content. The idle session used today gives stable numbers.
- Browser test scripts need **Node 22+** (`fs.globSync`, global `WebSocket`). The server itself
  is fine on 20. Machine currently runs v24.13.1 via nvm.

## Environment State

### Tools/Services Used

- **cmux** — control socket at `~/.local/state/cmux/cmux.sock`; app is a login item.
- **Tailscale Serve** — persistent config proxying the tailnet HTTPS name to `127.0.0.1:4488`;
  survives restarts, Tailscale is a login item.
- **launchd agent `com.dmytro.cmux-mirroring`** — `RunAtLoad` + `KeepAlive`, so it restarts on
  crash and at login (it is an *agent*, so a reboot needs a login before the phone can connect).
  Node path is pinned to `~/.nvm/versions/node/v24.13.1/bin/node`; removing that nvm version
  breaks the agent.
- **Playwright's headless Chromium** in `~/Library/Caches/ms-playwright/` — used by the browser
  tests via CDP. Note the Playwright **MCP** browser profile can be held by another Claude
  session; `scripts/lib/cdp.mjs` deliberately launches its own throwaway profile instead.

### Active Processes

- The mirroring server, running under launchd, restarted at the end of this session so the
  deployment matches `f79a091`. `curl -s localhost:4488/api/status` confirms (`cmuxOnline`).
- `data/stderr.log` holds ~15 transient `cmux …: timeout` lines from earlier days; these are
  ridden out, not a restart loop.

### Environment Variables

Names only (all optional; see README for defaults):
`PORT`, `HOST`, `VAPID_SUBJECT`, `CMUX_BIN`, `CMUX_SOCKET_PATH`, `CMUX_SOCKET_PASSWORD`.
The socket password is read from a file under `~/.local/state/cmux/` and must never be copied
into a document or a log.

## Related Resources

- [CLAUDE.md](../../CLAUDE.md) — commands, layout, gotchas (written this session)
- [README.md](../../README.md) — setup, updating, tests
- [docs/DESIGN.md](../../docs/DESIGN.md) — original design, written under the old name "cmux-push"
- [Previous handoff](./2026-09-12-113319-cmux-mirroring-pwa.md) — product, push pipeline, history
- GitHub: `git@github.com:DimaBinskyi/cmux_mirroring.git` (branch `main`, in sync)

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
