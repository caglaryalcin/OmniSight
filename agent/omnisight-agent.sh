#!/usr/bin/env bash
set -u

ENV_FILE="/etc/omnisight-agent/agent.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

URL="${OMNISIGHT_URL:?OMNISIGHT_URL required}"
URL="${URL%/}"
TOKEN="${OMNISIGHT_TOKEN:?OMNISIGHT_TOKEN required}"
INTERVAL="${OMNISIGHT_INTERVAL:-15}"
AGENT_ROLE="${OMNISIGHT_AGENT_ROLE:-auto}"
VERSION="1.2.4"
HOST_ROOT="${OMNISIGHT_HOST_ROOT:-/}"
INSECURE_TLS="${OMNISIGHT_INSECURE_TLS:-}"
CURL_TLS_ARGS=""
case "$INSECURE_TLS" in
  1|true|TRUE|yes|YES) CURL_TLS_ARGS="--insecure" ;;
esac
CURL_POST_REDIRECT_ARGS="--post301 --post302 --post303"

HOSTNAME_S="$(hostname -s 2>/dev/null || hostname)"
AGENT_ID="${OMNISIGHT_AGENT_ID:-}"
if [ -z "$AGENT_ID" ]; then
  MID="$(cat /etc/machine-id 2>/dev/null || true)"
  AGENT_ID="${HOSTNAME_S}-${MID:-$(hostname)}"
fi

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t'; }

docker_cmd() {
  if docker "$@" 2>/dev/null; then return 0; fi
  command -v sudo >/dev/null 2>&1 || return 1
  sudo docker "$@"
}

docker_cmd_capture() {
  local out rc
  out=$(docker "$@" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    out=$(sudo docker "$@" 2>&1)
    rc=$?
  fi
  printf '%s' "$out"
  return "$rc"
}

detect_type() {
  case "$AGENT_ROLE" in
    proxmox) echo proxmox; return ;;
    synology) echo synology; return ;;
    linux|docker) echo linux; return ;;
  esac
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

is_metric_block_device() {
  case "$1" in loop*|ram*|zram*|fd*|sr*|nbd*) return 1;; esac
  case "$1" in sd[a-z]*|hd[a-z]*|vd[a-z]*|xvd[a-z]*|nvme[0-9]*n[0-9]*|mmcblk[0-9]*|md[0-9]*|dm-[0-9]*|dasd[a-z]*|cciss!c[0-9]*d[0-9]*) return 0;; esac
  return 1
}

disk_counters() {
  awk '
    $3 ~ /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+|md[0-9]+|dm-[0-9]+|dasd[a-z]+|cciss!c[0-9]+d[0-9]+)$/ {
      readSectors += $6; writeSectors += $10; ops += $4 + $8; ioMs += $13
    }
    END { printf "%d %d %d %d", readSectors * 512, writeSectors * 512, ops, ioMs }
  ' /proc/diskstats 2>/dev/null
}

net_counters() {
  awk -F'[: ]+' '
    NR > 2 {
      iface = $2
      if (iface == "lo" || iface ~ /^(docker|br-[0-9a-f]|veth|virbr|cni|flannel|kube|tunl|gre|sit|wg|tun|tap|tailscale|zt)/) next
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

temps_json() {
  command -v smartctl >/dev/null 2>&1 || return 0
  local first=1 b dev info model out temp label
  printf '"temps":['
  for b in /sys/block/*; do
    [ -e "$b" ] || continue
    dev=${b##*/}
    is_metric_block_device "$dev" || continue
    info=$(smartctl -i "/dev/$dev" 2>/dev/null || true)
    model=$(printf "%s\n" "$info" | awk -F: '/Model Number|Device Model|Product/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}')
    [ -z "$model" ] && model=$(cat "$b/device/model" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    out=$(smartctl -A "/dev/$dev" 2>/dev/null || true)
    temp=$(printf "%s\n" "$out" | awk '/Temperature Sensor [0-9]+:/ {print $(NF-1); exit} /Composite Temperature:/ {print $(NF-1); exit} /Temperature:/ && $0 !~ /Warning|Critical/ {print $(NF-1); exit} /Temperature_Celsius/ {print $10; exit}')
    case "$temp" in ''|*[!0-9.]* ) continue;; esac
    case "$dev" in nvme*) label="NVMe ${model:-$dev} temp";; *) label="${model:-$dev} temp";; esac
    [ "$first" -eq 0 ] && printf ','
    first=0
    printf '{"label":"%s","value":%s}' "$(json_escape "$label")" "$temp"
  done
  printf '],'
}

smart_json() {
  command -v smartctl >/dev/null 2>&1 || return 0
  local first=1 b dev info model serial firmware out health temp poh used media realloc pending
  printf '"smart":['
  for b in /sys/block/*; do
    [ -e "$b" ] || continue
    dev=${b##*/}
    is_metric_block_device "$dev" || continue
    info=$(smartctl -i "/dev/$dev" 2>/dev/null || true)
    model=$(printf "%s\n" "$info" | awk -F: '/Model Number|Device Model|Product/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}')
    serial=$(printf "%s\n" "$info" | awk -F: '/Serial Number/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}')
    firmware=$(printf "%s\n" "$info" | awk -F: '/Firmware Version/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}')
    [ -z "$model" ] && model=$(cat "$b/device/model" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    out=$(smartctl -H -A "/dev/$dev" 2>/dev/null || true)
    health=$(printf "%s\n" "$out" | awk -F: '/SMART overall-health|SMART Health Status|self-assessment/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}')
    [ -z "$health" ] && continue
    temp=$(printf "%s\n" "$out" | awk '/Temperature Sensor [0-9]+:/ {print $(NF-1); exit} /Composite Temperature:/ {print $(NF-1); exit} /Temperature:/ && $0 !~ /Warning|Critical/ {print $(NF-1); exit} /Temperature_Celsius/ {print $10; exit}')
    poh=$(printf "%s\n" "$out" | awk -F: '/Power On Hours/ {gsub(/[^0-9]/, "", $2); print $2; exit} /Power_On_Hours/ {print $10; exit}')
    used=$(printf "%s\n" "$out" | awk -F: '/Percentage Used/ {gsub(/[^0-9]/, "", $2); print $2; exit}')
    media=$(printf "%s\n" "$out" | awk -F: '/Media and Data Integrity Errors/ {gsub(/[^0-9]/, "", $2); print $2; exit}')
    realloc=$(printf "%s\n" "$out" | awk '/Reallocated_Sector_Ct/ {print $10; exit}')
    pending=$(printf "%s\n" "$out" | awk '/Current_Pending_Sector/ {print $10; exit}')
    [ "$first" -eq 0 ] && printf ','
    first=0
    printf '{"device":"%s","health":"%s","ok":%s' "$(json_escape "$dev")" "$(json_escape "$health")" "$(printf '%s' "$health" | grep -Eiq 'passed|ok|healthy' && echo true || echo false)"
    [ -n "$model" ] && printf ',"model":"%s"' "$(json_escape "$model")"
    [ -n "$serial" ] && printf ',"serial":"%s"' "$(json_escape "$serial")"
    [ -n "$firmware" ] && printf ',"firmware":"%s"' "$(json_escape "$firmware")"
    case "$temp" in ''|*[!0-9.]* ) ;; *) printf ',"temperature":%s' "$temp";; esac
    case "$poh" in ''|*[!0-9]* ) ;; *) printf ',"powerOnHours":%s' "$poh";; esac
    case "$used" in ''|*[!0-9]* ) ;; *) printf ',"percentageUsed":%s' "$used";; esac
    case "$media" in ''|*[!0-9]* ) ;; *) printf ',"mediaErrors":%s' "$media";; esac
    case "$realloc" in ''|*[!0-9]* ) ;; *) printf ',"reallocatedSectors":%s' "$realloc";; esac
    case "$pending" in ''|*[!0-9]* ) ;; *) printf ',"pendingSectors":%s' "$pending";; esac
    printf '}'
  done
  printf '],'
}

services_json() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl list-units --type=service --state=running,failed --no-legend --no-pager --plain 2>/dev/null |
  awk '{
    name=$1; sub(/\.service$/,"",name); gsub(/["\\]/,"",name);
    printf "%s{\"name\":\"%s\",\"active\":%s,\"state\":\"%s\"}", (c++?",":""), name, ($3=="active"?"true":"false"), $4
  }'
}

docker_unused_count() {
  local usedf imagesf ids unused
  usedf=$(mktemp)
  imagesf=$(mktemp)
  docker_cmd ps -a --no-trunc --format '{{.Image}}' > "$usedf" 2>/dev/null || true
  ids=$(docker_cmd ps -aq --no-trunc 2>/dev/null || true)
  if [ -n "$ids" ]; then
    docker_cmd inspect --format '{{.Image}}' $ids >> "$usedf" 2>/dev/null || true
  fi
  if ! docker_cmd images --no-trunc --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Digest}}' > "$imagesf" 2>/dev/null; then
    rm -f "$usedf" "$imagesf"
    printf '0'
    return
  fi
  unused=$(awk -F'|' '
    function trim(v) { gsub(/^[ \t]+|[ \t]+$/, "", v); return v }
    function clean(v) {
      v = trim(v)
      gsub(/^\/+/, "", v)
      sub(/^docker\.io\//, "", v)
      return v
    }
    function has_tag(v, parts, n, last) {
      if (v ~ /@/ || v ~ /^sha256:/) return 1
      n = split(v, parts, "/")
      last = parts[n]
      return index(last, ":") > 0
    }
    function add_used(v, w) {
      v = clean(v)
      if (v == "" || v == "<none>" || v == "<none>:<none>") return
      used[v] = 1
      if (v ~ /^sha256:/) { w = v; sub(/^sha256:/, "", w); used[w] = 1 }
      if (v ~ /^library\//) {
        w = substr(v, 9)
        used[w] = 1
        if (!has_tag(w)) used[w ":latest"] = 1
      }
      if (!has_tag(v)) used[v ":latest"] = 1
    }
    function add_ref(v, w) {
      v = clean(v)
      if (v == "" || v == "<none>" || v == "<none>:<none>") return
      refs[++nrefs] = v
      if (v ~ /^sha256:/) { w = v; sub(/^sha256:/, "", w); refs[++nrefs] = w }
      if (v ~ /^library\//) {
        w = substr(v, 9)
        refs[++nrefs] = w
        if (!has_tag(w)) refs[++nrefs] = w ":latest"
      }
      if (!has_tag(v)) refs[++nrefs] = v ":latest"
    }
    FNR == NR { add_used($0); next }
    {
      for (k in refs) delete refs[k]
      nrefs = 0
      add_ref($1)
      repo = clean($2)
      tag = trim($3)
      digest = trim($4)
      if (repo != "" && repo != "<none>") {
        if (tag != "" && tag != "<none>") add_ref(repo ":" tag)
        if (digest != "" && digest != "<none>") add_ref(repo "@" digest)
      }
      used_row = 0
      for (i = 1; i <= nrefs; i++) if (refs[i] in used) used_row = 1
      if (nrefs > 0 && !used_row) count++
    }
    END { print count + 0 }
  ' "$usedf" "$imagesf")
  rm -f "$usedf" "$imagesf"
  printf '%s' "${unused:-0}"
}

docker_json() {
  command -v docker >/dev/null 2>&1 || return 0
  docker_cmd info >/dev/null 2>&1 || return 0
  local unused rows statsf
  unused=$(docker_unused_count)
  statsf=$(mktemp)
  docker_cmd stats --no-stream --no-trunc --format '{{.ID}}|{{.CPUPerc}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}' > "$statsf" 2>/dev/null || true
  rows=$(docker_cmd ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.Labels}}' 2>/dev/null)
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
    if ($7 != "") printf ",\"labelsText\":\"%s\"", $7
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
  local res ceph cephdf task
  res=$(timeout 12 pvesh get /cluster/resources --output-format json 2>/dev/null)
  [ -n "$res" ] || return 0
  ceph=$(timeout 8 pvesh get /cluster/ceph/status --output-format json 2>/dev/null)
  [ -z "$ceph" ] && ceph=$(timeout 8 pvesh get /ceph/status --output-format json 2>/dev/null)
  [ -z "$ceph" ] && ceph=$(timeout 8 pvesh get "/nodes/$HOSTNAME_S/ceph/status" --output-format json 2>/dev/null)
  cephdf=$(timeout 8 pvesh get /cluster/ceph/df --output-format json 2>/dev/null)
  [ -z "$cephdf" ] && cephdf=$(timeout 8 pvesh get /ceph/df --output-format json 2>/dev/null)
  task=$(timeout 8 pvesh get "/nodes/$HOSTNAME_S/tasks" --typefilter vzdump --limit 1 --output-format json 2>/dev/null)
  printf '"pve":{"node":"%s","resources":%s' "$(json_escape "$HOSTNAME_S")" "$res"
  if [ -n "$cephdf" ]; then
    [ -n "$ceph" ] && printf ',"ceph":{"statusData":%s,"df":%s}' "$ceph" "$cephdf"
  else
    [ -n "$ceph" ] && printf ',"ceph":%s' "$ceph"
  fi
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
    printf '"id":"%s","hostname":"%s","ip":"%s","os":"%s","kernel":"%s","platform":"%s","role":"%s","agentVersion":"%s","interval":%s,' \
      "$(json_escape "$AGENT_ID")" "$(json_escape "$HOSTNAME_S")" "$(json_escape "$ip")" "$os" \
      "$(json_escape "$(uname -r)")" "$(detect_type)" "$(json_escape "$AGENT_ROLE")" "$VERSION" "$INTERVAL"
    printf '"uptime":%s,"cpu":%s,"cores":%s,"load":[%s,%s,%s],' "${up:-0}" "${cpu:-0}" "$(cpu_cores)" "${l1:-0}" "${l5:-0}" "${l15:-0}"
    printf '"mem":{"totalKB":%s,"usedKB":%s},' "${mt:-0}" "${mu:-0}"
    printf '"disk":{"totalKB":%s,"usedKB":%s},' "${dt:-0}" "${du:-0}"
    printf '"metrics":{"diskIO":{"readBps":%s,"writeBps":%s,"iops":%s,"util":%s},"bandwidth":{"rxBps":%s,"txBps":%s},' \
      "${disk_read:-0}" "${disk_write:-0}" "${disk_iops:-0}" "${disk_util:-0}" "${net_rx:-0}" "${net_tx:-0}"
    swap_json
    temps_json
    smart_json
    printf '"agent":true},'
    case "$AGENT_ROLE" in
      linux) ;;
      proxmox) pve_json ;;
      docker) docker_json ;;
      *) docker_json; pve_json ;;
    esac
    [ -n "$temp" ] && printf '"temp":%s,' "$temp"
    printf '"services":[%s]}' "$(services_json)"
  } > "$tmp"
  curl -fsSL $CURL_POST_REDIRECT_ARGS $CURL_TLS_ARGS -m 20 -X POST -H "X-Agent-Token: $TOKEN" -H "Content-Type: application/json" \
    --data-binary @"$tmp" "$URL/api/agent/report"
  rc=$?
  rm -f "$tmp"
  return $rc
}

run_command() {
  local cid="$1" action="$2" target="$3" out b64 restart_agent
  printf '%s' "$target" | grep -Eq '^[a-zA-Z0-9@._:-]+$' || return
  case "$action" in
    status)
      out=$(systemctl status "$target" --no-pager -l 2>&1 | head -n 60) ;;
    start|stop|restart)
      out=$(systemctl "$action" "$target" 2>&1; echo "[exit $?]"; echo "state: $(systemctl is-active "$target" 2>&1)") ;;
    docker_logs)
      out=$(docker_cmd_capture logs --tail 300 "$target" | tail -c 200000) ;;
    docker_prune)
      out=$(docker_cmd_capture image prune -a -f) ;;
    agent_update)
      tmp="$(mktemp)"
      if curl -fsSL $CURL_TLS_ARGS -m 30 "$URL/agent/omnisight-agent.sh" -o "$tmp"; then
        chmod 755 "$tmp"
        install -m 755 "$tmp" /usr/local/bin/omnisight-agent
        rm -f "$tmp"
        out="omnisight-agent updated; restart scheduled"
        restart_agent=1
      else
        rc=$?
        rm -f "$tmp"
        out="agent update failed (curl exit $rc)"
      fi ;;
    *) return ;;
  esac
  b64=$(printf '%s' "$out" | base64 2>/dev/null | tr -d '\n')
  curl -fsSL $CURL_POST_REDIRECT_ARGS $CURL_TLS_ARGS -m 10 -X POST -H "X-Agent-Token: $TOKEN" -H "Content-Type: application/json" \
    -d "{\"id\":\"$cid\",\"output\":\"$b64\"}" "$URL/api/agent/result" >/dev/null 2>&1
  if [ "${restart_agent:-}" = "1" ]; then
    ( sleep 1; if command -v systemctl >/dev/null 2>&1; then systemctl restart omnisight-agent >/dev/null 2>&1 || true; else kill "$$" >/dev/null 2>&1 || true; fi ) &
  fi
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
    echo "omnisight-agent report failed; retrying in ${INTERVAL}s" >&2
    sleep "$INTERVAL"
    continue
  fi
  process_commands "$resp"
  resp=$(curl -fsSL $CURL_TLS_ARGS -m $((INTERVAL+5)) -H "X-Agent-Token: $TOKEN" \
    "$URL/api/agent/commands?id=$AGENT_ID&wait=$INTERVAL" 2>/dev/null) || sleep 2
  process_commands "$resp"
done
