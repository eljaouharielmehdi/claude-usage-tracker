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
- Git, and SSH access to your GitHub account (see below)

Install Docker if needed (Debian/Ubuntu):
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in after this
```

## 2. Get GitHub access working on the target device

The repo is at **https://github.com/eljaouharielmehdi/claude-usage-tracker**
(public, so cloning over HTTPS needs no auth at all — SSH is only needed if
you want to push changes back from that device):

```bash
git clone https://github.com/eljaouharielmehdi/claude-usage-tracker.git
```

If you'd rather use SSH (e.g. to push updates from that device too), generate
a key there and add it under a **new** entry in GitHub → Settings → SSH and
GPG keys (one key per device is fine — don't copy this machine's private
key over):
```bash
ssh-keygen -t ed25519 -C "<device-name>" -f ~/.ssh/id_ed25519_github -N ""
cat ~/.ssh/id_ed25519_github.pub   # paste this into GitHub
```
then:
```bash
git clone git@github.com:eljaouharielmehdi/claude-usage-tracker.git
```

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

Pull the latest changes and rebuild:
```bash
cd claude-usage-tracker
git pull
docker compose up -d --build
```

`config/` is gitignored (it holds each device's own seeded pricing file),
so pulling never overwrites your local rates.

## 7. Network traffic panel (optional, native Linux only)

The "Network traffic to Anthropic" panel needs the separate host-level
`netmon/` service (iptables + ipset accounting, root-owned systemd
service) — see `netmon/README.md` for what it installs and
`netmon/setup_iptables.sh` / `netmon/collector.py` for the actual setup
steps (there's no one-liner for this part, it's a few sequential root
commands, walked through in that README).

**On WSL2 (Windows host), this piece likely won't work as-is:**
- The WSL2 Linux VM has its own network stack, separate from Windows — it
  only sees traffic from processes running *inside* WSL (so Claude Code
  CLI run from a WSL shell would count, but a Windows-native browser or
  Claude Desktop for Windows would not, even on the same machine).
- Many stock WSL2 kernels don't ship with `iptables`/`ipset`/netfilter
  support compiled in at all — check with `sudo iptables -L` and
  `which ipset` before assuming this will work; if either fails, this
  feature isn't available there without a custom WSL2 kernel.
- The Docker/dashboard half of this project (tokens, cost) is unaffected
  either way — it's only this network-bytes panel that's Linux/conntrack-
  and-iptables-specific.

## If you ever want one combined view across all devices

That would mean either:
- each device's container pushing its stats to one central collector, or
- a central instance reading each device's `~/.claude/projects` over
  something like NFS/SSHFS/Tailscale,

which is more moving parts (network access between devices, auth, etc.).
Not set up here — ask if you want this built out.
