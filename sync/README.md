# Multi-device sync (SSH/rsync pull)

Every device can keep running its own standalone dashboard (just
`git clone` + `docker compose up -d --build` there, reading its own
`~/.claude/projects`). This directory is what additionally lets **this**
dashboard (on SRV) pull other devices' logs in and show a combined view,
broken down by device in the "By device" panel and the sessions table.

## How it works

- `pull_devices.py` reads `devices.json`, and for each device rsyncs
  `~/.claude/projects/` from that device into
  `claude-usage-tracker/remote_projects/<device-name>/` over SSH, using a
  dedicated key (`~/.ssh/id_ed25519_usage_pull` on SRV) that has no purpose
  beyond this — it's not SRV's general SSH key.
- `docker-compose.yml` mounts `remote_projects/<name>` read-only at
  `/data/devices/<name>` inside the container, alongside SRV's own logs at
  `/data/devices/srv`. `server.py` treats each top-level directory under
  `/data/devices` as a device name — no path-decoding, it's used verbatim.
- A device that's offline when the pull runs is skipped with a warning in
  the log, not treated as an error — its last-synced data just stays as-is
  until the next successful pull.

## One-time setup per new device

1. **Generate the key once** (already done on SRV — don't repeat):
   `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_usage_pull -N ""`

2. **On the new device**: add SRV's public key
   (`cat ~/.ssh/id_ed25519_usage_pull.pub` on SRV) to that device's
   `~/.ssh/authorized_keys`, and make sure an SSH server is running there
   and reachable from SRV (same LAN, or over the homelab VPN).

3. **Edit `devices.json`** on SRV: add `{"name": ..., "host": ..., "user": ...}`.
   `host` can be an IP, hostname, or VPN address — anything SRV can reach.

4. **Add the compose mount**: a line in `docker-compose.yml`
   `- ./remote_projects/<name>:/data/devices/<name>:ro`, then
   `docker compose up -d --build`.

5. **Test the pull once by hand**: `python3 sync/pull_devices.py`
   — it prints `[<name>] synced ok` or a specific rsync error.

6. **Add the cron job** (once; covers all configured devices):
   ```
   */5 * * * * cd /home/elmehdi/Desktop/selfsetup/claude-usage-tracker && python3 sync/pull_devices.py >> /tmp/usage-tracker-sync.log 2>&1
   ```

## Security notes

- The dedicated key is scoped to nothing but this: it's not the same key
  used for the GitHub push access documented in the main README. If a
  device is ever decommissioned, remove its line from `authorized_keys`
  there and delete its entry from `devices.json` + the compose mount.
- This is a **pull**, not a push: no device other than SRV ever needs
  network access to SRV for this feature. Nothing listens for incoming
  connections beyond the SSH server already running on each device.
- `devices.json` is not secret (hostnames and usernames only, no
  passwords — auth is entirely key-based), but it's still excluded from
  git via `.gitignore` since it's specific to this deployment.
