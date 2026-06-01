# OmniSight

![Status](https://img.shields.io/badge/status-beta-orange) [![Latest Release](https://img.shields.io/github/v/release/caglaryalcin/OmniSight?include_prereleases&color=blue)](https://github.com/caglaryalcin/OmniSight/releases)

A simple, single-glance monitoring dashboard for Proxmox, Linux servers, Kubernetes, SNMP devices, Docker and Healthchecks.

## Features

- **Proxmox** — node CPU/RAM/temperature, VM/LXC and cluster service status (API Token)
- **Linux servers** — service status via SSH + `systemctl`, plus CPU/RAM (agentless)
- **Kubernetes** — pod / deployment / service status and live pod log viewer (kubeconfig)
- **SNMP** — status of any SNMP v2c/v3 device (Synology, switches, routers, …)
- **Docker** — container status, ports, unused (dangling) image count, live container log viewer. Local socket, remote TCP, or over SSH (socket-forward, with `docker ps` / `sudo` fallback)

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/dashboard.png)

> Highlight support for container and pod logs

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/container-logs.png)

- **Healthchecks** — cron monitoring status
- **Alerts** — notifications on state changes (down/up) via **ntfy**, **Telegram** and **SMTP**
- **Public status** — Uptime-Kuma-style, read-only public summary page (`/status`)

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/public-page.png)

- **Logs** — live application log/warning/error stream at `/logs`

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/logs.png)

- Dark / light theme, global health badge in the header, live configuration from the Settings page

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/light-dark.png)

## Stack

Node.js + Express backend · single-file vanilla HTML/CSS/JS frontend (no framework).

## Quick start (Node.js)

```bash
git clone https://github.com/caglaryalcin/OmniSight.git
cd OmniSight
npm install
npm start
```

Dashboard: `http://localhost:3000` — the app starts with no config; set up your account and configure platforms from the Settings UI.

## Quick start (Docker)

```bash
docker compose up -d --build
```

Nothing to pre-create. The single `data/` directory holds all state (`config.yaml`, `secret.key`, `auth.yaml`, `sessions.yaml`, `kube.bin`, SSH keys); Docker auto-creates it and it persists across restarts. The app starts empty — set up your account and configure platforms from the Settings UI. Standalone Docker using the published image:

```bash
docker run -d --name omnisight -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  ghcr.io/caglaryalcin/omnisight
```

To build the image yourself instead, run `docker build -t omnisight .` and replace the last line with `omnisight`.

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

> **Docker path note:** Windows paths don't work inside the container. Put `kube.bin` and SSH keys in `./data/` and reference them with container paths, e.g. `kubeconfig: /app/data/kube.bin` and `privateKey: /app/data/id_ed25519`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `OMNISIGHT_ENCRYPT` | No | `true` | Config encryption is **enabled by default**. Set to `false` (or `0`/`off`/`no`) to disable. |
| `OMNISIGHT_SECRET` | No | auto | Encryption key. If unset, a random key is generated and stored in `data/secret.key` (auto-managed). Set this to use your own key (e.g. shared across instances). |

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

## Configuration (config.yaml)

The live config is `data/config.yaml` (created automatically on first save). Easiest is to configure everything from the Settings UI; to hand-edit, copy the template — `cp config.example.yaml data/config.yaml` — and edit it. All sections are optional; include only what you use. See `config.example.yaml`.

- `proxmox` — host, port, tokenId, tokenSecret, nodes[]
- `linux.servers[]` — name, host, port, user, privateKey **or** password, services[]
- `kubernetes` — kubeconfig, namespaces[] (the Settings UI has a **Browse…** button that uploads a kubeconfig from your machine into `data/` and fills in the container path automatically)
- `snmp.devices[]` — SNMP v2c (community) or v3 (username, authPassword, privPassword, …)
- `healthchecks` — url, apiKey
- `docker.hosts[]` — `type: socket | tcp | ssh` (for SSH: sshHost/sshUser + privateKey/sshPassword, optional `sudo`)
- `alerts` — `enabled` + `ntfy` / `telegram` / `smtp` channels
- `publicStatus: true` and `publicTitle` — expose the `/status` page publicly

### Alerts example

```yaml
alerts:
  enabled: true
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

Notifications are sent only on **state changes** (running→down = DOWN, down→running = UP). Pre-existing problems at startup do not trigger a flood. Each channel can be tested individually from the Settings page.

## Pages

| Path | Description |
|---|---|
| `/` | Main dashboard (login required) |
| `/status` | Public read-only summary (only when `publicStatus: true`) |
| `/settings` | Configuration |
| `/profile` | Username / password |
| `/logs` | Live log / warning / error stream |
| `/about`, `/help` | Version info and GitHub |

## Security

- The `data/` folder and `.env` are git-ignored.
- All state lives in `./data/` (`config.yaml`, `secret.key`, `kube.bin`, `auth.yaml`, `sessions.yaml`, SSH keys) — it never leaves your machine.
- Login password is set on first run from `/profile`. Passwords must be at least 8 characters and contain both an uppercase and a lowercase letter.
- Config secrets are encrypted at rest by default (see Encryption above).

## License

[MIT](LICENSE)
