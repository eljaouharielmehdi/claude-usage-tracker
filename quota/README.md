# Quota tracking (real rate-limit data)

The dashboard's token/cost numbers come from local session logs, which have
no concept of your actual Anthropic account quota — there's no local file
and no public API for "how much of my 5-hour/7-day limit have I used."

Claude Code itself knows this, though: it's the same data shown by `/usage`
in the terminal. The **only sanctioned way to get it** is the
[statusLine hook](https://code.claude.com/docs/en/statusline) — Claude Code
passes a JSON blob on stdin to your statusline command, including a
`rate_limits` object (`five_hour`, `seven_day`, `spend_limit`, each with
`used_percentage` and `resets_at`) and `prompt_cache` health fields, for
Pro/Max subscribers after the first API response in a session.

`statusline.py` in this directory is that hook: it renders a normal status
line (model, directory, cost, context %, 5h usage) **and**, as a side
effect, atomically writes the quota/cache fields to
`~/.claude/usage_state/usage_state.json`. The dashboard's `docker-compose.yml`
mounts that directory read-only, and `server.py` reads it into
`/api/stats.quota`.

## Setup (already done on this machine)

`~/.claude/settings.json` has:

```json
"statusLine": {
  "type": "command",
  "command": "python3 /home/elmehdi/Desktop/selfsetup/claude-usage-tracker/quota/statusline.py"
}
```

This replaces Claude Code's default status line footer with the one this
script prints, on every project (it's in the **global** settings file).

## On another device

1. Copy or `git clone` this repo there.
2. Add the same `statusLine` entry (with the right path) to that device's
   `~/.claude/settings.json`.
3. Restart Claude Code (or open `/hooks` once) so it picks up the new
   setting — settings.json changes aren't watched retroactively for a
   directory the CLI wasn't already watching at startup.
4. `docker compose up -d --build` — the volume mount is already in
   `docker-compose.yml`.

## Notes

- The quota panel only fills in once you've sent at least one message in a
  Claude Code session after this is set up — `rate_limits` isn't present
  before the first API response.
- If you don't use Claude Code interactively for a while, the panel shows
  the last known numbers with a "no active session right now" note rather
  than hiding them — they're just stale, not wrong.
- This is unrelated to the "Network traffic to Anthropic" panel (`netmon/`),
  which measures actual bytes on the wire, not quota.
