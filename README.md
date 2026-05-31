# OmniSight

A simple, single-glance monitoring dashboard for Proxmox, Linux servers, Kubernetes, SNMP devices, Docker and Healthchecks.

## Features

- **Proxmox** — node CPU/RAM/temperature, VM/LXC and cluster service status (API Token)
- **Linux servers** — service status via SSH + `systemctl`, plus CPU/RAM (agentless)
- **Kubernetes** — pod / deployment / service status and live pod log viewer (kubeconfig)
- **SNMP** — status of any SNMP v2c/v3 device (Synology, switches, routers, …)
- **Docker** — container status, ports, unused (dangling) image count, live container log viewer. Local socket, remote TCP, or over SSH (socket-forward, with `docker ps` / `sudo` fallback)

![](https://raw.githubusercontent.com/caglaryalcin/OmniSight/refs/heads/main/screenshots/dashboard.png)

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
npm install
cp config.example.yaml config.yaml   # edit it
npm start
```

Dashboard: `http://localhost:3000`

## Quick start (Docker)

```bash
cp config.example.yaml config.yaml   # edit it
docker compose up -d --build
```

The provided `docker-compose.yml` mounts `config.yaml` and the `credentials/` folder (which holds `secret.key`, `kube.bin`, `auth.yaml`, `sessions.yaml` and any SSH keys). Standalone Docker using the published image:

```bash
docker run -d --name omnisight -p 3000:3000 \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -v $(pwd)/credentials:/app/credentials \
  ghcr.io/caglaryalcin/omnisight
```

To build the image yourself instead, replace the last line with `omnisight` after running `docker build -t omnisight .`.

### Pre-built image (CI/CD)

A GitHub Actions workflow (`.github/workflows/deploy.yml`) builds and pushes the image to GitHub Container Registry on every push to `main`/`master` and on `v*` tags:

```bash
docker pull ghcr.io/caglaryalcin/omnisight
```

### Docker Stack (Swarm)

Use the published image (Swarm ignores `build:`), then deploy the stack:

```bash
docker stack deploy -c docker-stack.yml omnisight
```

`docker-stack.yml` is a Swarm-ready compose file using `image: ghcr.io/caglaryalcin/omnisight:latest` instead of `build:`.

### Kubernetes

A ready-to-edit manifest lives in `deploy/kubernetes.yaml` (Deployment + Service + PVC):

```bash
kubectl create configmap omnisight-config --from-file=config.yaml
kubectl create secret generic omnisight-secret --from-literal=OMNISIGHT_SECRET=$(openssl rand -hex 32)
kubectl apply -f deploy/kubernetes.yaml
```

> **Docker path note:** Windows paths don't work inside the container. Put `kube.bin` and SSH keys in `./credentials/` and reference them with container paths, e.g. `kubeconfig: /app/credentials/kube.bin` and `privateKey: /app/credentials/id_ed25519`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `OMNISIGHT_ENCRYPT` | No | `true` | Config encryption is **enabled by default**. Set to `false` (or `0`/`off`/`no`) to disable. |
| `OMNISIGHT_SECRET` | No | auto | Encryption key. If unset, a random key is generated and stored in `credentials/secret.key` (auto-managed). Set this to use your own key (e.g. shared across instances). |

### Encryption

Encryption is on by default. Sensitive fields in `config.yaml` (`tokenSecret`, `password`, `apiKey`, `token`, `botToken`, `sshKey`, …) are stored encrypted (`enc:` prefix, AES-256-GCM) whenever the config is saved from the Settings page or via `npm run encrypt-config`.

- The key lives in `OMNISIGHT_SECRET` if set, otherwise in the auto-generated `credentials/secret.key` file.
- **Keep `credentials/secret.key` safe and persistent.** In Docker the whole `credentials/` folder is mounted as a volume — if the key is lost, previously encrypted values can no longer be decrypted.
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

All sections are optional; include only what you use. See `config.example.yaml`.

- `proxmox` — host, port, tokenId, tokenSecret, nodes[]
- `linux.servers[]` — name, host, port, user, privateKey **or** password, services[]
- `kubernetes` — kubeconfig, namespaces[]
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

- `config.yaml`, the `credentials/` folder (keys, kubeconfig, `auth.yaml`, `sessions.yaml`) and `.env` are git-ignored.
- Sensitive state lives in `./credentials/` (`secret.key`, `kube.bin`, `auth.yaml`, `sessions.yaml`, SSH keys) — it never leaves your machine.
- Login password is set on first run from `/profile`. Passwords must be at least 8 characters and contain both an uppercase and a lowercase letter.
- Config secrets are encrypted at rest by default (see Encryption above).

## License

[MIT](LICENSE)
