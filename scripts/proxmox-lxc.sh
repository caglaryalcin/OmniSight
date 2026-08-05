#!/usr/bin/env bash
COMMUNITY_BUILD_URL="https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func"
COMMUNITY_INSTALL_SOURCE='https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/install/${var_install}.sh'
OMNISIGHT_INSTALL_URL="https://raw.githubusercontent.com/caglaryalcin/OmniSight/main/deploy/community-scripts/install/omnisight-install.sh"
COMMUNITY_DONATE_BADGE_SOURCE='https://img.shields.io/badge/❤️-Sponsoring%20%26%20Donations-FF5E5B'
COMMUNITY_DONATE_BADGE_TARGET='https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F-Sponsoring%20%26%20Donations-FF5E5B'
COMMUNITY_SCRIPT_BADGE_SOURCE='https://img.shields.io/badge/📦-Open%20Script%20Page-00617f'
COMMUNITY_SCRIPT_BADGE_TARGET='https://img.shields.io/badge/%F0%9F%93%A6-Open%20Script%20Page-00617f'

COMMUNITY_BUILD_FUNC="$(curl -fsSL "$COMMUNITY_BUILD_URL")" || {
  echo "Failed to download the Community Scripts framework." >&2
  exit 115
}
if [[ "$COMMUNITY_BUILD_FUNC" != *"$COMMUNITY_INSTALL_SOURCE"* ]]; then
  echo "The Community Scripts installer interface has changed; refusing to continue." >&2
  exit 115
fi
COMMUNITY_BUILD_FUNC="${COMMUNITY_BUILD_FUNC//$COMMUNITY_INSTALL_SOURCE/$OMNISIGHT_INSTALL_URL}"
COMMUNITY_BUILD_FUNC="${COMMUNITY_BUILD_FUNC//$COMMUNITY_DONATE_BADGE_SOURCE/$COMMUNITY_DONATE_BADGE_TARGET}"
COMMUNITY_BUILD_FUNC="${COMMUNITY_BUILD_FUNC//$COMMUNITY_SCRIPT_BADGE_SOURCE/$COMMUNITY_SCRIPT_BADGE_TARGET}"
source /dev/stdin <<<"$COMMUNITY_BUILD_FUNC"
unset COMMUNITY_BUILD_FUNC COMMUNITY_INSTALL_SOURCE COMMUNITY_DONATE_BADGE_SOURCE COMMUNITY_DONATE_BADGE_TARGET
unset COMMUNITY_SCRIPT_BADGE_SOURCE COMMUNITY_SCRIPT_BADGE_TARGET
# Copyright (c) 2026 community-scripts ORG
# Author: caglaryalcin
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/caglaryalcin/OmniSight

APP="OmniSight"
var_tags="${var_tags:-monitoring;dashboard;proxmox}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-6}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
# var_arm64 is intentionally unset until native ARM64 installation is verified.
var_unprivileged="${var_unprivileged:-1}"

if ! declare -F build_container >/dev/null; then
  echo "Failed to load the Community Scripts framework." >&2
  exit 115
fi

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -f /opt/omnisight/server.js ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "omnisight" "caglaryalcin/OmniSight"; then
    msg_info "Stopping Service"
    systemctl stop omnisight
    msg_ok "Stopped Service"

    create_backup /opt/omnisight/data
    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "omnisight" "caglaryalcin/OmniSight" "tarball" "latest" "/opt/omnisight"

    msg_info "Installing Dependencies"
    cd /opt/omnisight
    $STD npm ci --omit=dev --no-audit --no-fund
    msg_ok "Installed Dependencies"

    restore_backup
    chown -R omnisight:omnisight /opt/omnisight

    msg_info "Starting Service"
    systemctl start omnisight
    msg_ok "Started Service"
    msg_ok "Updated Successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:3000${CL}"
