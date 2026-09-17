"""
Anthropic network-traffic collector.

Keeps the `anthropic_v4` / `anthropic_v6` ipsets populated with the current
IPs behind a fixed list of Anthropic hostnames, then periodically reads the
cumulative byte counters from the ANTHROPIC_OUT/IN (+ v6) iptables chains
set up by setup_iptables.sh and appends running totals to a JSONL log the
dashboard container reads.

Runs as root (needed for iptables/ipset). Intended to run continuously as a
systemd service — see anthropic-netmon.service.

Scope note: this counts ALL traffic on this device to/from Anthropic's
resolved IPs — not just Claude Code CLI traffic. See README for why that's
an inherent limit of network-level accounting (vs. the exact per-message
token counts read from ~/.claude/projects).
"""

import json
import logging
import socket
import subprocess
import time
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("anthropic-netmon")

HOSTNAMES = ["api.anthropic.com", "console.anthropic.com", "claude.ai"]
DNS_REFRESH_SECONDS = 300
SAMPLE_SECONDS = 60
IPSET_TIMEOUT = 3600

BASE_DIR = Path(__file__).parent
STATE_PATH = BASE_DIR / "data" / "state.json"
LOG_PATH = BASE_DIR / "data" / "anthropic_traffic.jsonl"

CHAINS = {
    "sent": [("iptables", "ANTHROPIC_OUT"), ("ip6tables", "ANTHROPIC_OUT6")],
    "received": [("iptables", "ANTHROPIC_IN"), ("ip6tables", "ANTHROPIC_IN6")],
}


def resolve_ips():
    v4, v6 = set(), set()
    for host in HOSTNAMES:
        try:
            for family, _, _, _, sockaddr in socket.getaddrinfo(host, None):
                ip = sockaddr[0]
                if family == socket.AF_INET:
                    v4.add(ip)
                elif family == socket.AF_INET6:
                    v6.add(ip)
        except socket.gaierror as exc:
            logger.warning("DNS resolution failed for %s: %s", host, exc)
    return v4, v6


def refresh_ipsets():
    v4, v6 = resolve_ips()
    for ip in v4:
        subprocess.run(["ipset", "add", "anthropic_v4", ip, "timeout", str(IPSET_TIMEOUT), "-exist"], check=False)
    for ip in v6:
        subprocess.run(["ipset", "add", "anthropic_v6", ip, "timeout", str(IPSET_TIMEOUT), "-exist"], check=False)
    logger.info("Refreshed ipsets: %d IPv4, %d IPv6", len(v4), len(v6))


def read_chain_bytes(tool, chain):
    """Sum the byte counter across all rules in a chain (we only ever add one,
    but summing is harmless if that ever changes)."""
    try:
        out = subprocess.run([tool, "-nvxL", chain], capture_output=True, text=True, check=True).stdout
    except subprocess.CalledProcessError as exc:
        logger.warning("Failed to read %s chain %s: %s", tool, chain, exc)
        return 0
    total = 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            total += int(parts[1])
    return total


def read_totals():
    totals = {}
    for direction, chains in CHAINS.items():
        totals[direction] = sum(read_chain_bytes(tool, chain) for tool, chain in chains)
    return totals


def load_state():
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"cumulative_sent": 0, "cumulative_received": 0, "last_raw": {"sent": 0, "received": 0}}


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state))


def append_log(row):
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(row) + "\n")
    LOG_PATH.chmod(0o644)


def main():
    subprocess.run(["bash", str(BASE_DIR / "setup_iptables.sh")], check=True)

    state = load_state()
    last_dns_refresh = 0

    while True:
        now = time.time()
        if now - last_dns_refresh >= DNS_REFRESH_SECONDS:
            refresh_ipsets()
            last_dns_refresh = now

        raw = read_totals()
        deltas = {}
        for direction in ("sent", "received"):
            previous = state["last_raw"].get(direction, 0)
            current = raw[direction]
            # A counter can only go backwards if the chain got reset (reboot,
            # manual flush) — treat that as "start counting again from here".
            delta = current - previous if current >= previous else current
            deltas[direction] = delta
            state[f"cumulative_{direction}"] = state.get(f"cumulative_{direction}", 0) + delta
            state["last_raw"][direction] = current

        row = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bytes_sent_delta": deltas["sent"],
            "bytes_received_delta": deltas["received"],
            "bytes_sent_cumulative": state["cumulative_sent"],
            "bytes_received_cumulative": state["cumulative_received"],
        }
        append_log(row)
        save_state(state)

        time.sleep(SAMPLE_SECONDS)


if __name__ == "__main__":
    main()
