# OmniSight Documentation

OmniSight is a single-glance monitoring dashboard for Proxmox, Linux servers, Docker, Kubernetes, SNMP devices, Healthchecks, Uptime Kuma, Prometheus, Dockhand, firewalls, TrueNAS/QNAP/UGREEN storage, Proxmox Backup Server, Portainer, and databases.

This document explains what the platform is, how it works, where it stores state, how each integration is collected, how the agent and alert flows operate, how authentication and security are handled, and how to troubleshoot production issues.

## Table of Contents

- [1. Overview](#1-overview)
- [2. Architecture](#2-architecture)
- [3. Data Flow and Refresh Model](#3-data-flow-and-refresh-model)
- [4. Dashboard](#4-dashboard)
- [5. Platforms](#5-platforms)
- [6. Agent System](#6-agent-system)
- [7. Settings and Configuration](#7-settings-and-configuration)
- [8. Users, Roles, and Security](#8-users-roles-and-security)
- [9. Alerts and Event Center](#9-alerts-and-event-center)
- [10. Topology](#10-topology)
- [11. Backup, Restore, and Disaster Recovery](#11-backup-restore-and-disaster-recovery)
- [12. Demo, Production, and Deployment](#12-demo-production-and-deployment)
- [13. API and Integration Surface](#13-api-and-integration-surface)
- [14. Troubleshooting](#14-troubleshooting)
- [15. Operations Checklist](#15-operations-checklist)

## 1. Overview

OmniSight is a single-process monitoring application. The backend is Node.js + Express. The frontend is plain HTML/CSS/JavaScript without a framework. Platform collectors live under `src/`, static pages live under `public/`, and agent scripts live under `agent/`.

Primary goals:

- Show infrastructure health in one dashboard.
- Monitor Proxmox, Linux, Docker, Kubernetes, and external services through a shared UI model.
- Monitor systems behind NAT or firewalls using a push agent.
- Run service and container actions from the UI.
- Collect alert, audit, and runtime events in Event Center.
- Keep all persistent state inside one `data/` directory or volume.

Main pages:

| Path | Purpose |
|---|---|
| `/` | Main dashboard |
| `/settings` | Platform, user, security, alert, and backup configuration |
| `/agents` | Agent inventory, installed versions, update and repair actions |
| `/event-center` | Runtime logs, audit logs, alert history, and timelines |
| `/topology` | Platform, host, and workload relationship map |
| `/profile` | Profile, password, 2FA, and passkeys |
| `/status` | Public read-only status page |
| `/about` | Version and project information |

## 2. Architecture

The center of the application is `server.js`. It owns the Express server, authentication middleware, RBAC, static file serving, API endpoints, refresh scheduler, runtime cache, agent command channel, and alert dispatch.

### Main Layers

| Layer | Files | Responsibility |
|---|---|---|
| Runtime server | `server.js` | API, auth, RBAC, scheduler, cache, alerts, static serving |
| Frontend | `public/*.html`, `public/i18n.js` | Dashboard, Settings, Event Center, Agents, Topology, Profile |
| Agent | `agent/install.sh`, `agent/omnisight-agent.sh`, `agent/install-windows.ps1`, `agent/omnisight-agent.ps1` | Push reports and execute commands on Linux, Windows, Proxmox, and Docker hosts |
| Collectors | `src/*.js` | Platform-specific data collection |
| State | `data/` | Config, users, sessions, agents, history, certificates, icons |

### Collector Modules

| Module | Platform |
|---|---|
| `src/proxmox.js` | Proxmox API and SSH fallback |
| `src/agents.js` | Push agent reports and normalized Linux/Docker/Proxmox agent data |
| `src/docker.js` | Docker API/SSH hosts, logs, prune |
| `src/kubernetes.js` | Kubernetes pods, services, deployments, logs |
| `src/snmp.js` | SNMP v2c/v3 devices |
| `src/healthchecks.js` | Healthchecks API |
| `src/uptimekuma.js` | Uptime Kuma status page and socket history |
| `src/checks.js` | Built-in HTTP/TCP/Ping/DNS checks |
| `src/prometheus.js` | Prometheus targets |
| `src/dockhand.js` | Dockhand API |
| `src/firewall.js` | OPNsense gateways and compatible firewall APIs |
| `src/truenas.js` | TrueNAS SCALE/CORE storage appliances |
| `src/qnap.js` | QNAP QTS systems using official HTTP auth and File Station SID checks |
| `src/ugreen.js` | UGREEN UGOS Pro web endpoint reachability checks |
| `src/pbs.js` | Proxmox Backup Server management API |
| `src/veeam.js` | Veeam Backup & Replication REST API |
| `src/portainer.js` | Portainer instances and environments |
| `src/database.js` | PostgreSQL, MySQL/MariaDB, MongoDB |
| `src/alerts.js` | ntfy, Telegram, Mattermost, SMTP dispatch |
| `src/crypto.js` | Config secret encryption/decryption |
| `src/historyStore.js` | History map load/save and delayed flushing |

### Persistent Files

| File or Directory | Content |
|---|---|
| `data/config.yaml` | Platform settings, alert channels, UI/performance/security settings |
| `data/users.yaml` | Users, roles, password hashes, 2FA/passkey/profile data |
| `data/auth.yaml` | Legacy single-user auth data |
| `data/sessions.yaml` | Active session tokens and metadata |
| `data/agents.yaml` | Agent IDs, host metadata, last seen time |
| `data/secret.key` | Config encryption key |
| `data/certs/` | Trusted CA certificates |
| `data/icons/` | Uploaded platform icons |
| `data/*history*` | Graph and heartbeat history |
| `data/runtime-snapshot.json` | Runtime snapshot |

## 3. Data Flow and Refresh Model

OmniSight does not collect from every system on every dashboard request. The backend keeps a runtime cache and refreshes platform collectors on a schedule.

### Flow

1. The frontend reads state from `/api/status`, `/api/status/dashboard`, or `/api/status/stream`.
2. The backend tracks refresh state per platform: `inFlight`, `nextDue`, `failures`, `lastStarted`, and `lastFinished`.
3. A collector runs and normalizes platform data.
4. The runtime cache is updated, and history points are queued for persistence.
5. The alert engine evaluates state transitions and thresholds against the new cache.
6. The frontend renders dashboard cards and detail views.

### Refresh Behavior

- The default refresh interval is 15 seconds.
- Platform-specific refresh intervals can be configured.
- Collector concurrency is controlled through performance settings.
- Failed collectors use backoff.
- Docker and Proxmox can temporarily keep the previous healthy result during short refresh failures.
- Low I/O mode flushes history and agent state less often to reduce disk writes.

### SSE Stream

`/api/status/stream` uses Server-Sent Events. The frontend receives update, refresh, and snapshot events so it can react to runtime changes alongside normal refresh requests.

## 4. Dashboard

The dashboard is designed for fast operational scanning.

### Main Parts

- Top KPI cards: CPU, Memory, Disk I/O, Bandwidth.
- Platform cards: Proxmox, Linux, Docker, Kubernetes, SNMP, Healthchecks, Uptime Kuma, Checks, Prometheus, Dockhand, Firewalls, TrueNAS, QNAP, Ugreen, Proxmox Backup, Cloudflare, GitHub/GitLab CI, Portainer, Database.
- Optional side panel for active alerts and recent logs.
- Global health badge.
- Public status link.
- Command palette and global search.

### Card Behavior

- Cards can be reordered with drag-and-drop.
- Cards can be collapsed or expanded.
- Hidden platforms show a compact hidden-platform bar at the top of the dashboard.
- The restore button brings hidden platforms back.
- Clicking a platform card opens its detail view.
- The detail header reuses the compact summary counters from the dashboard card.

### Health Model

Each platform translates domain-specific signals into dashboard health:

- Linux: offline host, failed or inactive service.
- Proxmox: offline node, failed service, Ceph warning/error, resource issues.
- Docker: offline host, stopped or failed container, update/image signals.
- Kubernetes: failed or pending pod, deployment mismatch.
- Healthchecks: down or grace.
- Uptime Kuma: down monitor.
- Checks: down check.
- Prometheus: down target or instance.
- Firewalls: unreachable gateway, partial endpoint data, link warnings, pending updates, or reboot-required signal.
- TrueNAS: unreachable appliance, partial endpoint data, pool warnings, disk warnings, or critical appliance alerts.
- QNAP/UGREEN: unreachable appliance or endpoint warnings.
- Proxmox Backup Server: unreachable backup server, partial endpoint data, datastore warnings, or failed tasks.
- Cloudflare: API unreachable, partial endpoint data, inactive/paused zones, or down Cloudflare Tunnel connections.
- GitHub/GitLab CI: API unreachable, partial endpoint data, failed workflow runs, failed pipelines, or failed jobs.
- Portainer: unreachable instance, partial endpoint data, down environments, or stack warnings.
- Database: offline database or connection problem.

Excluded services do not degrade health and do not generate alerts.

## 5. Platforms

### Proxmox

Proxmox can be collected in two main ways:

- Proxmox API token: central pull model.
- Proxmox node agent: push model using local `pvesh` and host commands.

Optional SSH metrics fallback can fill metrics that the API does not expose.

Collected data:

- Node online/offline state.
- CPU, RAM, uptime.
- CPU/System/NVMe temperatures.
- Disk I/O and bandwidth.
- VM/LXC list, status, CPU/RAM.
- Node storage usage.
- Last vzdump backup status.
- Systemd service status and actions.
- SMART/NVMe disk health, model, serial, firmware, temperature, power-on hours, media errors.
- Ceph health, checks, OSD total/up/in, usage percentage.

Notes:

- The Proxmox API does not always expose host sensors. NVMe SMART, CPU temperature, or host Disk I/O may require the agent or SSH fallback.
- If a Proxmox agent exists, that host is filtered out of the Linux card to avoid duplicate display.
- Mini charts intentionally stay compact; detailed disk and health data is available in the detail view.

### Linux Server

Linux data comes from push agent reports.

Collected data:

- Hostname, IP, OS, kernel.
- CPU, RAM, swap, load.
- Root disk usage.
- Disk I/O.
- Bandwidth.
- Temperatures.
- Uptime.
- Systemd services.

Service actions:

- Status.
- Start.
- Stop.
- Restart.
- Exclude/Include.

Offline behavior:

- A host is marked offline when the agent stops reporting.
- The offline window is based on the agent interval.
- When the agent reports again, the host returns online.

### Cloudflare

Cloudflare uses the official API with a scoped API token. OmniSight reads zones, optional Cloudflare Tunnel connection state, and optional Cloudflare Registrar domain expiration. Tunnel monitoring needs `accountId` and Cloudflare Tunnel read access for that account. Domain expiration needs `accountId` plus Cloudflare Registrar read access and only applies to domains registered with Cloudflare Registrar.

Recommended config:

```yaml
cloudflare:
  enabled: true
  apiToken: "${CLOUDFLARE_API_TOKEN}"
  accountId: "your-account-id"
  includeTunnels: true
  includeRegistrarDomains: true
  domainExpiryWarningDays: 30
  zones:
    - example.com
```

Collected data:

- Zone active/paused/pending status.
- Cloudflare Tunnel status and active connection counts when an account ID is configured.
- Cloudflare Registrar domain expiration date, auto-renew state and expiring/expired warnings when enabled.
- Partial API errors when optional tunnel or registrar permissions are missing.

### GitHub/GitLab CI

GitHub/GitLab CI uses read-only API collection for repository/project build status. GitHub projects read Actions workflow runs. GitLab projects read pipelines and can optionally read recent pipeline jobs.

Recommended config:

```yaml
cicd:
  enabled: true
  projects:
    - name: App GitHub
      provider: github
      repo: "owner/repo"
      branch: main
      token: "${GITHUB_TOKEN}"
    - name: App GitLab
      provider: gitlab
      baseUrl: "https://gitlab.com"
      projectId: "group/project"
      branch: main
      token: "${GITLAB_TOKEN}"
      includeJobs: true
```

Collected data:

- GitHub Actions recent workflow runs.
- GitLab recent project pipelines.
- GitLab jobs for recent pipelines when enabled.
- Running, failed, canceled and successful run counts.

### Veeam

Veeam monitoring uses the Veeam Backup & Replication REST API. OmniSight authenticates with the password grant unless an access token is supplied, then reads jobs, recent sessions and backup repositories.

Recommended config:

```yaml
veeam:
  enabled: true
  instances:
    - name: VBR
      url: "https://veeam.example.com:9419"
      username: "DOMAIN\\monitoring"
      password: "${VEEAM_PASSWORD}"
      apiVersion: "1.3-rev1"
      insecureTLS: false
```

Collected data:

- VBR server online/offline state.
- Job list, disabled job count and last-run fields when exposed.
- Recent backup sessions with running, warning and failed states.
- Backup repository state and usage percentage when exposed.
- Partial API errors when optional job, session or repository endpoints are unavailable.
- Partial API errors when jobs are unavailable but pipelines are readable.

### Docker

Docker can be collected from three sources:

- Agent.
- Docker API host.
- SSH host running Docker CLI.

Collected data:

- Host online/offline state.
- Container state.
- Running/stopped/pending/failed summaries.
- Container CPU/RAM.
- Network I/O.
- Block I/O.
- Ports.
- Image update status.
- Unused image count.
- Live container logs.
- Prune action.

Dashboard summaries hide stopped, pending, and failed counters when they are zero.

### Kubernetes

Kubernetes uses a kubeconfig to connect to the cluster API.

Collected data:

- Pods.
- Deployments.
- Services.
- Namespace summaries.
- Pod status.
- Restart count.
- Pod logs.
- CPU/RAM when the Metrics API is available.

Namespace filters are configured in Settings. If credentials lack permission for a resource, OmniSight shows only the data that the API allows.

### SNMP

SNMP v2c and v3 are supported.

Collected data depends on the device:

- System info.
- CPU.
- RAM.
- Temperature.
- Disk/volume status.
- Network bandwidth.
- Disk I/O.
- Device health.

Synology, UniFi, switches, routers, and generic SNMP devices are interpreted through different OID sets.

### UniFi Network (controller)

UniFi controllers are monitored through the official **Integration API** (UniFi Network application 9.3+), authenticated with a stateless `X-API-KEY`. Create the key on the console under **Settings → Control Plane → Integrations**. Both UniFi OS consoles (`/proxy/network/integration/v1`) and self-hosted Network applications (`/v1`) are supported — the base path is detected automatically.

Collected data:

- Device inventory per site with semantic states (`online`, `offline`, `updating`, `adopting`, …), model and firmware version.
- Per-device CPU, memory and uptime (sampled every 4th refresh to keep controller load low).
- Gateway WAN state and uplink throughput.
- WAN latency and packet loss — **requires the optional legacy credentials** (see below).
- WAN up/down history series, rendered as an availability strip and "WAN down HH:MM–HH:MM" annotations.

WAN quality (latency/packet loss) is not exposed by the Integration API, so OmniSight can additionally query the classic API's `stat/health` endpoint. Configure a **dedicated local controller account** for this: local-only, read-only role, and **MFA-exempt** — accounts with MFA cannot log in headlessly. Without legacy credentials the platform still works; the card simply omits latency/loss. If legacy authentication starts failing, WAN quality degrades gracefully after 3 consecutive attempts and recovers automatically.

Alert semantics:

- Device `OFFLINE` (controller-reported) alerts only for devices that are **not** also monitored over SNMP — for SNMP-covered devices the SNMP down-alert remains the pager because it detects raw unreachability faster than the controller's heartbeat timeout (which adds 1–5 minutes).
- While the controller reports a device as `updating`/`adopting`, its SNMP down-alert is suppressed so scheduled firmware upgrades do not page.
- WAN Up→Down alerts with a 120-second duration rule (`alerts.rules.unifi`); an opt-in WAN latency threshold is available via `alerts.thresholds.wanLatency` (milliseconds).
- Note: if your alert channel (Mattermost, ntfy, Telegram) is reached **over the monitored WAN**, a WAN-down alert cannot be delivered until the WAN recovers — use a LAN-local channel for WAN alerting.

UniFi devices monitored over SNMP (profile `unifi`) and controller-reported devices render in **one merged UniFi card**: controller rows first (offline devices always on top), with matching SNMP detail embedded in each row's expanded view. Rate limiting (HTTP 429) is handled per controller instance with a cooldown that serves the last good data. Multiple controllers and multiple sites per controller are supported — add one instance per site.

### Healthchecks

Healthchecks reads cron/job status through the Healthchecks API.

States:

- `up`
- `down`
- `grace`
- `paused`

Grace is treated as warning. Down is treated as a critical problem.

### Uptime Kuma

Uptime Kuma reads monitor and heartbeat history through a status page slug or optional auth configuration.

States:

- Up.
- Down.
- Pending.
- Maintenance.
- Unknown.

Heartbeat bars are generated from available monitor history.

### Built-in Checks

Built-in checks remove the need for a separate external service for simple probes.

Check types:

- HTTP/HTTPS.
- TCP.
- Ping.
- DNS.

Each check keeps status, latency, and heartbeat history.

### Prometheus

Prometheus collection reads instance and target health.

Collected data:

- Instance online/offline state.
- Target up/down/unknown state.
- Target grouping.
- Last error.

Multiple Prometheus instances are supported.

### Dockhand

Dockhand API instances are monitored as a first-class platform.

Collected data:

- Instance connectivity.
- Environment.
- Container state.
- Container logs.

### Firewalls

Firewall gateways are monitored as a first-class platform. OPNsense uses its built-in API key/secret authentication. pfSense entries are supported when the target exposes a compatible REST API surface.

Collected data:

- Gateway online/offline state.
- Hostname, version, CPU, memory, update count, and reboot-required signals when exposed.
- Interface/link state, addresses, descriptions, and counters when permitted.
- Packet-filter state counts when permitted.

If an optional endpoint is unavailable or forbidden, the instance remains online with partial data instead of failing the whole platform.

### TrueNAS

Supported modes:

- WebSocket JSON-RPC for current TrueNAS SCALE releases.
- REST v2.0 fallback for older TrueNAS CORE/SCALE deployments.
- `apiMode: auto` tries WebSocket first and falls back to REST.

Collected data:

- Appliance online/offline state.
- Hostname, version, model, load and memory capacity when exposed.
- Pool health, size, used/free percentage and scan state when exposed.
- Disk status, model, size and temperature when exposed.
- Active TrueNAS alerts.

If a pool, disk, alert or update endpoint is forbidden or unavailable, the appliance remains online with partial data so one missing permission does not hide the whole storage system.

### QNAP

QNAP systems use the official QTS HTTP API login flow (`authLogin.cgi`) and validate the returned session with the File Station `check_sid` request. Configure a monitoring user with username/password, or provide an existing SID/token when you want OmniSight to skip login.

Collected data:

- Appliance online/offline state.
- Configured system name and URL.
- Session validation status from the QTS/File Station HTTP API.

### UGREEN

UGREEN publishes product documentation and downloads, but does not currently expose a stable public UGOS Pro monitoring API. OmniSight therefore treats UGREEN entries as web reachability checks for the configured UGOS Pro endpoint.

Collected data:

- Endpoint online/offline state.
- HTTP status code when reachable.
- Configured system name and URL.

### Proxmox Backup Server

Collected data:

- Backup server online/offline state.
- Version and node status when exposed.
- Datastore capacity, usage percentage, groups and snapshot counts when exposed.
- Recent task status.

Use a Proxmox Backup Server API token in `PBSAPIToken` format. If datastore status or task endpoints are forbidden, the server remains online with partial data.

### Portainer

Collected data:

- Portainer instance online/offline state and version when exposed.
- Environment list and environment status.
- Stack count and warning state when exposed.
- Lightweight Docker container summaries for Docker-compatible environments when permitted.

Use a Portainer access token. If a user lacks permission for stacks or Docker gateway endpoints, the Portainer instance remains online with partial data.

### Databases

Supported databases:

- PostgreSQL.
- MySQL.
- MariaDB.
- MongoDB.

Collected data:

- Up/down.
- Version.
- Active connections.
- Max connections.
- Database size.

If the monitoring user lacks permission for connection or size metrics, those fields may be omitted while basic availability still works.

## 6. Agent System

The agent is a small bash script that runs on a target system. It does not require inbound ports. It reports to OmniSight through outbound HTTP(S).

### Installation Model

Use one of these Settings actions:

- Linux Server -> Add System.
- Proxmox -> Add Node.
- Docker -> Add Host.

Supported installation modes:

- Binary/systemd.
- Docker container.
- Docker Stack/Swarm.

Example binary installation:

```bash
curl -fsSL https://omnisight.example/agent/install.sh | \
  sudo OMNISIGHT_URL=https://omnisight.example OMNISIGHT_TOKEN=<token> bash
```

For self-signed TLS:

```bash
curl -fsSL --insecure https://omnisight.example/agent/install.sh | \
  sudo OMNISIGHT_URL=https://omnisight.example OMNISIGHT_TOKEN=<token> OMNISIGHT_INSECURE_TLS=1 bash
```

### Agent Endpoints

| Endpoint | Purpose |
|---|---|
| `/api/agent/ping` | Token and dashboard reachability test |
| `/api/agent/report` | Metric and inventory report ingest |
| `/api/agent/commands` | Long-poll command channel |
| `/api/agent/result` | Command result upload |

### Command Channel

When the UI starts an action such as service restart, Docker logs, Docker prune, or agent update:

1. The backend creates a pending command in `src/agents.js`.
2. The agent receives the command through long-polling.
3. The command runs locally on the target host.
4. The agent sends stdout/stderr back to `/api/agent/result`.
5. The UI displays the result.

### Agent Roles

| Role | Behavior |
|---|---|
| `linux` | System metrics and systemd services |
| `windows` | Windows host metrics and Windows services |
| `proxmox` | Linux metrics plus Proxmox `pvesh`, VM/LXC, storage, Ceph, backup, SMART |
| `docker` | Docker host/container metrics, logs, prune |

### Repair Logic

The repair command shown on the Agents page:

- Reads the current `/etc/omnisight-agent/agent.env`.
- Preserves the agent ID.
- Downloads the install script using the current dashboard URL and token.
- Reinstalls the agent script.
- Restarts the systemd service.

If the service does not exist, the install script recreates the systemd unit.

## 7. Settings and Configuration

The Settings page is the UI representation of `data/config.yaml`.

### Main Sections

| Section | Purpose |
|---|---|
| System | Timezone, time format, default period, history retention, low I/O, language, side panel, backup |
| Users & roles | Users, roles, password reset setting |
| Sessions & access | Active sessions, browser/IP, force sign out, public IP allowlist |
| Certificates | CA upload and trust store |
| Platform cards | Proxmox, Linux, Kubernetes, SNMP, Healthchecks, Uptime Kuma, Checks, Prometheus, Docker, Dockhand, Database |
| Alerts | Thresholds, alert timing, anomaly detection, maintenance windows, webhook, notification channels |

### Config Save Behavior

- An empty masked secret field does not erase the existing secret.
- Sensitive fields are encrypted when config encryption is enabled.
- `ui` and `topology` sidecar settings may be stored separately.
- Save & Apply reshapes the runtime cache according to the new configuration.

### Config Encryption

Config encryption is enabled by default.

- Key source: `OMNISIGHT_SECRET` or `data/secret.key`.
- Algorithm: AES-256-GCM.
- Encrypted fields include token, password, apiKey, tokenSecret, botToken, sshKey, and similar sensitive values.

If `data/secret.key` is lost, previously encrypted secrets cannot be decrypted.

## 8. Users, Roles, and Security

### Roles

| Role | Permissions |
|---|---|
| admin | Full settings, user/session management, agent repair, config import/export |
| operator | Operational actions, alert ack/mute, own profile |
| read-only | Read-only access; secrets and sensitive fields are redacted |

### Authentication

- On first run, onboarding creates the initial admin user.
- Login-page self-registration creates read-only users only and can be disabled by admins.
- Passwords are stored as salted hashes.
- Login attempts are rate-limited.
- Cookies are `HttpOnly` and `SameSite=Strict`.
- TOTP 2FA is optional.
- Passkeys are supported.
- Users created with temporary passwords must change their password before continuing to the dashboard.

### Sessions & Access

The Sessions & access section in Settings:

- Lists active login sessions.
- Shows username, browser, User-Agent, IP, public IP, created time, expiry time, and last seen time.
- Allows admins to force sign out a session.
- Force sign out deletes the token; the user must log in again with password and 2FA if enabled.
- If Allowed public IPs is non-empty, the platform can only be accessed from those public IPs.
- The backend refuses to save a non-empty allowlist that does not include the current admin public IP, preventing accidental lockout.

## 9. Alerts and Event Center

The alert engine evaluates runtime cache data for problems and recoveries.

### Alert Sources

- Platform down/up.
- Host offline/online.
- Service failed/recovered.
- Docker container stopped/failed.
- Kubernetes pod failed/pending.
- Prometheus target down.
- Healthchecks down/grace.
- CPU/RAM/disk resource thresholds.
- CPU/RAM anomaly detection.
- Webhook events.

Alert settings can define `durationSeconds` per category. `rules.default` defaults to 60 seconds and applies to checks without a more specific rule, such as Proxmox service state or Prometheus instance reachability. Set it to `0` for immediate notifications.

### Notification Channels

- ntfy.
- Telegram.
- Mattermost (incoming webhook; payload is Slack/Rocket.Chat compatible).
- SMTP.

### Cooldown and Duplicate Suppression

Notifications use an event signature and cooldown so the same problem is not sent repeatedly. The default cooldown is one hour.

Environment override:

```bash
OMNISIGHT_ALERT_COOLDOWN_MS=3600000
```

### Event Center

Event Center combines:

- Runtime logs.
- Audit events.
- Alert history.
- Alert timeline.
- Acknowledge.
- Temporary mute/unmute.

Admins can export audit events from `/api/audit/export?format=json|csv|syslog`.
`since` and `limit` query parameters are supported for incremental exports.

### Webhook Events

External systems can post events:

```bash
curl -fsS https://omnisight.example/api/webhook/event \
  -H "Authorization: Bearer <webhook-token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Backup failed","severity":"critical","source":"backup01","key":"backup01:nightly"}'
```

## 10. Topology

Topology visualizes relationships between platforms, hosts, and workloads.

Features:

- Platform nodes.
- Host/workload nodes.
- Manually editable links.
- Persistent positions.
- Status colors based on dashboard health data.

Topology configuration is stored as sidecar state so layout data can be managed separately from platform configuration.

## 11. Backup, Restore, and Disaster Recovery

### Backup Types

| Type | Content |
|---|---|
| Config backup | `config.yaml` and platform settings |
| Full backup | Users, secret key, certificates, icons, history, and important data files |

### Restore Behavior

- Config restore replaces settings.
- Full restore clears sessions.
- After full restore, the user should return to the login screen.
- Restarting OmniSight after restore is recommended.

### Disaster Recovery Flow

1. Stop OmniSight.
2. Restore the `data/` volume.
3. Confirm that `data/secret.key` was restored.
4. Start OmniSight.
5. Log in.
6. Check Settings, Agents, and Event Center.

## 12. Demo, Production, and Deployment

### Local Node

```bash
npm install
npm start
```

Default ports:

- Production dashboard: `3000`.
- Demo listener: `4000` when enabled.

### Native (LXC / bare metal, systemd)

Run OmniSight directly under `systemd` with no Docker. Two scripts in `scripts/` cover this, and both default to the upstream repository — every environment-specific value is an environment-variable override, so the same scripts work unchanged across installations.

**Inside any Debian/Ubuntu container, VM, or bare-metal host** — `scripts/install-lxc.sh` (run as root) installs Node.js (NodeSource, major 22 by default), clones the repo to `/opt/omnisight`, runs `npm ci --omit=dev`, creates the unprivileged `omnisight` system user, and installs + starts a hardened systemd unit:

```bash
bash scripts/install-lxc.sh                          # fresh install
bash /opt/omnisight/scripts/install-lxc.sh --update  # update in place, later
```

Or one-liner from a running dashboard host:

```bash
curl -fsSL https://raw.githubusercontent.com/caglaryalcin/OmniSight/main/scripts/install-lxc.sh | sudo bash
```

**On a Proxmox VE 8/9 host** — `scripts/proxmox-lxc.sh` (run as root on the host) additionally *creates* an unprivileged Ubuntu 24.04 LXC (nesting enabled), waits for network, then runs `install-lxc.sh` inside it. Interactive by default; set the env vars to run unattended.

```bash
bash scripts/proxmox-lxc.sh
CTID=150 CT_HOSTNAME=mon STORAGE=tank BRIDGE=vmbr1 bash scripts/proxmox-lxc.sh   # unattended
```

**Environment overrides:**

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `OMNISIGHT_REPO` | both | `https://github.com/caglaryalcin/OmniSight.git` | Source git repo (fork or mirror). Private repos: embed a token, or use `OMNISIGHT_TOKEN`/`OMNISIGHT_TOKEN_USER` on the Proxmox wrapper |
| `OMNISIGHT_BRANCH` | both | `main` | Branch or tag to check out |
| `OMNISIGHT_DIR` | install | `/opt/omnisight` | Install directory |
| `OMNISIGHT_PORT` | both | `3000` | Listen port |
| `NODE_MAJOR` | install | `22` | Node.js major version (NodeSource) |
| `CTID` `CT_HOSTNAME` `STORAGE` `TEMPLATE_STORAGE` `DISK_GB` `MEMORY_MB` `CORES` `BRIDGE` `NET_CONF` | proxmox | next free ID, `omnisight`, `local-lvm`, `local`, 6, 1024, 2, `vmbr0`, DHCP | LXC shape and placement (stock Proxmox conventions) |

**`--update` semantics.** `install-lxc.sh --update` runs `git fetch --all` then `git reset --hard origin/$OMNISIGHT_BRANCH`, reinstalls production deps, `chown`s to `omnisight`, and restarts the service. The hard reset **discards any local edits** in the install directory — carry local patches on a branch/fork and point `OMNISIGHT_BRANCH`/the checkout's `origin` at it rather than editing in place.

**Systemd unit.** Runs as `User=omnisight`, `ExecStart=node --openssl-legacy-provider server.js` (the legacy OpenSSL provider flag is required), `Restart=on-failure`. Hardened with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, and `ReadWritePaths=$APP_DIR/data` — so at runtime the process can only write to `data/` (the only state that must survive redeploys). Manage with `systemctl status|restart omnisight` and `journalctl -u omnisight`.

**Supported scope.** The installer targets Debian/Ubuntu (`apt` + NodeSource) and requires Node 20+. On other distributions do the equivalent by hand: install Node ≥ 20, `git clone` the repo, `npm ci --omit=dev`, then create a `systemd` unit mirroring the one above (same `ExecStart`, `NODE_ENV=production`, and `ReadWritePaths` for `data/`).

### Docker

```bash
docker compose up -d
```

The critical requirement is a persistent `data/` volume.

### Kubernetes

`deploy/kubernetes.yaml` contains PVC, Deployment, and Service definitions.

Check these before production use:

- Image tag.
- PVC.
- Service port.
- Optional health endpoint: `/healthz`.
- Optional readiness diagnostic endpoint: `/readyz`.
- `OMNISIGHT_SECRET` as a Secret if required.
- CA handling through `data/certs/` or `NODE_EXTRA_CA_CERTS` when needed.

### Cache Behavior

To avoid stale UI after production deploys:

- HTML responses use no-store/no-cache.
- `sw.js` clears old caches and behaves network-only.
- JS/CSS are revalidated.

This reduces the need for Ctrl+F5 after updates.

## 13. API and Integration Surface

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Lightweight health endpoint; confirms the Node.js process is responding |
| `GET /readyz` | Readiness diagnostic endpoint; confirms the data volume and core state files are readable/writable |
| `GET /api/status` | Full runtime status |
| `GET /api/status/dashboard` | Dashboard-optimized status |
| `GET /api/status/summary` | Lightweight summary |
| `GET /api/status/stream` | SSE status stream |
| `GET /api/config` | Read config |
| `POST /api/config` | Save config |
| `GET /api/settings/status` | Slim status for Settings |
| `GET /api/settings/agents` | Agent rows for Settings |
| `GET /api/agents` | Agents page inventory |
| `GET /api/agent/repair-commands` | Admin repair commands |
| `POST /api/agent/report` | Agent report ingest |
| `GET /api/agent/commands` | Agent long-poll commands |
| `POST /api/agent/result` | Agent command result |
| `POST /api/webhook/event` | External event ingest |
| `GET /api/public/status` | Public status data |
| `GET /api/about` | Version and author information |

Authenticated endpoints require the session cookie or an `x-session-token` header. Agent endpoints are protected by `X-Agent-Token`. Webhook events are protected by bearer/webhook token.

## 14. Troubleshooting

### Agent Offline

On the target host:

```bash
sudo systemctl status omnisight-agent --no-pager -l
sudo journalctl -u omnisight-agent -n 120 --no-pager
```

Dashboard reachability test:

```bash
sudo bash -lc 'set -a; . /etc/omnisight-agent/agent.env; set +a; printf "{\"id\":\"%s\"}" "$OMNISIGHT_AGENT_ID" > /tmp/os-ping.json; curl -k -sS -w "\nhttp=%{http_code} time=%{time_total}s\n" -H "X-Agent-Token: $OMNISIGHT_TOKEN" -H "Content-Type: application/json" --data-binary @/tmp/os-ping.json "$OMNISIGHT_URL/api/agent/ping"'
```

Check:

- Is the token correct?
- Is the URL correct?
- Is there a TLS CA problem?
- Does DNS resolve?
- Is the dashboard pod/container restarting?
- Was the OS reinstalled and the agent env lost?

### Missing Proxmox Metrics

- Check API token permissions.
- Check whether the Proxmox API exposes that metric.
- Install the agent or SSH fallback for NVMe/SMART/CPU temperature.
- For Ceph, validate `ceph status` and `ceph df` on the node.

### Missing Docker Data

- In agent mode, is the Docker socket mounted?
- Does the agent container include Docker CLI?
- In API mode, are TLS and insecure settings correct?
- In SSH mode, can the user run Docker commands?

### Missing Kubernetes Data

- Is the kubeconfig path correct?
- Does the account have permission for the namespace and resource?
- If Metrics API is missing, CPU/RAM metrics may not appear.

### Stale UI After Deploy

- Confirm that the new image includes the cache fix.
- Confirm that the old service worker updated to the new `sw.js`.
- Check whether a reverse proxy is caching HTML.
- Check ingress/CDN cache rules for HTML pages.

### Force Sign Out Does Not Work

- Confirm the Settings page is current.
- In browser Network, `DELETE /api/sessions/<token>` should return 200.
- Non-admin users receive 403.
- Once deleted, the target user is redirected to login on the next authenticated request.

### Repeated Notifications

- Is the alert key/signature stable?
- What is the cooldown env value?
- Is alert history persisted across restarts?
- If the problem recovered and then failed again, it is treated as a new event.

## 15. Operations Checklist

### Before Production

- `data/` volume is persistent.
- `data/secret.key` is backed up.
- `/healthz` responds from inside the container.
- `/readyz` responds from inside the container when the data volume is healthy.
- TLS/CA is correct.
- Agent token exists.
- Config or full backup exists.
- Reverse proxy does not cache HTML.
- If public IP allowlist is enabled, the current admin IP is included.

### Adding a New Platform

1. Enable the platform in Settings.
2. Enter credentials, TLS, and icon settings.
3. Save & Apply.
4. Check the dashboard dot color.
5. Check Event Center runtime logs.
6. Send a test alert if alerts are configured.

### After Restore

1. Return to the login screen.
2. Log in as admin.
3. Check Settings.
4. Check agent online state.
5. Check Event Center for errors.
6. Restart the app/pod if runtime state looks stale.

### Agent Maintenance

- Check versions on the Agents page.
- Use Update for outdated agents.
- Use Query Agent for offline agents.
- If the OS was reinstalled, reinstall the agent; pass `OMNISIGHT_AGENT_ID` if the old identity must be preserved.

