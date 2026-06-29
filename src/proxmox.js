const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { Client } = require('ssh2');
const { loadHistoryMap, scheduleSaveHistoryMap } = require('./historyStore');
const { mapLimit } = require('./concurrency');

const PVE_HISTORY_MAX = 5760;
const pveHistory = loadHistoryMap('proxmox-history', PVE_HISTORY_MAX);
const pveSshDiskStats = new Map();

function percentValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  const pct = n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

function ratioValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.max(0, Math.min(1, n <= 1 ? n : n / 100));
}

function normBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

function authHeader(cfg) {
  if (!cfg.tokenId || !cfg.tokenSecret) return null;
  return `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`;
}

async function pveFetch(cfg, path) {
  return new Promise((resolve, reject) => {
    const base = normBase(cfg.url);
    if (!base) return reject(new Error('Proxmox URL is required'));
    const u = new URL(base + path);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { Authorization: authHeader(cfg) },
      rejectUnauthorized: cfg.insecureTLS ? false : undefined,
      timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = txt ? JSON.parse(txt) : {}; } catch {}
        if (res.statusCode >= 400) return reject(new Error(body?.errors ? JSON.stringify(body.errors) : (body?.message || res.statusMessage)));
        resolve(body.data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function expandPath(p) {
  return p ? String(p).replace(/^~(?=$|[\\/])/, os.homedir()) : p;
}

function shQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function cleanSshError(message) {
  const lines = String(message || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.join('\n') || 'SSH command failed';
}

function execSsh(host, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => done(new Error('SSH command timed out')), 30000);
    const cfg = {
      host: host.sshHost,
      port: Number(host.sshPort) || 22,
      username: host.sshUser || 'root',
      readyTimeout: 20000,
      tryKeyboard: true,
    };
    if (host.sshPassword) cfg.password = String(host.sshPassword);
    if (host.sshKey) {
      try { cfg.privateKey = fs.readFileSync(expandPath(host.sshKey)); } catch {}
    }
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return done(new Error(cleanSshError(err.message)));
        let stdout = '', stderr = '';
        if (/sudo\s+-S/.test(command) && host.sshPassword) stream.write(`${host.sshPassword}\n`);
        stream.on('data', d => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', d => { stderr += d.toString('utf8'); });
        stream.on('close', code => {
          if (code === 0) return done(null, stdout);
          done(new Error(cleanSshError(stderr || stdout || `SSH command failed (${code})`)));
        });
      });
    });
    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish(prompts.map(() => String(host.sshPassword || '')));
    });
    conn.on('error', err => done(new Error(cleanSshError(err.message))));
    conn.connect(cfg);
  });
}

function ramObj(used, total) {
  used = Number(used) || 0;
  total = Number(total) || 0;
  return {
    percent: total ? Math.round((used / total) * 100) : null,
    usedGB: (used / 1024 ** 3).toFixed(1),
    totalGB: (total / 1024 ** 3).toFixed(1),
    used,
    total,
  };
}

function rateNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function ratePair(a, b, ka, kb) {
  const av = rateNum(a);
  const bv = rateNum(b);
  if (av === null && bv === null) return null;
  return { [ka]: av, [kb]: bv };
}

const RATE_KEYS = {
  diskRead: ['diskread', 'disk_read', 'diskRead', 'io_read', 'read_bytes', 'readBps', 'diskReadBps'],
  diskWrite: ['diskwrite', 'disk_write', 'diskWrite', 'io_write', 'write_bytes', 'writeBps', 'diskWriteBps'],
  netIn: ['netin', 'net_in', 'netIn', 'rx', 'rx_bytes', 'rxBps', 'bandwidthRxBps'],
  netOut: ['netout', 'net_out', 'netOut', 'tx', 'tx_bytes', 'txBps', 'bandwidthTxBps'],
};

function pickRate(obj, keys) {
  for (const key of keys) {
    const n = rateNum(obj?.[key]);
    if (n !== null) return n;
  }
  return null;
}

function hasRateFields(row) {
  return pickRate(row, RATE_KEYS.diskRead) !== null ||
    pickRate(row, RATE_KEYS.diskWrite) !== null ||
    pickRate(row, RATE_KEYS.netIn) !== null ||
    pickRate(row, RATE_KEYS.netOut) !== null;
}

function latestRrdPoint(rows = []) {
  if (!Array.isArray(rows)) return null;
  return [...rows].reverse().find(hasRateFields) || null;
}

function ratePairFrom(sources, aKeys, bKeys, ka, kb) {
  for (const src of sources) {
    const av = pickRate(src, aKeys);
    const bv = pickRate(src, bKeys);
    if (av !== null || bv !== null) return { [ka]: av, [kb]: bv };
  }
  return null;
}

function tempNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 1000) return tempNum(n / 1000);
  return n > -50 && n < 150 ? n : null;
}

function tempLabel(label) {
  const s = String(label || '').toLowerCase();
  if (/nvme|ssd|disk|drive/.test(s)) {
    let clean = String(label || '')
      .replace(/(^|[\s._:-])(temp(erature)?|input|composite|sensor\s*\d+|temperature_celsius|temperature_internal|current|value)($|[\s._:-])/gi, ' ')
      .replace(/hwmon\d+|temp\d+|\/dev\//gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/(^|\s)node(\s|\/)|[/.]disk\b|[\\/]/i.test(clean)) clean = 'NVMe';
    if (!/nvme/i.test(clean)) clean = `NVMe ${clean}`;
    clean = clean.replace(/\s+/g, ' ').trim();
    return clean && clean.length > 5 ? `${clean.slice(0, 80)} temp` : 'NVMe temp';
  }
  if (/(^|[\s._:-])cpu($|[\s._:-])|coretemp|package|(^|[\s._:-])core($|[\s._:-]|\d)/.test(s)) return 'CPU temp';
  if (/gpu/.test(s)) return 'GPU temp';
  if (/dimm|memory|ram/.test(s)) return 'Memory temp';
  if (/pch|acpi|motherboard|mainboard|board|system/.test(s)) return 'System temp';
  return 'Temperature';
}

function tempHistoryKey(label) {
  const clean = String(label || 'temperature')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `temp_${clean || 'temperature'}`;
}

function tempScore(label) {
  const s = String(label || '').toLowerCase();
  if (/fan|rpm|volt|power|watt|freq|clock|load|usage|critical|crit|max|high|limit|alarm|cpuinfo|cpus/.test(s)) return -100;
  if (/(^|[\s._:-])cpu($|[\s._:-])|coretemp|package|(^|[\s._:-])core($|[\s._:-]|\d)/.test(s)) return 100;
  if (/nvme|ssd|disk|drive/.test(s)) return 40;
  if (/gpu/.test(s)) return 60;
  if (/pch|acpi|motherboard|mainboard|board|system|thermal/.test(s)) return 50;
  if (/temp|temperature|sensor|core/.test(s)) return 30;
  return -100;
}

function tempVariantScore(label) {
  const s = String(label || '').toLowerCase();
  let score = 0;
  if (/nvme|ssd|disk|drive/.test(s)) {
    if (/composite/.test(s)) score += 25;
    if (/(^|[\s._:-])sensor\s*\d+/.test(s)) score -= 25;
  }
  if (/(^|[\s._:-])cpu($|[\s._:-])|coretemp|package|(^|[\s._:-])core($|[\s._:-]|\d)/.test(s)) {
    if (/package|tctl|tdie/.test(s)) score += 25;
    if (/(^|[\s._:-])core\s*\d+/.test(s)) score -= 5;
  }
  return score;
}

function uniqueTemps(values = []) {
  const byLabel = new Map();
  values
    .filter(v => v && v.label && Number.isFinite(Number(v.value)))
    .forEach(v => {
      const prev = byLabel.get(v.label);
      if (!prev || v.score > prev.score || (v.score === prev.score && v.value > prev.value)) {
        byLabel.set(v.label, { value: Math.round(Number(v.value)), label: v.label, score: v.score });
      }
    });
  const rows = [...byLabel.values()];
  const isGenericNvme = label => /^nvme\s+temp$/i.test(label) || /\bnode\b|[/.]disk\b|[\\/]|hwmon|sensor/i.test(label);
  const hasNamedNvme = rows.some(t => /^nvme\s+.+\s+temp$/i.test(t.label) && !isGenericNvme(t.label));
  return rows
    .filter(t => !(hasNamedNvme && isGenericNvme(t.label)))
    .sort((a, b) => (b.score - a.score) || a.label.localeCompare(b.label));
}

function extractTemperatures(input) {
  const values = [];
  const seen = new Set();
  function add(value, label) {
    const score = tempScore(label) + tempVariantScore(label);
    const n = tempNum(value);
    if (score < 0 || n === null || n < 15 || n > 115) return;
    values.push({ value: Math.round(n), label: tempLabel(label), score });
  }
  function walk(value, key = '') {
    if (value == null) return;
    if (typeof value === 'number' || typeof value === 'string') {
      add(value, key);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${key}.${i}`));
      return;
    }
    const label = [key, value.name, value.label, value.sensor, value.type, value.id].filter(Boolean).join(' ');
    add(value.value ?? value.current ?? value.temp ?? value.temperature, label);
    for (const [k, v] of Object.entries(value)) {
      walk(v, [label, k].filter(Boolean).join('.'));
    }
  }
  walk(input);
  return uniqueTemps(values);
}

function extractTemperature(input) {
  return extractTemperatures(input)[0] || null;
}

function pveSshMetricHosts(cfg) {
  const hosts = Array.isArray(cfg.sshMetrics) ? cfg.sshMetrics : [];
  if (hosts.length) return hosts.filter(h => h && h.sshHost);
  return cfg.sshHost ? [{
    node: cfg.sshNode || cfg.node || '',
    name: cfg.sshName || cfg.sshHost,
    sshHost: cfg.sshHost,
    sshUser: cfg.sshUser,
    sshPort: cfg.sshPort,
    sshKey: cfg.sshKey,
    sshPassword: cfg.sshPassword,
    sudo: cfg.sudo,
  }] : [];
}

function findSshMetricHost(cfg, nodeName) {
  const hosts = pveSshMetricHosts(cfg);
  if (!hosts.length) return null;
  const want = String(nodeName || '').toLowerCase();
  return hosts.find(h => String(h.node || h.name || '').toLowerCase() === want)
    || hosts.find(h => String(h.sshHost || '').toLowerCase() === want)
    || null;
}

const SSH_METRICS_SCRIPT = [
  'PATH=$PATH:/usr/sbin:/usr/bin:/sbin:/bin',
  'for d in /sys/class/hwmon/hwmon*; do',
  '  [ -d "$d" ] || continue',
  '  n=$(cat "$d/name" 2>/dev/null || true)',
  '  for f in "$d"/temp*_input; do',
  '    [ -e "$f" ] || continue',
  '    l="${f%_input}_label"',
  '    label=$(cat "$l" 2>/dev/null || basename "$f")',
  '    val=$(cat "$f" 2>/dev/null || true)',
  '    printf "TEMP\\t%s\\t%s\\t%s\\n" "$n" "$label" "$val"',
  '  done',
  'done',
  'for b in /sys/block/*; do',
  '  [ -e "$b/stat" ] || continue',
  '  dev=${b##*/}',
  '  case "$dev" in loop*|ram*|zram*|fd*|sr*|nbd*) continue;; esac',
  '  case "$dev" in sd[a-z]*|vd[a-z]*|xvd[a-z]*|nvme[0-9]*n[0-9]*|mmcblk[0-9]*) ;; *) continue;; esac',
  '  set -- $(cat "$b/stat" 2>/dev/null || true)',
  '  [ $# -ge 7 ] || continue',
  '  printf "DISK\\t%s\\t%s\\t%s\\n" "$dev" "$3" "$7"',
  'done',
  'if command -v smartctl >/dev/null 2>&1; then',
  '  for b in /sys/block/*; do',
  '    [ -e "$b" ] || continue',
  '    dev=${b##*/}',
  '    case "$dev" in loop*|ram*|zram*|fd*|sr*|nbd*) continue;; esac',
  '    case "$dev" in sd[a-z]*|vd[a-z]*|xvd[a-z]*|nvme[0-9]*n[0-9]*|mmcblk[0-9]*) ;; *) continue;; esac',
  '    info=$(smartctl -i "/dev/$dev" 2>/dev/null || true)',
  '    model=$(printf "%s\\n" "$info" | awk -F: \'/Model Number|Device Model|Product/ {gsub(/^[ \\t]+|[ \\t]+$/, "", $2); print $2; exit}\')',
  '    serial=$(printf "%s\\n" "$info" | awk -F: \'/Serial Number/ {gsub(/^[ \\t]+|[ \\t]+$/, "", $2); print $2; exit}\')',
  '    firmware=$(printf "%s\\n" "$info" | awk -F: \'/Firmware Version/ {gsub(/^[ \\t]+|[ \\t]+$/, "", $2); print $2; exit}\')',
  '    [ -z "$model" ] && model=$(cat "$b/device/model" 2>/dev/null | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")',
  '    out=$(smartctl -H -A "/dev/$dev" 2>/dev/null || true)',
  '    health=$(printf "%s\\n" "$out" | awk -F: \'/SMART overall-health|SMART Health Status|self-assessment/ {gsub(/^[ \\t]+|[ \\t]+$/, "", $2); print $2; exit}\')',
  '    temp=$(printf "%s\\n" "$out" | awk \'/Temperature Sensor [0-9]+:/ {print $(NF-1); exit} /Composite Temperature:/ {print $(NF-1); exit} /Temperature:/ && $0 !~ /Warning|Critical/ {print $(NF-1); exit} /Temperature_Celsius/ {print $10; exit}\')',
  '    poh=$(printf "%s\\n" "$out" | awk -F: \'/Power On Hours/ {gsub(/[^0-9]/, "", $2); print $2; exit} /Power_On_Hours/ {print $10; exit}\')',
  '    used=$(printf "%s\\n" "$out" | awk -F: \'/Percentage Used/ {gsub(/[^0-9]/, "", $2); print $2; exit}\')',
  '    media=$(printf "%s\\n" "$out" | awk -F: \'/Media and Data Integrity Errors/ {gsub(/[^0-9]/, "", $2); print $2; exit}\')',
  '    realloc=$(printf "%s\\n" "$out" | awk \'/Reallocated_Sector_Ct/ {print $10; exit}\')',
  '    pending=$(printf "%s\\n" "$out" | awk \'/Current_Pending_Sector/ {print $10; exit}\')',
  '    uncorrect=$(printf "%s\\n" "$out" | awk \'/Offline_Uncorrectable/ {print $10; exit}\')',
  '    [ -n "$health" ] && printf "SMART\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$dev" "$health" "$model" "$serial" "$firmware" "$temp" "$poh" "$used" "$media" "$realloc" "$pending"',
  '    case "$temp" in ""|*[!0-9.]*) ;; *) printf "NVME_TEMP\\t%s\\t%s\\t%s\\n" "$dev" "$model" "$temp";; esac',
  '  done',
  'fi',
].join('\n');

function parseSshMetrics(text, key) {
  const tempCandidates = [];
  const smart = [];
  let readSectors = 0;
  let writeSectors = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts[0] === 'TEMP') {
      const source = parts[1] || '';
      const label = parts[2] || '';
      const raw = Number(parts[3]);
      const value = Number.isFinite(raw) ? raw / 1000 : NaN;
      const score = tempScore(`${source} ${label}`) + tempVariantScore(`${source} ${label}`);
      if (score >= 0 && Number.isFinite(value) && value >= 15 && value <= 115) {
        tempCandidates.push({ value: Math.round(value), label: tempLabel(`${source} ${label}`), score });
      }
    } else if (parts[0] === 'DISK') {
      readSectors += Number(parts[2]) || 0;
      writeSectors += Number(parts[3]) || 0;
    } else if (parts[0] === 'SMART') {
      const dev = parts[1] || '';
      const health = String(parts[2] || '').trim();
      if (dev && health) smart.push({
        device: dev,
        health,
        ok: /passed|ok|healthy/i.test(health),
        model: String(parts[3] || '').trim(),
        serial: String(parts[4] || '').trim(),
        firmware: String(parts[5] || '').trim(),
        temperature: rateNum(parts[6]),
        powerOnHours: rateNum(parts[7]),
        percentageUsed: rateNum(parts[8]),
        mediaErrors: rateNum(parts[9]),
        reallocatedSectors: rateNum(parts[10]),
        pendingSectors: rateNum(parts[11]),
      });
    } else if (parts[0] === 'NVME_TEMP') {
      const dev = parts[1] || '';
      const model = String(parts[2] || '').trim();
      const raw = Number(parts[3]);
      const value = Number.isFinite(raw) ? raw : NaN;
      const label = ['NVMe', model || dev].filter(Boolean).join(' ');
      if (Number.isFinite(value) && value >= 15 && value <= 115) {
        tempCandidates.push({ value: Math.round(value), label: tempLabel(label), score: 85 });
      }
    }
  }
  const tempInfos = uniqueTemps(tempCandidates);
  const now = Date.now();
  const readBytes = readSectors * 512;
  const writeBytes = writeSectors * 512;
  const prev = pveSshDiskStats.get(key);
  pveSshDiskStats.set(key, { time: now, readBytes, writeBytes });
  let diskIO = null;
  if (prev && now > prev.time && readBytes >= prev.readBytes && writeBytes >= prev.writeBytes) {
    const sec = Math.max(1, (now - prev.time) / 1000);
    diskIO = {
      readBps: Math.max(0, (readBytes - prev.readBytes) / sec),
      writeBps: Math.max(0, (writeBytes - prev.writeBytes) / sec),
    };
  }
  return { tempInfo: tempInfos[0] || null, tempInfos, diskIO, smart };
}

async function readSshMetrics(cfg, nodeName) {
  const host = findSshMetricHost(cfg, nodeName);
  if (!host?.sshHost) return null;
  const key = `${nodeName}:${host.sshHost}:${host.sshPort || 22}`;
  const base = `sh -c ${shQuote(SSH_METRICS_SCRIPT)}`;
  const command = host.sudo ? `sudo -S -p '' ${base}` : base;
  const text = await execSsh(host, command);
  return parseSshMetrics(text, key);
}

async function readSshMetricsSafe(cfg, nodeName) {
  const host = findSshMetricHost(cfg, nodeName);
  if (!host?.sshHost) return null;
  try {
    const metrics = await readSshMetrics(cfg, nodeName);
    return metrics ? { ...metrics, configured: true } : null;
  } catch (err) {
    const message = err?.message || String(err);
    console.warn(`[Proxmox ${nodeName}] SSH metrics fallback failed: ${message}`);
    return { error: message, configured: true };
  }
}

function svcName(s) {
  return String(s.name || s.service || s.id || '').replace(/\.service$/, '');
}

async function nodeData(cfg, node, excluded, resource = null) {
  const name = node.node || node.name;
  try {
    const [status, qemu, lxc, storage, services, rrdHour, sensors] = await Promise.all([
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/status`).catch(() => ({})),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/qemu`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/lxc`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/storage`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/services`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/rrddata?timeframe=hour&cf=AVERAGE`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/sensors`).catch(() => null),
    ]);
    const cpuRaw = ratioValue(status.cpu);
    const cpu = percentValue(status.cpu);
    const mem = ramObj(status.memory?.used, status.memory?.total);
    let rrdPoint = latestRrdPoint(rrdHour);
    if (!rrdPoint) {
      const rrdDay = await pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/rrddata?timeframe=day&cf=AVERAGE`).catch(() => []);
      rrdPoint = latestRrdPoint(rrdDay);
    }
    const metricSources = [rrdPoint, status, resource, node].filter(Boolean);
    const diskIO = ratePairFrom(metricSources, RATE_KEYS.diskRead, RATE_KEYS.diskWrite, 'readBps', 'writeBps');
    const bandwidth = ratePairFrom(metricSources, RATE_KEYS.netIn, RATE_KEYS.netOut, 'rxBps', 'txBps');
    const bandwidthTotal = bandwidth ? (Number(bandwidth.rxBps) || 0) + (Number(bandwidth.txBps) || 0) : null;
    const sshMetrics = await readSshMetricsSafe(cfg, name);
    const sshDiskAuthoritative = !!(sshMetrics?.configured && !sshMetrics.error);
    const finalDiskIO = sshDiskAuthoritative ? (sshMetrics.diskIO || null) : (sshMetrics?.diskIO || diskIO || null);
    const diskIOSource = sshMetrics?.diskIO ? 'ssh' : diskIO && !sshDiskAuthoritative ? 'api' : null;
    const finalDiskIOTotal = finalDiskIO ? (Number(finalDiskIO.readBps) || 0) + (Number(finalDiskIO.writeBps) || 0) : null;
    const apiTempInfos = uniqueTemps([
      ...extractTemperatures(sensors),
      ...extractTemperatures(status),
      ...extractTemperatures(resource),
      ...extractTemperatures(node),
    ]);
    const tempInfos = uniqueTemps([
      ...(sshMetrics?.tempInfos || []),
      ...(sshMetrics?.error ? [] : apiTempInfos),
    ]);
    const apiTempInfo = apiTempInfos[0] || null;
    const tempInfo = tempInfos[0] ?? (sshMetrics?.error ? null : apiTempInfo);
    const temp = tempInfo?.value ?? null;
    const hist = pveHistory.get(name) || [];
    const tempHistory = {};
    for (const t of tempInfos) {
      tempHistory[tempHistoryKey(t.label)] = t.value;
    }
    hist.push({ time: Date.now(), cpu, mem: mem.percent || 0, temp, ...tempHistory, diskIO: finalDiskIOTotal, bandwidth: bandwidthTotal });
    if (hist.length > PVE_HISTORY_MAX) hist.splice(0, hist.length - PVE_HISTORY_MAX);
    pveHistory.set(name, hist);
    scheduleSaveHistoryMap('proxmox-history', pveHistory, PVE_HISTORY_MAX);
    const exList = excluded[name] || [];
    return {
      node: {
        name,
        online: node.status !== 'offline',
        cpu,
        cpuRaw,
        cpuCores: Number(status.cpuinfo?.cpus || node.maxcpu || 0),
        ram: mem,
        temp,
        tempLabel: tempInfo?.label || null,
        temps: tempInfos.map(t => ({ label: t.label, value: t.value, historyKey: tempHistoryKey(t.label) })),
        uptime: Number(status.uptime) || null,
      },
      host: cfg.url,
      metrics: { diskIO: finalDiskIO, diskIOSource, bandwidth, smart: sshMetrics?.smart || [] },
      metricsError: sshMetrics?.error || null,
      services: (services || []).map(s => {
        const n = svcName(s);
        return { name: n, desc: s.desc || n, state: s.state || s.status || 'unknown', active: (s.state || s.status) === 'running', excluded: exList.includes(n) };
      }).filter(s => s.name),
      vms: [...(qemu || []).map(v => ({ ...v, type: 'vm' })), ...(lxc || []).map(v => ({ ...v, type: 'lxc' }))].filter(v => !v.template).map(v => ({
        id: v.vmid,
        name: String(v.name || v.vmid || '').slice(0, 128),
        type: v.type,
        os: v.os || v.ostype || v.osType || '',
        ostype: v.ostype || v.os || v.osType || '',
        status: v.status,
        running: v.status === 'running',
        cpu: percentValue(v.cpu),
        mem: Number(v.mem) || 0,
        maxmem: Number(v.maxmem) || 0,
        ram: v.mem && v.maxmem ? Math.round((v.mem / v.maxmem) * 100) : 0,
        disk: Number(v.disk) || 0,
        maxdisk: Number(v.maxdisk) || 0,
        uptime: Number(v.uptime) || 0,
        netin: Number(v.netin) || 0,
        netout: Number(v.netout) || 0,
        diskread: Number(v.diskread) || 0,
        diskwrite: Number(v.diskwrite) || 0,
        pid: v.pid || null,
        tags: v.tags || '',
        lock: v.lock || '',
      })),
      storage: (storage || []).map(s => ({
        name: String(s.storage || '').slice(0, 128),
        type: s.type || 'storage',
        active: Number(s.enabled) !== 0 && Number(s.active) !== 0,
        total: s.total || 0,
        used: s.used || 0,
        avail: s.avail || 0,
        percent: s.total ? Math.round(((s.used || 0) / s.total) * 100) : 0,
      })),
      history: [...hist],
      backup: null,
    };
  } catch (err) {
    return { node: { name, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } }, host: cfg.url, services: [], vms: [], history: [...(pveHistory.get(name) || [])], backup: null, storage: [], error: err.message };
  }
}

function numAny(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function cephHealthStatus(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      const nested = cephHealthStatus(value.status, value.health, value.health_status, value.overall_status);
      if (nested) return nested;
      continue;
    }
    const raw = String(value).trim().toUpperCase();
    if (!raw) continue;
    if (raw === 'OK') return 'HEALTH_OK';
    if (raw === 'WARN' || raw === 'WARNING') return 'HEALTH_WARN';
    if (raw === 'ERR' || raw === 'ERROR') return 'HEALTH_ERR';
    const match = raw.match(/\bHEALTH_(OK|WARN|ERR)\b/);
    if (match) return `HEALTH_${match[1]}`;
  }
  return '';
}

function normalizeCephStatus(raw, dfRaw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const statusData = raw.statusData || raw.cephStatus || raw.status_data || raw;
  const dfData = raw.df || raw.dfData || raw.cephDf || dfRaw || null;
  const health = statusData.health || statusData.health_status || statusData.status || statusData;
  const status = cephHealthStatus(health, statusData.health, statusData.health_status, statusData.status, raw.health, raw.status);
  if (!status) return null;
  const checks = [];
  const src = health.checks || statusData.checks || {};
  if (Array.isArray(src)) {
    src.forEach(c => {
      const msg = c?.summary?.message || c?.message || c?.summary || c?.name;
      if (msg) checks.push(String(msg).slice(0, 300));
    });
  } else if (src && typeof src === 'object') {
    for (const k of Object.keys(src)) {
      const c = src[k];
      const msg = c?.summary?.message || c?.message || c?.summary || k;
      if (msg) checks.push(String(msg).slice(0, 300));
    }
  }
  const osdmap = statusData.osdmap?.osdmap || statusData.osdmap || {};
  const osd = {
    total: numAny(osdmap.num_osds, osdmap.num_osd, osdmap.osd_count),
    up: numAny(osdmap.num_up_osds, osdmap.num_up_osd, osdmap.up),
    in: numAny(osdmap.num_in_osds, osdmap.num_in_osd, osdmap.in),
  };
  const stats = dfData?.stats || statusData.pgmap || {};
  const totalBytes = numAny(stats.total_bytes, stats.bytes_total, statusData.pgmap?.bytes_total);
  const usedBytes = numAny(stats.total_used_bytes, stats.bytes_used, statusData.pgmap?.bytes_used);
  const availBytes = numAny(stats.total_avail_bytes, stats.bytes_avail, statusData.pgmap?.bytes_avail);
  const usage = totalBytes ? {
    totalBytes,
    usedBytes: usedBytes || 0,
    availBytes: availBytes ?? Math.max(0, totalBytes - (usedBytes || 0)),
    percent: Math.round(((usedBytes || 0) / totalBytes) * 1000) / 10,
  } : null;
  return { health: status, checks, osd, usage };
}

async function getProxmoxApiData(cfg = {}) {
  if (!cfg.url || !cfg.tokenId || !cfg.tokenSecret) return { clusterSummary: null, nodes: [], ceph: null };
  const excluded = cfg.excludedServices?.proxmox || {};
  const [nodesRaw, resourcesRaw, cephRaw, cephDfRaw] = await Promise.all([
    pveFetch(cfg, '/api2/json/nodes'),
    pveFetch(cfg, '/api2/json/cluster/resources').catch(() => []),
    pveFetch(cfg, '/api2/json/cluster/ceph/status').catch(() => null),
    pveFetch(cfg, '/api2/json/cluster/ceph/df').catch(() => null),
  ]);
  const resourcesByNode = new Map((resourcesRaw || [])
    .filter(r => r.type === 'node' && (r.node || r.id))
    .map(r => [String(r.node || r.id).replace(/^node\//, ''), r]));
  const nodes = (await mapLimit((nodesRaw || []), Number(cfg.concurrency || cfg.collectorConcurrency || 3), n => nodeData(cfg, n, excluded, resourcesByNode.get(n.node || n.name))))
    .sort((a, b) => String(a.node.name).localeCompare(String(b.node.name)));
  const onlineNodes = nodes.filter(n => n.node.online);
  const clusterSummary = {
    nodesOnline: onlineNodes.length,
    totalNodes: nodes.length,
    totalCores: nodes.reduce((s, n) => s + (n.node.cpuCores || 0), 0),
    usedCores: onlineNodes.reduce((s, n) => s + (n.node.cpuRaw || 0) * (n.node.cpuCores || 0), 0),
    totalRAM: nodes.reduce((s, n) => s + (n.node.ram?.total || 0), 0),
    usedRAM: onlineNodes.reduce((s, n) => s + (n.node.ram?.used || 0), 0),
  };
  return { clusterSummary, nodes, ceph: normalizeCephStatus(cephRaw, cephDfRaw) };
}

module.exports = { getProxmoxApiData };
