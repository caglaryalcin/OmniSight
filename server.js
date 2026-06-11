const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');
const childProcess = require('child_process');
const agents = require('./src/agents');
const { getAllKubernetesData, getPodLogs } = require('./src/kubernetes');
const { getAllSynologyData } = require('./src/snmp');
const { getAllHealthchecks } = require('./src/healthchecks');
const { getAllUptimeKuma } = require('./src/uptimekuma');
const { getPrometheusData } = require('./src/prometheus');
const { getAllDatabaseData } = require('./src/database');
const { getProxmoxApiData } = require('./src/proxmox');
const { getDockerApiData, dockerLogs: dockerApiLogs, dockerPrune: dockerApiPrune } = require('./src/docker');
const { dispatchAlert } = require('./src/alerts');
const { decryptConfig, encryptConfigValue, isEncrypted, SENSITIVE_KEYS, encryptionEnabled } = require('./src/crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const LOG_BUFFER = [];
const LOG_MAX = 500;
function safeStr(a) {
  if (typeof a !== 'object' || a === null) return String(a);
  try { return JSON.stringify(a); } catch { return '[object]'; }
}
function pushLog(level, args) {
  try {
    const msg = args.map(safeStr).join(' ');
    LOG_BUFFER.push({ t: Date.now(), level, msg });
    if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
  } catch {}
}
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
console.log   = (...a) => { try { _log(...a); } catch {} pushLog('info',  a); };
console.warn  = (...a) => { try { _warn(...a); } catch {} pushLog('warn',  a); };
console.error = (...a) => { try { _error(...a); } catch {} pushLog('error', a); };
const REFRESH_INTERVAL = 15000;
try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch {}

function reloadExtraCA() {
  try {
    const https = require('https');
    const tls = require('tls');
    const certDir = path.join(__dirname, 'data', 'certs');
    fs.mkdirSync(certDir, { recursive: true });
    const extra = [];
    for (const f of fs.readdirSync(certDir)) {
      if (/\.(crt|pem|cer)$/i.test(f)) { try { extra.push(fs.readFileSync(path.join(certDir, f))); } catch {} }
    }
    https.globalAgent.options.ca = extra.length ? [...tls.rootCertificates, ...extra] : undefined;
    if (extra.length) console.log(`Trusting ${extra.length} extra CA certificate(s) from data/certs/`);
    return extra.length;
  } catch (e) { console.warn('CA cert load failed:', e.message); return 0; }
}
reloadExtraCA();
const CONFIG_PATH = path.join(__dirname, 'data', 'config.yaml');
const AUTH_PATH  = path.join(__dirname, 'data', 'auth.yaml');

const NOTIFY_PATH = path.join(__dirname, 'data', 'notifications.yaml');
function loadNotify() {
  try { const a = yaml.load(fs.readFileSync(NOTIFY_PATH, 'utf8')); return new Set(Array.isArray(a) ? a : (a?.disabled || [])); }
  catch { return new Set(); }
}
function saveNotify() {
  try { fs.writeFileSync(NOTIFY_PATH, yaml.dump(Array.from(notifyDisabled))); }
  catch (e) { console.warn('notifications save failed:', e.message); }
}
let notifyDisabled = loadNotify();

const SESSIONS_PATH = path.join(__dirname, 'data', 'sessions.yaml');
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function loadSessions() {
  if (!fs.existsSync(SESSIONS_PATH)) return new Map();
  try {
    const obj = yaml.load(fs.readFileSync(SESSIONS_PATH, 'utf8')) || {};
    const now = Date.now();
    return new Map(Object.entries(obj).filter(([, v]) => now < v.expires));
  } catch { return new Map(); }
}

function saveSessions(map) {
  try {
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    fs.writeFileSync(SESSIONS_PATH, yaml.dump(obj), 'utf8');
  } catch {}
}

const sessions = loadSessions();

function loadAuth() {
  if (!fs.existsSync(AUTH_PATH)) return null;
  return yaml.load(fs.readFileSync(AUTH_PATH, 'utf8')) || null;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter';
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter';
  return null;
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, hash, salt) {
  return crypto.timingSafeEqual(
    Buffer.from(hashPassword(password, salt), 'hex'),
    Buffer.from(hash, 'hex')
  );
}

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
  const auth = loadAuth();
  if (req.path.startsWith('/assets/')) return next();
  if (req.path.startsWith('/api/icons/')) return next();
  if (req.path.startsWith('/agent/') || ['/api/agent/report', '/api/agent/result', '/api/agent/commands'].includes(req.path)) return next();
  const token = req.headers['x-session-token'] || req.cookies?.session;
  if (token && sessions.has(token) && Date.now() < sessions.get(token).expires) return next();
  if (config.publicStatus && (req.path === '/status' || req.path === '/api/public/status')) return next();
  if (!auth) {
    if (['/login', '/api/login', '/api/auth-status', '/api/set-password'].includes(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Setup required' });
    return res.redirect('/login');
  }
  if (req.path === '/login' || req.path === '/api/login' || req.path === '/api/auth-status') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

function parseCookies(req, res, next) {
  const raw = req.headers.cookie || '';
  req.cookies = {};
  raw.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next();
}

function loadConfig() {
  let text;
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return {};
    }
    if (fs.statSync(CONFIG_PATH).isDirectory()) {
      return {};
    }
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    return {};
  }
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, name, def) => {
    const v = process.env[name];
    return v !== undefined ? v : (def !== undefined ? def : m);
  });
  let raw;
  try { raw = yaml.load(text) || {}; }
  catch (e) { return {}; }
  if (!encryptionEnabled()) return raw;
  try { return decryptConfig(raw); } catch { return raw; }
}

function encryptConfigObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(encryptConfigObj);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'object' && v !== null) out[k] = encryptConfigObj(v);
    else out[k] = encryptConfigValue(k, v);
  }
  return out;
}

let config = loadConfig();
process.env.TZ = config.timezone || process.env.TZ || process.env.TIMEZONE || 'UTC';

let cache = { data: null };
let refreshPromise = null;

const PLATFORM_HISTORY = {};

function hasProxmoxApi() {
  return !!(config.proxmox && config.proxmox.url && config.proxmox.tokenId && config.proxmox.tokenSecret);
}

function hasDockerApi() {
  return !!(config.docker && Array.isArray(config.docker.hosts) && config.docker.hosts.length);
}

function dockerConfigHostName(h = {}) {
  return h.name || h.url || h.socketPath || h.sshHost || 'docker';
}

function dockerConfigHostTarget(h = {}) {
  return h.url || h.socketPath || h.sshHost || '';
}

function dockerConfigRows() {
  const hosts = Array.isArray(config.docker?.hosts) ? config.docker.hosts : [];
  return hosts.map(h => ({
    source: 'configured',
    name: dockerConfigHostName(h),
    host: dockerConfigHostTarget(h),
    online: false,
    _connecting: true,
    summary: { total: 0, running: 0, stopped: 0, unused: 0 },
    containers: [],
  }));
}

function mergeDockerConfiguredRows(currentRows = [], agentRows = []) {
  if (!hasDockerApi()) return agentRows;
  const currentByName = new Map((currentRows || []).map(h => [h.name, h]));
  const configured = dockerConfigRows().map(row => {
    const prev = currentByName.get(row.name);
    return prev ? { ...row, ...prev, source: row.source, name: row.name, host: prev.host || row.host } : row;
  });
  const configuredNames = new Set(configured.map(h => h.name));
  return [...configured, ...agentRows.filter(h => !configuredNames.has(h.name))];
}

function dockerRowKeys(row = {}) {
  return [row.name, row.host, row.url, row.socketPath, row.sshHost]
    .filter(Boolean)
    .map(v => String(v).trim().toLowerCase());
}

function sameDockerRow(a, b) {
  const keys = new Set(dockerRowKeys(a));
  return dockerRowKeys(b).some(k => keys.has(k));
}

function preserveDockerOnTransient(nextRows) {
  const prevRows = Array.isArray(cache.data?.docker) ? cache.data.docker : [];
  if (!Array.isArray(nextRows) || !prevRows.length) return nextRows;
  const configured = dockerConfigRows();
  if (!nextRows.length && configured.length) {
    const now = Date.now();
    const kept = prevRows.filter(row => row?.online && configured.some(cfg => sameDockerRow(cfg, row))).map(row => {
      const staleSince = row._staleSince || now;
      if (now - staleSince > STALE_KEEP_MS) return null;
      return { ...row, _stale: true, _staleSince: staleSince, error: 'temporary Docker refresh failure' };
    }).filter(Boolean);
    if (kept.length) return kept;
  }
  const now = Date.now();
  return nextRows.map(next => {
    if (!next || next.online) return next;
    if (!configured.some(row => sameDockerRow(row, next))) return next;
    const prev = prevRows.find(row => row?.online && sameDockerRow(row, next));
    if (!prev) return next;
    const staleSince = prev._staleSince || now;
    if (now - staleSince > STALE_KEEP_MS) return next;
    return {
      ...prev,
      _stale: true,
      _staleSince: staleSince,
      error: next._connecting ? 'refresh in progress' : (next.error || 'temporary Docker refresh failure'),
    };
  });
}

async function getProxmoxData() {
  if (hasProxmoxApi()) return getProxmoxApiData({ ...config.proxmox, excludedServices: config.excludedServices });
  return agents.getProxmoxData({ excludedServices: config.excludedServices });
}

async function getDockerData() {
  const apiData = hasDockerApi() ? await getDockerApiData(config.docker) : [];
  const agentData = agents.getDockerData();
  const names = new Set(apiData.map(h => h.name));
  return [...apiData, ...agentData.filter(h => !names.has(h.name))];
}

function assignStatic(base) {
  base.publicStatus = !!config.publicStatus;
  base.configured = configuredList();
  base.notifyDisabled = Array.from(notifyDisabled);
  base.timeFormat = config.timeFormat || '24h';
  base.icons = {
    proxmox: config.proxmox?.icon, linux: config.linux?.icon, kubernetes: config.kubernetes?.icon,
    snmp: config.snmp?.icon, healthchecks: config.healthchecks?.icon, prometheus: config.prometheus?.icon, docker: config.docker?.icon,
    database: config.database?.icon, uptimekuma: config.uptimekuma?.icon,
  };
}

function configuredList() {
  const en = c => c && c.enabled !== false;
  const hasPrometheus = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const ids = [];
  if (en(config.proxmox)      && (agents.hasPve() || (config.proxmox.url && config.proxmox.tokenId && config.proxmox.tokenSecret))) ids.push('proxmox');
  if (en(config.kubernetes)   && config.kubernetes.kubeconfig)          ids.push('kubernetes');
  if (en(config.linux)        && config.linux.agentToken)               ids.push('linux');
  if (en(config.snmp)         && (config.snmp.devices || []).length)    ids.push('snmp');
  if (en(config.healthchecks) && config.healthchecks.url)               ids.push('healthchecks');
  if (en(config.uptimekuma)   && config.uptimekuma.url)                 ids.push('uptimekuma');
  if (en(config.prometheus)   && hasPrometheus(config.prometheus))       ids.push('prometheus');
  if (en(config.docker)       && (agents.hasDocker() || (config.docker.hosts || []).length)) ids.push('docker');
  if (en(config.database)     && (config.database.instances || []).length) ids.push('database');
  return ids;
}

function prometheusConfigInstances(c = {}) {
  const src = Array.isArray(c.instances) && c.instances.length ? c.instances : (c.url ? [c] : []);
  return src
    .filter(i => i && (i.url || i.name))
    .map((i, idx) => ({
      name: String(i.name || i.label || i.url || `Prometheus ${idx + 1}`).trim(),
      url: i.url || '',
    }));
}

function promKeys(row = {}) {
  return [row.url, row.sourceUrl, row.name, row.sourceName]
    .filter(Boolean)
    .map(v => String(v).trim().toLowerCase());
}

function findPromRow(rows, want) {
  const keys = new Set(promKeys(want));
  return rows.find(row => promKeys(row).some(k => keys.has(k)));
}

function recomputePrometheusSummary(instances, targets) {
  const instanceUp = instances.filter(i => i.online).length;
  const instanceConnecting = instances.filter(i => i._connecting).length;
  return {
    instances: instances.length,
    instanceUp,
    instanceConnecting,
    instanceDown: instances.filter(i => !i.online && !i._connecting).length,
    total: targets.length,
    up: targets.filter(t => t.health === 'up').length,
    down: targets.filter(t => t.health === 'down').length,
    unknown: targets.filter(t => t.health === 'unknown').length,
  };
}

function mergePrometheusConfigured(current, cfg) {
  const wanted = prometheusConfigInstances(cfg);
  if (!wanted.length) return null;
  const cur = current && typeof current === 'object' ? current : {};
  const oldInstances = Array.isArray(cur.instances) && cur.instances.length
    ? cur.instances
    : (cur.url || cur.online !== undefined ? [{ name: cur.name || cfg.name || 'Prometheus', url: cur.url || cfg.url, online: cur.online, error: cur.error, summary: cur.summary }] : []);
  const instances = wanted.map(w => {
    const prev = findPromRow(oldInstances, w);
    if (prev) return { ...prev, name: w.name, url: w.url };
    return { name: w.name, url: w.url, online: false, _connecting: true, summary: { total: 0, up: 0, down: 0, unknown: 0 } };
  });
  const targets = (cur.targets || []).filter(t => findPromRow(wanted, t));
  const summary = recomputePrometheusSummary(instances, targets);
  return {
    online: summary.instanceUp > 0,
    _connecting: summary.instanceUp === 0 && summary.instanceConnecting > 0,
    error: instances.find(i => !i.online && !i._connecting)?.error || '',
    summary,
    instances,
    targets,
  };
}

function extractChecks(data) {
  const m = new Map();
  const add = (key, ok, label, detail) => m.set(key, { ok, label, detail });
  (data.proxmox?.nodes || []).forEach(n => {
    if (n._connecting) return;
    const nm = n.node?.name || n.name || 'node';
    add('px:' + nm, !!n.node?.online, 'Proxmox node ' + nm, 'offline');
    if (n.node?.online) {
      (n.services || []).forEach(s => {
        if (!s.excluded) add('px:' + nm + ':' + s.name, !!s.active, 'Proxmox ' + nm + ' / ' + s.name, 'inactive');
      });
    }
  });
  (data.linux || []).forEach(l => {
    if (l._connecting) return;
    add('lx:' + l.name, !!l.online, 'Server ' + l.name, 'unreachable');
    if (l.online) {
      (l.services || []).forEach(s => {
        if (!s.excluded) add('lx:' + l.name + ':' + s.name, !!s.active, l.name + ' / ' + s.name, 'inactive');
      });
    }
  });
  const k = data.kubernetes;
  if (k && k.online !== undefined) {
    add('k8s', !!k.online, 'Kubernetes', 'unreachable');
    if (k.online) (k.pods || []).forEach(p => add('k8s:' + p.namespace + '/' + p.name, !p.failed, 'Pod ' + p.namespace + '/' + p.name, p.phase));
  }
  (data.snmp || []).forEach(s => add('snmp:' + s.name, !!s.online, 'SNMP ' + s.name, 'unreachable'));
  (data.docker || []).forEach(h => {
    if (h._connecting) return;
    add('dk:' + h.name, !!h.online, 'Docker host ' + h.name, 'unreachable');
    if (h.online) (h.containers || []).forEach(c => {
      const ok = c.state === 'running' || c.state === 'created' || c.state === 'paused' || c.state === 'restarting';
      add('dk:' + h.name + ':' + c.name, ok, 'Container ' + c.name + ' @ ' + h.name, c.state);
    });
  });
  const hc = data.healthchecks;
  if (hc && Array.isArray(hc.checks)) hc.checks.forEach(c => {
    const nm = c.name || c.slug;
    add('hc:' + nm, c.status !== 'down' && c.status !== 'grace', 'Healthcheck ' + nm, c.status);
  });
  const uk = data.uptimekuma;
  if (uk && Array.isArray(uk.monitors)) uk.monitors.forEach(m => {
    const nm = m.name || m.id;
    add('uk:' + nm, m.status !== 'down', 'Uptime Kuma ' + nm, m.status);
  });
  const prom = data.prometheus;
  if (prom && Array.isArray(prom.instances)) prom.instances.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.url || 'Prometheus';
    add('prom:instance:' + nm, !!i.online, 'Prometheus ' + nm, i.error || 'unreachable');
  });
  if (prom && Array.isArray(prom.targets)) prom.targets.forEach(t => {
    const nm = t.name || t.scrapeUrl || 'target';
    const key = [t.sourceName || t.sourceUrl || 'default', nm].join(':');
    add('prom:' + key, t.health === 'up', 'Prometheus target ' + nm, t.lastError || t.health);
  });
  (data.database || []).forEach(d => add('db:' + d.name, !!d.online, 'Database ' + d.name, 'unreachable'));
  return m;
}

let prevChecks = null;
function logAlertResult(rs) {
  (rs || []).forEach(r => { if (!r.ok) console.warn(`Alert ${r.channel} failed: ${r.error}`); });
}
function runAlertChecks(data) {
  if (!config.alerts) return;
  const cur = extractChecks(data);
  if (prevChecks === null) { prevChecks = cur; return; }
  for (const [key, c] of cur) {
    if (notifyDisabled.has(key)) continue;
    const p = prevChecks.get(key);
    if (!p) continue;
    if (p.ok && !c.ok) {
      dispatchAlert(config.alerts, {
        title: `\u{1F534} DOWN \u2014 ${c.label}`,
        message: `${c.label} is ${c.detail || 'down'}\n${new Date().toLocaleString()}`,
        priority: 'high', tags: 'rotating_light',
      }).then(logAlertResult).catch(() => {});
    } else if (!p.ok && c.ok) {
      dispatchAlert(config.alerts, {
        title: `\u{1F7E2} UP \u2014 ${c.label}`,
        message: `${c.label} recovered\n${new Date().toLocaleString()}`,
        priority: 'default', tags: 'white_check_mark',
      }).then(logAlertResult).catch(() => {});
    }
  }
  prevChecks = cur;
}

const STALE_KEEP_MS = 120000;
function preserveProxmoxOnTransient(next, err) {
  const prev = cache.data?.proxmox;
  if (!prev?.nodes?.length) return next;
  const prevHadOnline = prev.nodes.some(n => n.node?.online);
  if (!prevHadOnline) return next;
  if (next?._connecting) return { ...prev, _stale: true, _staleSince: prev._staleSince || Date.now(), error: 'refresh in progress' };
  const nodes = next?.nodes || [];
  const looksDropped = !nodes.length || nodes.every(n => !n.node?.online);
  if (!looksDropped) return { ...next, _stale: false, _staleSince: null, error: undefined };
  const now = Date.now();
  const staleSince = prev._staleSince || now;
  if (now - staleSince > STALE_KEEP_MS) return next;
  return { ...prev, _stale: true, _staleSince: staleSince, error: err?.message || 'temporary Proxmox refresh failure' };
}

function backgroundRefresh() {
  if (refreshPromise) return refreshPromise;
  const enabled = c => c && c.enabled !== false;
  if (!cache.data) cache.data = { timestamp: new Date().toISOString(), proxmox: { clusterSummary: null, nodes: [] }, linux: [], kubernetes: null, snmp: [], healthchecks: null, uptimekuma: null, prometheus: null, docker: [], database: [], publicStatus: false, loading: true };
  const base = cache.data;
  assignStatic(base);
  const tasks = [
    ['proxmox',      enabled(config.proxmox)      ? getProxmoxData() : Promise.resolve({ clusterSummary: null, nodes: [] }), { clusterSummary: null, nodes: [] }],
    ['linux',        enabled(config.linux)        ? Promise.resolve(agents.getAllAgentData({ ...config.linux, excludedServices: config.excludedServices })) : Promise.resolve([]),   []],
    ['kubernetes',   enabled(config.kubernetes)   ? getAllKubernetesData(config.kubernetes)  : Promise.resolve(null), null],
    ['snmp',         enabled(config.snmp)         ? getAllSynologyData(config.snmp)          : Promise.resolve([]),   []],
    ['healthchecks', enabled(config.healthchecks) ? getAllHealthchecks(config.healthchecks) : Promise.resolve(null), null],
    ['uptimekuma',   enabled(config.uptimekuma)   ? getAllUptimeKuma(config.uptimekuma)     : Promise.resolve(null), null],
    ['prometheus',   enabled(config.prometheus)   ? getPrometheusData(config.prometheus)    : Promise.resolve(null), null],
    ['docker',       enabled(config.docker)       ? getDockerData()  : Promise.resolve([]),   []],
    ['database',     enabled(config.database)     ? getAllDatabaseData(config.database)      : Promise.resolve([]),   []],
  ];
  const ps = tasks.map(([key, p, fb]) =>
    p.then(v => {
      const next = (v == null ? fb : v);
      base[key] = key === 'proxmox' ? preserveProxmoxOnTransient(next)
        : key === 'docker' ? preserveDockerOnTransient(next)
        : next;
      base.timestamp = new Date().toISOString();
    })
     .catch(err => {
       if (key === 'proxmox') {
         base[key] = preserveProxmoxOnTransient(fb, err);
         if (base[key]?._stale) console.warn(`Proxmox refresh failed; keeping last data: ${err.message}`);
       } else if (key === 'docker') {
         base[key] = preserveDockerOnTransient(fb);
         if ((base[key] || []).some(h => h._stale)) console.warn(`Docker refresh failed; keeping last data: ${err.message}`);
       } else {
         base[key] = fb;
       }
     })
  );
  refreshPromise = Promise.allSettled(ps)
    .then(() => { 
      base.loading = false; 
      base.timestamp = new Date().toISOString(); 
      runAlertChecks(base); 
      const svcs = buildPublicSummary(base);
      svcs.forEach(s => {
        if (!PLATFORM_HISTORY[s.id]) PLATFORM_HISTORY[s.id] = Array(20).fill(null).map(() => ({ health: 100 }));
        let score = 100;
        if (s.status === 'down') score = 0;
        else if (s.status === 'warn') score = 65;
        PLATFORM_HISTORY[s.id].push({ health: score });
        if (PLATFORM_HISTORY[s.id].length > 1440) PLATFORM_HISTORY[s.id].shift();
      });
    })
    .catch(err => { console.error(err.message); })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

const EMPTY = {
  loading: true,
  proxmox: { clusterSummary: null, nodes: [] },
  linux: [],
  kubernetes: null,
  snmp: [],
  healthchecks: null,
  uptimekuma: null,
  prometheus: null,
  docker: [],
  database: [],
  publicStatus: false,
};

function getCachedData() {
  if (!cache.data) {
    backgroundRefresh();
    return Promise.resolve(cache.data || { ...EMPTY, timestamp: new Date().toISOString(), configured: configuredList() });
  }
  return Promise.resolve(cache.data);
}

backgroundRefresh();
setInterval(backgroundRefresh, REFRESH_INTERVAL);

app.use(express.json({ limit: '5mb' }));
app.use(parseCookies);
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.post('/api/login', (req, res) => {
  const auth = loadAuth();
  if (!auth) return res.json({ ok: true });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  if (username !== auth.username) return res.status(401).json({ error: 'Invalid credentials' });
  try {
    if (!verifyPassword(password, auth.hash, auth.salt)) return res.status(401).json({ error: 'Invalid credentials' });
  } catch { return res.status(401).json({ error: 'Invalid credentials' }); }
  const token = genToken();
  const remember = req.body.remember === true;
  const expires = Date.now() + (remember ? THIRTY_DAYS : 24 * 60 * 60 * 1000);
  sessions.set(token, { username, created: Date.now(), expires });
  saveSessions(sessions);
  res.json({ ok: true, token });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'] || req.cookies?.session;
  if (token) { sessions.delete(token); saveSessions(sessions); }
  res.json({ ok: true });
});

app.get('/api/auth-status', (req, res) => {
  const auth = loadAuth();
  res.json({ required: !!auth, username: auth?.username || null });
});

app.post('/api/set-password', (req, res) => {
  const { username, password, currentPassword } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing fields' });
  const auth = loadAuth();
  if (auth && password) {
    if (!currentPassword) return res.status(401).json({ error: 'Current password required' });
    try {
      if (!verifyPassword(currentPassword, auth.hash, auth.salt))
        return res.status(401).json({ error: 'Wrong current password' });
    } catch { return res.status(401).json({ error: 'Wrong current password' }); }
  } else if (!auth && !password) {
    return res.status(400).json({ error: 'Password required for initial setup' });
  }
  if (password) {
    const pErr = validatePassword(password);
    if (pErr) return res.status(400).json({ error: pErr });
  }
  const finalUsername = (username === '__current__' && auth?.username) ? auth.username : username;
  const salt = password ? crypto.randomBytes(16).toString('hex') : auth.salt;
  const hash = password ? hashPassword(password, salt) : auth.hash;
  fs.writeFileSync(AUTH_PATH, yaml.dump({ username: finalUsername, hash, salt }), 'utf8');
  res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {
  try { res.json(await getCachedData()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/refresh', async (req, res) => {
  try {
    await backgroundRefresh();
    res.json(cache.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/config', (req, res) => {
  const raw = fs.existsSync(CONFIG_PATH)
    ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}
    : {};
    
  if (!raw.timezone && process.env.TZ) {
    raw.timezone = process.env.TZ;
  }
  
  const masked = maskConfig(raw);
  res.json(masked);
});

function maskConfig(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskConfig);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k) && v) out[k] = isEncrypted(v) ? '__encrypted__' : '__set__';
    else if (typeof v === 'object' && v !== null) out[k] = maskConfig(v);
    else out[k] = v;
  }
  return out;
}

app.post('/api/config', (req, res) => {
  try {
    const incoming = req.body;
    const existing = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};

    if (existing.excludedServices) {
      incoming.excludedServices = existing.excludedServices;
    }

    const merged = mergePreservingSecrets(incoming, existing);
	if (merged.timezone) process.env.TZ = merged.timezone;
    const toSave = encryptionEnabled() ? encryptConfigObj(merged) : merged;
    fs.writeFileSync(CONFIG_PATH, yaml.dump(toSave, { lineWidth: -1 }), 'utf8');
    config = loadConfig();

    if (cache.data) {
      const en = c => c && c.enabled !== false;

      if (en(config.proxmox)) {
        if (hasProxmoxApi()) {
          cache.data.proxmox = preserveProxmoxOnTransient({ clusterSummary: null, nodes: [], _connecting: true });
        } else {
          cache.data.proxmox = agents.getProxmoxData({ excludedServices: config.excludedServices });
        }
      } else { cache.data.proxmox = { clusterSummary: null, nodes: [] }; }

      if (en(config.linux)) {
        cache.data.linux = agents.getAllAgentData({ ...config.linux, excludedServices: config.excludedServices });
      } else { cache.data.linux = []; }

      if (en(config.kubernetes)) {
        if (!cache.data.kubernetes) {
          cache.data.kubernetes = { _connecting: true, online: false, summary: { total: 0, running: 0, failed: 0, pending: 0 }, pods: [], services: [], deployments: [] };
        }
      } else { cache.data.kubernetes = null; }

      if (en(config.snmp)) {
        const devices = config.snmp.devices || [];
        cache.data.snmp = (cache.data.snmp || []).filter(d => devices.some(dev => dev.name === d.name));
        devices.forEach(dev => {
          if (!cache.data.snmp.some(d => d.name === dev.name)) {
            cache.data.snmp.push({ name: dev.name, host: dev.host, online: false, _connecting: true });
          }
        });
      } else { cache.data.snmp = []; }

      if (en(config.healthchecks)) {
        if (!cache.data.healthchecks) {
          cache.data.healthchecks = { _connecting: true, online: false, summary: { total: 0, up: 0, down: 0, grace: 0, paused: 0 }, checks: [] };
        }
      } else { cache.data.healthchecks = null; }

      if (en(config.uptimekuma)) {
        if (!cache.data.uptimekuma) {
          cache.data.uptimekuma = { _connecting: true, online: false, summary: { total: 0, up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0 }, monitors: [] };
        }
      } else { cache.data.uptimekuma = null; }

      if (en(config.prometheus)) {
        cache.data.prometheus = mergePrometheusConfigured(cache.data.prometheus, config.prometheus);
      } else { cache.data.prometheus = null; }

      if (en(config.docker)) {
        cache.data.docker = mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData());
      } else { cache.data.docker = []; }

      if (en(config.database)) {
        const instances = config.database.instances || [];
        cache.data.database = (cache.data.database || []).filter(d => instances.some(i => i.name === d.name));
        instances.forEach(i => {
          if (!cache.data.database.some(d => d.name === i.name)) {
            cache.data.database.push({ name: i.name, type: i.type, host: i.host, online: false, _connecting: true });
          }
        });
      } else { cache.data.database = []; }

      assignStatic(cache.data);
    }

    if (!refreshPromise) backgroundRefresh();

    res.json({ ok: true, data: cache.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function patchCacheExclude(platform, host, service, isExcluded) {
  if (!cache.data) return;
  if (platform === 'linux' && cache.data.linux) {
    const srv = cache.data.linux.find(s => s.host === host || s.name === host);
    if (srv && srv.services) {
      const svc = srv.services.find(s => s.name === service);
      if (svc) svc.excluded = isExcluded;
    }
  } else if (platform === 'proxmox' && cache.data.proxmox?.nodes) {
    const node = cache.data.proxmox.nodes.find(n => n.node?.name === host);
    if (node && node.services) {
      const svc = node.services.find(s => s.name === service);
      if (svc) svc.excluded = isExcluded;
    }
  }
  runAlertChecks(cache.data);
}

app.post('/api/services/exclude', (req, res) => {
  try {
    const { platform, host, service } = req.body;
    if (!platform || !host || !service) return res.status(400).json({ error: 'Missing fields' });
    const existing = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};
    existing.excludedServices = existing.excludedServices || {};
    existing.excludedServices[platform] = existing.excludedServices[platform] || {};
    existing.excludedServices[platform][host] = existing.excludedServices[platform][host] || [];
    if (!existing.excludedServices[platform][host].includes(service)) {
      existing.excludedServices[platform][host].push(service);
      const toSave = encryptionEnabled() ? encryptConfigObj(existing) : existing;
      fs.writeFileSync(CONFIG_PATH, yaml.dump(toSave, { lineWidth: -1 }), 'utf8');
      config = loadConfig();
    }
    patchCacheExclude(platform, host, service, true);
    res.json({ ok: true, data: cache.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/services/include', (req, res) => {
  try {
    const { platform, host, service } = req.body;
    if (!platform || !host || !service) return res.status(400).json({ error: 'Missing fields' });
    const existing = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};
    if (existing.excludedServices?.[platform]?.[host]) {
      existing.excludedServices[platform][host] = existing.excludedServices[platform][host].filter(s => s !== service);
      const toSave = encryptionEnabled() ? encryptConfigObj(existing) : existing;
      fs.writeFileSync(CONFIG_PATH, yaml.dump(toSave, { lineWidth: -1 }), 'utf8');
      config = loadConfig();
    }
    patchCacheExclude(platform, host, service, false);
    res.json({ ok: true, data: cache.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/kubeconfig', (req, res) => {
  try {
    const { name, content } = req.body || {};
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'No file content' });
    let base = path.basename(String(name || 'kube.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!base || base === '.' || base === '..') base = 'kube.bin';
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    const dest = path.join(__dirname, 'data', base);
    fs.writeFileSync(dest, content, { mode: 0o600 });
    res.json({ path: dest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/icon', (req, res) => {
  try {
    const { name, dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'No file content' });
    const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    const b64 = m ? m[1] : dataUrl;
    let base = path.basename(String(name || 'icon')).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/\.(png|svg|webp|jpg|jpeg|gif|ico)$/i.test(base)) base += '.png';
    const dir = path.join(__dirname, 'data', 'icons');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, base), Buffer.from(b64, 'base64'));
    res.json({ path: '/api/icons/' + base });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/certificates', (req, res) => {
  try {
    const dir = path.join(__dirname, 'data', 'certs');
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir)
      .filter(f => /\.(crt|pem|cer|pfx|p12)$/i.test(f))
      .map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size, trusted: /\.(crt|pem|cer)$/i.test(f) }));
    res.json({ files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload/certificate', (req, res) => {
  try {
    const { name, dataUrl, password } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'No file content' });
    const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    const b64 = m ? m[1] : dataUrl;
    let base = path.basename(String(name || 'ca.crt')).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/\.(crt|pem|cer|pfx|p12)$/i.test(base)) return res.status(400).json({ error: 'Use .crt, .pem, .cer, .pfx or .p12' });
    const dir = path.join(__dirname, 'data', 'certs');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, base);
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'), { mode: 0o600 });
    if (/\.(pfx|p12)$/i.test(base)) {
      const out = path.join(dir, base.replace(/\.(pfx|p12)$/i, '.pem'));
      try {
        childProcess.execFileSync('openssl', ['pkcs12', '-in', dest, '-nokeys', '-nodes', '-passin', `pass:${String(password || '')}`, '-out', out], { stdio: 'ignore' });
      } catch {
        return res.status(400).json({ error: 'PFX uploaded, but openssl could not extract a CA certificate. Try .crt/.pem or provide the PFX password.' });
      }
    }
    const count = reloadExtraCA();
    res.json({ ok: true, name: base, trusted: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/certificates/:name', (req, res) => {
  try {
    const dir = path.join(__dirname, 'data', 'certs');
    const base = path.basename(req.params.name || '');
    if (!/\.(crt|pem|cer|pfx|p12)$/i.test(base)) return res.status(400).json({ error: 'invalid certificate name' });
    const dest = path.join(dir, base);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    if (/\.(pfx|p12)$/i.test(base)) {
      const pem = path.join(dir, base.replace(/\.(pfx|p12)$/i, '.pem'));
      if (fs.existsSync(pem)) fs.unlinkSync(pem);
    }
    reloadExtraCA();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/icons/:file', (req, res) => {
  const dir = path.join(__dirname, 'data', 'icons');
  const fp = path.join(dir, path.basename(req.params.file));
  if (!fp.startsWith(dir) || !fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

app.post('/api/notifications', (req, res) => {
  try {
    const { key, enabled } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    if (enabled === false) notifyDisabled.add(key); else notifyDisabled.delete(key);
    saveNotify();
    res.json({ ok: true, disabled: Array.from(notifyDisabled) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function configItemKey(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const parts = [item.type, item.name, item.host, item.url, item.socketPath, item.sshHost, item.database]
    .filter(v => v != null && v !== '')
    .map(String);
  return parts.length ? parts.join('|') : null;
}

function mergePreservingSecrets(incoming, existing) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (Array.isArray(incoming)) {
    const existingArr = Array.isArray(existing) ? existing : [];
    const existingByKey = new Map();
    existingArr.forEach(item => {
      const key = configItemKey(item);
      if (key && !existingByKey.has(key)) existingByKey.set(key, item);
    });
    return incoming.map((item, i) => {
      const key = configItemKey(item);
      return mergePreservingSecrets(item, key ? existingByKey.get(key) : existingArr[i]);
    });
  }
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (SENSITIVE_KEYS.has(k) && (v === '__encrypted__' || v === '__set__')) {
      out[k] = existing?.[k] ?? v;
    } else if (k === 'instances' && Array.isArray(v) && existing && !Array.isArray(existing.instances) && existing.url) {
      out[k] = mergePreservingSecrets(v, [existing]);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = mergePreservingSecrets(v, existing?.[k]);
    } else {
      out[k] = v;
    }
  }
  return out;
}

app.get('/api/debug/docker', async (req, res) => {
  try { res.json(await getDockerData()); }
  catch (err) { res.status(500).json({ error: err.message, stack: err.stack }); }
});

app.get('/api/debug/kubernetes', async (req, res) => {
  try { res.json(await getAllKubernetesData(config.kubernetes)); }
  catch (err) { res.status(500).json({ error: err.message, stack: err.stack }); }
});

app.get('/api/debug/snmp', async (req, res) => {
  try { res.json(await getAllSynologyData(config.snmp)); }
  catch (err) { res.status(500).json({ error: err.message, stack: err.stack }); }
});

app.get('/api/debug/snmp-probe', async (req, res) => {
  const snmp = require('net-snmp');
  const devices = config.snmp?.devices || [];
  if (!devices.length) return res.json({ error: 'No SNMP devices in config' });
  const dev = devices[0];
  const result = {
    device: { name: dev.name, host: dev.host, snmpVersion: dev.snmpVersion },
    constants: {
      Version3: snmp.Version3,
      Version2c: snmp.Version2c,
      SecurityLevel: snmp.SecurityLevel,
      AuthProtocols: snmp.AuthProtocols ? Object.keys(snmp.AuthProtocols) : null,
      PrivProtocols: snmp.PrivProtocols ? Object.keys(snmp.PrivProtocols) : null,
    },
    resolvedVersion: Number(dev.snmpVersion),
    willUseV3: Number(dev.snmpVersion) === 3,
  };
  try {
    const ver = Number(dev.snmpVersion);
    let session;
    if (ver === 3) {
      const user = { name: dev.username, level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha, authKey: dev.authPassword, privProtocol: snmp.PrivProtocols.aes, privKey: dev.privPassword };
      session = snmp.createV3Session(dev.host, user, { context: '', transport: 'udp4', timeout: 5000, retries: 0 });
    } else {
      session = snmp.createSession(dev.host, dev.community || 'public', { version: snmp.Version2c, timeout: 5000, retries: 0 });
    }
    await new Promise((resolve, reject) => {
      try {
        session.get(['1.3.6.1.2.1.1.1.0'], (err, vb) => {
          session.close();
          if (err) { result.probeError = err.message; reject(err); }
          else { result.probeResult = vb[0]?.value?.toString(); resolve(); }
        });
      } catch (e) { session.close(); reject(e); }
    });
  } catch (e) { result.sessionError = e.message; }
  res.json(result);
});

function agentAuth(req, res) {
  const token = String(req.headers['x-agent-token'] || '');
  const expected = String(config.linux?.agentToken || '');
  if (!expected) { res.status(403).json({ error: 'agent token is not configured' }); return false; }
  const a = Buffer.from(token), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.status(401).json({ error: 'invalid agent token' }); return false; }
  return true;
}

app.get('/agent/install.sh', (req, res) => {
  res.type('text/x-shellscript').sendFile(path.join(__dirname, 'agent', 'install.sh'));
});

app.get('/agent/omnisight-agent.sh', (req, res) => {
  res.type('text/x-shellscript').sendFile(path.join(__dirname, 'agent', 'omnisight-agent.sh'));
});

app.post('/api/agent/report', (req, res) => {
  if (!agentAuth(req, res)) return;
  try {
    const a = agents.handleReport(req.body || {});
    if (cache.data) {
      const en = c => c && c.enabled !== false;
      cache.data.linux = en(config.linux) ? agents.getAllAgentData({ ...config.linux, excludedServices: config.excludedServices }) : [];
      if (en(config.proxmox) && !hasProxmoxApi()) {
        cache.data.proxmox = preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
      } else if (!en(config.proxmox)) {
        cache.data.proxmox = { clusterSummary: null, nodes: [] };
      }
      cache.data.docker = en(config.docker) ? mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData()) : [];
      assignStatic(cache.data);
    }
    const cmds = agents.takeCommands(a.id);
    res.type('text/plain').send(agents.commandLines(cmds));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/agent/commands', async (req, res) => {
  if (!agentAuth(req, res)) return;
  const id = String(req.query.id || '').replace(/[^\w.-]/g, '').slice(0, 128);
  if (!id) return res.status(400).json({ error: 'id required' });
  const waitMs = Math.min(Math.max(Number(req.query.wait) || 10, 1), 55) * 1000;
  const cmds = await agents.waitForCommands(id, waitMs);
  res.type('text/plain').send(agents.commandLines(cmds));
});

app.post('/api/agent/result', (req, res) => {
  if (!agentAuth(req, res)) return;
  res.json({ ok: agents.handleResult(req.body || {}) });
});

function appVersion() {
  try { return require('./package.json').version || '1.0.0'; }
  catch { return '1.0.0'; }
}

function agentLatestVersion() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, 'agent', 'omnisight-agent.sh'), 'utf8');
    return (txt.match(/^VERSION="([^"]+)"/m) || [])[1] || appVersion();
  } catch {
    return appVersion();
  }
}

function versionCompare(a, b) {
  const pa = String(a || '0').split('.').map(n => Number(n) || 0);
  const pb = String(b || '0').split('.').map(n => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

app.get('/api/agents', (req, res) => {
  res.json({ latestVersion: agentLatestVersion(), agents: agents.listAgents() });
});

app.post('/api/agent/update', async (req, res) => {
  try {
    const id = String(req.body?.id || '').replace(/[^\w.-]/g, '').slice(0, 128);
    if (!id) return res.status(400).json({ error: 'id required' });
    const agent = agents.findAgent(id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    if (versionCompare(agent.agentVersion, '1.2.1') < 0) {
      return res.status(409).json({
        error: 'This agent needs a one-time manual update before remote updates are available.',
        manualCommand: "sudo sh -c 'set -a; . /etc/omnisight-agent/agent.env; set +a; curl -fsS ${OMNISIGHT_INSECURE_TLS:+--insecure} \"$OMNISIGHT_URL/agent/install.sh\" -o /tmp/omnisight-install.sh && bash /tmp/omnisight-install.sh && systemctl restart omnisight-agent'",
      });
    }
    const output = await agents.queueCommand(id, 'agent_update', 'self');
    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/token', (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const existing = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};
    existing.linux = existing.linux || {};
    existing.linux.agentToken = token;
    if (existing.linux.enabled === undefined) existing.linux.enabled = true;
    const toSave = encryptionEnabled() ? encryptConfigObj(existing) : existing;
    fs.writeFileSync(CONFIG_PATH, yaml.dump(toSave, { lineWidth: -1 }), 'utf8');
    config = loadConfig();
    res.json({ ok: true, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/pending', (req, res) => {
  try {
    const kind = ['linux', 'proxmox', 'docker'].includes(req.body?.kind) ? req.body.kind : 'linux';
    const pending = agents.addPendingInstall(kind);
    if (cache.data) {
      if (kind === 'linux') {
        cache.data.linux = agents.getAllAgentData({ ...config.linux, excludedServices: config.excludedServices });
      }
      if (kind === 'proxmox') {
        cache.data.proxmox = preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
      }
      if (kind === 'docker') {
        cache.data.docker = mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData());
      }
      assignStatic(cache.data);
    }
    res.json({ ok: true, pending, data: cache.data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/remove', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const ok = agents.removeAgent(id);
    if (cache.data) {
      cache.data.linux = agents.getAllAgentData({ ...config.linux, excludedServices: config.excludedServices });
      cache.data.proxmox = hasProxmoxApi()
        ? cache.data.proxmox
        : preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
      cache.data.docker = mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData());
      assignStatic(cache.data);
    }
    res.json({ ok, data: cache.data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(LOG_BUFFER.filter(l => l.t > since));
});

function buildPublicSummary(data) {
  const out = [];
  const nodes = data.proxmox?.nodes || [];
  if (nodes.length) {
    const activeNodes = nodes.filter(n => !n._connecting);
    const connecting = nodes.length - activeNodes.length;
    const online = activeNodes.filter(n => n.node?.online).length;
    const failedSvcs = activeNodes.reduce((a, n) => a + (n.services || []).filter(s => !s.active && !s.excluded).length, 0);
    const ceph = data.proxmox.ceph;
    
    let status = 'ok';
    let meta = activeNodes.length ? `${online}/${activeNodes.length} nodes online` : 'connecting...';
    
    if (!activeNodes.length && connecting) status = 'connecting';
    else if (online === 0) status = 'down';
    else if (online < activeNodes.length || connecting || failedSvcs > 0 || (ceph && ceph.health !== 'HEALTH_OK')) status = 'warn';
    if (ceph && ceph.health === 'HEALTH_ERR') status = 'down';
    
    if (failedSvcs > 0) meta += `, ${failedSvcs} failed services`;
    if (ceph && ceph.health !== 'HEALTH_OK') meta += `, Ceph ${ceph.health.replace('HEALTH_', '')}`;
    
    out.push({ id: 'proxmox', title: 'Proxmox', status, meta });
  }
  if ((data.linux || []).length) {
    const linuxRows = data.linux.filter(l => !l._connecting);
    const connecting = data.linux.length - linuxRows.length;
    const up = linuxRows.filter(l => l.online).length;
    const svcTotal = linuxRows.reduce((a, l) => a + (l.services || []).filter(s => !s.excluded).length, 0);
    const svcUp = linuxRows.reduce((a, l) => a + (l.services || []).filter(x => x.active && !x.excluded).length, 0);
    const failedSvcs = svcTotal - svcUp;
    const status = !linuxRows.length && connecting ? 'connecting' : up === 0 ? 'down' : (up < linuxRows.length || connecting || failedSvcs > 0 ? 'warn' : 'ok');
    out.push({ id: 'linux', title: 'Linux Servers', status, meta: linuxRows.length ? `${up}/${linuxRows.length} servers, ${svcUp}/${svcTotal} services` : 'connecting...' });
  }
  const k = data.kubernetes;
  if (k && k.online !== undefined && (k.online || k.summary)) {
    const sm = k.summary || {};
    out.push({ id: 'kubernetes', title: 'Kubernetes', status: !k.online ? 'down' : (sm.failed > 0 ? 'warn' : 'ok'), meta: k.online ? `${sm.running || 0}/${sm.total || 0} pods running` : 'unreachable' });
  }
  if ((data.snmp || []).length) {
    const up = data.snmp.filter(d => d.online).length;
    out.push({ id: 'snmp', title: 'SNMP', status: up === data.snmp.length ? 'ok' : up > 0 ? 'warn' : 'down', meta: `${up}/${data.snmp.length} online` });
  }
  const hc = data.healthchecks;
  if (hc && hc.online !== undefined) {
    const sm = hc.summary || {};
    out.push({ id: 'healthchecks', title: 'Healthchecks', status: !hc.online ? 'down' : ((sm.down || 0) > 0 ? 'down' : (sm.grace || 0) > 0 ? 'warn' : 'ok'), meta: hc.online ? `${sm.up || 0}/${sm.total || 0} up` : 'unreachable' });
  }
  const uk = data.uptimekuma;
  if (uk && uk.online !== undefined) {
    const sm = uk.summary || {};
    const up = sm.up || 0;
    const down = sm.down || 0;
    const warn = (sm.pending || 0) + (sm.unknown || 0);
    const status = !uk.online ? 'down' : (down > 0 ? (up > 0 ? 'warn' : 'down') : (warn > 0 ? 'warn' : 'ok'));
    out.push({ id: 'uptimekuma', title: 'Uptime Kuma', status, meta: uk.online ? `${up}/${sm.total || 0} up` : 'unreachable' });
  }
  const prom = data.prometheus;
  if (prom && prom.online !== undefined) {
    const sm = prom.summary || {};
    const up = sm.up || 0;
    const down = sm.down || 0;
    const unknown = sm.unknown || 0;
    const instanceDown = sm.instanceDown || 0;
    const status = !prom.online ? 'down' : (down > 0 ? (up > 0 ? 'warn' : 'down') : ((unknown > 0 || instanceDown > 0) ? 'warn' : 'ok'));
    const instanceMeta = sm.instances ? ` · ${sm.instanceUp || 0}/${sm.instances} servers` : '';
    out.push({ id: 'prometheus', title: 'Prometheus', status, meta: prom.online ? `${up}/${sm.total || 0} targets up${instanceMeta}` : 'unreachable' });
  }
  if ((data.docker || []).length) {
    const dockerRows = data.docker.filter(h => !h._connecting);
    const connecting = data.docker.length - dockerRows.length;
    const up = dockerRows.filter(h => h.online).length;
    const running = dockerRows.reduce((a, h) => a + (h.summary?.running || 0), 0);
    const total = dockerRows.reduce((a, h) => a + (h.summary?.total || 0), 0);
    const stopped = dockerRows.reduce((a, h) => a + (h.summary?.stopped || 0), 0);
    const status = !dockerRows.length && connecting ? 'connecting' : up < dockerRows.length ? (up > 0 ? 'warn' : 'down') : (connecting || stopped > 0 ? 'warn' : 'ok');
    const meta = stopped > 0 ? `${running}/${total} running, ${stopped} stopped` : `${running}/${total} containers running`;
    out.push({ id: 'docker', title: 'Docker', status, meta: dockerRows.length ? meta : 'connecting...' });
  }
  if ((data.database || []).length) {
    const up = data.database.filter(d => d.online).length;
    out.push({ id: 'database', title: 'Databases', status: up === data.database.length ? 'ok' : up > 0 ? 'warn' : 'down', meta: `${up}/${data.database.length} online` });
  }
  return out;
}

app.get('/api/public/status', (req, res) => {
  if (!config.publicStatus) return res.status(404).json({ error: 'public status not enabled' });
  const data = cache.data || EMPTY;
  const services = buildPublicSummary(data);
  const present = new Set(services.map(s => s.id));
  const titles = { proxmox: 'Proxmox', linux: 'Linux Servers', kubernetes: 'Kubernetes', snmp: 'SNMP', healthchecks: 'Healthchecks', uptimekuma: 'Uptime Kuma', prometheus: 'Prometheus', docker: 'Docker', database: 'Databases' };
  (data.configured || configuredList()).forEach(id => {
    if (!present.has(id)) services.push({ id, title: titles[id] || id, status: 'connecting', meta: 'connecting…' });
  });
  services.forEach(s => { 
    s.history = (PLATFORM_HISTORY[s.id] && PLATFORM_HISTORY[s.id].length) 
      ? PLATFORM_HISTORY[s.id] 
      : Array(20).fill(null).map(() => ({ health: 100 })); 
  });
  res.json({
    title: config.publicTitle || 'OmniSight Status',
    timestamp: data.timestamp || new Date().toISOString(),
    refreshing: !!refreshPromise,
    services,
  });
});

app.get('/api/about', (req, res) => {
  let version = '1.0.0', author = 'caglaryalcin';
  try { const pkg = require('./package.json'); version = pkg.version; author = pkg.author || author; } catch {}
  res.json({ name: 'OmniSight', version, author, github: 'https://github.com/caglaryalcin/OmniSight' });
});

app.post('/api/alerts/test', async (req, res) => {
  try {
    if (!config.alerts) return res.status(400).json({ error: 'alerts not configured' });
    const only = req.query.channel;
    const results = await dispatchAlert(config.alerts, {
      title: '\u{1F514} OmniSight test alert',
      message: 'This is a test notification from OmniSight.\n' + new Date().toLocaleString(),
      priority: 'default', tags: 'bell',
    }, only);
    results.forEach(r => { if (!r.ok) console.warn(`Alert test ${r.channel} failed: ${r.error}`); });
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/proxmox/service', async (req, res) => {
  try {
    const { node, service, action } = req.query;
    if (!['status', 'start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (!agents.findAgent(node)) return res.status(404).json({ error: 'node agent not found' });
    const output = await agents.queueCommand(node, action, service);
    if (action !== 'status') {
      if (cache.data?.proxmox?.nodes) {
        const n = cache.data.proxmox.nodes.find(x => x.node?.name === node);
        if (n && n.services) {
          const s = n.services.find(x => x.name === service);
          if (s) s.active = action === 'start';
        }
      }
      refreshPromise = null;
      backgroundRefresh();
    }
    res.json({ ok: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/linux/service', async (req, res) => {
  try {
    const { host, service, action } = req.query;
    if (!['status', 'start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (!agents.findAgent(host)) return res.status(404).json({ error: 'agent not found' });
    const output = await agents.queueCommand(host, action, service);
    if (action !== 'status') {
      if (cache.data?.linux) {
        const s = cache.data.linux.find(x => x.host === host || x.name === host);
        if (s && s.services) {
          const svc = s.services.find(x => x.name === service);
          if (svc) svc.active = action !== 'stop';
        }
      }
      refreshPromise = null;
      backgroundRefresh();
    }
    res.json({ ok: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/docker/prune', async (req, res) => {
  try {
    const host = String(req.query.host || '');
    let output;
    if (agents.findAgent(host)) output = await agents.queueCommand(host, 'docker_prune', 'all');
    else if (hasDockerApi()) output = await dockerApiPrune(config.docker, host);
    else return res.status(404).json({ error: 'docker host not found' });
    if (cache.data?.docker) {
      const h = cache.data.docker.find(x => x.name === host);
      if (h && h.summary) h.summary.unused = 0;
    }
    refreshPromise = null;
    backgroundRefresh();
    res.json({ ok: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/docker/logs', async (req, res) => {
  try {
    const { host, id } = req.query;
    if (!host || !id) return res.status(400).json({ error: 'host and id required' });
    if (!/^[\w.-]+$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    let logs;
    if (agents.findAgent(host)) logs = await agents.queueCommand(host, 'docker_logs', id);
    else if (hasDockerApi()) logs = await dockerApiLogs(config.docker, host, id);
    else return res.status(404).json({ error: 'docker host not found' });
    res.type('text/plain; charset=utf-8').send(logs || '');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/kubernetes/logs', async (req, res) => {
  try {
    const { namespace, pod, container } = req.query;
    if (!namespace || !pod) return res.status(400).json({ error: 'namespace and pod required' });
    const logs = await getPodLogs(config.kubernetes, namespace, pod, container, req.query.tail);
    res.type('text/plain; charset=utf-8').send(logs || '');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`OmniSight running at http://localhost:${PORT}`);
});
