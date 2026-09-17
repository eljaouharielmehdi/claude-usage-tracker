# Anthropic network-traffic accounting

Tracks real network bytes sent/received to/from Anthropic's servers from
this device, as a companion to the token-based numbers the main dashboard
reads from `~/.claude/projects`. These are two different, complementary
metrics:

|                      | Token counts (main dashboard) | Network bytes (this) |
|----------------------|-------------------------------|-----------------------|
| Source               | `~/.claude/projects/**/*.jsonl` | iptables byte counters |
| Scope                | Claude Code CLI only          | **whole device** |
| Precision            | Exact (Anthropic's own accounting) | Approximate (see below) |
| Includes             | Just the token cost            | TLS/HTTP overhead, retries, streaming chunks — everything on the wire |

## Why this is device-wide, not CLI-specific

There's no clean way to attribute network bytes to one specific process
without much heavier instrumentation (per-process cgroup/eBPF accounting).
This setup counts *any* traffic on this machine to Anthropic's resolved
IPs — Claude Code CLI, but also a browser open to claude.ai, or Claude
Desktop, if either is ever used on this same box. If you only ever use
Claude Code CLI here, that distinction doesn't matter in practice.

## Why this is approximate, not exact

Anthropic's endpoints sit behind IPs that could in principle be shared by
other services on the same CDN/hosting. In practice this is a reasonable
approximation for a personal machine, not a certified metering tool.

## How it works

1. **`setup_iptables.sh`** (idempotent, safe to re-run) creates:
   - Two ipsets, `anthropic_v4` / `anthropic_v6`, holding the currently
     resolved IPs for `api.anthropic.com`, `console.anthropic.com`, and
     `claude.ai` (1-hour ipset entry timeout — stale IPs drop out on their
     own if no longer in use).
   - Four **counting-only** iptables/ip6tables chains (`ANTHROPIC_OUT`,
     `ANTHROPIC_IN`, `ANTHROPIC_OUT6`, `ANTHROPIC_IN6`), jumped to from the
     very top of `OUTPUT`/`INPUT`. Each just matches the relevant ipset and
     `RETURN`s — it never `ACCEPT`s or `DROP`s anything, so it cannot change
     what traffic is allowed. Existing `ufw` rules are completely
     unaffected. The rule is created once and never flushed, so its byte
     counter accumulates indefinitely — only ipset *membership* is updated
     on refresh.

2. **`collector.py`** runs continuously (as the `anthropic-netmon` systemd
   service, root — needed for iptables/ipset):
   - Every 5 minutes, re-resolves the hostnames and refreshes ipset
     membership.
   - Every 60 seconds, reads the four chains' cumulative byte counters,
     computes the delta since the last read (handling counter resets, e.g.
     after a reboot), and appends one row to
     `data/anthropic_traffic.jsonl`:
     ```json
     {"timestamp": "...", "bytes_sent_delta": 1234, "bytes_received_delta": 567,
      "bytes_sent_cumulative": 999999, "bytes_received_cumulative": 88888}
     ```

3. The dashboard container mounts `netmon/data/` **read-only** and the
   Flask app reads that JSONL file to build the "Network traffic to
   Anthropic" panel (24h chart + all-time totals).

## Managing the service

```bash
sudo systemctl status anthropic-netmon
sudo systemctl restart anthropic-netmon
journalctl -u anthropic-netmon -f
```

## What got changed on this host to set this up

- Installed packages: `conntrack` (tried first, see below), `ipset`
- Enabled `net.netfilter.nf_conntrack_acct=1` via
  `/etc/sysctl.d/99-conntrack-acct.conf` (harmless — just turns on
  extended connection-tracking accounting; not actually used by the final
  design below, left enabled since other tools may want it)
- Added iptables/ip6tables chains + jump rules (see above) — **not**
  managed by `ufw`, so a `ufw` reload/reset won't remove them, but they
  also won't survive a full iptables flush; `collector.py` re-runs
  `setup_iptables.sh` on every start (including after a reboot, via the
  systemd service), so they self-heal
- Added `anthropic-netmon.service`, enabled at boot

## A dead end worth knowing about, if you ever revisit this

The first approach tried was `conntrack -L` (reading the kernel's
connection-tracking table directly, no firewall rule changes needed at
all). On this host (Ubuntu, kernel 6.8, conntrack-tools 1.4.8) the netlink
dump genuinely returns connection data — confirmed with `strace` — but the
`conntrack` CLI itself prints "0 flow entries" regardless, a bug in that
particular tool/kernel combination rather than anything about the traffic
itself. Switched to the iptables/ipset approach instead, which is simpler,
better-tested, and doesn't depend on that code path at all.
