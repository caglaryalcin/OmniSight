<img src="./public/assets/omnisight-wordmark.svg" width="512" alt="Omnisight Logo" />

![Status](https://img.shields.io/badge/status-stable-brightgreen) [![Version](https://img.shields.io/badge/version-1.5.0-blue)](https://github.com/caglaryalcin/OmniSight/releases) [![Latest Release](https://img.shields.io/github/v/release/caglaryalcin/OmniSight?include_prereleases&color=blue)](https://github.com/caglaryalcin/OmniSight/releases)

A simple, single-glance monitoring dashboard for Proxmox, Linux servers, Kubernetes, SNMP devices, Docker, databases, Healthchecks, Uptime Kuma and Prometheus.

## Features

- **Modern UI** — fully redesigned interface: glass header, soft-glow status indicators, card-grid summaries, draggable/collapsible dashboard cards, compact platform summaries in detail headers, Inter typography, refined dark & light themes and subtle micro-animations
- **One agent, one command** — Linux servers, Proxmox nodes and Docker hosts can be monitored by a single tiny push agent (one bash script + systemd, nothing beyond `curl`). In Settings just click **+ Add System / Node / Host**, pick **Binary**, **Docker** or **Stack**, copy the pre-filled command, run it on the server — the system self-registers and pops up online within seconds. No inbound firewall rules, NAT-friendly (see [The agent](#the-agent))
- **Proxmox** — node CPU/RAM/temperature/uptime, Disk I/O and bandwidth when exposed by the API, agent or optional SSH metrics fallback, VM/LXC, per-node service status with **start/stop/restart/exclude** actions, **last backup** (vzdump) status, **Ceph cluster storage health** with active alert summaries, node storage utilization and CPU/RAM/temperature history charts — collected via API token, locally by the agent via `pvesh`, or SSH fallback for host-only metrics
- **Linux servers** — CPU/RAM/disk/swap/load/temperature/uptime/OS plus disk I/O and bandwidth history, with **auto-discovered** running/failed services and near-instant **status/start/stop/restart/exclude** actions over the agent's command long-poll. Works on any systemd Linux incl. NAS devices (e.g. Synology)
- **Kubernetes** — pod / deployment / service status, expandable groups, live pod log viewer and optional pod CPU/RAM sorting when the Kubernetes metrics API is available
- **SNMP** — status of any SNMP v2c/v3 device (Synology, UniFi, switches, routers, …) with CPU/RAM/system or CPU temperature, dynamic MB/GB memory display and history charts where exposed
- **Docker** — container status, ports, CPU/memory, network I/O, block I/O, host-level CPU/RAM history, unused (dangling) image count with a **Prune** action, sortable container columns and live container log viewer — via agent, Docker API host or SSH host (Linux/Synology, key or password)
- **Databases** — **PostgreSQL**, **MySQL/MariaDB** and **MongoDB**: up/down, active/max connections, total size and version
- **Uptime Kuma** — import monitors from a public status page slug, show up/down/pending/maintenance state, configurable history range and interactive heartbeat bars
- **Prometheus** — monitor one or more Prometheus instances, group targets by server and track active target health with expandable target lists

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/dashboard.png)

> Highlight support for container and pod logs

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/container-logs.png)

- **Healthchecks** — cron monitoring status with last-ping and period/grace
- **Alerts** — notifications on state changes (down/up) and resource thresholds via **ntfy**, **Telegram** and **SMTP**, with warning/critical percentages and a **per-device bell** to mute/enable notifications for individual platforms/devices
- **Custom icons** — set any platform's icon from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) by name/URL or upload your own (see [Platform icons](#platform-icons))
- **Custom CA** — trust private/self-signed CAs (see [Custom CA certificates](#custom-ca-certificates))
- **Public status** — Read-only public summary page (`/status`)
- **Agents** — connected agent inventory, installed versions and update actions
- **Profile** — profile image, password changes and optional TOTP two-factor authentication
- **Appearance** — dashboard side panel toggle, default history period, 12/24 hour time format and English/Turkish UI language preference

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/public-page.png)

- **Logs** — live application log/warning/error stream at `/logs`

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/logs.png)

- Dark / light theme, global health badge in the header, smooth manual refresh, live configuration from the Settings page

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/light-dark.png)

## Stack

Node.js + Express backend · single-file vanilla HTML/CSS/JS frontend (no framework).

## Dashboard

- Platform cards can be reordered with drag-and-drop and collapsed/expanded in place.
- CPU, memory, disk I/O and bandwidth overview cards can be filtered by platform.
- Active alerts and recent logs can be shown or hidden from **Settings → Appearance**; when hidden, the platform grid expands to use the available space.
- Platform detail pages include the same compact summary counters as the dashboard card header.
- CPU, RAM and temperature history charts are available where the integration exposes those metrics.
- Uptime monitor history bars include hover details for status, time range, ping and message data when available.

## Quick start (Node.js)

```bash
git clone https://github.com/caglaryalcin/OmniSight.git
cd OmniSight
npm install
npm start
```

Dashboard: `http://localhost:3000` — the app starts with no config; set up your account and configure platforms from the Settings UI.

## The agent

Linux servers, and optionally Proxmox nodes and Docker hosts, are monitored by the **OmniSight agent** — a single bash script that **pushes** metrics to OmniSight over HTTP(S). Nothing to expose on the servers, no credentials stored in OmniSight for this mode, works behind NAT/firewalls as long as the server can reach the dashboard.

**Setup :**

1. Open **Settings** and click **+ Add System** (Linux Servers), **+ Add Node** (Proxmox) or **+ Add Host** (Docker). The shared agent token is generated automatically.
2. Pick an install method in the dialog and copy the pre-filled command:

**Binary (systemd):**

```bash
curl -fsSL http://<omnisight-host>:3000/agent/install.sh | \
  sudo OMNISIGHT_URL=http://<omnisight-host>:3000 OMNISIGHT_TOKEN=<token> bash
```

For a private/self-signed HTTPS endpoint, either install the CA certificate on the target host, or use the temporary insecure TLS option:

```bash
curl -fsSL --insecure https://<omnisight-host>/agent/install.sh | \
  sudo OMNISIGHT_URL=https://<omnisight-host> OMNISIGHT_TOKEN=<token> OMNISIGHT_INSECURE_TLS=1 bash
```

**Docker (agent in a container):**

```bash
docker run -d --name omnisight-agent --restart unless-stopped \
  --network host --pid host \
  -e OMNISIGHT_URL=http://<omnisight-host>:3000 \
  -e OMNISIGHT_TOKEN=<token> \
  -e OMNISIGHT_HOST_ROOT=/host \
  -v /:/host:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  docker:cli sh -c "apk add --no-cache bash curl coreutils >/dev/null && curl -fsSL http://<omnisight-host>:3000/agent/omnisight-agent.sh -o /usr/local/bin/omnisight-agent && exec bash /usr/local/bin/omnisight-agent"
```

**Docker Stack (Swarm):**

```bash
docker stack deploy -c - omnisight-agent <<'EOF'
version: "3.8"
services:
  agent:
    image: docker:cli
    command: sh -c "apk add --no-cache bash curl coreutils >/dev/null && curl -fsSL http://<omnisight-host>:3000/agent/omnisight-agent.sh -o /usr/local/bin/omnisight-agent && exec bash /usr/local/bin/omnisight-agent"
    environment:
      OMNISIGHT_URL: http://<omnisight-host>:3000
      OMNISIGHT_TOKEN: <token>
      OMNISIGHT_HOST_ROOT: /host
    volumes:
      - /:/host:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    deploy:
      mode: global
      restart_policy:
        condition: any
EOF
```

3. Run it on the server — the dialog shows a live "✓ connected" confirmation and the system appears on the dashboard within seconds.

**What one agent covers, automatically:**

- **System** — hostname, IP, OS, kernel, CPU %, load, RAM, swap, root disk, disk I/O, bandwidth, temperature, uptime and all running/failed **systemd services** → *Linux Servers* card
- **Docker** (when `docker` is present, or the socket is mounted) — containers, states, ports, CPU/memory, network I/O, block I/O, dangling-image count → *Docker* card; `logs` and `Prune` run locally on the host and stream back over the command channel
- **Proxmox** (when `pvesh` is present) — VM/LXC list, node storage, last vzdump backup, Ceph health → *Proxmox* card; the node moves from *Linux Servers* to *Proxmox* automatically

**How actions work:** between reports the agent holds a long-poll against `/api/agent/commands`, so service `start/stop/restart`, container logs and prune clicked in the UI reach the server near-instantly and execute locally (`systemctl` / `docker`).

**Details:**

- Report interval: 15s by default — `OMNISIGHT_INTERVAL=<seconds>` at install time, or edit `/etc/omnisight-agent/agent.env` and restart.
- Authentication: one shared token (`X-Agent-Token` header), auto-generated on first add and regenerable from **Settings → Linux Servers**. Regenerating invalidates all installed agents until updated.
- Agent identity: the installer writes a unique `OMNISIGHT_AGENT_ID` into `/etc/omnisight-agent/agent.env`, so cloned VMs with the same `/etc/machine-id` still appear as separate systems.
- A system is marked **offline** when no report arrives for ~2.5× its interval.
- Agent versions are visible in **Agents**. If an agent is outdated, use the Update action there; very old agents may show a one-time manual update command.
- Logs: `journalctl -u omnisight-agent -f` (binary) / `docker logs -f omnisight-agent` (container)
- Uninstall: `curl -fsSL http://<omnisight-host>:3000/agent/install.sh | sudo bash -s uninstall` / `docker rm -f omnisight-agent` / `docker stack rm omnisight-agent`
- Remove from dashboard: the ✕ button next to the system in Settings.

> Upgrading from ≤0.7.x: SSH-based `linux.servers[]` is no longer used. Install the agent on Linux systems instead; service exclude lists are preserved per hostname. Proxmox and Docker can be monitored either with agents or with the dedicated API/SSH options in Settings.

## Quick start (Docker)

```bash
docker compose up -d
```

Nothing to pre-create. The single `data/` directory holds all state (`config.yaml`, `secret.key`, `auth.yaml`, `sessions.yaml`, `agents.yaml`, `kube.bin`); Docker auto-creates it and it persists across restarts. The compose file uses the published image by default (`ghcr.io/caglaryalcin/omnisight:latest`). The app starts empty — set up your account and configure platforms from the Settings UI. Standalone Docker using the published image:

```bash
docker run -d --name omnisight -p 3000:3000 \
  -e TZ=UTC \
  -v $(pwd)/data:/app/data \
  ghcr.io/caglaryalcin/omnisight
```

To build the image yourself instead, uncomment `build: .` in `docker-compose.yml`, or run `docker build -t omnisight .` and replace the last line with `omnisight`.

### Pre-built image (CI/CD)

A GitHub Actions workflow (`.github/workflows/deploy.yml`) builds and pushes the image to GitHub Container Registry on every push to `main`/`master` and on `v*` tags:

```bash
docker pull ghcr.io/caglaryalcin/omnisight
```

### Docker Stack (Swarm)

Use the published image (Swarm ignores `build:`). Enable Swarm once if you haven't, then deploy the stack:

```bash
docker swarm init        # only if this node isn't a Swarm manager yet
docker stack deploy -c docker-stack.yml omnisight
```

`docker-stack.yml` is a Swarm-ready compose file using `image: ghcr.io/caglaryalcin/omnisight:latest` instead of `build:`.

### Kubernetes

A manifest lives in `deploy/kubernetes.yaml` (PVC + Deployment + Service). Edit it and replace `OWNER` in the image (`ghcr.io/OWNER/omnisight`) with your GitHub owner, then apply:

```bash
kubectl apply -f deploy/kubernetes.yaml
```

No ConfigMap/Secret to create: the app starts empty and you configure it from the Settings UI, which writes `config.yaml` to the persistent volume (`config.yaml`, `secret.key`, `auth.yaml`, `sessions.yaml` all persist on the PVC).

> **Docker path note:** Windows paths don't work inside the container. Put `kube.bin` in `./data/` and reference it with a container path, e.g. `kubeconfig: /app/data/kube.bin`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `TZ` | No | `UTC` | Server timezone for Node timestamps and notifications, e.g. `Europe/Istanbul`. `TIMEZONE` is also accepted as an alias. |
| `OMNISIGHT_ENCRYPT` | No | `true` | Config encryption is **enabled by default**. Set to `false` (or `0`/`off`/`no`) to disable. |
| `OMNISIGHT_SECRET` | No | auto | Encryption key. If unset, a random key is generated and stored in `data/secret.key` (auto-managed). Set this to use your own key (e.g. shared across instances). |
| `OMNISIGHT_DEBUG` | No | `false` | Enables local-only debug endpoints such as `/api/debug/docker`. Keep disabled in production. |
| `NODE_EXTRA_CA_CERTS` | No | — | Path to a CA certificate file to trust (Node standard), e.g. `/app/data/certs/ca.crt`. You can also just drop `*.crt`/`*.pem` files into `data/certs/` — they are auto-trusted on startup. See [Custom CA certificates](#custom-ca-certificates). |

### Encryption

Encryption is on by default. Sensitive fields in `config.yaml` (`tokenSecret`, `password`, `apiKey`, `token`, `botToken`, `sshKey`, …) are stored encrypted (`enc:` prefix, AES-256-GCM) whenever the config is saved from the Settings page or via `npm run encrypt-config`.

- The key lives in `OMNISIGHT_SECRET` if set, otherwise in the auto-generated `data/secret.key` file.
- **Keep `data/secret.key` safe and persistent.** In Docker the whole `data/` folder is mounted as a volume — if the key is lost, previously encrypted values can no longer be decrypted.
- To turn encryption off, set `OMNISIGHT_ENCRYPT=false` (do this before encrypting, or decrypt your config first).

### Referencing env vars inside config.yaml

Any value in `config.yaml` may reference an environment variable, which makes it easy to keep secrets out of the file (handy for Docker). Both forms are supported:

```yaml
proxmox:
  tokenSecret: ${PVE_TOKEN_SECRET}
alerts:
  telegram:
    botToken: ${TG_BOT_TOKEN}
    chatId: "${TG_CHAT_ID}"
  smtp:
    password: ${SMTP_PASSWORD:-changeme}   # ${VAR:-default}
```

Unresolved `${VAR}` (no env value, no default) is left as-is. This works for every section — platforms and alerts alike.

## Custom CA certificates

To make OmniSight trust a private/self-signed CA (e.g. a corporate root for your Healthchecks/SMTP/ntfy endpoints), use either method:

- **Drop-in (recommended):** place one or more `*.crt` / `*.pem` files into `data/certs/`. They are auto-trusted on startup — no env needed. In Docker/Kubernetes this directory lives inside the mounted `data` volume.
- **Settings UI:** upload `.crt`, `.pem`, `.cer`, `.pfx` or `.p12` files from **Settings → Certificates**. PFX/P12 files are converted to a trusted PEM when `openssl` can extract the CA certificate.
- **Env var (Node standard):** set `NODE_EXTRA_CA_CERTS` to a cert file path, e.g. `NODE_EXTRA_CA_CERTS=/app/data/certs/ca.crt`.

In Kubernetes you can also mount the CA from a ConfigMap — `deploy/kubernetes.yaml` has a ready, commented example (ConfigMap `omnisight-ca` + `NODE_EXTRA_CA_CERTS=/app/certs/ca.crt` + a read-only `/app/certs` mount).

## Configuration (config.yaml)

The live config is `data/config.yaml` (created automatically on first save). Easiest is to configure everything from the Settings UI; to hand-edit, copy the template — `cp config.example.yaml data/config.yaml` — and edit it. All sections are optional; include only what you use. See `config.example.yaml`.

- `linux` — `enabled` + `agentToken` (auto-generated from the Settings UI). Systems self-register via the [agent](#the-agent); no per-server entries needed. Services are auto-discovered and Exclude/Include is managed from the UI
- `proxmox` — `enabled`, optional `url` / `tokenId` / `tokenSecret` / `insecureTLS` for API mode, optional `sshMetrics[]` (`node`, `sshHost`, `sshUser`, `sshPassword`/`sshKey`, `sshPort`, `sudo`) to fill host CPU temperature and host Disk I/O when the API does not expose them, plus optional `icon`. Without API settings, data can come from agents running on the nodes (`pvesh`)
- `docker` — `enabled`, optional `hosts[]` for Docker API or SSH hosts (`sshHost`, `sshUser`, `sshPassword`/`sshKey`, `sshMode`, `sudo`, `insecureTLS`), plus optional `icon`. Agent-reported Docker hosts also appear automatically
- `kubernetes` — kubeconfig, namespaces[] (the Settings UI has a **Browse…** button that uploads a kubeconfig from your machine into `data/` and fills in the container path automatically). Pod CPU/RAM sorting uses the Kubernetes metrics API when it is available to the configured account
- `snmp.devices[]` — SNMP v2c (community) or v3 (username, authPassword, privPassword, …)
- `healthchecks` — url, apiKey
- `defaultTimePeriodHours`, `timeFormat`, `preferredLanguage` and `appearance.dashboardSidePanel` — dashboard-wide history period, 12/24 hour time format, UI language and dashboard side-panel visibility
- `uptimekuma` — url, status page `slug`, optional apiKey, username/password and historyHours
- `prometheus` — one or more `instances[]` with name, url, optional bearerToken and `insecureTLS`
- `database.instances[]` — `type: postgresql | mysql | mariadb | mongodb`, name, host, port, user, password, optional `database`
- `alerts` — `enabled` + `ntfy` / `telegram` / `smtp` channels
- `publicStatus: true` and `publicTitle` — expose the `/status` page publicly
- each platform also takes an optional `icon` (see below)

### Service & maintenance actions

Some cards expose actions (no extra setup beyond the access the connection already has):

- **Linux & Proxmox services** — query `status`, `start`, `stop`, `restart` on inactive/failed units via the agent (executed locally with `systemctl`, delivered near-instantly over the command long-poll). You can also Exclude/Include intentionally stopped services directly from the UI so they don't degrade the dashboard health or trigger alerts.
- **Docker** — `Prune` removes dangling images and the live log viewer streams `docker logs`, executed through the agent or the configured Docker API/SSH host.

### Databases

The `pg`, `mysql2` and `mongodb` drivers are bundled (installed via `npm install` / image build). The monitoring account only needs read access — e.g. PostgreSQL `pg_monitor`, MySQL `PROCESS` + `SELECT` on `information_schema`, MongoDB `clusterMonitor`. If a metric (connections/size) isn't permitted it's simply omitted; up/down still works.

### Platform icons

Each platform card shows an icon you can customise from the Settings UI (the `icon` field on every platform). Proxmox, Kubernetes, Healthchecks and Docker default to their real logos; Linux and SNMP use a built-in glyph. Three ways to set one:

- **By name** — type an icon name from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons), e.g. `proxmox`, `ubuntu.png`, `unifi.svg`. It's fetched from the jsDelivr CDN (`svg` is assumed when no extension is given).
- **By URL** — paste any full `https://…` image URL.
- **Upload** — can't find it on the CDN? Click **Browse…** next to the field and pick an image; it's stored in `data/icons/` and served by the app. Uploaded icons persist in the `data` volume.

If a chosen icon fails to load, the card falls back to the built-in default automatically.

### Alerts example

```yaml
alerts:
  enabled: true
  thresholds:
    cpu:
      warning: 80
      critical: 90
    ram:
      warning: 80
      critical: 90
    disk:
      warning: 80
      critical: 90
  ntfy:
    url: "https://ntfy.sh"
    topic: "omnisight-xxxx"
    priority: "default"
  telegram:
    botToken: "123456:ABC-..."
    chatId: "123456789"
  smtp:
    host: "smtp.gmail.com"
    port: 587
    secure: false
    user: "you@gmail.com"
    password: "app-password"
    from: "OmniSight <you@gmail.com>"
    to: ["alerts@domain.com"]
```

Notifications are sent on **state changes** (running→down = DOWN, down→running = UP) and resource threshold changes (CPU/RAM/disk crossing the configured percentages). Pre-existing problems at startup do not trigger a flood. Healthchecks `grace` is treated as degraded/warning; the DOWN notification is sent only after the check becomes `down`. Each channel can be tested individually from the Settings page.

## Pages

| Path | Description |
|---|---|
| `/` | Main dashboard (login required) |
| `/status` | Public read-only summary (only when `publicStatus: true`) |
| `/settings` | Configuration |
| `/agents` | Connected agents, versions and update actions |
| `/profile` | Username / password and two-factor authentication |
| `/logs` | Live log / warning / error stream |
| `/about` | Version info and GitHub |

The sidebar footer also links to GitHub and opens a new issue form for help/bug reports.

## Security

- The `data/` folder and `.env` are git-ignored.
- All state lives in `./data/` (`config.yaml`, `secret.key`, `kube.bin`, `auth.yaml`, `sessions.yaml`, SSH keys) — it never leaves your machine.
- Login password is set on first run. Passwords must be at least 8 characters and contain both an uppercase and a lowercase letter.
- Optional TOTP two-factor authentication can be enabled from the Profile page.
- Sessions use `HttpOnly`, `SameSite=Strict` cookies; login attempts are rate-limited.
- Mutating API requests are protected by same-origin checks, and browser security headers are enabled.
- Uploaded icons, kubeconfigs and certificates are size-limited; uploaded SVG icons are checked for active content.
- TLS verification is enabled by default for integrations. Use each platform's explicit self-signed/insecure option only when needed.
- Config secrets are encrypted at rest by default (see Encryption above).

## License

[MIT](LICENSE)
