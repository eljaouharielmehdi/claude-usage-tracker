#!/usr/bin/env python3
"""
Claude Code statusLine script.

Renders the terminal status line AND, as a side effect, writes the
session's rate_limits / prompt_cache data (from the JSON Claude Code
passes on stdin — see https://code.claude.com/docs/en/statusline) to a
local file the claude-usage-tracker dashboard reads. This is the only
sanctioned way to get real quota data: there is no API for it.

Never raises — a broken status line would break every session, so any
error here falls back to printing something minimal.
"""

import json
import os
import sys
import tempfile

STATE_DIR = os.path.expanduser("~/.claude/usage_state")
STATE_PATH = os.path.join(STATE_DIR, "usage_state.json")


def write_state(data):
    os.makedirs(STATE_DIR, exist_ok=True)
    rate_limits = data.get("rate_limits") or {}
    prompt_cache = data.get("prompt_cache") or {}
    cost = data.get("cost") or {}
    state = {
        "updated_at": data.get("_written_at"),
        "session_id": data.get("session_id"),
        "model": (data.get("model") or {}).get("display_name"),
        "rate_limits": {
            "five_hour": rate_limits.get("five_hour"),
            "seven_day": rate_limits.get("seven_day"),
            "spend_limit": rate_limits.get("spend_limit"),
        },
        "prompt_cache": {
            "warm": prompt_cache.get("warm"),
            "hit_ratio": prompt_cache.get("hit_ratio"),
            "expires_at": prompt_cache.get("expires_at"),
            "last_miss_cause": prompt_cache.get("last_miss_cause"),
        },
        "session_cost_usd": cost.get("total_cost_usd"),
    }
    # Atomic write so the dashboard (reading concurrently) never sees a
    # half-written file.
    fd, tmp_path = tempfile.mkstemp(dir=STATE_DIR, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.replace(tmp_path, STATE_PATH)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def render(data):
    import time
    model = (data.get("model") or {}).get("display_name", "?")
    cwd = (data.get("workspace") or {}).get("current_dir") or data.get("cwd") or ""
    short_dir = os.path.basename(cwd.rstrip("/")) or cwd
    cost = (data.get("cost") or {}).get("total_cost_usd")
    cost_str = f"${cost:.2f}" if isinstance(cost, (int, float)) else "$0.00"
    ctx = data.get("context_window") or {}
    used_pct = ctx.get("used_percentage")
    ctx_str = f"{used_pct}% ctx" if isinstance(used_pct, (int, float)) else ""

    rate_limits = data.get("rate_limits") or {}
    five_h = (rate_limits.get("five_hour") or {}).get("used_percentage")
    parts = [model, short_dir, cost_str]
    if ctx_str:
        parts.append(ctx_str)
    if isinstance(five_h, (int, float)):
        parts.append(f"{five_h:.0f}% 5h")
    return " | ".join(parts)


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, OSError):
        data = {}

    try:
        import time
        data["_written_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_state(data)
    except Exception:
        pass  # writing dashboard state must never break the status line itself

    try:
        print(render(data))
    except Exception:
        print("claude")


if __name__ == "__main__":
    main()
