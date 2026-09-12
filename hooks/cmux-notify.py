#!/usr/bin/env python3
"""cmux notification hook -> cmux mirroring Web Push.

cmux runs this for every notification it raises: the notification policy arrives
as JSON on stdin, and whatever is printed on stdout is the policy cmux then
applies. This hook does not change the policy — the Mac keeps its own banners —
it only forwards the notification to the local server, which fans it out to
every subscribed phone. Register it in ~/.config/cmux/cmux.json; the README's
"Notifications from cmux" step has the exact block.

The emoji in the title is the contract with the server: 🚨 / ⚠️ / ✅ map onto the
attention / error / done categories that can be muted individually in the app's
Settings, and anything else counts as silent background chatter.

Pushes are skipped while the user is demonstrably sitting at the Mac. Focus
alone is not enough — a locked screen or an abandoned desk keeps cmux
"focused", which would swallow exactly the pushes remote access exists for — so
HIDIdleTime breaks the tie.

Fails open: on any error the policy is echoed back unchanged, so a push problem
never costs a notification on the Mac.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

ENDPOINT = os.environ.get("CMUX_MIRRORING_URL", "http://127.0.0.1:4488") + "/api/notify"

# cmux frontmost + input this recently -> the user is watching the screen and
# already got cmux's own banner; the phone stays quiet.
IDLE_SUPPRESS_SECONDS = 30

# Ordered: first matching bucket wins, so a blocked agent outranks everything.
# (emoji, silent) — silent arrives without sound and can be muted separately.
URGENCY_MAP = [
    (("needs your input", "needs input", "permission", "waiting for",
      "approve", "question"), "\U0001f6a8", False),      # 🚨 loud
    (("error", "failed", "failure", "crash"), "⚠️", False),   # ⚠️ loud
    (("finished", "done", "complete", "completed"), "✅", False),   # ✅ normal
]
DEFAULT_URGENCY = ("\U0001f916", True)  # 🤖 silent


def user_is_at_mac(context):
    if not context.get("appFocused"):
        return False
    try:
        out = subprocess.run(
            ["/usr/sbin/ioreg", "-c", "IOHIDSystem", "-d", "4"],
            capture_output=True, text=True, timeout=3,
        ).stdout
        m = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', out)
        if m:
            return int(m.group(1)) / 1_000_000_000 < IDLE_SUPPRESS_SECONDS
    except Exception:
        pass
    # Idle state unknowable: fall back to the plain focus rule rather than
    # double-pinging someone who is actively looking at cmux.
    return True


def classify(text):
    lowered = text.lower()
    for needles, emoji, silent in URGENCY_MAP:
        if any(n in lowered for n in needles):
            return emoji, silent
    return DEFAULT_URGENCY


def push(notification):
    title = str(notification.get("title") or "cmux")
    subtitle = str(notification.get("subtitle") or "")
    body = str(notification.get("body") or notification.get("message") or "")
    emoji, silent = classify(f"{title} {subtitle} {body}")
    payload = {
        "title": f"{emoji} {title} — {subtitle}" if subtitle else f"{emoji} {title}",
        "body": body,
        "silent": silent,
    }
    workspace_id = str(notification.get("workspaceId") or "")
    if workspace_id:
        payload["url"] = f"/#/ws/{workspace_id}"
        # Coalesces repeat pings from one session, and tells the server to skip
        # the push entirely while that session is open on the phone.
        payload["tag"] = workspace_id
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    # The server is on loopback, so a short blocking call is cheaper than
    # detaching; if it is down, the refusal is immediate.
    urllib.request.urlopen(req, timeout=3).close()


def main():
    raw = sys.stdin.read()
    try:
        policy = json.loads(raw)
        try:
            if not user_is_at_mac(policy.get("context") or {}):
                push(policy.get("notification") or {})
        except Exception:
            pass  # server down or not installed yet — never break the pipeline
        sys.stdout.write(json.dumps(policy))
    except Exception:
        sys.stdout.write(raw)


if __name__ == "__main__":
    main()
