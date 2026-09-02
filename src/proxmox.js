const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { Client } = require('ssh2');
const { loadHistoryMap, scheduleSaveHistoryMap } = require('./historyStore');
const { mapLimit } = require('./concurrency');
const { normalizeCephStatus } = require('./ceph');

const PVE_HISTORY_MAX = 5760;
const pveHistory = loadHistoryMap('proxmox-history', PVE_HISTORY_MAX);
const pveSshDiskStats = new Map();
const pveGuestFsCache = new Map();
const pveGuestFsInflight = new Map();

const PVE_GUEST_FS_CACHE_MS = 5 * 60 * 1000;
const PVE_GUEST_FS_FAILURE_CACHE_MS = 60 * 1000;
const PVE_GUEST_FS_STALE_MS = 30 * 60 * 1000;
const PVE_GUEST_FS_TIMEOUT_MS = 6000;
const PVE_GUEST_FS_BATCH_BUDGET_MS = 12000;

const PVE_GUEST_FS_PSEUDO_TYPES = new Set([
  'autofs', 'binfmt_misc', 'cgroup', 'cgroup2', 'configfs', 'debugfs', 'devpts',
  'devtmpfs', 'erofs', 'fusectl', 'hugetlbfs', 'iso9660', 'mqueue', 'nsfs',
  'overlay', 'proc', 'pstore', 'ramfs', 'securityfs', 'squashfs', 'sysfs',
  'tmpfs', 'tracefs', 'udf',
]);
const PVE_GUEST_FS_REMOTE_TYPES = new Set([
  '9p', 'afs', 'ceph', 'cifs', 'fuse.sshfs', 'glusterfs', 'nfs', 'nfs4',
  'smb2', 'smb3', 'sshfs', 'virtiofs',
]);

function optionalNonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function guestFsRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.result)) return raw.result;
  if (Array.isArray(raw?.data?.result)) return raw.data.result;
  if (Array.isArray(raw?.return)) return raw.return;
  return [];
}

function isWindowsRootMount(mountpoint) {
  return /^[a-z]:[\\/]*$/i.test(String(mountpoint || '').trim());
}

function normalizeGuestFsInfo(raw) {
  const candidates = [];
  for (const row of guestFsRows(raw)) {
    if (!row || typeof row !== 'object') continue;
    const privilegedTotal = optionalNonNegativeNumber(row['total-bytes-privileged'] ?? row.totalBytesPrivileged);
    const regularTotal = optionalNonNegativeNumber(row['total-bytes'] ?? row.totalBytes ?? row.total);
    const totalBytes = privilegedTotal > 0 ? privilegedTotal : regularTotal;
    const rawUsed = optionalNonNegativeNumber(row['used-bytes'] ?? row.usedBytes ?? row.used);
    if (!(totalBytes > 0) || rawUsed === null) continue;
    const mountpoint = String(row.mountpoint ?? row.mountPoint ?? '').trim();
    const filesystem = String(row.type ?? row.filesystem ?? '').trim().toLowerCase();
    const device = String(row.name ?? row.device ?? '').trim();
    const deviceLower = device.toLowerCase();
    const mountLower = mountpoint.toLowerCase().replace(/\\/g, '/');
    if (PVE_GUEST_FS_PSEUDO_TYPES.has(filesystem) || PVE_GUEST_FS_REMOTE_TYPES.has(filesystem)) continue;
    if (/^(?:\/dev\/)?(?:zram|loop)\d*$/.test(deviceLower) || deviceLower === 'tmpfs') continue;
    if (/^\/(?:proc|sys|dev|run)(?:\/|$)/.test(mountLower)) continue;
    candidates.push({
      mountpoint,
      filesystem,
      device,
      usedBytes: Math.min(rawUsed, totalBytes),
      totalBytes,
    });
  }
  if (!candidates.length) return null;

  const largest = candidates.reduce((best, row) => row.totalBytes > best.totalBytes ? row : best);
  const windowsRoot = candidates.find(row => /^c:[\\/]*$/i.test(row.mountpoint))
    || candidates.find(row => isWindowsRootMount(row.mountpoint));
  const unixRoot = candidates.find(row => row.mountpoint === '/');
  // Appliance guests such as HAOS expose a tiny read-only root plus a much larger
  // persistent data filesystem. In that case the data filesystem is the useful metric.
  const unixRootIsTiny = unixRoot
    && unixRoot.totalBytes < 2 * 1024 ** 3
    && largest.totalBytes >= unixRoot.totalBytes * 4;
  const selected = windowsRoot || (unixRoot && !unixRootIsTiny ? unixRoot : largest);
  return {
    usedBytes: selected.usedBytes,
    totalBytes: selected.totalBytes,
    percent: Math.round((selected.usedBytes / selected.totalBytes) * 1000) / 10,
    mountpoint: selected.mountpoint || null,
    filesystem: selected.filesystem || null,
    device: selected.device || null,
    filesystemCount: candidates.length,
    source: 'qemu-guest-agent',
  };
}

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

function optionalBool(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'online', 'active', 'quorate'].includes(text)) return true;
  if (['0', 'false', 'no', 'offline', 'inactive', 'lost'].includes(text)) return false;
  return null;
}

function clusterMemberOnline(row = {}) {
  const direct = optionalBool(row.online);
  if (direct !== null) return direct;
  return optionalBool(row.status);
}

function normalizeClusterStatus(rawStatus, options = {}) {
  const statusRows = Array.isArray(rawStatus)
    ? rawStatus
    : Array.isArray(rawStatus?.data)
      ? rawStatus.data
      : [];
  const nodeRows = Array.isArray(options.nodesRaw) ? options.nodesRaw : [];
  const clusterRow = statusRows.find(row => String(row?.type || '').toLowerCase() === 'cluster') || null;
  const membersByName = new Map();
  const addMember = row => {
    const name = String(row?.name || row?.node || '').trim().slice(0, 128);
    if (!name) return;
    const previous = membersByName.get(name) || {};
    const online = clusterMemberOnline(row);
    const local = optionalBool(row?.local);
    const nodeId = Number(row?.nodeid ?? row?.nodeId);
    membersByName.set(name, {
      name,
      online: online === null ? (previous.online ?? null) : online,
      local: local === null ? (previous.local ?? false) : local,
      nodeId: Number.isFinite(nodeId) ? nodeId : (previous.nodeId ?? null),
    });
  };
  statusRows
    .filter(row => String(row?.type || '').toLowerCase() === 'node')
    .forEach(addMember);
  nodeRows.forEach(addMember);
  const members = [...membersByName.values()]
    .sort((a, b) => (Number(a.nodeId ?? Number.MAX_SAFE_INTEGER) - Number(b.nodeId ?? Number.MAX_SAFE_INTEGER)) || a.name.localeCompare(b.name));
  const configuredName = String(options.name || options.label || 'Proxmox').trim().slice(0, 128) || 'Proxmox';
  const detectedName = String(clusterRow?.name || '').trim().slice(0, 128);
  const isCluster = !!clusterRow || members.length > 1;
  const localNode = members.find(member => member.local)?.name || '';
  const totalFromCluster = Number(clusterRow?.nodes);
  const totalNodes = Math.max(members.length, Number.isFinite(totalFromCluster) ? Math.max(0, Math.floor(totalFromCluster)) : 0);
  const nodesOnline = members.filter(member => member.online === true).length;
  const version = Number(clusterRow?.version);
  return {
    name: detectedName || (isCluster ? configuredName : (localNode || members[0]?.name || configuredName)),
    configuredName,
    isCluster,
    detected: !!clusterRow,
    quorate: isCluster && clusterRow ? optionalBool(clusterRow.quorate) : null,
    version: Number.isFinite(version) ? version : null,
    totalNodes,
    nodesOnline,
    localNode,
    members,
  };
}

function normBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

function authHeader(cfg) {
  if (!cfg.tokenId || !cfg.tokenSecret) return null;
  return `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`;
}

async function pveFetch(cfg, path, options = {}) {
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
      timeout: Math.max(500, Number(options.timeoutMs) || 10000),
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

function guestFsCacheKey(cfg, vmid) {
  return `${cfg.instanceKey || normBase(cfg.url)}:${vmid}`;
}

function freshGuestFsCache(key, now = Date.now()) {
  const entry = pveGuestFsCache.get(key);
  if (!entry || entry.expiresAt <= now) return { hit: false, entry };
  return { hit: true, entry, value: entry.value };
}

function staleGuestFsCacheValue(entry, now = Date.now()) {
  if (!entry?.value || now - Number(entry.checkedAt || 0) > PVE_GUEST_FS_STALE_MS) return null;
  return { ...entry.value, stale: true };
}

async function queryGuestFsUsage(cfg, nodeName, vmid, timeoutMs = PVE_GUEST_FS_TIMEOUT_MS) {
  const key = guestFsCacheKey(cfg, vmid);
  const now = Date.now();
  const cached = freshGuestFsCache(key, now);
  if (cached.hit) return cached.value;
  if (pveGuestFsInflight.has(key)) return pveGuestFsInflight.get(key);
  const pending = (async () => {
    try {
      const result = await pveFetch(
        cfg,
        `/api2/json/nodes/${encodeURIComponent(nodeName)}/qemu/${encodeURIComponent(vmid)}/agent/get-fsinfo`,
        { timeoutMs },
      );
      const normalized = normalizeGuestFsInfo(result);
      const checkedAt = Date.now();
      const value = normalized ? { ...normalized, checkedAt, stale: false } : null;
      pveGuestFsCache.set(key, {
        value,
        checkedAt,
        expiresAt: checkedAt + (value ? PVE_GUEST_FS_CACHE_MS : PVE_GUEST_FS_FAILURE_CACHE_MS),
      });
      return value;
    } catch {
      const failedAt = Date.now();
      const previous = cached.entry;
      const value = staleGuestFsCacheValue(previous, failedAt);
      const canUseStale = !!value;
      pveGuestFsCache.set(key, {
        value,
        checkedAt: canUseStale ? previous.checkedAt : failedAt,
        expiresAt: failedAt + PVE_GUEST_FS_FAILURE_CACHE_MS,
      });
      return value;
    } finally {
      pveGuestFsInflight.delete(key);
    }
  })();
  pveGuestFsInflight.set(key, pending);
  return pending;
}

async function collectGuestFsUsage(cfg, resources) {
  const runningGuests = (Array.isArray(resources) ? resources : [])
    .filter(row => row && row.type === 'qemu' && !row.template && row.status === 'running'
      && row.node && row.vmid !== undefined && row.vmid !== null);
  if (!runningGuests.length) return new Map();
  const configuredConcurrency = Number(cfg.guestAgentConcurrency ?? cfg.qgaConcurrency ?? 6);
  const concurrency = Math.max(1, Math.min(8, Number.isFinite(configuredConcurrency) ? configuredConcurrency : 6));
  const configuredBudget = Number(cfg.guestAgentCollectionBudgetMs ?? cfg.qgaCollectionBudgetMs ?? PVE_GUEST_FS_BATCH_BUDGET_MS);
  const budgetMs = Math.max(3000, Math.min(30000, Number.isFinite(configuredBudget) ? configuredBudget : PVE_GUEST_FS_BATCH_BUDGET_MS));
  const deadline = Date.now() + budgetMs;
  const rows = await mapLimit(runningGuests, concurrency, async guest => {
    const id = String(guest.vmid);
    const cached = freshGuestFsCache(guestFsCacheKey(cfg, id));
    if (cached.hit) return [id, cached.value];
    const remaining = deadline - Date.now();
    if (remaining <= 0) return [id, staleGuestFsCacheValue(cached.entry)];
    const timeoutMs = Math.max(500, Math.min(PVE_GUEST_FS_TIMEOUT_MS, remaining));
    const usage = await queryGuestFsUsage(cfg, guest.node, id, timeoutMs);
    return [id, usage];
  });
  if (pveGuestFsCache.size > 10000) {
    const now = Date.now();
    for (const [key, entry] of pveGuestFsCache) {
      if (entry.expiresAt < now - PVE_GUEST_FS_STALE_MS) pveGuestFsCache.delete(key);
    }
  }
  return new Map(rows);
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
  'is_metric_block_device() {',
  '  case "$1" in loop*|ram*|zram*|fd*|sr*|nbd*) return 1;; esac',
  '  case "$1" in sd[a-z]*|hd[a-z]*|vd[a-z]*|xvd[a-z]*|nvme[0-9]*n[0-9]*|mmcblk[0-9]*|md[0-9]*|dm-[0-9]*|dasd[a-z]*|cciss!c[0-9]*d[0-9]*) return 0;; esac',
  '  return 1',
  '}',
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
  '  is_metric_block_device "$dev" || continue',
  '  set -- $(cat "$b/stat" 2>/dev/null || true)',
  '  [ $# -ge 7 ] || continue',
  '  printf "DISK\\t%s\\t%s\\t%s\\n" "$dev" "$3" "$7"',
  'done',
  'if command -v smartctl >/dev/null 2>&1; then',
  '  for b in /sys/block/*; do',
  '    [ -e "$b" ] || continue',
  '    dev=${b##*/}',
  '    is_metric_block_device "$dev" || continue',
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

function normalizeAptUpdates(rows, checkedAt = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(rows)) return null;
  const checked = Number(checkedAt);
  return {
    count: rows.length,
    source: 'apt',
    checkedAt: Number.isFinite(checked) && checked >= 0 ? Math.floor(checked) : Math.floor(Date.now() / 1000),
  };
}

async function nodeData(cfg, node, excluded, resource = null) {
  const name = node.node || node.name;
  const clusterName = String(cfg.actualClusterName || cfg.name || cfg.label || cfg.url || 'Proxmox');
  const historyKey = `${cfg.instanceKey || normBase(cfg.url)}:${name}`;
  try {
    const [status, qemu, lxc, storage, services, rrdHour, sensors, aptUpdates] = await Promise.all([
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/status`).catch(() => ({})),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/qemu`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/lxc`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/storage`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/services`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/rrddata?timeframe=hour&cf=AVERAGE`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/sensors`).catch(() => null),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/apt/update`).catch(() => null),
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
    const hist = pveHistory.get(historyKey) || [];
    const tempHistory = {};
    for (const t of tempInfos) {
      tempHistory[tempHistoryKey(t.label)] = t.value;
    }
    hist.push({ time: Date.now(), cpu, mem: mem.percent || 0, temp, ...tempHistory, diskIO: finalDiskIOTotal, bandwidth: bandwidthTotal });
    if (hist.length > PVE_HISTORY_MAX) hist.splice(0, hist.length - PVE_HISTORY_MAX);
    pveHistory.set(historyKey, hist);
    scheduleSaveHistoryMap('proxmox-history', pveHistory, PVE_HISTORY_MAX);
    const exList = excluded[`${clusterName}:${name}`] || excluded[name] || [];
    return {
      clusterName,
      clusterUrl: cfg.url,
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
      updates: normalizeAptUpdates(aptUpdates),
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
        disk: optionalNonNegativeNumber(v.disk),
        maxdisk: optionalNonNegativeNumber(v.maxdisk),
        guestDisk: null,
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
    return { clusterName, clusterUrl: cfg.url, node: { name, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } }, host: cfg.url, updates: null, services: [], vms: [], history: [...(pveHistory.get(historyKey) || [])], backup: null, storage: [], error: err.message };
  }
}

async function getProxmoxApiData(cfg = {}) {
  if (!cfg.url || !cfg.tokenId || !cfg.tokenSecret) return { clusterSummary: null, nodes: [], ceph: null, cluster: null };
  const excluded = cfg.excludedServices?.proxmox || {};
  const nodesPromise = pveFetch(cfg, '/api2/json/nodes');
  const clusterStatusPromise = pveFetch(cfg, '/api2/json/cluster/status').catch(() => null);
  const cephOsdPromise = nodesPromise.then(rawNodes => {
    const node = (rawNodes || []).find(item => String(item.status || '').toLowerCase() !== 'offline') || (rawNodes || [])[0];
    if (!node?.node) return null;
    return pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(node.node)}/ceph/osd`).catch(() => null);
  }).catch(() => null);
  const [nodesRaw, resourcesRaw, clusterStatusRaw, cephRaw, cephDfRaw, cephOsdRaw] = await Promise.all([
    nodesPromise,
    pveFetch(cfg, '/api2/json/cluster/resources').catch(() => []),
    clusterStatusPromise,
    pveFetch(cfg, '/api2/json/cluster/ceph/status').catch(() => null),
    pveFetch(cfg, '/api2/json/cluster/ceph/df').catch(() => null),
    cephOsdPromise,
  ]);
  const cluster = normalizeClusterStatus(clusterStatusRaw, { name: cfg.name || cfg.label, nodesRaw });
  const nodeConfig = { ...cfg, actualClusterName: cluster.name };
  const guestFsUsagePromise = collectGuestFsUsage(nodeConfig, resourcesRaw).catch(() => new Map());
  const resourcesByNode = new Map((resourcesRaw || [])
    .filter(r => r.type === 'node' && (r.node || r.id))
    .map(r => [String(r.node || r.id).replace(/^node\//, ''), r]));
  const nodes = (await mapLimit((nodesRaw || []), Number(cfg.concurrency || cfg.collectorConcurrency || 3), n => nodeData(nodeConfig, n, excluded, resourcesByNode.get(n.node || n.name))))
    .sort((a, b) => String(a.node.name).localeCompare(String(b.node.name)));
  const guestFsUsage = await guestFsUsagePromise;
  for (const nodeRow of nodes) {
    for (const guest of nodeRow.vms || []) {
      if (guest.type === 'vm') guest.guestDisk = guestFsUsage.get(String(guest.id)) || null;
    }
  }
  const onlineNodes = nodes.filter(n => n.node.online);
  const clusterSummary = {
    nodesOnline: onlineNodes.length,
    totalNodes: nodes.length,
    totalCores: nodes.reduce((s, n) => s + (n.node.cpuCores || 0), 0),
    usedCores: onlineNodes.reduce((s, n) => s + (n.node.cpuRaw || 0) * (n.node.cpuCores || 0), 0),
    totalRAM: nodes.reduce((s, n) => s + (n.node.ram?.total || 0), 0),
    usedRAM: onlineNodes.reduce((s, n) => s + (n.node.ram?.used || 0), 0),
  };
  return { clusterSummary, nodes, ceph: normalizeCephStatus(cephRaw, cephDfRaw, cephOsdRaw), cluster };
}

function configuredInstances(config = {}) {
  const rows = Array.isArray(config.instances) && config.instances.length
    ? config.instances
    : (config.url ? [config] : []);
  return rows
    .filter(row => row && row.url && row.tokenId && row.tokenSecret)
    .map((row, idx) => ({
      ...row,
      name: String(row.name || row.label || row.url || `Proxmox ${idx + 1}`),
      sshMetrics: Array.isArray(row.sshMetrics) ? row.sshMetrics : config.sshMetrics,
      excludedServices: row.excludedServices || config.excludedServices,
      instanceKey: `${idx}:${normBase(row.url)}`,
    }));
}

async function getAllProxmoxApiData(config = {}) {
  const instances = configuredInstances(config);
  if (!instances.length) return { clusterSummary: null, nodes: [], ceph: null, clusters: [] };
  const clusters = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 3), async cfg => {
    try {
      const data = await getProxmoxApiData(cfg);
      return { name: data.cluster?.name || cfg.name, configuredName: cfg.name, url: cfg.url, online: true, ...data };
    } catch (err) {
      return { name: cfg.name, configuredName: cfg.name, url: cfg.url, online: false, error: err.message, clusterSummary: null, nodes: [], ceph: null, cluster: null };
    }
  });
  const nodes = clusters.flatMap(cluster => (cluster.nodes || []).map(node => ({
    ...node,
    clusterName: node.clusterName || cluster.name,
    clusterUrl: node.clusterUrl || cluster.url,
  })));
  const onlineNodes = nodes.filter(node => node.node?.online);
  const clusterSummary = {
    clustersOnline: clusters.filter(cluster => cluster.online).length,
    totalClusters: clusters.length,
    nodesOnline: onlineNodes.length,
    totalNodes: nodes.length,
    totalCores: nodes.reduce((sum, node) => sum + Number(node.node?.cpuCores || 0), 0),
    usedCores: onlineNodes.reduce((sum, node) => sum + Number(node.node?.cpuRaw || 0) * Number(node.node?.cpuCores || 0), 0),
    totalRAM: nodes.reduce((sum, node) => sum + Number(node.node?.ram?.total || 0), 0),
    usedRAM: onlineNodes.reduce((sum, node) => sum + Number(node.node?.ram?.used || 0), 0),
  };
  const cephClusters = clusters.filter(cluster => cluster.ceph).map(cluster => ({ name: cluster.name, ...cluster.ceph }));
  return {
    clusterSummary,
    nodes,
    ceph: cephClusters.length === 1 ? cephClusters[0] : null,
    cephClusters,
    clusters: clusters.map(cluster => ({
      name: cluster.cluster?.name || cluster.name,
      configuredName: cluster.configuredName || cluster.name,
      url: cluster.url,
      online: cluster.online,
      error: cluster.error || '',
      isCluster: cluster.cluster?.isCluster ?? ((cluster.nodes || []).length > 1),
      detected: cluster.cluster?.detected ?? false,
      quorate: cluster.cluster?.quorate ?? null,
      version: cluster.cluster?.version ?? null,
      nodesOnline: cluster.cluster?.nodesOnline ?? cluster.clusterSummary?.nodesOnline ?? 0,
      totalNodes: cluster.cluster?.totalNodes ?? cluster.clusterSummary?.totalNodes ?? 0,
      localNode: cluster.cluster?.localNode || '',
      members: cluster.cluster?.members || [],
      clusterSummary: cluster.clusterSummary,
    })),
    error: clusters.find(cluster => !cluster.online)?.error || '',
  };
}

module.exports = {
  getProxmoxApiData,
  getAllProxmoxApiData,
  configuredInstances,
  normalizeClusterStatus,
  normalizeAptUpdates,
  normalizeGuestFsInfo,
};
