const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');
const { loadHistoryMap, scheduleSaveHistoryMap, cancelHistorySaves } = require('./historyStore');

const AGENTS_PATH = path.join(__dirname, '..', 'data', 'agents.yaml');
const HISTORY_MAX = 5760;
const CMD_TIMEOUT = 60000;
const INSTALL_PENDING_TTL = 5 * 60 * 1000;
const SVC_NAME = /^[a-zA-Z0-9@._:-]+$/;
const STARTUP_CONNECTING_MS = Math.max(30000, Number(process.env.OMNISIGHT_AGENT_STARTUP_CONNECTING_MS || 90000));

const agents = new Map();
let history = loadHistoryMap('agent-history', HISTORY_MAX);
const pending = new Map();
const pendingInstalls = new Map();
const waiters = new Map();
const pollWaiters = new Map();

let saveTimer = null;
let saveDelay = 2000;
const DEFAULT_AGENT_HISTORY_SAVE_DELAY_MS = Math.max(5000, Number(process.env.OMNISIGHT_AGENT_HISTORY_SAVE_DELAY_MS || 30000));
let historySaveDelay = DEFAULT_AGENT_HISTORY_SAVE_DELAY_MS;
let stateVersion = 1;

function bumpStateVersion() {
  stateVersion += 1;
}

function revision() {
  return stateVersion;
}

function loadAgents() {
  agents.clear();
  try {
    const obj = yaml.load(fs.readFileSync(AGENTS_PATH, 'utf8')) || {};
    const now = Date.now();
    for (const [id, meta] of Object.entries(obj)) {
      const intervalMs = Math.max(5000, (Number(meta?.interval) || 15) * 1000);
      const connectingMs = Math.min(10 * 60 * 1000, Math.max(STARTUP_CONNECTING_MS, intervalMs * 3 + 10000));
      agents.set(id, { ...meta, id, services: [], cpu: null, ram: null, live: false, _connectingUntil: now + connectingMs });
    }
  } catch {}
}
loadAgents();

function rejectWaiters(reason) {
  for (const w of waiters.values()) {
    try {
      clearTimeout(w.timer);
      w.reject?.(new Error(reason));
    } catch {}
  }
  waiters.clear();
}

function reload() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  cancelHistorySaves('agent-history');
  pending.clear();
  pendingInstalls.clear();
  pollWaiters.clear();
  rejectWaiters('agent registry reloaded');
  history = loadHistoryMap('agent-history', HISTORY_MAX);
  loadAgents();
  bumpStateVersion();
  return agents.size;
}

function saveAgents() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeAgentsNow();
  }, saveDelay);
}

function writeAgentsNow() {
  try {
    const out = {};
    for (const [id, a] of agents) {
      out[id] = {
        hostname: a.hostname, ip: a.ip, os: a.os, kernel: a.kernel,
        platform: a.platform, role: a.role, agentVersion: a.agentVersion,
        interval: a.interval, lastSeen: a.lastSeen,
        hasDocker: !!a.docker, pveNode: a.pve?.node || null,
      };
    }
    fs.mkdirSync(path.dirname(AGENTS_PATH), { recursive: true });
    fs.writeFileSync(AGENTS_PATH, yaml.dump(out), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(AGENTS_PATH, 0o600); } catch {}
  } catch (e) { console.warn('agents save failed:', e.message); }
}

function setSaveDelay(delay) {
  const n = Number(delay);
  if (Number.isFinite(n) && n >= 1000) {
    saveDelay = Math.min(n, 5 * 60 * 1000);
    historySaveDelay = Math.max(DEFAULT_AGENT_HISTORY_SAVE_DELAY_MS, Math.min(saveDelay * 10, 5 * 60 * 1000));
  }
}

function flushSaves() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeAgentsNow();
}

function num(v, max = 1e15) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
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

function normalizeCephStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const statusData = raw.statusData || raw.cephStatus || raw.status_data || raw;
  const dfData = raw.df || raw.dfData || raw.cephDf || null;
  const health = statusData.health || statusData.health_status || statusData.status || statusData;
  const status = cephHealthStatus(health, statusData.health, statusData.health_status, statusData.status);
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

function tempHistoryKey(label) {
  const clean = String(label || 'temperature')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `temp_${clean || 'temperature'}`;
}

function metricTemps(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 32)
    .map(t => {
      const value = num(t?.value ?? t?.temp, 200);
      const label = String(t?.label || t?.name || 'Temperature').slice(0, 100);
      return value != null && value >= 0 ? { label, value, historyKey: tempHistoryKey(label) } : null;
    })
    .filter(Boolean);
}

function metricSmart(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 128)
    .map(s => {
      const device = String(s?.device || s?.name || '').slice(0, 80);
      const health = String(s?.health || s?.status || '').slice(0, 120);
      if (!device || !health) return null;
      return {
        device,
        health,
        ok: s?.ok === true || /passed|ok|healthy/i.test(health),
        model: String(s?.model || '').slice(0, 160),
        serial: String(s?.serial || '').slice(0, 120),
        firmware: String(s?.firmware || '').slice(0, 80),
        temperature: num(s?.temperature, 200),
        powerOnHours: num(s?.powerOnHours, 1e9),
        percentageUsed: num(s?.percentageUsed, 1000),
        mediaErrors: num(s?.mediaErrors, 1e12),
        reallocatedSectors: num(s?.reallocatedSectors, 1e12),
        pendingSectors: num(s?.pendingSectors, 1e12),
      };
    })
    .filter(Boolean);
}

function rateObj(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    readBps: num(o.readBps),
    writeBps: num(o.writeBps),
    iops: num(o.iops, 1e9),
    util: num(o.util, 100),
    rxBps: num(o.rxBps),
    txBps: num(o.txBps),
  };
}

function cleanupPendingInstalls(now = Date.now()) {
  let changed = false;
  for (const [id, p] of pendingInstalls) {
    if (now - p.createdAt > INSTALL_PENDING_TTL) {
      pendingInstalls.delete(id);
      changed = true;
    }
  }
  if (changed) bumpStateVersion();
}

function addPendingInstall(kind = 'linux') {
  cleanupPendingInstalls();
  kind = ['linux', 'windows', 'proxmox', 'docker'].includes(kind) ? kind : 'linux';
  const id = `${kind}-${crypto.randomBytes(6).toString('hex')}`;
  const title = kind === 'proxmox' ? 'New Proxmox node' : kind === 'docker' ? 'New Docker host' : kind === 'windows' ? 'New Windows host' : 'New system';
  const p = { id, kind, name: title, createdAt: Date.now(), expiresAt: Date.now() + INSTALL_PENDING_TTL };
  pendingInstalls.set(id, p);
  bumpStateVersion();
  return p;
}

function removePendingInstall(id) {
  cleanupPendingInstalls();
  const ok = pendingInstalls.delete(String(id || ''));
  if (ok) bumpStateVersion();
  return ok;
}

function clearPendingForKinds(kinds) {
  cleanupPendingInstalls();
  for (const kind of kinds) {
    const match = [...pendingInstalls.values()]
      .filter(p => p.kind === kind)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (match) {
      pendingInstalls.delete(match.id);
      bumpStateVersion();
    }
  }
}

function pendingByKind(kind) {
  cleanupPendingInstalls();
  return [...pendingInstalls.values()].filter(p => p.kind === kind);
}

function listPendingInstalls() {
  cleanupPendingInstalls();
  return [...pendingInstalls.values()];
}

function handleReport(r) {
  const id = String(r.id || r.hostname || '').replace(/[^\w.-]/g, '').slice(0, 128);
  if (!id) throw new Error('missing agent id');
  const hostname = String(r.hostname || id).slice(0, 128);

  const services = Array.isArray(r.services) ? r.services.slice(0, 500).map(s => ({
    name: String(s.name || '').slice(0, 200),
    state: String(s.state || 'unknown').slice(0, 32),
    active: !!s.active,
  })).filter(s => s.name && SVC_NAME.test(s.name)) : [];

  const memTotal = num(r.mem?.totalKB), memUsed = num(r.mem?.usedKB);
  const diskTotal = num(r.disk?.totalKB), diskUsed = num(r.disk?.usedKB);
  const cpu = num(r.cpu, 100);
  const swapTotal = num(r.metrics?.swap?.totalKB), swapUsed = num(r.metrics?.swap?.usedKB);
  const diskIO = rateObj(r.metrics?.diskIO);
  const bandwidth = rateObj(r.metrics?.bandwidth);
  const temps = metricTemps(r.metrics?.temps);
  const smart = metricSmart(r.metrics?.smart);

  let docker = null;
  if (r.docker && typeof r.docker === 'object') {
    docker = {
      unused: num(r.docker.unused, 1e6) || 0,
      containers: (Array.isArray(r.docker.containers) ? r.docker.containers.slice(0, 500) : []).map(c => ({
        id: String(c.id || '').replace(/[^\w]/g, '').slice(0, 12),
        name: String(c.name || '').slice(0, 200),
        image: String(c.image || '').slice(0, 300),
        state: String(c.state || '').toLowerCase().slice(0, 24),
        status: String(c.status || '').slice(0, 100),
        ports: String(c.ports || '').slice(0, 500),
        labelsText: String(c.labelsText || '').slice(0, 4000),
        cpu: num(c.cpu, 1e6),
        memPercent: num(c.memPercent, 1e6),
        netIO: String(c.netIO || '').slice(0, 80),
        blockIO: String(c.blockIO || '').slice(0, 80),
      })).filter(c => c.id),
    };
  }

  let pve = null;
  if (r.pve && typeof r.pve === 'object' && Array.isArray(r.pve.resources)) {
    pve = {
      node: String(r.pve.node || r.hostname || '').slice(0, 128),
      resources: r.pve.resources.slice(0, 2000),
      ceph: (r.pve.ceph && typeof r.pve.ceph === 'object') ? r.pve.ceph : null,
      backup: Array.isArray(r.pve.backup) ? r.pve.backup.slice(0, 5) : null,
    };
  }

  const a = {
    id,
    hostname,
    ip: String(r.ip || '').slice(0, 64),
    os: String(r.os || '').slice(0, 128),
    kernel: String(r.kernel || '').slice(0, 64),
    platform: ['proxmox', 'synology', 'windows'].includes(r.platform) ? r.platform : 'linux',
    role: ['linux', 'windows', 'docker', 'proxmox', 'synology', 'auto'].includes(r.role) ? r.role : 'auto',
    agentVersion: String(r.agentVersion || '').slice(0, 16),
    interval: Math.min(Math.max(num(r.interval) || 15, 5), 300),
    uptime: num(r.uptime),
    cpu,
    load: Array.isArray(r.load) ? r.load.slice(0, 3).map(x => num(x, 10000)) : null,
    temp: num(r.temp, 200),
    mem: memTotal ? { totalKB: memTotal, usedKB: memUsed || 0 } : null,
    disk: diskTotal ? { totalKB: diskTotal, usedKB: diskUsed || 0 } : null,
    metrics: {
      diskIO,
      bandwidth,
      swap: swapTotal ? { totalKB: swapTotal, usedKB: swapUsed || 0 } : null,
      temps,
      smart,
    },
    services,
    docker,
    pve,
    cores: num(r.cores, 4096),
    lastSeen: Date.now(),
    live: true,
  };
  agents.set(id, a);
  bumpStateVersion();
  const reportKinds = (a.pve || a.platform === 'proxmox' || a.role === 'proxmox') ? ['proxmox'] : (a.role === 'docker' ? ['docker'] : (a.platform === 'windows' || a.role === 'windows') ? ['windows'] : ['linux']);
  clearPendingForKinds(reportKinds);

  if (cpu != null || a.temp != null) {
    const hist = history.get(id) || [];
    const point = {
      time: Date.now(),
      cpu: cpu ?? null,
      ram: memTotal ? Math.round((memUsed / memTotal) * 100) : 0,
      disk: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0,
      temp: a.temp ?? null,
      diskReadBps: diskIO?.readBps ?? null,
      diskWriteBps: diskIO?.writeBps ?? null,
      bandwidthRxBps: bandwidth?.rxBps ?? null,
      bandwidthTxBps: bandwidth?.txBps ?? null,
    };
    temps.forEach(t => { point[t.historyKey] = t.value; });
    hist.push(point);
    if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
    history.set(id, hist);
    scheduleSaveHistoryMap('agent-history', history, HISTORY_MAX, historySaveDelay);
  }
  saveAgents();
  return a;
}

function isOnline(a, now) {
  const staleMs = ((a.interval || 15) * 2.5 + 10) * 1000;
  return a.live && (now - (a.lastSeen || 0)) < staleMs;
}

function isConnecting(a, now) {
  return !isOnline(a, now) && Number(a._connectingUntil || 0) > now;
}

function agentHistoryForUi(id) {
  return [...(history.get(id) || [])].map(h => {
    const read = h.diskReadBps == null ? null : Number(h.diskReadBps);
    const write = h.diskWriteBps == null ? null : Number(h.diskWriteBps);
    const hasDiskIO = Number.isFinite(read) || Number.isFinite(write);
    return {
      ...h,
      diskIO: hasDiskIO ? (Number.isFinite(read) ? read : 0) + (Number.isFinite(write) ? write : 0) : h.diskIO,
    };
  });
}

function getAllAgentData(config) {
  const excluded = (config && config.excludedServices?.linux) || {};
  const now = Date.now();
  const rows = [...agents.values()].filter(a => a.platform !== 'proxmox' && a.platform !== 'windows' && a.role !== 'docker' && a.role !== 'windows').map(a => {
    const staleMs = ((a.interval || 15) * 2.5 + 10) * 1000;
    const online = a.live && (now - (a.lastSeen || 0)) < staleMs;
    const connecting = isConnecting(a, now);
    const exList = excluded[a.hostname] || [];
    const services = (a.services || []).map(s => ({ ...s, excluded: exList.includes(s.name) }))
      .sort((x, y) => (x.active === y.active) ? x.name.localeCompare(y.name) : (x.active ? 1 : -1));
    const ram = a.mem ? {
      percent: Math.min(100, Math.round((a.mem.usedKB / a.mem.totalKB) * 100)),
      usedGB: (a.mem.usedKB / 1048576).toFixed(1),
      totalGB: (a.mem.totalKB / 1048576).toFixed(1),
    } : null;
    const disk = a.disk ? {
      percent: Math.min(100, Math.round((a.disk.usedKB / a.disk.totalKB) * 100)),
      usedGB: (a.disk.usedKB / 1048576).toFixed(1),
      totalGB: (a.disk.totalKB / 1048576).toFixed(1),
    } : null;
    const swap = a.metrics?.swap ? {
      percent: a.metrics.swap.totalKB ? Math.min(100, Math.round((a.metrics.swap.usedKB / a.metrics.swap.totalKB) * 100)) : 0,
      usedGB: (a.metrics.swap.usedKB / 1048576).toFixed(1),
      totalGB: (a.metrics.swap.totalKB / 1048576).toFixed(1),
      totalKB: a.metrics.swap.totalKB,
      usedKB: a.metrics.swap.usedKB,
    } : null;
    return {
      id: a.id,
      name: a.hostname,
      host: a.hostname,
      ip: a.ip,
      os: a.os,
      kernel: a.kernel,
      platform: a.platform,
      role: a.role,
      agentVersion: a.agentVersion,
      online,
      _connecting: connecting,
      error: online ? undefined : (connecting ? 'waiting for first report after restart' : (a.lastSeen ? `no report for ${Math.round((now - a.lastSeen) / 1000)}s` : 'never reported')),
      cpu: online ? a.cpu : null,
      ram: online ? ram : null,
      disk: online ? disk : null,
      swap: online ? swap : null,
      metrics: online ? { diskIO: a.metrics?.diskIO || null, bandwidth: a.metrics?.bandwidth || null } : null,
      temp: online ? a.temp : null,
      load: online ? a.load : null,
      uptime: online ? a.uptime : null,
      lastSeen: a.lastSeen || null,
      services: online ? services : [],
      history: agentHistoryForUi(a.id),
    };
  });
  pendingByKind('linux').forEach(p => rows.push({
    id: p.id,
    name: p.name,
    host: 'waiting for agent',
    ip: '',
    os: '',
    platform: 'linux',
    online: false,
    _connecting: true,
    error: 'waiting for first report',
    lastSeen: p.createdAt,
    services: [],
    history: [],
  }));
  return rows.sort((x, y) => (x._connecting === y._connecting ? x.name.localeCompare(y.name) : x._connecting ? -1 : 1));
}

function getWindowsData(config) {
  const excluded = (config && config.excludedServices?.windows) || {};
  const now = Date.now();
  const rows = [...agents.values()].filter(a => a.platform === 'windows' || a.role === 'windows').map(a => {
    const staleMs = ((a.interval || 15) * 2.5 + 10) * 1000;
    const online = a.live && (now - (a.lastSeen || 0)) < staleMs;
    const connecting = isConnecting(a, now);
    const exList = excluded[a.hostname] || [];
    const services = (a.services || []).map(s => ({ ...s, excluded: exList.includes(s.name) }))
      .sort((x, y) => (x.active === y.active) ? x.name.localeCompare(y.name) : (x.active ? 1 : -1));
    const ram = a.mem ? {
      percent: Math.min(100, Math.round((a.mem.usedKB / a.mem.totalKB) * 100)),
      usedGB: (a.mem.usedKB / 1048576).toFixed(1),
      totalGB: (a.mem.totalKB / 1048576).toFixed(1),
    } : null;
    const disk = a.disk ? {
      percent: Math.min(100, Math.round((a.disk.usedKB / a.disk.totalKB) * 100)),
      usedGB: (a.disk.usedKB / 1048576).toFixed(1),
      totalGB: (a.disk.totalKB / 1048576).toFixed(1),
    } : null;
    return {
      id: a.id,
      name: a.hostname,
      host: a.hostname,
      ip: a.ip,
      os: a.os,
      kernel: a.kernel,
      platform: 'windows',
      role: a.role,
      agentVersion: a.agentVersion,
      online,
      _connecting: connecting,
      error: online ? undefined : (connecting ? 'waiting for first report after restart' : (a.lastSeen ? `no report for ${Math.round((now - a.lastSeen) / 1000)}s` : 'never reported')),
      cpu: online ? a.cpu : null,
      ram: online ? ram : null,
      disk: online ? disk : null,
      metrics: online ? { diskIO: a.metrics?.diskIO || null, bandwidth: a.metrics?.bandwidth || null } : null,
      temp: online ? a.temp : null,
      load: online ? a.load : null,
      uptime: online ? a.uptime : null,
      lastSeen: a.lastSeen || null,
      services: online ? services : [],
      history: agentHistoryForUi(a.id),
    };
  });
  pendingByKind('windows').forEach(p => rows.push({
    id: p.id,
    name: p.name,
    host: 'waiting for agent',
    ip: '',
    os: '',
    platform: 'windows',
    online: false,
    _connecting: true,
    error: 'waiting for first report',
    lastSeen: p.createdAt,
    services: [],
    history: [],
  }));
  return rows.sort((x, y) => (x._connecting === y._connecting ? x.name.localeCompare(y.name) : x._connecting ? -1 : 1));
}

function stateColor(state) {
  switch (state) {
    case 'running':    return 'green';
    case 'paused':     return 'yellow';
    case 'restarting': return 'yellow';
    case 'exited':     return 'red';
    case 'dead':       return 'red';
    default:           return 'gray';
  }
}

function parsePorts(raw) {
  const out = [];
  const seen = new Set();
  const re = /(\d+)->(\d+)/g;
  let m;
  while ((m = re.exec(String(raw))) && out.length < 3) {
    const key = `${m[1]}→${m[2]}`;
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}

function getDockerData() {
  const now = Date.now();
  const rows = [...agents.values()].filter(a => a.role === 'docker').map(a => {
    const online = isOnline(a, now) && !!a.docker;
    const connecting = isConnecting(a, now);
    if (!online && connecting) return { source: 'agent', id: a.id, name: a.hostname, host: a.ip || '', online: false, _connecting: true, error: 'waiting for first report after restart', containers: [], summary: { total: 0, running: 0, stopped: 0, other: 0, unused: null } };
    if (!online) return { source: 'agent', id: a.id, name: a.hostname, host: a.ip || '', online: false, error: 'agent offline', containers: [], summary: { total: 0, running: 0, stopped: 0, other: 0, unused: null } };
    const containers = (a.docker.containers || []).map(c => ({
      id: c.id,
      name: c.name,
      image: c.image,
      imageShort: c.image.split('/').pop().split(':')[0],
      state: c.state,
      status: c.status,
      uptime: null,
      ports: parsePorts(c.ports),
      labelsText: c.labelsText || '',
      color: stateColor(c.state),
      cpu: c.cpu ?? null,
      memPercent: c.memPercent ?? null,
      netIO: c.netIO || '',
      blockIO: c.blockIO || '',
    })).sort((x, y) => {
      const order = { running: 0, restarting: 1, paused: 2, exited: 3, dead: 4 };
      return (order[x.state] ?? 5) - (order[y.state] ?? 5);
    });
    const running = containers.filter(c => c.state === 'running').length;
    const stopped = containers.filter(c => c.state === 'exited' || c.state === 'dead').length;
    const cpu = Math.round(containers.reduce((s, c) => s + (c.cpu || 0), 0) * 10) / 10;
    const memPercent = Math.round(containers.reduce((s, c) => s + (c.memPercent || 0), 0) * 10) / 10;
    return {
      source: 'agent', id: a.id, name: a.hostname, host: a.ip || '', online: true, containers,
      metrics: { bandwidth: a.metrics?.bandwidth || null },
      summary: { total: containers.length, running, stopped, other: containers.length - running - stopped, unused: a.docker.unused ?? null, cpu, memPercent },
    };
  });
  pendingByKind('docker').forEach(p => rows.push({
    id: p.id,
    name: p.name,
    host: 'waiting for agent',
    online: false,
    _connecting: true,
    error: 'waiting for first report',
    containers: [],
    summary: { total: 0, running: 0, stopped: 0, other: 0, unused: null },
  }));
  return rows.sort((x, y) => (x._connecting === y._connecting ? x.name.localeCompare(y.name) : x._connecting ? -1 : 1));
}

function getProxmoxData(config) {
  const excluded = (config && config.excludedServices?.proxmox) || {};
  const now = Date.now();
  const pveAgents = [...agents.values()].filter(a => a.pve || a.pveNode || a.platform === 'proxmox');
  const pendingNodes = pendingByKind('proxmox').map(p => ({
    id: p.id,
    node: { name: p.name, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } },
    host: 'waiting for agent',
    services: [],
    vms: [],
    history: [],
    backup: null,
    storage: [],
    _connecting: true,
  }));
  if (!pveAgents.length) return { clusterSummary: null, nodes: pendingNodes, ceph: null };

  let ceph = null;
  const nodes = pveAgents.map(a => {
    const nodeName = a.pve?.node || a.pveNode || a.hostname;
    const online = isOnline(a, now) && !!a.pve;
    const connecting = isConnecting(a, now);
    if (!online) {
      return {
        node: { name: nodeName, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 }, temp: a.temp ?? null, temps: a.metrics?.temps || [] },
        host: a.ip,
        services: [],
        vms: [],
        history: [...(history.get(a.id) || [])].map(h => ({
          time: h.time, cpu: h.cpu, mem: h.ram, temp: h.temp, ...(a.metrics?.temps || []).reduce((out, t) => { out[t.historyKey] = h[t.historyKey]; return out; }, {}),
          diskIO: (Number(h.diskReadBps) || 0) + (Number(h.diskWriteBps) || 0),
          bandwidth: (Number(h.bandwidthRxBps) || 0) + (Number(h.bandwidthTxBps) || 0),
        })),
        metrics: { diskIO: a.metrics?.diskIO || null, bandwidth: a.metrics?.bandwidth || null, smart: a.metrics?.smart || [] },
        backup: null,
        storage: [],
        _connecting: connecting,
      };
    }
    const res = a.pve.resources || [];
    const ne = res.find(r => r.type === 'node' && r.node === nodeName) || {};
    const memUsed = ne.mem || 0, memTotal = ne.maxmem || 0;
    const vms = res.filter(r => (r.type === 'qemu' || r.type === 'lxc') && r.node === nodeName && !r.template).map(v => ({
      id: v.vmid,
      name: String(v.name || v.vmid || '').slice(0, 128),
      type: v.type === 'qemu' ? 'vm' : 'lxc',
      status: v.status,
      running: v.status === 'running',
      cpu: percentValue(v.cpu),
      ram: v.mem && v.maxmem ? Math.round((v.mem / v.maxmem) * 100) : 0,
    }));
    const storage = res.filter(r => r.type === 'storage' && r.node === nodeName).map(s => ({
      name: String(s.storage || '').slice(0, 128),
      type: s.plugintype || 'storage',
      active: s.status === 'available',
      total: s.maxdisk || 0,
      used: s.disk || 0,
      avail: (s.maxdisk || 0) - (s.disk || 0),
      percent: s.maxdisk ? Math.round(((s.disk || 0) / s.maxdisk) * 100) : 0,
    }));
    const exList = excluded[nodeName] || [];
    const services = (a.services || []).map(s => ({ name: s.name, desc: s.name, state: s.state, active: s.active, excluded: exList.includes(s.name) }));
    let backup = null;
    const b = a.pve.backup?.[0];
    if (b) {
      const running = !b.endtime;
      backup = { status: running ? 'running' : (b.status || 'unknown'), ok: b.status === 'OK', running, starttime: b.starttime || null, endtime: b.endtime || null };
    }
    if (!ceph && a.pve.ceph) ceph = normalizeCephStatus(a.pve.ceph);
    return {
      node: {
        name: nodeName,
        online: true,
        cpu: percentValue(ne.cpu),
        cpuCores: ne.maxcpu || a.cores || 0,
        cpuRaw: ratioValue(ne.cpu),
        ram: {
          percent: memTotal ? Math.round((memUsed / memTotal) * 100) : null,
          usedGB: (memUsed / 1024 ** 3).toFixed(1),
          totalGB: (memTotal / 1024 ** 3).toFixed(1),
          used: memUsed,
          total: memTotal,
        },
        temp: a.temp ?? null,
        temps: a.metrics?.temps || [],
        uptime: ne.uptime || a.uptime || null,
      },
      host: a.ip,
      services,
      vms,
      history: [...(history.get(a.id) || [])].map(h => ({
        time: h.time, cpu: h.cpu, mem: h.ram, temp: h.temp, ...(a.metrics?.temps || []).reduce((out, t) => { out[t.historyKey] = h[t.historyKey]; return out; }, {}),
        diskIO: (Number(h.diskReadBps) || 0) + (Number(h.diskWriteBps) || 0),
        bandwidth: (Number(h.bandwidthRxBps) || 0) + (Number(h.bandwidthTxBps) || 0),
      })),
      metrics: { diskIO: a.metrics?.diskIO || null, bandwidth: a.metrics?.bandwidth || null, smart: a.metrics?.smart || [] },
      backup,
      storage,
    };
  });
  nodes.push(...pendingNodes);
  nodes.sort((x, y) => (x._connecting === y._connecting ? String(x.node.name).localeCompare(String(y.node.name)) : x._connecting ? -1 : 1));

  const onlineNodes = nodes.filter(n => n.node.online);
  const clusterSummary = {
    nodesOnline: onlineNodes.length,
    totalNodes: nodes.length,
    totalCores: nodes.reduce((s, n) => s + (n.node.cpuCores || 0), 0),
    usedCores: onlineNodes.reduce((s, n) => s + (n.node.cpuRaw || 0) * (n.node.cpuCores || 0), 0),
    totalRAM: nodes.reduce((s, n) => s + (n.node.ram?.total || 0), 0),
    usedRAM: onlineNodes.reduce((s, n) => s + (n.node.ram?.used || 0), 0),
  };

  return { clusterSummary, nodes, ceph };
}

function hasPve() {
  cleanupPendingInstalls();
  return [...agents.values()].some(a => a.pve || a.pveNode || a.platform === 'proxmox') || pendingByKind('proxmox').length > 0;
}

function hasDocker() {
  cleanupPendingInstalls();
  return [...agents.values()].some(a => a.role === 'docker' && (a.docker || a.hasDocker)) || pendingByKind('docker').length > 0;
}

function hasLinux() {
  cleanupPendingInstalls();
  return [...agents.values()].some(a => !a.pve && !a.pveNode && a.platform !== 'proxmox' && a.platform !== 'windows' && a.role !== 'docker' && a.role !== 'windows') || pendingByKind('linux').length > 0;
}

function hasWindows() {
  cleanupPendingInstalls();
  return [...agents.values()].some(a => a.platform === 'windows' || a.role === 'windows') || pendingByKind('windows').length > 0;
}

function findAgent(hostOrName) {
  for (const a of agents.values()) {
    if (a.id === hostOrName || a.hostname === hostOrName || a.ip === hostOrName || a.pve?.node === hostOrName || a.pveNode === hostOrName) return a;
  }
  return null;
}

function takeCommands(agentId) {
  const list = pending.get(agentId) || [];
  pending.delete(agentId);
  return list;
}

function commandLines(cmds) {
  return cmds.map(c => `CMD\t${c.id}\t${c.action}\t${c.service}`).join('\n');
}

function queueCommand(hostOrName, action, service) {
  return new Promise((resolve, reject) => {
    const agent = findAgent(hostOrName);
    if (!agent) return reject(new Error('agent not found'));
    if (!SVC_NAME.test(service)) return reject(new Error('invalid target name'));
    if (!['status', 'start', 'stop', 'restart', 'docker_logs', 'docker_prune', 'agent_update'].includes(action)) return reject(new Error('invalid action'));
    const id = crypto.randomBytes(8).toString('hex');
    const list = pending.get(agent.id) || [];
    list.push({ id, action, service });
    pending.set(agent.id, list);
    waiters.set(id, {
      resolve, reject,
      timer: setTimeout(() => { waiters.delete(id); reject(new Error('agent did not respond in time')); }, CMD_TIMEOUT),
    });
    const pw = pollWaiters.get(agent.id);
    if (pw) { pollWaiters.delete(agent.id); pw(); }
  });
}

function listAgents() {
  const now = Date.now();
  return [...agents.values()].map(a => ({
    id: a.id,
    name: a.hostname || a.id || 'agent',
    ip: a.ip || '',
    os: a.os || '',
    kernel: a.kernel || '',
    platform: a.platform || 'linux',
    role: a.role || 'auto',
    agentVersion: a.agentVersion || '',
    interval: a.interval || null,
    lastSeen: a.lastSeen || null,
    online: isOnline(a, now),
    connecting: isConnecting(a, now),
    hasDocker: !!a.docker,
    pveNode: a.pve?.node || a.pveNode || null,
  })).sort((a, b) => {
    const rank = x => x.online ? 0 : x.connecting ? 1 : 2;
    return rank(a) === rank(b) ? String(a.name || '').localeCompare(String(b.name || '')) : rank(a) - rank(b);
  });
}

function waitForCommands(agentId, waitMs) {
  if (pending.has(agentId)) return Promise.resolve(takeCommands(agentId));
  return new Promise(res => {
    const t = setTimeout(() => { pollWaiters.delete(agentId); res([]); }, waitMs);
    pollWaiters.set(agentId, () => { clearTimeout(t); res(takeCommands(agentId)); });
  });
}

function handleResult(r) {
  const w = waiters.get(String(r.id || ''));
  if (!w) return false;
  clearTimeout(w.timer);
  waiters.delete(String(r.id));
  let out = '';
  try { out = Buffer.from(String(r.output || ''), 'base64').toString('utf8'); } catch {}
  w.resolve(out);
  return true;
}

function removeAgent(id) {
  if (removePendingInstall(id)) return true;
  const a = findAgent(id);
  if (!a) return false;
  agents.delete(a.id);
  history.delete(a.id);
  pending.delete(a.id);
  pollWaiters.delete(a.id);
  bumpStateVersion();
  saveAgents();
  return true;
}

module.exports = { handleReport, getAllAgentData, getWindowsData, getDockerData, getProxmoxData, hasPve, hasDocker, hasLinux, hasWindows, queueCommand, takeCommands, waitForCommands, handleResult, removeAgent, findAgent, listAgents, commandLines, addPendingInstall, listPendingInstalls, setSaveDelay, flushSaves, reload, revision };
