# Claude Code Usage Tracker

A small self-hosted dashboard that reads your local Claude Code CLI session
logs (`~/.claude/projects/**/*.jsonl`) and shows live token usage and
estimated cost, per session, per project, and per model. Nothing leaves the
container — it only reads files already on this machine.

## Run it

```bash
cd claude-usage-tracker
docker compose up -d --build
```

Open http://localhost:61209 (or `http://<this-machine-ip>:61209` from
another device on the LAN).

## Pricing

Token costs are an **estimate**. On first run the app seeds
`config/pricing.json` with rough defaults — edit that file with your actual
per-token rates (USD per 1,000,000 tokens) and refresh the page; no rebuild
needed, it's read live on each poll.

## How it works

- The dashboard polls `/api/stats` every 2 seconds.
- The backend parses every `*.jsonl` file under the mounted
  `~/.claude/projects` directory, pulling `message.usage` and `message.model`
  out of assistant turns (input/output/cache-write/cache-read tokens).
- Stats are aggregated globally, by model, by project, and by session, plus
  token and network charts with a selectable window: 1h (1-min bars), 24h
  (5-min), 7d (hourly), 30d (6-hour) or 1y (daily). Each chart remembers
  its own choice in the browser. `/api/stats?range=7d&net_range=1h` is the
  underlying call.
- Parsed results are cached per file keyed on `(mtime, size)`, so a poll
  only re-reads the session log that is actually being written to — the
  cost of a poll stays flat as old logs pile up.
- "Saved by caching" is what your cache-read tokens would have cost at the
  full input rate minus what they actually cost — i.e. how much prompt
  caching is shaving off the bill, using the same `pricing.json` rates.
- Session logs are mounted **read-only**; the container never writes to them.

## Multi-device (optional)

Each device can run this dashboard standalone against its own
`~/.claude/projects` — that's the default setup above and needs nothing
extra. To additionally see everyone's usage combined in one dashboard
(broken down by device in the "By device" panel and the sessions table),
one machine can pull other devices' logs in over SSH/rsync — see
**`sync/README.md`**. This is opt-in and pull-only: no device needs to
expose anything beyond the SSH server it likely already has.

## Network traffic to Anthropic (optional, host-level)

The dashboard also shows a "Network traffic to Anthropic" panel — real
bytes sent/received, not token counts — if a small host-level collector
service is set up. This needs root and touches iptables, so it's kept
separate from the Docker app: see **`netmon/README.md`** for what it does
and how to install it. Without it, that panel just shows "no data yet".

This is genuinely a different, complementary metric from the token counts
above (device-wide network bytes including protocol overhead, vs. exact
per-message Claude Code token counts) — see `netmon/README.md` for the
full comparison.

## Notes

- Token/cost tracking here is Claude Code CLI usage on this machine, not
  your Anthropic account/API usage as a whole — it only sees what's in
  `~/.claude/projects`.
- Project names are decoded from Claude Code's directory-naming scheme
  (path separators become `-`) — best-effort, may be slightly off for paths
  that contain literal hyphens.
- Port 61209 was picked to sit next to the existing Glances container on
  61208 — change the `ports:` mapping in `docker-compose.yml` if it
  collides with something else.
- There is no authentication. The page shows project paths and spend, so
  if you don't need LAN access, bind it to localhost only:
  `"127.0.0.1:61209:8687"` in `docker-compose.yml`.
