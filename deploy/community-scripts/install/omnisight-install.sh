#!/usr/bin/env bash

# Copyright (c) 2026 community-scripts ORG
# Author: caglaryalcin
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/caglaryalcin/OmniSight

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

NODE_VERSION="22" setup_nodejs

fetch_and_deploy_gh_release "omnisight" "caglaryalcin/OmniSight" "tarball" "latest" "/opt/omnisight"

msg_info "Installing Dependencies"
cd /opt/omnisight
$STD npm ci --omit=dev --no-audit --no-fund
msg_ok "Installed Dependencies"

msg_info "Configuring OmniSight"
id omnisight >/dev/null 2>&1 || useradd --system --home-dir /opt/omnisight --shell /usr/sbin/nologin omnisight
install -d -o omnisight -g omnisight -m 0750 /opt/omnisight/data
if [[ ! -f /opt/omnisight/data/config.yaml ]]; then
  printf '{}\n' >/opt/omnisight/data/config.yaml
fi
chown -R omnisight:omnisight /opt/omnisight
chmod 0600 /opt/omnisight/data/config.yaml
msg_ok "Configured OmniSight"

msg_info "Creating Service"
cat <<'EOF' >/etc/systemd/system/omnisight.service
[Unit]
Description=OmniSight monitoring dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=omnisight
Group=omnisight
WorkingDirectory=/opt/omnisight
ExecStart=/usr/bin/node --openssl-legacy-provider /opt/omnisight/server.js
Environment=NODE_ENV=production
Environment=PORT=3000
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/omnisight/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now omnisight
msg_ok "Created Service"

motd_ssh
customize

cat <<'EOF' >/usr/bin/update
#!/usr/bin/env bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/caglaryalcin/OmniSight/main/deploy/community-scripts/ct/omnisight.sh)"
EOF
chmod +x /usr/bin/update
cleanup_lxc
