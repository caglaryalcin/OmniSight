<img src="./public/assets/omnisight-wordmark.svg" width="512" alt="Omnisight Logo" />

![Status](https://img.shields.io/badge/status-stable-brightgreen) [![Latest Release](https://img.shields.io/github/v/release/caglaryalcin/OmniSight?include_prereleases&color=blue)](https://github.com/caglaryalcin/OmniSight/releases)

A simple, single-glance monitoring dashboard for Proxmox, Linux servers, Kubernetes, SNMP devices, Docker, Dockhand, databases, built-in service checks, Healthchecks, Uptime Kuma and Prometheus.

For deeper architecture, operations and troubleshooting notes, see [DOCUMENTATION.md](DOCUMENTATION.md).

## Features

- **Modern UI** — fully redesigned interface: glass header, soft-glow status indicators, card-grid summaries, draggable/collapsible dashboard cards, compact platform summaries in detail headers, Inter typography, refined dark & light themes and subtle micro-animations
- **One agent, one command** — Linux servers, Proxmox nodes and Docker hosts can be monitored by a single tiny push agent (one bash script + systemd, nothing beyond `curl`). In Settings just click **+ Add System / Node / Host**, pick **Binary**, **Docker** or **Stack**, copy the pre-filled command, run it on the server — the system self-registers and pops up online within seconds. No inbound firewall rules, NAT-friendly (see [The agent](#the-agent))
- **Proxmox** — node CPU/RAM/temperature/uptime, Disk I/O and bandwidth when exposed by the API, agent or optional SSH metrics fallback, VM/LXC lists with clickable detail views, per-node service status with **start/stop/restart/exclude** actions, **last backup** (vzdump) status, **Ceph cluster storage health** with active alert summaries, node storage utilization and CPU/RAM/temperature history charts — collected via API token, locally by the agent via `pvesh`, or SSH fallback for host-only metrics

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/proxmox.gif)

- **Linux servers** — CPU/RAM/disk/swap/load/temperature/uptime/OS plus disk I/O and bandwidth history, with **auto-discovered** running/failed services and near-instant **status/start/stop/restart/exclude** actions over the agent's command long-poll. Works on any systemd Linux incl. NAS devices (e.g. Synology)

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/linux-servers.gif)

- **Kubernetes** — pod / deployment / service status, namespace filtering with namespace summaries, expandable groups, live pod log viewer and optional pod CPU/RAM sorting when the Kubernetes metrics API is available

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/kubernetes.gif)

- **SNMP** — status of any SNMP v2c/v3 device (Synology, UniFi, switches, routers, …) with CPU/RAM/system or CPU temperature, bandwidth and disk I/O history where exposed, plus dynamic MB/GB memory display

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/snmp.gif)

- **Docker** — container status, ports, CPU/memory, network I/O, block I/O, host-level CPU/RAM history, image update status, unused image count with a **Prune** action, sortable container columns and live container log viewer — via agent, Docker API host or SSH host

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/docker.gif)

- **Dockhand** — monitor one or more Dockhand API instances, server connectivity, container state and live container logs

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/dockhand.gif)

- **Databases** — **PostgreSQL**, **MySQL/MariaDB** and **MongoDB**: up/down, active/max connections, total size and version

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/databases.gif)

- **Uptime Kuma** — import monitors from a public status page slug, show up/down/pending/maintenance state, configurable history range and interactive heartbeat bars

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/uptimekuma.gif)

- **Prometheus** — monitor one or more Prometheus instances, group targets by server and track active target health with expandable target lists

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/gifs/prometheus.gif)

> Highlight support for container and pod logs

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/container-logs.png)

- **Healthchecks** — cron monitoring status with last-ping and period/grace
- **Built-in service checks** — HTTP/HTTPS, TCP, Ping and DNS checks without requiring an external status tool, with persisted heartbeat bars and latency history
- **Alerts** — notifications on state changes (down/up), resource thresholds and CPU/RAM anomaly detection via **ntfy**, **Telegram** and **SMTP**, with warning/critical percentages and a **per-device bell** to mute/enable notifications for individual platforms/devices
- **REST API / Webhook events** — external systems can POST events into OmniSight and have them appear in Event Center / alert history
- **Mobile / PWA** — installable manifest, service worker and responsive dashboard layout for phone/tablet use
- **Custom icons** — set any platform's icon from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) by name/URL or upload your own (see [Platform icons](#platform-icons))
- **Custom CA** — trust private/self-signed CAs (see [Custom CA certificates](#custom-ca-certificates))
- **Public status** — Read-only public summary page (`/status`)

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/public-page.png)

- **Agents** — connected agent inventory, installed versions and update actions
- **Onboarding** — first-run setup wizard for admin account, timezone, notifications and the first platform
- **Users & roles** — multi-user access with admin, operator and read-only roles
- **Profile** — profile image, password changes, password reset support, passkeys and optional TOTP two-factor authentication
- **Appearance** — dashboard side panel toggle, default history period, 12/24 hour time format, English/Turkish UI language preference and installable PWA manifest
- **Backup & restore** — config backup export/restore plus password-gated full backup export for users, secret key, certs and history

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/backup-export.png)

- **Topology** — relationship map for platforms, hosts and workloads

![](https://github.com/caglaryalcin/OmniSight/blob/main/screenshots/gifs/topology.gif)

- **Event Center** — live runtime log/warning/error stream plus audit and alert history at `/event-center`; admins can export audit events from `/api/audit/export?format=json|csv|syslog`

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/logs.png)

- Dark / light theme, global health badge in the header, smooth manual refresh, live configuration from the Settings page

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/light-dark.png)

## Stack

Node.js + Express backend · vanilla HTML/CSS/JS frontend (no framework).

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

### Demo mode

```bash
npm run demo
```

Demo: `http://localhost:4000` — default credentials are `demo` / `demo` unless `OMNISIGHT_DEMO_USER` and `OMNISIGHT_DEMO_PASSWORD` are set.

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
- **Docker** (when `docker` is present, or the socket is mounted) — containers, states, ports, CPU/memory, network I/O, block I/O, unused-image count → *Docker* card; `logs` and `Prune` run locally on the host and stream back over the command channel
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
  --cap-add NET_RAW \
  -e TZ=UTC \
  -v $(pwd)/data:/app/data \
  ghcr.io/caglaryalcin/omnisight
```

`NET_RAW` is only needed for built-in Ping checks. HTTP, TCP and DNS checks work without it.

To build the image yourself instead, uncomment `build: .` in `docker-compose.yml`, or run `docker build -t omnisight .` and replace the last line with `omnisight`.

If an upgraded container unexpectedly shows the first-run wizard, the app user probably cannot read the existing `data/` volume. Fix ownership and restart:

```bash
docker compose exec -u 0 omnisight sh -lc 'chown -R omnisight:omnisight /app/data'
docker compose restart omnisight
```

### Pre-built image (CI/CD)

A GitHub Actions workflow (`.github/workflows/deploy.yml`) builds and pushes the image to GitHub Container Registry on `main`/`master` and `v*` tags. It also pushes to Docker Hub when `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are configured for the repository:

```bash
docker pull ghcr.io/caglaryalcin/omnisight:latest
# Optional Docker Hub mirror, when configured:
# docker pull docker.io/<namespace>/omnisight:latest
```

### Docker Stack (Swarm)

Use the published image (Swarm ignores `build:`). Enable Swarm once if you haven't, then deploy the stack:

```bash
docker swarm init        # only if this node isn't a Swarm manager yet
docker stack deploy -c docker-stack.yml omnisight
```

`docker-stack.yml` is a Swarm-ready compose file using `image: ghcr.io/caglaryalcin/omnisight:latest` instead of `build:`.

### Kubernetes / Helm

For Helm deployments, expose the main app on container port `3000`. The image also exposes `4000` for the bundled demo server. Use `OMNISIGHT_MODE=prod` for the normal app, or run a separate demo deployment with `OMNISIGHT_MODE=demo` and `OMNISIGHT_DEMO_PORT=4000` when you want the demo page reachable.

When running from source with `npm start`, `OMNISIGHT_START_DEMO=1` can start the demo listener alongside the main app.

> **Docker path note:** Windows paths don't work inside the container. Put `kube.bin` in `./data/` and reference it with a container path, e.g. `kubeconfig: /app/data/kube.bin`.

### Password recovery

If you lock yourself out, reset the local account from inside the running container/pod. The command updates `data/auth.yaml`; no restart is required and old sessions are invalidated automatically.

Docker:

```bash
docker exec -e OMNISIGHT_RESET_PASSWORD='NewStrongPass1' omnisight \
  npm run reset-password -- --username admin
```

Kubernetes:

```bash
kubectl exec -n omnisight deploy/omnisight -- sh -lc \
  "OMNISIGHT_RESET_PASSWORD='NewStrongPass1' npm run reset-password -- --username admin"
```

If you also lost access to your authenticator app, add `--disable-2fa`.

## Backup and restore

Settings → Appearance includes backup actions:

- **Export config backup** downloads only `data/config.yaml`.
- **Restore config backup** imports an OmniSight config backup and replaces the current platform/settings configuration.
- **Full backup/export** asks for the current admin password before exporting the important `data/` volume files, including users, `secret.key`, certificates and persisted history. Runtime sessions and password-reset codes are intentionally excluded.
- **Import full backup** restores a full OmniSight backup into the `data/` volume after asking for the current admin password. Sessions are cleared after import; restart OmniSight and sign in again so all restored history and state is loaded cleanly.

For disaster recovery, the safest flow is still: stop OmniSight, restore the files from the full backup into the new `data/` volume, then start OmniSight again. If config encryption is enabled, keep the matching `data/secret.key`; encrypted secrets cannot be decrypted without it.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `OMNISIGHT_MODE` | No | `prod` | Container entrypoint mode. `prod` runs the main app; `demo` runs the bundled demo server. |
| `DEMO_PORT` / `OMNISIGHT_DEMO_PORT` | No | `4000` | Demo dashboard port |
| `OMNISIGHT_DEMO_USER` / `OMNISIGHT_DEMO_PASSWORD` | No | `demo` / `demo` | Demo login credentials |
| `OMNISIGHT_START_DEMO` | No | `0` | Source/local mode only: set to `1` to start the demo listener alongside the main app |
| `OMNISIGHT_ALERT_COOLDOWN_MS` | No | `3600000` | Minimum time before the same alert notification can be sent again |
| `TZ` | No | `UTC` | Server timezone for Node timestamps and notifications, e.g. `Europe/Istanbul`. `TIMEZONE` is also accepted as an alias. |
| `OMNISIGHT_ENCRYPT` | No | `true` | Config encryption is **enabled by default**. Plaintext secrets require this to be disabled and `OMNISIGHT_ALLOW_PLAINTEXT_SECRETS=1`. |
| `OMNISIGHT_ALLOW_PLAINTEXT_SECRETS` | No | `0` | Unsafe escape hatch that allows `OMNISIGHT_ENCRYPT=false` to store secrets in plaintext. Do not enable in production. |
| `OMNISIGHT_REQUIRE_HTTPS` | No | `0` | Reject API traffic and redirect pages when the request is not HTTPS. Enable behind a TLS-terminating reverse proxy. |
| `OMNISIGHT_REQUIRE_AGENT_TLS` | No | inherits `OMNISIGHT_REQUIRE_HTTPS` | Reject non-TLS agent API traffic. |
| `OMNISIGHT_REDACT_IPS` | No | `0` | Store/display hashed IP identifiers in logs and sessions instead of raw IP addresses. This can also be enabled with `security.redactIpAddresses: true`. |
| `OMNISIGHT_SECRET` | No | auto | Encryption key. If unset, a random key is generated and stored in `data/secret.key` (auto-managed). Set this to use your own key (e.g. shared across instances). |
| `OMNISIGHT_DEBUG` | No | `false` | Enables local-only debug endpoints such as `/api/debug/docker`. Keep disabled in production. |
| `NODE_EXTRA_CA_CERTS` | No | — | Path to a CA certificate file to trust (Node standard), e.g. `/app/data/certs/ca.crt`. You can also just drop `*.crt`/`*.pem` files into `data/certs/` — they are auto-trusted on startup. See [Custom CA certificates](#custom-ca-certificates). |

### Encryption

Encryption is on by default. Sensitive fields in `config.yaml` (`tokenSecret`, `password`, `apiKey`, `token`, `botToken`, `sshKey`, …) are stored encrypted (`enc:` prefix, AES-256-GCM) whenever the config is saved from the Settings page or via `npm run encrypt-config`.

- The key lives in `OMNISIGHT_SECRET` if set, otherwise in the auto-generated `data/secret.key` file.
- **Keep `data/secret.key` safe and persistent.** In Docker the whole `data/` folder is mounted as a volume — if the key is lost, previously encrypted values can no longer be decrypted.
- Plaintext secret storage is intentionally hard to enable. It requires both `OMNISIGHT_ENCRYPT=false` and `OMNISIGHT_ALLOW_PLAINTEXT_SECRETS=1`.

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

In Kubernetes you can also mount the CA from a Secret or ConfigMap and set `NODE_EXTRA_CA_CERTS` to the mounted certificate path, e.g. `NODE_EXTRA_CA_CERTS=/app/certs/ca.crt`.

## Configuration (config.yaml)

The live config is `data/config.yaml` (created automatically on first save). Easiest is to configure everything from the Settings UI; to hand-edit, copy the template — `cp config.example.yaml data/config.yaml` — and edit it. All sections are optional; include only what you use. See `config.example.yaml`.

- `linux` — `enabled` + `agentToken` (auto-generated from the Settings UI). Systems self-register via the [agent](#the-agent); no per-server entries needed. Services are auto-discovered and Exclude/Include is managed from the UI
- `proxmox` — `enabled`, optional `url` / `tokenId` / `tokenSecret` / `insecureTLS` for API mode, optional `sshMetrics[]` (`node`, `sshHost`, `sshUser`, `sshPassword`/`sshKey`, `sshPort`, `sudo`) to fill host CPU temperature and host Disk I/O when the API does not expose them, plus optional `icon`. Without API settings, data can come from agents running on the nodes (`pvesh`)
- `docker` — `enabled`, optional `hosts[]` for Docker API or SSH hosts (`sshHost`, `sshUser`, `sshPassword`/`sshKey`, `sshMode`, `sudo`, `insecureTLS`), plus optional `icon`. Agent-reported Docker hosts also appear automatically
- `dockhand` — one or more API `instances[]` with name, url, bearer token and optional `insecureTLS`
- `kubernetes` — kubeconfig, namespaces[] (the Settings UI has a **Browse…** button that uploads a kubeconfig from your machine into `data/` and fills in the container path automatically). Pod CPU/RAM sorting uses the Kubernetes metrics API when it is available to the configured account
- `snmp.devices[]` — SNMP v2c (community) or v3 (username, authPassword, privPassword, …)
- `healthchecks` — url, apiKey
- `checks.services[]` — built-in `http`, `tcp`, `ping` or `dns` checks with name, target, optional port/status/record type and timeout
- `defaultTimePeriodHours`, `historyRetentionDays`, `timeFormat`, `preferredLanguage`, `appearance.dashboardSidePanel` and `performance.*` — dashboard-wide history period, persistent history retention, 12/24 hour time format, UI language, dashboard side-panel visibility, lower-frequency disk flushes for slower storage, collector concurrency and optional per-platform refresh intervals
- `uptimekuma` — url, status page `slug`, optional apiKey, username/password and historyHours
- `prometheus` — one or more `instances[]` with name, url, optional bearerToken and `insecureTLS`
- `database.instances[]` — `type: postgresql | mysql | mariadb | mongodb`, name, host, port, user, password, optional `database`
- `alerts` — `enabled`, warning/critical resource thresholds, per-kind alert rules, optional CPU/RAM anomaly detection, maintenance windows, `webhook` event ingestion and `ntfy` / `telegram` / `smtp` notification channels
- `publicStatus: true`, `publicTitle`, `publicDescription`, `publicPlatforms[]`, `publicStatusShowDetails` and `publicStatusShowHistory` — expose and customize the `/status` page publicly. Details and history are opt-in so the public page can stay minimal by default.
- each platform also takes an optional `icon` (see below)

### Service & maintenance actions

Some cards expose actions (no extra setup beyond the access the connection already has):

- **Linux & Proxmox services** — query `status`, `start`, `stop`, `restart` on inactive/failed units via the agent (executed locally with `systemctl`, delivered near-instantly over the command long-poll). You can also Exclude/Include intentionally stopped services directly from the UI so they don't degrade the dashboard health or trigger alerts.
- **Docker** — `Prune` removes unused images and the live log viewer streams `docker logs`, executed through the agent or the configured Docker API/SSH host.

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
  rules:
    cpu: { durationSeconds: 60 }
    ram: { durationSeconds: 60 }
    disk: { durationSeconds: 60 }
    pod: { durationSeconds: 60 }
    container: { durationSeconds: 60 }
    target: { durationSeconds: 60 }
  maintenanceWindows:
    - start: "23:00"
      end: "23:30"
      days: ["sun"]
  webhook:
    enabled: true
    token: "change-me-long-random-token"
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

Notifications are sent on **state changes** (running→down = DOWN, down→running = UP) and resource threshold changes (CPU/RAM/disk crossing the configured percentages). Pre-existing problems at startup do not trigger a flood. Alert rules can add per-metric duration delays for CPU/RAM/disk, Kubernetes pods, Docker containers and Prometheus targets, plus maintenance windows. The Alerts page keeps a timeline, supports acknowledgement and temporary mute. Healthchecks `grace` is treated as degraded/warning; the DOWN notification is sent only after the check becomes `down`. Each channel can be tested individually from the Settings page.

External systems can send events into Event Center:

```bash
curl -fsS http://<omnisight-host>:3000/api/webhook/event \
  -H "Authorization: Bearer <webhook-token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Backup failed","message":"nightly job exited with code 1","severity":"critical","source":"backup01","key":"backup01:nightly"}'
```

## Pages

| Path | Description |
|---|---|
| `/` | Main dashboard (login required) |
| `/onboarding` | First-run setup wizard when no admin account exists |
| `/status` | Public read-only summary (only when `publicStatus: true`) |
| `/settings` | Configuration |
| `/agents` | Connected agents, versions and update actions |
| `/topology` | Platform relationship map |
| `/profile` | Profile image, username, e-mail, password, passkeys and two-factor authentication |
| `/event-center` | Event Center: live log / warning / error stream plus audit and alert history, timeline, acknowledge and mute actions |
| `/about` | Version info and GitHub |

The sidebar footer also links to GitHub and opens a new issue form for help/bug reports.

## Security

- The `data/` folder and `.env` are git-ignored.
- All state lives in `./data/` (`config.yaml`, `secret.key`, `kube.bin`, `auth.yaml`, `sessions.yaml`, SSH keys) — it never leaves your machine.
- Login password is set on first run through the onboarding wizard. Passwords must be at least 8 characters and contain both an uppercase and a lowercase letter.
- Multi-user access is stored in `data/users.yaml` with `admin`, `operator` and `read-only` roles. Existing single-user `auth.yaml` installs are migrated automatically. New users created with a temporary password are forced to change it before accessing the dashboard.
- Passkeys and optional TOTP two-factor authentication can be enabled from the Profile page.
- Password reset by e-mail can be enabled or disabled by admins.
- Sessions use `HttpOnly`, `SameSite=Strict` cookies; login attempts are rate-limited.
- Mutating API requests are protected by same-origin checks, and browser security headers are enabled.
- Uploaded icons, kubeconfigs and certificates are size-limited; uploaded SVG icons are checked for active content.
- TLS verification is enabled by default for integrations. Use each platform's explicit self-signed/insecure option only when needed.
- Config secrets are encrypted at rest by default (see Encryption above).

## License

[MIT](LICENSE)
