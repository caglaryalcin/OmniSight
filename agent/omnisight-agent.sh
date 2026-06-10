#!/usr/bin/env bash
set -u

ENV_FILE="/etc/omnisight-agent/agent.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

URL="${OMNISIGHT_URL:?OMNISIGHT_URL required}"
URL="${URL%/}"
TOKEN="${OMNISIGHT_TOKEN:?OMNISIGHT_TOKEN required}"
INTERVAL="${OMNISIGHT_INTERVAL:-15}"
VERSION="1.2.0"
HOST_ROOT="${OMNISIGHT_HOST_ROOT:-/}"
INSECURE_TLS="${OMNISIGHT_INSECURE_TLS:-}"
CURL_TLS_ARGS=""
case "$INSECURE_TLS" in
  1|true|TRUE|yes|YES) CURL_TLS_ARGS="--insecure" ;;
esac

AGENT_ID="$(cat /etc/machine-id 2>/dev/null || hostname)"
HOSTNAME_S="$(hostname -s 2>/dev/null || hostname)"

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t'; }

detect_type() {
  if command -v pvesh >/dev/null 2>&1; then echo proxmox
  elif [ -f /etc/synoinfo.conf ]; then echo synology
  else echo linux; fi
}

get_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release 2>/dev/null
    printf '%s' "${PRETTY_NAME:-Linux}"
  else
    uname -s
  fi
}

get_ip() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$ip" ] && ip=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}')
  printf '%s' "$ip"
}

cpu_pct() {
  local u1 n1 s1 i1 w1 q1 sq1 st1 u2 n2 s2 i2 w2 q2 sq2 st2 rest t1 t2 dt di
  read -r _ u1 n1 s1 i1 w1 q1 sq1 st1 rest < /proc/stat
  sleep 1
  read -r _ u2 n2 s2 i2 w2 q2 sq2 st2 rest < /proc/stat
  t1=$((u1+n1+s1+i1+w1+q1+sq1+st1)); t2=$((u2+n2+s2+i2+w2+q2+sq2+st2))
  dt=$((t2-t1)); di=$(( (i2+w2)-(i1+w1) ))
  if [ "$dt" -gt 0 ]; then echo $(( (100*(dt-di))/dt )); else echo 0; fi
}

cpu_cores() { grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 0; }

disk_counters() {
  awk '
    $3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/ {
      readSectors += $6; writeSectors += $10; ops += $4 + $8; ioMs += $13
    }
    END { printf "%d %d %d %d", readSectors * 512, writeSectors * 512, ops, ioMs }
  ' /proc/diskstats 2>/dev/null
}

net_counters() {
  awk -F'[: ]+' '
    NR > 2 {
      iface = $2
      if (iface == "lo" || iface ~ /^(docker|br-|veth|virbr|cni|flannel|kube|tunl|gre|sit)/) next
      rx += $3; tx += $11
    }
    END { printf "%d %d", rx, tx }
  ' /proc/net/dev 2>/dev/null
}

swap_json() {
  awk '
    /^SwapTotal:/ { total=$2 }
    /^SwapFree:/ { free=$2 }
    END {
      used = total - free
      if (used < 0) used = 0
      printf "\"swap\":{\"totalKB\":%d,\"usedKB\":%d},", total, used
    }
  ' /proc/meminfo 2>/dev/null
}

get_temp() {
  local f t max=0
  for f in /sys/class/thermal/thermal_zone*/temp /sys/class/hwmon/hwmon*/temp1_input; do
    [ -r "$f" ] || continue
    t=$(cat "$f" 2>/dev/null) || continue
    case "$t" in ''|*[!0-9]*) continue;; esac
    [ "$t" -gt "$max" ] && max=$t
  done
  if [ "$max" -gt 1000 ]; then echo $((max/1000)); elif [ "$max" -gt 0 ]; then echo "$max"; fi
}

services_json() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl list-units --type=service --state=running,failed --no-legend --no-pager --plain 2>/dev/null |
  awk '{
    name=$1; sub(/\.service$/,"",name); gsub(/["\\]/,"",name);
    printf "%s{\"name\":\"%s\",\"active\":%s,\"state\":\"%s\"}", (c++?",":""), name, ($3=="active"?"true":"false"), $4
  }'
}

docker_json() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  local unused rows statsf
  unused=$(docker images -f dangling=true -q 2>/dev/null | wc -l | tr -d ' ')
  statsf=$(mktemp)
  docker stats --no-stream --no-trunc --format '{{.ID}}|{{.CPUPerc}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}' > "$statsf" 2>/dev/null || true
  rows=$(docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}' 2>/dev/null)
  printf '"docker":{"unused":%s,"containers":[' "${unused:-0}"
  [ -n "$rows" ] && printf '%s\n' "$rows" | awk -F'|' -v statsf="$statsf" '
  BEGIN {
    while ((getline line < statsf) > 0) {
      split(line, s, "|")
      id=s[1]
      gsub(/%/,"",s[2]); gsub(/%/,"",s[3])
      cpu[id]=s[2]; mem[id]=s[3]; net[id]=s[4]; block[id]=s[5]
    }
    close(statsf)
  }
  NF>=4{
    for(i=1;i<=NF;i++) gsub(/["\\]/,"",$i);
    full=$1
    printf "%s{\"id\":\"%s\",\"name\":\"%s\",\"image\":\"%s\",\"state\":\"%s\",\"status\":\"%s\",\"ports\":\"%s\"",
      (c++?",":""), substr($1,1,12), $2, $3, $4, $5, $6
    if (cpu[full] != "") printf ",\"cpu\":%s", cpu[full]
    if (mem[full] != "") printf ",\"memPercent\":%s", mem[full]
    if (net[full] != "") printf ",\"netIO\":\"%s\"", net[full]
    if (block[full] != "") printf ",\"blockIO\":\"%s\"", block[full]
    printf "}"
  }'
  rm -f "$statsf"
  printf ']},'
}

pve_json() {
  command -v pvesh >/dev/null 2>&1 || return 0
  local res ceph task
  res=$(timeout 12 pvesh get /cluster/resources --output-format json 2>/dev/null)
  [ -n "$res" ] || return 0
  ceph=$(timeout 8 pvesh get /cluster/ceph/status --output-format json 2>/dev/null)
  task=$(timeout 8 pvesh get "/nodes/$HOSTNAME_S/tasks" --typefilter vzdump --limit 1 --output-format json 2>/dev/null)
  printf '"pve":{"node":"%s","resources":%s' "$(json_escape "$HOSTNAME_S")" "$res"
  [ -n "$ceph" ] && printf ',"ceph":%s' "$ceph"
  [ -n "$task" ] && printf ',"backup":%s' "$task"
  printf '},'
}

send_report() {
  local cpu temp up l1 l5 l15 mt ma mu dt du os ip tmp rc dr1 dw1 do1 dio1 dr2 dw2 do2 dio2 nr1 nt1 nr2 nt2 disk_read disk_write disk_iops disk_util net_rx net_tx
  read -r dr1 dw1 do1 dio1 <<EOF
$(disk_counters)
EOF
  read -r nr1 nt1 <<EOF
$(net_counters)
EOF
  cpu=$(cpu_pct)
  read -r dr2 dw2 do2 dio2 <<EOF
$(disk_counters)
EOF
  read -r nr2 nt2 <<EOF
$(net_counters)
EOF
  disk_read=$((dr2>=dr1 ? dr2-dr1 : 0))
  disk_write=$((dw2>=dw1 ? dw2-dw1 : 0))
  disk_iops=$((do2>=do1 ? do2-do1 : 0))
  disk_util=$(((dio2>=dio1 ? dio2-dio1 : 0) / 10))
  [ "$disk_util" -gt 100 ] && disk_util=100
  net_rx=$((nr2>=nr1 ? nr2-nr1 : 0))
  net_tx=$((nt2>=nt1 ? nt2-nt1 : 0))
  temp=$(get_temp)
  up=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)
  read -r l1 l5 l15 _ < /proc/loadavg
  mt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  ma=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  mu=$((mt-ma))
  read -r dt du <<EOF
$(df -Pk "$HOST_ROOT" 2>/dev/null | awk 'NR==2{print $2" "$3}')
EOF
  os=$(json_escape "$(get_os)")
  ip=$(get_ip)
  tmp=$(mktemp)
  {
    printf '{'
    printf '"id":"%s","hostname":"%s","ip":"%s","os":"%s","kernel":"%s","platform":"%s","agentVersion":"%s","interval":%s,' \
      "$(json_escape "$AGENT_ID")" "$(json_escape "$HOSTNAME_S")" "$(json_escape "$ip")" "$os" \
      "$(json_escape "$(uname -r)")" "$(detect_type)" "$VERSION" "$INTERVAL"
    printf '"uptime":%s,"cpu":%s,"cores":%s,"load":[%s,%s,%s],' "${up:-0}" "${cpu:-0}" "$(cpu_cores)" "${l1:-0}" "${l5:-0}" "${l15:-0}"
    printf '"mem":{"totalKB":%s,"usedKB":%s},' "${mt:-0}" "${mu:-0}"
    printf '"disk":{"totalKB":%s,"usedKB":%s},' "${dt:-0}" "${du:-0}"
    printf '"metrics":{"diskIO":{"readBps":%s,"writeBps":%s,"iops":%s,"util":%s},"bandwidth":{"rxBps":%s,"txBps":%s},' \
      "${disk_read:-0}" "${disk_write:-0}" "${disk_iops:-0}" "${disk_util:-0}" "${net_rx:-0}" "${net_tx:-0}"
    swap_json
    printf '"agent":true},'
    docker_json
    pve_json
    [ -n "$temp" ] && printf '"temp":%s,' "$temp"
    printf '"services":[%s]}' "$(services_json)"
  } > "$tmp"
  curl -fsS $CURL_TLS_ARGS -m 20 -X POST -H "X-Agent-Token: $TOKEN" -H "Content-Type: application/json" \
    --data-binary @"$tmp" "$URL/api/agent/report" 2>/dev/null
  rc=$?
  rm -f "$tmp"
  return $rc
}

run_command() {
  local cid="$1" action="$2" target="$3" out b64
  printf '%s' "$target" | grep -Eq '^[a-zA-Z0-9@._:-]+$' || return
  case "$action" in
    status)
      out=$(systemctl status "$target" --no-pager -l 2>&1 | head -n 60) ;;
    start|stop|restart)
      out=$(systemctl "$action" "$target" 2>&1; echo "[exit $?]"; echo "state: $(systemctl is-active "$target" 2>&1)") ;;
    docker_logs)
      out=$(docker logs --tail 300 "$target" 2>&1 | tail -c 200000) ;;
    docker_prune)
      out=$(docker image prune -f 2>&1) ;;
    *) return ;;
  esac
  b64=$(printf '%s' "$out" | base64 2>/dev/null | tr -d '\n')
  curl -fsS $CURL_TLS_ARGS -m 10 -X POST -H "X-Agent-Token: $TOKEN" -H "Content-Type: application/json" \
    -d "{\"id\":\"$cid\",\"output\":\"$b64\"}" "$URL/api/agent/result" >/dev/null 2>&1
}

process_commands() {
  [ -n "$1" ] || return 0
  while IFS="$(printf '\t')" read -r tag cid action target; do
    [ "$tag" = "CMD" ] || continue
    run_command "$cid" "$action" "$target"
  done <<EOF
$1
EOF
}

echo "omnisight-agent $VERSION starting (id=$AGENT_ID, server=$URL, interval=${INTERVAL}s)"

while true; do
  resp=$(send_report)
  if [ $? -ne 0 ]; then
    sleep "$INTERVAL"
    continue
  fi
  process_commands "$resp"
  resp=$(curl -fsS $CURL_TLS_ARGS -m $((INTERVAL+5)) -H "X-Agent-Token: $TOKEN" \
    "$URL/api/agent/commands?id=$AGENT_ID&wait=$INTERVAL" 2>/dev/null) || sleep 2
  process_commands "$resp"
done
