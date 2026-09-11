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
  deltas, 150ms adaptive polling); scrolling up swaps to a frozen styled snapshot
  with scrollback — nothing moves while you read, select, or copy. 🔍 search
  across scrollback with ▲/▼ hit navigation; "▲ All" loads up to 10k lines of
  plain-text history.
- **Tabs, not splits**: every cmux tab *and* split shows as a chip. Chips update
  live when tabs are created/closed on the Mac, each has its own ✕ (with
  confirmation), and ＋ opens a new tab and switches to it.
- **Two-way bound input**: a multi-line textarea mirrors the terminal's input line
  in both directions. Typing echoes locally and streams to the pty (batched,
  cursor-aware — mid-line edits, word-delete, selection replace, paste all land
  exactly where the terminal cursor is). ↑ recalls history into both. Enter adds
  a newline (Meta+Enter in the Claude composer); only the ⏎ button submits.
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

## Setup

1. `npm install`
2. `node scripts/gen-icons.mjs` (once, generates the PWA icons)
3. Run it: `node server.mjs` — or install the launchd agent so it survives reboots
   (see `com.dmytro.cmux-mirroring.plist` for a template; adjust paths).
4. HTTPS on your tailnet: enable Serve/HTTPS for the tailnet once (Tailscale admin
   console), then `tailscale serve --bg 4488`.

## Install on the iPhone

Two ways (Tailscale connected on the phone):

- **Full install with push (recommended)** — needs the HTTPS step above:
  open `https://<mac-name>.<tailnet>.ts.net` in Safari → Share →
  **Add to Home Screen** → open from the icon → Settings →
  **Enable notifications** → **Send test push**. iOS only grants Web Push to
  home-screen apps installed from an HTTPS origin.
- **Quick look without push**: open `http://<mac-tailscale-ip>:4488` in Safari.
  The full live UI works (terminal, chat, tabs); push and offline caching do
  not — iOS requires a secure origin for service workers.

To feed cmux notifications to the phone, POST them from a notification hook:

```bash
curl -m 5 -H 'Content-Type: application/json' \
  -d '{"title":"🚨 Claude needs input","body":"...","url":"/#/ws/<workspace-uuid>"}' \
  http://127.0.0.1:4488/api/notify
```

## Notes

- The server binds to 127.0.0.1 only; Tailscale Serve terminates HTTPS and proxies
  to it, so exposure is tailnet-only.
- VAPID keys are generated on first start into `data/` (gitignored), along with
  push subscriptions, notification history, and preferences.
- Colored scrollback is limited to what cmux's render grid retains (~240 rows);
  the "▲ All" view loads up to 10k lines of plain-text history.
