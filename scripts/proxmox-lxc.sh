#!/usr/bin/env bash
# Creates an unprivileged Debian 13 LXC on Proxmox VE and installs OmniSight
# natively inside it (no Docker). Run on the Proxmox host as root:
#   bash proxmox-lxc.sh
#
# Environment overrides:
#   DISTRO / DISTRO_VERSION     template family/version     (default: debian/13)
#   CTID / CT_HOSTNAME         container identity          (default: next ID/omnisight)
#   STORAGE / TEMPLATE_STORAGE rootfs/template storage     (default: local-lvm/local)
#   DISK_GB / MEMORY_MB / CORES                         (default: 6/1024/2)
#   BRIDGE / NET_CONF          network bridge/config       (default: vmbr0/DHCP)
#   NESTING                    enable LXC nesting           (default: 0)
#   KEEP_FAILED_CT             keep a failed new container (default: 0)
#   CONFIRM                    skip interactive confirmation with 1
#   VERBOSE                    show command output with 1   (default: 0)
#   OMNISIGHT_REPO / OMNISIGHT_BRANCH / OMNISIGHT_PORT
#   OMNISIGHT_INSTALLER_URL    companion installer URL for remote execution
#   OMNISIGHT_TOKEN_FILE       optional private-repo token file
#   OMNISIGHT_TOKEN_USER       token username              (default: oauth2)
set -Eeuo pipefail

msg()  { echo -e "\033[1;32m[omnisight-lxc]\033[0m $*"; }
warn() { echo -e "\033[1;33m[omnisight-lxc]\033[0m $*" >&2; }
fail() {
  echo -e "\033[1;31m[omnisight-lxc]\033[0m $*" >&2
  if [ "${VERBOSE:-0}" != "1" ] && [ -n "${HOST_LOG_FILE:-}" ] && [ -s "$HOST_LOG_FILE" ]; then
    warn "last command output:"
    tail -n 25 "$HOST_LOG_FILE" >&2
  fi
  exit 1
}

is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
is_valid_hostname() { [[ ${#1} -le 63 && "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]]; }

CREATED_CT=0
INSTALL_OK=0
HOST_TOKEN_FILE=""
HOST_INSTALLER_DIR=""
HOST_LOG_FILE=""

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [ -n "$HOST_TOKEN_FILE" ]; then rm -f -- "$HOST_TOKEN_FILE"; fi
  if [ -n "$HOST_INSTALLER_DIR" ]; then rm -rf -- "$HOST_INSTALLER_DIR"; fi
  if [ -n "$HOST_LOG_FILE" ]; then rm -f -- "$HOST_LOG_FILE"; fi
  if [ "$CREATED_CT" = "1" ] && [ "$INSTALL_OK" != "1" ]; then
    if [ "$KEEP_FAILED_CT" = "1" ]; then
      warn "installation failed; keeping newly-created LXC $CTID for diagnosis"
    else
      warn "installation failed; removing newly-created LXC $CTID"
      pct stop "$CTID" --skiplock 1 >/dev/null 2>&1 || true
      pct destroy "$CTID" --purge 1 >/dev/null 2>&1 || warn "could not remove LXC $CTID automatically"
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT

run_cmd() {
  if [ "$VERBOSE" = "1" ]; then
    "$@"
  else
    "$@" >>"$HOST_LOG_FILE" 2>&1
  fi
}

command -v pct >/dev/null || fail "run this on a Proxmox VE host"
command -v pvesh >/dev/null || fail "pvesh is required"
command -v pveam >/dev/null || fail "pveam is required"
[ "$(id -u)" -eq 0 ] || fail "run as root"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install-lxc.sh"
NEEDS_INSTALLER_DOWNLOAD=0
if [ ! -f "$INSTALLER" ]; then
  command -v curl >/dev/null || fail "curl is required when running proxmox-lxc.sh from a URL"
  INSTALLER_URL="${OMNISIGHT_INSTALLER_URL:-https://raw.githubusercontent.com/caglaryalcin/OmniSight/main/scripts/install-lxc.sh?cache=$(date +%s)}"
  [[ "$INSTALLER_URL" =~ ^https://[^[:space:]]+$ ]] || fail "OMNISIGHT_INSTALLER_URL must be an HTTPS URL"
  NEEDS_INSTALLER_DOWNLOAD=1
fi

NEXT_ID=$(pvesh get /cluster/nextid)
DEFAULT_REPO="https://github.com/caglaryalcin/OmniSight.git"
REPO="${OMNISIGHT_REPO:-}"
BRANCH="${OMNISIGHT_BRANCH:-}"
TOKEN_SOURCE="${OMNISIGHT_TOKEN_FILE:-}"
TOKEN_USER="${OMNISIGHT_TOKEN_USER:-oauth2}"
TOKEN_VALUE="${OMNISIGHT_TOKEN:-}"

if [ -t 0 ]; then
  if [ -z "${CTID:-}" ]; then
    read -r -p "Container ID [$NEXT_ID]: " CTID
    CTID="${CTID:-$NEXT_ID}"
  fi
  if [ -z "${CT_HOSTNAME:-}" ]; then
    while true; do
      read -r -p "Hostname [omnisight]: " CT_HOSTNAME
      CT_HOSTNAME="${CT_HOSTNAME:-omnisight}"
      is_valid_hostname "$CT_HOSTNAME" && break
      warn "hostname must contain only letters, numbers and hyphens"
      CT_HOSTNAME=""
    done
  fi
  if [ -z "${VERBOSE:-}" ]; then
    while true; do
      read -r -p "Enable verbose mode? [y/N]: " verbose_answer
      case "$verbose_answer" in
        [Yy]) VERBOSE=1; break ;;
        ""|[Nn]) VERBOSE=0; break ;;
        *) warn "please answer y or n" ;;
      esac
    done
  fi
else
  CTID="${CTID:-$NEXT_ID}"
  CT_HOSTNAME="${CT_HOSTNAME:-omnisight}"
fi

REPO="${REPO:-$DEFAULT_REPO}"
BRANCH="${BRANCH:-main}"
DISTRO="${DISTRO:-debian}"
case "$DISTRO" in
  debian)
    DISTRO_VERSION="${DISTRO_VERSION:-13}"
    NETWORK_HOST="deb.debian.org"
    ;;
  ubuntu)
    DISTRO_VERSION="${DISTRO_VERSION:-24.04}"
    NETWORK_HOST="archive.ubuntu.com"
    ;;
  *) fail "DISTRO must be debian or ubuntu" ;;
esac

STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK_GB="${DISK_GB:-6}"
MEMORY_MB="${MEMORY_MB:-1024}"
CORES="${CORES:-2}"
BRIDGE="${BRIDGE:-vmbr0}"
NET_CONF="${NET_CONF:-name=eth0,bridge=$BRIDGE,ip=dhcp}"
NESTING="${NESTING:-0}"
KEEP_FAILED_CT="${KEEP_FAILED_CT:-0}"
CONFIRM="${CONFIRM:-0}"
VERBOSE="${VERBOSE:-0}"
PORT="${OMNISIGHT_PORT:-3000}"

[[ "$CTID" =~ ^[1-9][0-9]{2,8}$ ]] || fail "CTID must be a numeric Proxmox VMID (100-999999999)"
is_valid_hostname "$CT_HOSTNAME" || fail "CT_HOSTNAME must be a valid DNS hostname"
[[ "$DISTRO_VERSION" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "DISTRO_VERSION is invalid"
[[ "$STORAGE" =~ ^[A-Za-z0-9._-]+$ ]] || fail "STORAGE contains unsupported characters"
[[ "$TEMPLATE_STORAGE" =~ ^[A-Za-z0-9._-]+$ ]] || fail "TEMPLATE_STORAGE contains unsupported characters"
[[ "$BRIDGE" =~ ^[A-Za-z0-9._-]+$ ]] || fail "BRIDGE contains unsupported characters"
[[ "$NET_CONF" != *$'\n'* && "$NET_CONF" != *$'\r'* ]] || fail "NET_CONF must be a single line"
for value_name in DISK_GB MEMORY_MB CORES PORT; do
  value="${!value_name}"
  is_uint "$value" || fail "$value_name must be a positive integer"
  [ "$value" -gt 0 ] || fail "$value_name must be greater than zero"
done
[ "$PORT" -le 65535 ] || fail "OMNISIGHT_PORT must be at most 65535"
[[ "$NESTING" = "0" || "$NESTING" = "1" ]] || fail "NESTING must be 0 or 1"
[[ "$KEEP_FAILED_CT" = "0" || "$KEEP_FAILED_CT" = "1" ]] || fail "KEEP_FAILED_CT must be 0 or 1"
[[ "$CONFIRM" = "0" || "$CONFIRM" = "1" ]] || fail "CONFIRM must be 0 or 1"
[[ "$VERBOSE" = "0" || "$VERBOSE" = "1" ]] || fail "VERBOSE must be 0 or 1"
[[ "$REPO" =~ ^https://[^[:space:]@]+$ ]] || fail "OMNISIGHT_REPO must be an HTTPS URL without embedded credentials"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "OMNISIGHT_BRANCH contains unsupported characters"
[[ "$BRANCH" != -* && "$BRANCH" != *..* && "$BRANCH" != *//* && "$BRANCH" != */ && "$BRANCH" != *.lock ]] || fail "OMNISIGHT_BRANCH is not a safe branch name"
[[ "$TOKEN_USER" =~ ^[A-Za-z0-9._+@-]+$ ]] || fail "OMNISIGHT_TOKEN_USER contains unsupported characters"
if [ -n "$TOKEN_SOURCE" ]; then
  [ -f "$TOKEN_SOURCE" ] && [ -r "$TOKEN_SOURCE" ] || fail "OMNISIGHT_TOKEN_FILE is not readable"
fi
if [ "$VERBOSE" = "0" ]; then
  HOST_LOG_FILE=$(mktemp)
  chmod 0600 "$HOST_LOG_FILE"
fi

if pct status "$CTID" >/dev/null 2>&1; then fail "CTID $CTID already exists"; fi

msg "planned LXC: $CTID ($CT_HOSTNAME), $DISTRO $DISTRO_VERSION, ${CORES}c/${MEMORY_MB}MB/${DISK_GB}GB"
msg "storage: $STORAGE, network: $NET_CONF, nesting: $NESTING"
msg "source: $REPO ($BRANCH), OmniSight port: $PORT"
msg "verbose mode: $([ "$VERBOSE" = "1" ] && echo enabled || echo disabled)"
if [ -t 0 ] && [ "$CONFIRM" != "1" ]; then
  while true; do
    read -r -p "Create this LXC and install OmniSight? [Y/n]: " answer
    case "$answer" in
      ""|[Yy]) break ;;
      [Nn]) fail "cancelled" ;;
      *) warn "please answer y or n" ;;
    esac
  done
fi

if [ "$NEEDS_INSTALLER_DOWNLOAD" = "1" ]; then
  HOST_INSTALLER_DIR=$(mktemp -d)
  INSTALLER="$HOST_INSTALLER_DIR/install-lxc.sh"
  msg "downloading companion OmniSight installer"
  run_cmd curl --proto '=https' --tlsv1.2 -fL "$INSTALLER_URL" -o "$INSTALLER" || fail "could not download install-lxc.sh"
  chmod 0700 "$INSTALLER"
fi

if [ -n "$TOKEN_SOURCE" ] || [ -n "$TOKEN_VALUE" ]; then
  HOST_TOKEN_FILE=$(mktemp)
  chmod 0600 "$HOST_TOKEN_FILE"
  if [ -n "$TOKEN_SOURCE" ]; then cat -- "$TOKEN_SOURCE" > "$HOST_TOKEN_FILE"; else printf '%s' "$TOKEN_VALUE" > "$HOST_TOKEN_FILE"; fi
  TOKEN_VALUE=""
fi

TEMPLATE_PREFIX="${DISTRO}-${DISTRO_VERSION}-standard_"
msg "finding $DISTRO $DISTRO_VERSION template"
run_cmd pveam update || fail "could not refresh the Proxmox template list"
TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep -E "^${TEMPLATE_PREFIX}" | sort -V | tail -1 || true)
[ -n "$TEMPLATE" ] || fail "no ${DISTRO}-${DISTRO_VERSION}-standard template available via pveam"
if ! pveam list "$TEMPLATE_STORAGE" | grep -Fq "$TEMPLATE"; then
  msg "downloading $TEMPLATE"
  run_cmd pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" || fail "template download failed"
fi

msg "creating unprivileged LXC $CTID"
create_args=(
  create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE"
  --hostname "$CT_HOSTNAME"
  --unprivileged 1
  --cores "$CORES"
  --memory "$MEMORY_MB"
  --swap 512
  --rootfs "$STORAGE:$DISK_GB"
  --net0 "$NET_CONF"
  --onboot 1
  --start 1
)
if [ "$NESTING" = "1" ]; then create_args+=(--features nesting=1); fi
if ! run_cmd pct "${create_args[@]}"; then
  if pct status "$CTID" >/dev/null 2>&1; then CREATED_CT=1; fi
  fail "LXC creation failed"
fi
CREATED_CT=1

msg "waiting for DNS/network in container"
for attempt in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts "$NETWORK_HOST" >/dev/null 2>&1; then break; fi
  [ "$attempt" -eq 30 ] && fail "container has no working network after 60 seconds"
  sleep 2
done

msg "copying and running the OmniSight installer"
run_cmd pct push "$CTID" "$INSTALLER" /root/install-lxc.sh --perms 0700 || fail "could not copy the OmniSight installer into LXC $CTID"
install_env=(
  env
  "OMNISIGHT_REPO=$REPO"
  "OMNISIGHT_BRANCH=$BRANCH"
  "OMNISIGHT_PORT=$PORT"
)
if [ -n "$HOST_TOKEN_FILE" ]; then
  run_cmd pct push "$CTID" "$HOST_TOKEN_FILE" /root/.omnisight-repo-token --perms 0600 || fail "could not copy the repository token into LXC $CTID"
  install_env+=(
    "OMNISIGHT_TOKEN_FILE=/root/.omnisight-repo-token"
    "OMNISIGHT_TOKEN_FILE_DELETE=1"
    "OMNISIGHT_TOKEN_USER=$TOKEN_USER"
  )
fi
run_cmd pct exec "$CTID" -- "${install_env[@]}" bash /root/install-lxc.sh || fail "OmniSight installation failed inside LXC $CTID"

INSTALL_OK=1
IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
msg "done — OmniSight LXC $CTID is up: http://$IP:$PORT"
