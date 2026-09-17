# Setting up the usage tracker on another device

Each device runs its own **independent** copy of this dashboard, reading
that device's own `~/.claude/projects`. There is no cross-device syncing —
this is the same architecture as the one running on this machine, just
copied over. (If you later want one dashboard showing every device's usage
in one place, that's a different, bigger feature — see the note at the
bottom.)

## 1. Requirements on the target device

- Docker + Docker Compose v2 (`docker compose version` should work)
- Claude Code CLI already used at least once there, so `~/.claude/projects`
  exists

Install Docker if needed (Debian/Ubuntu):
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in after this
```

## 2. Copy the project over

From this machine:
```bash
rsync -av --exclude='config' \
  /home/elmehdi/Desktop/selfsetup/claude-usage-tracker/ \
  <user>@<other-device-ip>:~/claude-usage-tracker/
```
(`--exclude=config` skips this device's already-seeded pricing file so the
other device gets a fresh default — copy it too if you want the same rates
everywhere.)

No code needs editing — `docker-compose.yml` already uses `${HOME}` so it
picks up whichever user runs `docker compose` on that device.

## 3. Build and run on the target device

```bash
cd ~/claude-usage-tracker
docker compose up -d --build
```

Check it came up:
```bash
docker compose logs -f
```

## 4. Open it

- Locally on that device: http://localhost:61209
- From another device on its LAN: http://<that-device-ip>:61209

If a firewall (ufw, ufw-docker, etc.) is active on the target device and you
want LAN access, allow the port:
```bash
sudo ufw allow 61209/tcp
```

## 5. Set real pricing (optional, per device)

On first run it seeds `config/pricing.json` with placeholder rates. Edit
that file on each device with your actual per-token rates — no rebuild
needed, it's re-read on every refresh.

## 6. Survive reboots

`restart: unless-stopped` in the compose file already brings the container
back after a Docker restart. Make sure Docker itself starts on boot:
```bash
sudo systemctl enable docker
```

## Updating later

Whenever you change the app, `rsync` the updated files over again (still
excluding `config/`) and re-run:
```bash
docker compose up -d --build
```

## If you ever want one combined view across all devices

That would mean either:
- each device's container pushing its stats to one central collector, or
- a central instance reading each device's `~/.claude/projects` over
  something like NFS/SSHFS/Tailscale,

which is more moving parts (network access between devices, auth, etc.).
Not set up here — ask if you want this built out.
