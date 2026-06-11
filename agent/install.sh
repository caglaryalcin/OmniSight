#!/usr/bin/env bash
set -e

BIN=/usr/local/bin/omnisight-agent
SVC=/etc/systemd/system/omnisight-agent.service
ENVDIR=/etc/omnisight-agent

[ "$(id -u)" = 0 ] || { echo "error: run as root (sudo)"; exit 1; }

if [ "${1:-}" = "uninstall" ]; then
  systemctl disable --now omnisight-agent 2>/dev/null || true
  rm -f "$BIN" "$SVC"
  rm -rf "$ENVDIR"
  systemctl daemon-reload
  echo "omnisight-agent removed"
  exit 0
fi

: "${OMNISIGHT_URL:?error: OMNISIGHT_URL is required}"
: "${OMNISIGHT_TOKEN:?error: OMNISIGHT_TOKEN is required}"
INTERVAL="${OMNISIGHT_INTERVAL:-15}"
ROLE="${OMNISIGHT_AGENT_ROLE:-auto}"
INSECURE_TLS="${OMNISIGHT_INSECURE_TLS:-}"
OMNISIGHT_URL="${OMNISIGHT_URL%/}"
CURL_TLS_ARGS=""
case "$INSECURE_TLS" in
  1|true|TRUE|yes|YES) CURL_TLS_ARGS="--insecure" ;;
esac

command -v curl >/dev/null 2>&1 || { echo "error: curl is required"; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "error: systemd is required"; exit 1; }

echo "downloading agent from $OMNISIGHT_URL ..."
curl -fsS $CURL_TLS_ARGS "$OMNISIGHT_URL/agent/omnisight-agent.sh" -o "$BIN"
chmod 755 "$BIN"

mkdir -p "$ENVDIR"
AGENT_ID="${OMNISIGHT_AGENT_ID:-}"
if [ -z "$AGENT_ID" ] && [ -f "$ENVDIR/agent.env" ]; then
  AGENT_ID="$(sed -n 's/^OMNISIGHT_AGENT_ID=//p' "$ENVDIR/agent.env" | head -n1)"
fi
if [ -z "$AGENT_ID" ]; then
  PID="$(systemctl show -p MainPID --value omnisight-agent 2>/dev/null || true)"
  if [ -n "$PID" ] && [ "$PID" != "0" ] && [ -r "/proc/$PID/environ" ]; then
    AGENT_ID="$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^OMNISIGHT_AGENT_ID=//p' | head -n1)"
  fi
fi
if [ -z "$AGENT_ID" ]; then
  HOST_ID="$(hostname -s 2>/dev/null || hostname)"
  RAND_ID="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  [ -z "$RAND_ID" ] && RAND_ID="$(date +%s)"
  AGENT_ID="${HOST_ID}-${RAND_ID}"
fi
cat > "$ENVDIR/agent.env" <<EOF
OMNISIGHT_URL=$OMNISIGHT_URL
OMNISIGHT_TOKEN=$OMNISIGHT_TOKEN
OMNISIGHT_INTERVAL=$INTERVAL
OMNISIGHT_AGENT_ID=$AGENT_ID
OMNISIGHT_AGENT_ROLE=$ROLE
EOF
if [ -n "$CURL_TLS_ARGS" ]; then
  echo "OMNISIGHT_INSECURE_TLS=1" >> "$ENVDIR/agent.env"
fi
chmod 600 "$ENVDIR/agent.env"

cat > "$SVC" <<EOF
[Unit]
Description=OmniSight monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENVDIR/agent.env
ExecStart=$BIN
Restart=always
RestartSec=5
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now omnisight-agent
echo "omnisight-agent installed and started (id: ${AGENT_ID}, interval: ${INTERVAL}s)"
echo "logs: journalctl -u omnisight-agent -f"
