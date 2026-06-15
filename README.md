# Dashify

A lightweight, self-hosted **status page and service dashboard** configured entirely through a single YAML file — in the spirit of [Homepage](https://gethomepage.dev/) or [Glance](https://github.com/glanceapp/glance).

- 🔗 Quick links to all your services, grouped into cards
- 🟢 Live HTTP health checks with status dots (auto-refresh)
- 🎨 Dark / light themes, customizable columns, icons, and descriptions
- ⚙️ Edit `config/config.yaml` and changes apply **live** — no restart
- 🐳 Runs in Docker or an LXC, exposed on port **6969**

---

## Quick start

> **Cloning a private repo.** This repository is private, so the LXC/host needs to authenticate to GitHub.
> The simplest one-off method is a [Personal Access Token](https://github.com/settings/tokens) with `repo` scope:
> ```bash
> git clone https://<YOUR_TOKEN>@github.com/dagfinn2000/dashify.git
> ```
> Or set up an SSH key and use `git clone git@github.com:dagfinn2000/dashify.git`.

### Option A — Docker Compose (recommended)

The simplest way. From the cloned repo:

```bash
git clone https://github.com/dagfinn2000/dashify.git
cd dashify
docker compose up -d
```

Open **http://<host-ip>:6969**.

Your `config/config.yaml` is bind-mounted into the container (`./config:/app/config:ro`), so edits on the host apply live — just save the file and refresh the page.

### Option B — Plain Docker

```bash
git clone https://github.com/dagfinn2000/dashify.git
cd dashify
docker build -t dashify .
docker run -d \
  --name dashify \
  -p 6969:6969 \
  -v "$(pwd)/config:/app/config:ro" \
  --restart unless-stopped \
  dashify
```

The image bundles a default config, so it also runs **standalone** with no volume mount — but mounting `./config` lets you customize without rebuilding.

### Option C — LXC / bare metal (Node.js)

Inside a Debian/Ubuntu LXC container:

```bash
# Install Node.js 20+ (one-time)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git

# Clone and run
git clone https://github.com/dagfinn2000/dashify.git
cd dashify
npm install --omit=dev
npm start
```

To keep it running after logout, install it as a systemd service — see [Run as a service](#run-as-a-systemd-service-lxc) below.

---

## Configuration

Everything lives in [`config/config.yaml`](config/config.yaml). Edit it and refresh the browser.

```yaml
title: "My Dashboard"
subtitle: "Home Lab"      # optional
theme: dark               # dark | light
refresh_interval: 30      # seconds between health checks (0 = disable)
columns: 3                # 1-4 column grid

groups:
  - name: "Media"
    icon: "🎬"
    services:
      - name: "Jellyfin"
        url: "http://192.168.1.100:8096"
        icon: "🎞️"
        description: "Media server"
        check: true            # show a live status dot
        check_path: "/health"  # optional: path used for the health check
```

| Field | Scope | Description |
|---|---|---|
| `title` | top-level | Dashboard title in the header |
| `subtitle` | top-level | Optional small text under the title |
| `theme` | top-level | `dark` or `light` |
| `refresh_interval` | top-level | Seconds between status re-checks (`0` disables auto-refresh) |
| `columns` | top-level | Number of group columns, `1`–`4` |
| `name` / `icon` | group | Group card heading and emoji |
| `name` / `url` | service | Link label and destination |
| `icon` | service | Emoji shown next to the service |
| `description` | service | Optional subtitle line |
| `check` | service | `true` to enable the live status dot |
| `check_path` | service | Optional path appended to `url` for the health check |

Icons are just emoji — paste any you like. The status dot turns **green** when the service responds (HTTP < 400), **red** when it's unreachable or times out, and **gray** when `check` is off.

---

## Changing the port

The app listens on `6969` by default. To change it:

- **Docker Compose** — edit the `ports` mapping in [`docker-compose.yml`](docker-compose.yml), e.g. `"8080:6969"`, or set the `PORT` env var to change the internal port too.
- **Bare Node** — set the `PORT` environment variable: `PORT=8080 npm start`.

---

## Run as a systemd service (LXC)

```ini
# /etc/systemd/system/dashify.service
[Unit]
Description=Dashify
After=network.target

[Service]
WorkingDirectory=/opt/dashify
ExecStart=/usr/bin/node src/server.js
Environment=PORT=6969
Restart=always
User=root

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp -r dashify /opt/dashify
sudo systemctl enable --now dashify
```

---

## Project structure

```
dashify/
├── config/config.yaml     # your dashboard definition (edit this)
├── src/
│   ├── server.js          # Express backend + health checks + live config reload
│   └── public/            # static frontend (HTML/CSS/JS, no build step)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

No build step, no database — just Node and a YAML file.
