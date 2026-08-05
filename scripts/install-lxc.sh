#!/usr/bin/env bash
# OmniSight native installer for Debian/Ubuntu (LXC, VM, or bare metal).
# Run as root:
#   bash install-lxc.sh
#   bash install-lxc.sh --update
#
# Environment overrides:
#   OMNISIGHT_REPO               HTTPS git repository (default: upstream GitHub)
#   OMNISIGHT_BRANCH             branch to install             (default: main)
#   OMNISIGHT_DIR                install directory             (default: /opt/omnisight)
#   OMNISIGHT_PORT               listen port                   (default: 3000)
#   OMNISIGHT_TOKEN_FILE         optional private-repo token file
#   OMNISIGHT_TOKEN_USER         token username                (default: oauth2)
#   OMNISIGHT_TOKEN_FILE_DELETE  delete token file on exit     (default: 0)
#   NODE_MAJOR                   Node.js major from NodeSource (default: 22)
set -Eeuo pipefail

REPO="${OMNISIGHT_REPO:-https://github.com/caglaryalcin/OmniSight.git}"
BRANCH="${OMNISIGHT_BRANCH:-main}"
APP_DIR="${OMNISIGHT_DIR:-/opt/omnisight}"
PORT="${OMNISIGHT_PORT:-3000}"
TOKEN_FILE="${OMNISIGHT_TOKEN_FILE:-}"
TOKEN_USER="${OMNISIGHT_TOKEN_USER:-oauth2}"
TOKEN_FILE_DELETE="${OMNISIGHT_TOKEN_FILE_DELETE:-0}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP_USER="omnisight"
SERVICE="omnisight"
TOKEN="${OMNISIGHT_TOKEN:-}"
ASKPASS_FILE=""

msg()  { echo -e "\033[1;32m[omnisight]\033[0m $*"; }
warn() { echo -e "\033[1;33m[omnisight]\033[0m $*" >&2; }
fail() { echo -e "\033[1;31m[omnisight]\033[0m $*" >&2; exit 1; }

is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

cleanup() {
  local exit_code=$?
  if [ -n "$ASKPASS_FILE" ]; then rm -f -- "$ASKPASS_FILE"; fi
  if [ "$TOKEN_FILE_DELETE" = "1" ] && [ -n "$TOKEN_FILE" ]; then rm -f -- "$TOKEN_FILE"; fi
  TOKEN=""
  return "$exit_code"
}
trap cleanup EXIT

validate_config() {
  [[ "$REPO" =~ ^https://[^[:space:]@]+$ ]] || fail "OMNISIGHT_REPO must be an HTTPS URL without embedded credentials"
  [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "OMNISIGHT_BRANCH contains unsupported characters"
  [[ "$BRANCH" != -* && "$BRANCH" != *..* && "$BRANCH" != *//* && "$BRANCH" != */ && "$BRANCH" != *.lock ]] || fail "OMNISIGHT_BRANCH is not a safe branch name"
  [[ "$APP_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$APP_DIR" != "/" && "$APP_DIR" != *..* ]] || fail "OMNISIGHT_DIR must be a safe absolute path"
  is_uint "$PORT" && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "OMNISIGHT_PORT must be between 1 and 65535"
  is_uint "$NODE_MAJOR" && [ "$NODE_MAJOR" -ge 20 ] && [ "$NODE_MAJOR" -le 99 ] || fail "NODE_MAJOR must be 20 or newer"
  [[ "$TOKEN_USER" =~ ^[A-Za-z0-9._+@-]+$ ]] || fail "OMNISIGHT_TOKEN_USER contains unsupported characters"
  [[ "$TOKEN_FILE_DELETE" = "0" || "$TOKEN_FILE_DELETE" = "1" ]] || fail "OMNISIGHT_TOKEN_FILE_DELETE must be 0 or 1"
  if [ -n "$TOKEN_FILE" ]; then
    [ -f "$TOKEN_FILE" ] || fail "OMNISIGHT_TOKEN_FILE is not a readable file"
    [ -r "$TOKEN_FILE" ] || fail "OMNISIGHT_TOKEN_FILE is not readable"
  fi
}

load_token() {
  if [ -n "$TOKEN_FILE" ]; then
    TOKEN=$(cat -- "$TOKEN_FILE")
  fi
  [[ "$TOKEN" != *$'\n'* && "$TOKEN" != *$'\r'* ]] || fail "repository token must be a single line"
}

prepare_askpass() {
  [ -n "$TOKEN" ] || return 0
  [ -n "$ASKPASS_FILE" ] && return 0
  ASKPASS_FILE=$(mktemp)
  chmod 0700 "$ASKPASS_FILE"
  cat > "$ASKPASS_FILE" <<'EOF'
#!/usr/bin/env sh
case "$1" in
  *Username*) printf '%s\n' "$OMNISIGHT_TOKEN_USER" ;;
  *Password*) printf '%s\n' "$OMNISIGHT_TOKEN" ;;
  *) exit 1 ;;
esac
EOF
}

run_git() {
  if [ -n "$TOKEN" ]; then
    prepare_askpass
    OMNISIGHT_TOKEN="$TOKEN" \
    OMNISIGHT_TOKEN_USER="$TOKEN_USER" \
    GIT_ASKPASS="$ASKPASS_FILE" \
    GIT_TERMINAL_PROMPT=0 \
      git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

node_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)'
}

validate_config
load_token

[ "$(id -u)" -eq 0 ] || fail "run as root"
command -v apt-get >/dev/null || fail "this installer supports Debian/Ubuntu (apt) only"
command -v systemctl >/dev/null || fail "systemd is required"

case "${1:-}" in
  "") ;;
  --update) ;;
  *) fail "usage: bash install-lxc.sh [--update]" ;;
esac

if [ "${1:-}" = "--update" ]; then
  [ -d "$APP_DIR/.git" ] || fail "no existing install in $APP_DIR"
  [ -z "$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" status --porcelain --untracked-files=no)" ] || fail "tracked files have local changes; commit or revert them before updating"
  msg "updating $APP_DIR from $REPO ($BRANCH)"
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" remote set-url origin "$REPO"
  run_git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" checkout -B "$BRANCH" FETCH_HEAD
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  systemctl restart "$SERVICE"
  msg "updated and restarted"
  exit 0
fi

[ ! -e "$APP_DIR" ] || fail "$APP_DIR already exists — use --update for an existing installation"

msg "installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl git gnupg

if ! node_supported; then
  msg "installing Node.js $NODE_MAJOR from NodeSource"
  install -d -m 0755 /etc/apt/keyrings
  curl --proto '=https' --tlsv1.2 -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -yq nodejs
fi
node_supported || fail "Node.js 20.19 or newer is required"
msg "node $(node --version), npm $(npm --version)"

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

msg "cloning $REPO ($BRANCH) into $APP_DIR"
run_git clone --depth 1 --branch "$BRANCH" -- "$REPO" "$APP_DIR"
git -c safe.directory="$APP_DIR" -C "$APP_DIR" remote set-url origin "$REPO"

msg "installing production dependencies"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)

mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

msg "creating hardened systemd service"
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
  warn "installation files were kept for diagnosis"
  fail "service failed to start — check: journalctl -u $SERVICE -n 50"
fi
