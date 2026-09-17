#!/usr/bin/env python3
"""
Pulls Claude Code session logs from remote devices into
claude-usage-tracker/remote_projects/<device>/, via rsync over SSH using a
dedicated read-only-in-practice key (~/.ssh/id_ed25519_usage_pull).

Run from cron every few minutes on SRV. Devices are read from devices.json
next to this script. A device that's unreachable (laptop asleep, off the
VPN, etc.) is skipped with a warning, not treated as fatal — the next run
picks it up again.
"""

import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DEVICES_PATH = SCRIPT_DIR / "devices.json"
DEST_ROOT = SCRIPT_DIR.parent / "remote_projects"
SSH_KEY = Path.home() / ".ssh" / "id_ed25519_usage_pull"


def load_devices():
    if not DEVICES_PATH.exists():
        print(f"{DEVICES_PATH} not found — copy devices.json.example to devices.json and fill it in.", file=sys.stderr)
        return []
    with open(DEVICES_PATH) as f:
        return json.load(f)["devices"]


def pull(device):
    name = device["name"]
    host = device["host"]
    user = device["user"]
    port = device.get("port", 22)
    remote_path = device["remote_path"].rstrip("/") + "/"
    dest = DEST_ROOT / name
    dest.mkdir(parents=True, exist_ok=True)

    ssh_cmd = f"ssh -i {SSH_KEY} -p {port} -o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
    result = subprocess.run(
        ["rsync", "-az", "--delete", "-e", ssh_cmd, f"{user}@{host}:{remote_path}", f"{dest}/"],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        print(f"[{name}] rsync failed (exit {result.returncode}): {result.stderr.strip()}", file=sys.stderr)
        return False
    print(f"[{name}] synced ok")
    return True


def main():
    if host_placeholder_present():
        print("devices.json still has REPLACE_ME placeholders — edit it first.", file=sys.stderr)
        return
    ok = True
    for device in load_devices():
        if device.get("host") == "REPLACE_ME":
            print(f"[{device['name']}] skipped — devices.json not configured for this device", file=sys.stderr)
            continue
        ok = pull(device) and ok
    sys.exit(0 if ok else 1)


def host_placeholder_present():
    devices = load_devices()
    return devices and all(d.get("host") == "REPLACE_ME" for d in devices)


if __name__ == "__main__":
    main()
