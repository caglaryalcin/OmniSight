#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/../misc/build.func" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main}/misc/build.func")
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
