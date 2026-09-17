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
  an hourly token chart for the last 24h.
- Session logs are mounted **read-only**; the container never writes to them.

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
