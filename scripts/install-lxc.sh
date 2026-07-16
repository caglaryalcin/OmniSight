#!/usr/bin/env bash
# OmniSight native installer for Debian/Ubuntu (LXC or bare metal, no Docker).
# Run inside the container/VM as root:
#   bash install-lxc.sh              # install
#   bash install-lxc.sh --update     # update existing install
#
# Environment overrides:
#   OMNISIGHT_REPO    git repository to install from (default: upstream GitHub)
#   OMNISIGHT_BRANCH  branch/tag to check out                (default: main)
#   OMNISIGHT_DIR     install directory                      (default: /opt/omnisight)
#   OMNISIGHT_PORT    listen port                            (default: 3000)
#   NODE_MAJOR        Node.js major version from NodeSource  (default: 22)
set -euo pipefail

REPO="${OMNISIGHT_REPO:-https://github.com/caglaryalcin/OmniSight.git}"
BRANCH="${OMNISIGHT_BRANCH:-main}"
APP_DIR="${OMNISIGHT_DIR:-/opt/omnisight}"
PORT="${OMNISIGHT_PORT:-3000}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP_USER="omnisight"
SERVICE="omnisight"

msg()  { echo -e "\033[1;32m[omnisight]\033[0m $*"; }
fail() { echo -e "\033[1;31m[omnisight]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
command -v apt-get >/dev/null || fail "this installer supports Debian/Ubuntu (apt) only"

if [ "${1:-}" = "--update" ]; then
  [ -d "$APP_DIR/.git" ] || fail "no existing install in $APP_DIR"
  msg "updating $APP_DIR"
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  systemctl restart "$SERVICE"
  msg "updated and restarted"
  exit 0
fi

msg "installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl git gnupg

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  msg "installing Node.js $NODE_MAJOR (NodeSource)"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -yq nodejs
fi
msg "node $(node --version), npm $(npm --version)"

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

if [ -d "$APP_DIR/.git" ]; then
  fail "$APP_DIR already exists — use: bash install-lxc.sh --update"
fi
SAFE_REPO="$REPO"
if [[ "$SAFE_REPO" == *"@"* ]]; then SAFE_REPO="https://***@${SAFE_REPO#*@}"; fi
msg "cloning $SAFE_REPO ($BRANCH) into $APP_DIR"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"

msg "installing dependencies"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)

mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

msg "creating systemd service"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=OmniSight monitoring dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) --openssl-legacy-provider $APP_DIR/server.js
Environment=NODE_ENV=production
Environment=PORT=$PORT
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE"

sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  msg "OmniSight is running: http://${IP:-<host>}:$PORT"
  msg "update later with: bash $APP_DIR/scripts/install-lxc.sh --update"
else
  fail "service failed to start — check: journalctl -u $SERVICE -n 50"
fi
