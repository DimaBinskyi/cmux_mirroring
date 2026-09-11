# cmux mirroring

A phone-friendly mirror of [cmux](https://cmux.io) as an installable PWA — no Apple
Developer account, no App Store, no weekly re-signing. Built for iPhone (iOS 16.4+),
works in any browser.

## What it does

- **Home = the cmux sidebar**: every workspace with live status (🚨 needs input /
  ⚙️ working / ✅ done / 💤 idle), current activity, and workspace groups with
  worst-status roll-up.
- **Terminal view (default)**: the real pane rendered with full colors and styling
  via cmux's render grid — scrollback, search, text selection, a key toolbar
  (esc ⇥ ⇧⇥ arrows ^C ^D ^Z ^L ^R ⏎), and full plain-text history on demand.
- **Two-way bound input**: the input field mirrors the terminal's input line in both
  directions — type on the phone and it lands in the pty; type on the Mac (or recall
  history with ↑) and the field updates itself.
- **Chat view**: the Claude Code conversation rendered as chat — markdown, collapsed
  tool calls, permission prompts as Allow/Deny cards, composer with slash-command
  suggestions.
- **Web Push notifications**: urgency-mapped pushes that deep-link into the pinging
  session; they arrive even when the phone is off the tailnet. Category toggles in
  Settings.
- **Settings**: server address (host:port) and notification preferences.

## Architecture

```
iPhone PWA (installed from Safari)
 ├─ HTTPS + SSE ── Tailscale ──▶ Node server (Mac, 127.0.0.1:4488, launchd)
 │                                ├─ cmux socket: rpc / events / read-screen / send
 │                                └─ ~/.claude/projects/*.jsonl (chat transcripts)
 └─ Web Push ◀── Apple ◀───────── same server
```

No build step, no framework, one dependency (`web-push`). See `docs/DESIGN.md`.

## Setup

1. `npm install`
2. `node scripts/gen-icons.mjs` (once, generates the PWA icons)
3. Run it: `node server.mjs` — or install the launchd agent so it survives reboots
   (see `com.dmytro.cmux-mirroring.plist` for a template; adjust paths).
4. HTTPS on your tailnet: `tailscale serve --bg 4488`
   (requires MagicDNS + HTTPS certificates enabled for the tailnet).
5. On the iPhone (Tailscale connected): open `https://<mac-name>.<tailnet>.ts.net`
   in Safari → Share → **Add to Home Screen** → open from the icon →
   Settings → **Enable notifications**.

To have cmux notifications pushed to the phone, POST them to the server from a
notification hook:

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
