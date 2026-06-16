# Dashify

A lightweight, self-hosted **status page and service dashboard** configured entirely through a single YAML file — in the spirit of [Homepage](https://gethomepage.dev/) or [Glance](https://github.com/glanceapp/glance).

- Quick links to all your services, grouped into cards
- **Automatic service icons** from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) — just name your service, no emoji wrangling
- Live HTTP health checks with status dots, response-time tooltips, and an at-a-glance "up" summary
- Optional self-signed TLS support for homelab boxes (Proxmox, NPM, …)
- Instant client-side filter (press `/`) and a one-click dark/light theme toggle that remembers your choice
- Dark / light / auto themes, custom **background image**, and configurable columns
- Edit `config/config.yaml` and changes apply **live** — no restart
- Runs in Docker (non-root, with a healthcheck) or an LXC, exposed on port **6969**

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
theme: dark               # dark | light | auto
refresh_interval: 30      # seconds between health checks (0 = disable)
columns: 3                # 1-4 column grid
timeout: 5                # default health-check timeout, seconds
status_cache_ttl: 5       # server-side cache so open tabs share one check
icon_format: svg          # svg | png | webp (dashboard-icons asset type)

groups:
  - name: "Media"
    services:
      - name: "Jellyfin"           # icon resolves to jellyfin automatically
        url: "http://192.168.1.100:8096"
        description: "Media server"
        check: true                # show a live status dot
        check_path: "/health"      # optional: path used for the health check
      - name: "Pi-hole"
        url: "http://192.168.1.1/admin"
        icon: pihole               # keyword aliases map to the right slug (pi-hole)
        check: true
      - name: "Proxmox"
        url: "https://192.168.1.10:8006"
        check: true
        allow_insecure: true       # accept the self-signed TLS certificate
```

| Field | Scope | Description |
|---|---|---|
| `title` | top-level | Dashboard title in the header |
| `subtitle` | top-level | Optional small text under the title |
| `theme` | top-level | `dark`, `light`, or `auto` (follow the browser/OS preference). A toggle in the header overrides this per-browser. |
| `refresh_interval` | top-level | Seconds between status re-checks (`0` disables auto-refresh) |
| `columns` | top-level | Number of group columns, `1`–`4` |
| `timeout` | top-level | Default health-check timeout in seconds (per-service `timeout` overrides it) |
| `status_cache_ttl` | top-level | Seconds the server caches `/api/status` so multiple open tabs share one sweep (`0` disables) |
| `icon_format` | top-level | dashboard-icons asset type: `svg` (default), `png`, or `webp` |
| `background` | top-level | Optional background image — a URL or a filename dropped in `config/` (see [Background image](#background-image)) |
| `background_dim` | top-level | `0`–`1` scrim over the background so text stays readable (default `0.5`) |
| `background_blur` | top-level | Pixels of blur applied to the background image (default `0`) |
| `name` / `icon` | group | Group card heading and optional icon |
| `name` / `url` | service | Link label and destination |
| `icon` | service | Optional icon override (see [Icons](#icons)) — defaults to one resolved from the name |
| `description` | service | Optional subtitle line |
| `check` | service | `true` to enable the live status dot |
| `check_path` | service | Optional path appended to `url` for the health check |
| `allow_insecure` | service | `true` to accept self-signed/invalid TLS certificates for this check |
| `timeout` | service | Per-service health-check timeout in seconds |
| `method` | service | HTTP method for the check (default `GET`; e.g. `HEAD`) |
| `expect_status` | service | Require this exact status code instead of the default "any code `< 400`" |

The status dot turns **green** when the service responds (HTTP < 400, or matches `expect_status`), **red** when it's unreachable or times out, and **gray** when `check` is off. Hover a dot to see the response time.

**Tips:** press `/` to jump to the filter box, and use the header toggle to switch theme — your choice is remembered in the browser.

### Icons

By default each service's icon is looked up from the
[dashboard-icons](https://github.com/homarr-labs/dashboard-icons) collection using
its **name** — so `Jellyfin`, `Portainer`, `Proxmox`, etc. just work. Any icon in
that repository is referenceable; set `icon:` to:

- a **slug** — e.g. `icon: pi-hole` (common keywords like `pihole`, `adguard`, `npm` are aliased automatically),
- an **emoji** — e.g. `icon: "🎬"`,
- a **URL** — e.g. `icon: "https://example.com/logo.png"`, or
- a **local file** dropped in `config/` — e.g. `icon: my-logo.png` (served from `/user/`).

Icons load from a CDN; if one can't be found (or you're offline) the service falls
back to a coloured monogram of its first letter. Pick the asset type with
`icon_format` (`svg`, `png`, or `webp`).

### Background image

Set a dashboard-wide background with `background:`. Either point it at a URL, or
drop an image into your `config/` folder and reference it by filename:

```yaml
background: "background.jpg"   # a file in config/ (served from /user/background.jpg)
background_dim: 0.55           # darken/lighten the scrim for readability (0–1)
background_blur: 3             # optional blur, in pixels
```

Any file you place next to `config.yaml` is served under `/user/`, so the same
mechanism works for custom service icons too. With Docker the `config/` folder is
bind-mounted, so just drop the image in and refresh — no rebuild needed.

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
├── test/                  # node:test smoke + health-check tests
├── .github/workflows/     # CI (lint, test, docker build)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

No build step, no database — just Node and a YAML file.

---

## Development

```bash
npm install
npm run dev     # auto-restart on changes
npm test        # run the test suite
npm run lint    # syntax-check the source
```

Tests run on plain Node (`node --test`) with no extra dependencies. They boot the
server on a throwaway port, exercise the API, and verify the health-check logic
against a local stand-in server.
