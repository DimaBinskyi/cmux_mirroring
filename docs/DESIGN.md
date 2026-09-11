# cmux-push v1 — cmux on the phone, mobile friendly

Date: 2026-09-10. Approved direction: "a copy of cmux on phone but mobile friendly" —
mirror cmux's own information architecture, adapted to a phone. PWA (home-screen web
app) because a free Apple account can't ship a native app with push (no APNs
entitlement, 7-day signing expiry).

## Architecture

```
iPhone PWA (installed from Safari)
 ├─ HTTPS + SSE ── Tailscale ──▶ cmux-push server (Mac, 127.0.0.1:4488, launchd)
 │                                ├─ cmux socket:  rpc (workspace.list, system.tree,
 │                                │   surface.read_text, surface.send_text/send_key,
 │                                │   workspace.prompt_submit, feed.list,
 │                                │   feed.permission/question/exit_plan.reply)
 │                                ├─ cmux events --reconnect  (live status, hook events)
 │                                └─ ~/.claude/projects/*/<session>.jsonl  (chat transcripts)
 └─ Web Push ◀── Apple ◀───────── same server (arrives even off Tailscale)
```

- `tailscale serve --bg 4488` terminates HTTPS at
  `https://macbook-air-dmytro-work.tail4f72b4.ts.net`; server binds 127.0.0.1 only.
- Live updates: SSE (`/api/stream`), not WebSocket — one direction is enough, and
  EventSource reconnects for free after iOS suspends the app. Actions are plain POSTs.
- Workspace ↔ Claude session mapping comes from cmux `agent.hook.*` events, which carry
  `workspace_id`, `surface_id`, and payload `session_id` + `cwd`. No heuristics.

## Screens (mirroring cmux)

1. **Home = sidebar.** Workspace list in sidebar order: status glyph, title, one-line
   "doing now" (latest conversation message / pending item), age. Groups render as
   collapsible sections whose header rolls up the WORST member status (a collapsed
   group can never hide a blocked agent). Bottom tabs: Sessions | Feed (push history).
2. **Session = Chat tab (default) + Terminal tab.** Surface chips when a workspace has
   multiple panes/surfaces; Chat pins to the agent surface, Terminal follows the
   selected chip.
   - Chat: transcript rendered as chat (markdown-lite, collapsed tool rows), pending
     permission/question as a card — buttons use the semantic `feed.*.reply` RPCs with
     a raw-keys fallback row ([1][2][3][esc]). Composer submits via
     `workspace.prompt_submit` (fallback `surface.send_text` + Enter) with
     autocomplete: slash commands + quick replies, filtered as you type.
   - Terminal: `surface.read_text` polled ~2s while visible; "load scrollback" pulls
     `read-screen --scrollback`; client-side search; key toolbar
     (esc ⇥ ↑ ↓ ^C digits ⏎) + raw text input.
3. **Push deep links**: notification tap opens `/#/ws/<workspace_id>`.

## Status model

attention (permission/question/needs input) > working (recent hook activity) >
done (Stop event / "finished" notification) > idle. Derived from cmux events +
`feed.list` pending items + notifications; full `workspace.list`/`tree` refresh is
debounced on events with a 30s polling fallback.

## Non-goals for v1 (explicit "later" bucket)

Diff viewer, todos, creating workspaces/tasks from phone, browser surface mirroring
(`browser.stream.v1` / `mobile.*` RPCs exist for this), transcript search, multi-Mac.

## Failure handling

- Server down → installed PWA + push subscription survive; UI shows cached shell with
  "Mac unreachable". Pushes require the Mac anyway (they originate there).
- SSE drops (screen lock) → EventSource auto-reconnects; state re-snapshots on focus.
- `cmux events` process dies → supervisor restarts it with the saved cursor
  (`--cursor-file`), so no gaps.
- Unknown RPC parameter shapes (feed replies) → defensive: on error the UI falls back
  to the raw-keys row; failures logged to data/stderr.log.

## Push (unchanged from the already-built base)

Web Push + VAPID, subscriptions in data/, urgency mapping in the notify-filter hook
(children silent, 🚨/⚠️/✅/🤖). Telegram stays in parallel until the PWA is proven.
