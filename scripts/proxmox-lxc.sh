#!/usr/bin/env bash
# Creates an Ubuntu 24.04 LXC on a Proxmox VE 8/9 host and installs OmniSight
# natively inside it (no Docker). Run on the Proxmox host as root:
#   bash proxmox-lxc.sh
#
# Environment overrides:
#   CTID        container ID            (default: next free ID)
#   CT_HOSTNAME container hostname      (default: omnisight)
#   STORAGE     rootfs storage          (default: local-lvm)
#   TEMPLATE_STORAGE  template storage  (default: local)
#   DISK_GB     rootfs size in GB       (default: 6)
#   MEMORY_MB   RAM in MB               (default: 1024)
#   CORES       CPU cores               (default: 2)
#   BRIDGE      network bridge          (default: vmbr0)
#   NET_CONF    pct net0 config         (default: DHCP on BRIDGE)
#   OMNISIGHT_REPO / OMNISIGHT_BRANCH / OMNISIGHT_PORT  passed to the installer
#   OMNISIGHT_TOKEN / OMNISIGHT_TOKEN_USER  credentials for private repos
#
# When run on a terminal, the script prompts for container ID, hostname and
# repo credentials; set the corresponding env vars to skip the prompts
# (unattended use).
set -euo pipefail

msg()  { echo -e "\033[1;32m[omnisight-lxc]\033[0m $*"; }
fail() { echo -e "\033[1;31m[omnisight-lxc]\033[0m $*" >&2; exit 1; }

command -v pct >/dev/null || fail "run this on a Proxmox VE host"
[ "$(id -u)" -eq 0 ] || fail "run as root"

NEXT_ID=$(pvesh get /cluster/nextid)
DEFAULT_REPO="https://github.com/caglaryalcin/OmniSight.git"
REPO="${OMNISIGHT_REPO:-}"
BRANCH="${OMNISIGHT_BRANCH:-}"
TOKEN="${OMNISIGHT_TOKEN:-}"
TOKEN_USER="${OMNISIGHT_TOKEN_USER:-oauth2}"
if [ -t 0 ]; then
  if [ -z "${CTID:-}" ]; then
    read -r -p "Container ID [$NEXT_ID]: " CTID
    CTID="${CTID:-$NEXT_ID}"
  fi
  if [ -z "${CT_HOSTNAME:-}" ]; then
    read -r -p "Hostname [omnisight]: " CT_HOSTNAME
    CT_HOSTNAME="${CT_HOSTNAME:-omnisight}"
  fi
  if [ -z "$REPO" ]; then
    read -r -p "Repo URL [$DEFAULT_REPO]: " REPO
    REPO="${REPO:-$DEFAULT_REPO}"
  fi
  if [ -z "$BRANCH" ]; then
    read -r -p "Branch [main]: " BRANCH
    BRANCH="${BRANCH:-main}"
  fi
  if [ -z "$TOKEN" ] && [[ "$REPO" != *"@"* ]]; then
    read -r -s -p "Access token for the repo (empty = anonymous): " TOKEN
    echo
    if [ -n "$TOKEN" ]; then
      read -r -p "Token username [oauth2] (deploy tokens: gitlab+deploy-token-N): " TOKEN_USER
      TOKEN_USER="${TOKEN_USER:-oauth2}"
    fi
  fi
else
  CTID="${CTID:-$NEXT_ID}"
  CT_HOSTNAME="${CT_HOSTNAME:-omnisight}"
fi
REPO="${REPO:-$DEFAULT_REPO}"
BRANCH="${BRANCH:-main}"
if [ -n "$TOKEN" ] && [[ "$REPO" == https://* ]] && [[ "$REPO" != *"@"* ]]; then
  REPO="https://${TOKEN_USER}:${TOKEN}@${REPO#https://}"
fi
SAFE_REPO="$REPO"
if [[ "$SAFE_REPO" == *"@"* ]]; then SAFE_REPO="https://***@${SAFE_REPO#*@}"; fi
msg "source: $SAFE_REPO (branch: $BRANCH)"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK_GB="${DISK_GB:-6}"
MEMORY_MB="${MEMORY_MB:-1024}"
CORES="${CORES:-2}"
BRIDGE="${BRIDGE:-vmbr0}"
NET_CONF="${NET_CONF:-name=eth0,bridge=$BRIDGE,ip=dhcp}"

pct status "$CTID" >/dev/null 2>&1 && fail "CTID $CTID already exists"

msg "finding Ubuntu 24.04 template"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep -E '^ubuntu-24.04-standard' | sort -V | tail -1)
[ -n "$TEMPLATE" ] || fail "no ubuntu-24.04-standard template available via pveam"
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  msg "downloading $TEMPLATE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

msg "creating LXC $CTID ($CT_HOSTNAME): ${CORES}c/${MEMORY_MB}MB/${DISK_GB}GB on $STORAGE"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --unprivileged 1 \
  --features nesting=1 \
  --cores "$CORES" \
  --memory "$MEMORY_MB" \
  --swap 512 \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "$NET_CONF" \
  --onboot 1 \
  --start 1

msg "waiting for network in container"
for i in $(seq 1 30); do
  if pct exec "$CTID" -- ping -c1 -W2 archive.ubuntu.com >/dev/null 2>&1; then break; fi
  [ "$i" -eq 30 ] && fail "container has no network after 60s"
  sleep 2
done

msg "running OmniSight installer inside LXC $CTID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/install-lxc.sh" ]; then
  pct push "$CTID" "$SCRIPT_DIR/install-lxc.sh" /root/install-lxc.sh
else
  # Standalone run: pull the installer out of the target repo itself, so it
  # always matches OMNISIGHT_REPO/OMNISIGHT_BRANCH (incl. private repos with
  # credentials embedded in the URL).
  pct exec "$CTID" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -yq git ca-certificates && rm -rf /root/omnisight-src && git clone --depth 1 --branch '$BRANCH' '$REPO' /root/omnisight-src && cp /root/omnisight-src/scripts/install-lxc.sh /root/install-lxc.sh && rm -rf /root/omnisight-src"
fi
pct exec "$CTID" -- env \
  OMNISIGHT_REPO="$REPO" \
  OMNISIGHT_BRANCH="$BRANCH" \
  OMNISIGHT_PORT="${OMNISIGHT_PORT:-3000}" \
  bash /root/install-lxc.sh

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
msg "done — OmniSight LXC $CTID is up: http://$IP:${OMNISIGHT_PORT:-3000}"
