const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');
const { getAllProxmoxData, proxmoxServiceAction } = require('./src/proxmox');
const { getAllLinuxData, runServiceAction } = require('./src/linux');
const { getAllKubernetesData, getPodLogs } = require('./src/kubernetes');
const { getAllSynologyData } = require('./src/snmp');
const { getAllHealthchecks } = require('./src/healthchecks');
const { getAllDockerData, getContainerLogs, pruneImages } = require('./src/docker');
const { getAllDatabaseData } = require('./src/database');
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

try {
  const https = require('https');
  const tls = require('tls');
  const certDir = path.join(__dirname, 'data', 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  const extra = [];
  for (const f of fs.readdirSync(certDir)) {
    if (/\.(crt|pem|cer)$/i.test(f)) { try { extra.push(fs.readFileSync(path.join(certDir, f))); } catch {} }
  }
  if (extra.length) {
    https.globalAgent.options.ca = [...tls.rootCertificates, ...extra];
    console.log(`Trusting ${extra.length} extra CA certificate(s) from data/certs/`);
  }
} catch (e) { console.warn('CA cert load failed:', e.message); }
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
  if (req.path.startsWith('/api/icons/')) return next();
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

let cache = { data: null };
let refreshPromise = null;

const PLATFORM_HISTORY = {};

function assignStatic(base) {
  base.publicStatus = !!config.publicStatus;
  base.configured = configuredList();
  base.notifyDisabled = Array.from(notifyDisabled);
  base.icons = {
    proxmox: config.proxmox?.icon, linux: config.linux?.icon, kubernetes: config.kubernetes?.icon,
    snmp: config.snmp?.icon, healthchecks: config.healthchecks?.icon, docker: config.docker?.icon,
    database: config.database?.icon,
  };
}

function configuredList() {
  const en = c => c && c.enabled !== false;
  const ids = [];
  if (en(config.proxmox)      && (config.proxmox.nodes || []).length)   ids.push('proxmox');
  if (en(config.kubernetes)   && config.kubernetes.kubeconfig)          ids.push('kubernetes');
  if (en(config.linux)        && (config.linux.servers || []).length)   ids.push('linux');
  if (en(config.snmp)         && (config.snmp.devices || []).length)    ids.push('snmp');
  if (en(config.healthchecks) && config.healthchecks.url)               ids.push('healthchecks');
  if (en(config.docker)       && (config.docker.hosts || []).length)    ids.push('docker');
  if (en(config.database)     && (config.database.instances || []).length) ids.push('database');
  return ids;
}

function extractChecks(data) {
  const m = new Map();
  const add = (key, ok, label, detail) => m.set(key, { ok, label, detail });
  (data.proxmox?.nodes || []).forEach(n => {
    const nm = n.node?.name || n.name || 'node';
    add('px:' + nm, !!n.node?.online, 'Proxmox node ' + nm, 'offline');
    if (n.node?.online) {
      (n.services || []).forEach(s => {
        if (!s.excluded) add('px:' + nm + ':' + s.name, !!s.active, 'Proxmox ' + nm + ' / ' + s.name, 'inactive');
      });
    }
  });
  (data.linux || []).forEach(l => {
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

function backgroundRefresh() {
  if (refreshPromise) return refreshPromise;
  const enabled = c => c && c.enabled !== false;
  if (!cache.data) cache.data = { timestamp: new Date().toISOString(), proxmox: { clusterSummary: null, nodes: [] }, linux: [], kubernetes: null, snmp: [], healthchecks: null, docker: [], database: [], publicStatus: false, loading: true };
  const base = cache.data;
  assignStatic(base);
  const tasks = [
    ['proxmox',      enabled(config.proxmox)      ? getAllProxmoxData({ ...config.proxmox, excludedServices: config.excludedServices }) : Promise.resolve({ clusterSummary: null, nodes: [] }), { clusterSummary: null, nodes: [] }],
    ['linux',        enabled(config.linux)        ? getAllLinuxData({ ...config.linux, excludedServices: config.excludedServices })     : Promise.resolve([]),   []],
    ['kubernetes',   enabled(config.kubernetes)   ? getAllKubernetesData(config.kubernetes)  : Promise.resolve(null), null],
    ['snmp',         enabled(config.snmp)         ? getAllSynologyData(config.snmp)          : Promise.resolve([]),   []],
    ['healthchecks', enabled(config.healthchecks) ? getAllHealthchecks(config.healthchecks) : Promise.resolve(null), null],
    ['docker',       enabled(config.docker)       ? getAllDockerData(config.docker)          : Promise.resolve([]),   []],
    ['database',     enabled(config.database)     ? getAllDatabaseData(config.database)      : Promise.resolve([]),   []],
  ];
  const ps = tasks.map(([key, p, fb]) =>
    p.then(v => { base[key] = (v == null ? fb : v); base.timestamp = new Date().toISOString(); })
     .catch(() => { base[key] = fb; })
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
        if (PLATFORM_HISTORY[s.id].length > 80) PLATFORM_HISTORY[s.id].shift();
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
  docker: [],
  database: [],
  publicStatus: false,
};

function getCachedData() {
  if (!cache.data) {
    backgroundRefresh();
    return Promise.resolve({ ...EMPTY, timestamp: new Date().toISOString(), configured: configuredList() });
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
  const masked = maskConfig(raw);
  res.json(masked);
});

function maskConfig(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskConfig);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'object' && v !== null) out[k] = maskConfig(v);
    else if (SENSITIVE_KEYS.has(k) && v) out[k] = isEncrypted(v) ? '__encrypted__' : '__set__';
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
    const toSave = encryptionEnabled() ? encryptConfigObj(merged) : merged;
    fs.writeFileSync(CONFIG_PATH, yaml.dump(toSave, { lineWidth: -1 }), 'utf8');
    config = loadConfig();

    if (cache.data) {
      const en = c => c && c.enabled !== false;

      if (en(config.proxmox)) {
        const nodes = config.proxmox.nodes || [];
        cache.data.proxmox = cache.data.proxmox || { clusterSummary: null, nodes: [] };
        cache.data.proxmox.nodes = cache.data.proxmox.nodes.filter(n => nodes.includes(n.node?.name));
        nodes.forEach(nm => {
          if (!cache.data.proxmox.nodes.some(n => n.node?.name === nm)) {
            cache.data.proxmox.nodes.push({ node: { name: nm, online: false }, services: [], vms: [], history: [], storage: [], _connecting: true });
          }
        });
      } else { cache.data.proxmox = { clusterSummary: null, nodes: [] }; }

      if (en(config.linux)) {
        const servers = config.linux.servers || [];
        cache.data.linux = (cache.data.linux || []).filter(s => servers.some(srv => srv.name === s.name || srv.host === s.host));
        servers.forEach(srv => {
          if (!cache.data.linux.some(s => s.name === srv.name || s.host === srv.host)) {
            cache.data.linux.push({ name: srv.name, host: srv.host, online: false, services: [], _connecting: true });
          }
        });
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

      if (en(config.docker)) {
        const hosts = config.docker.hosts || [];
        cache.data.docker = (cache.data.docker || []).filter(h => hosts.some(host => host.name === h.name));
        hosts.forEach(host => {
          if (!cache.data.docker.some(h => h.name === host.name)) {
            cache.data.docker.push({ name: host.name, online: false, containers: [], summary: { total: 0, running: 0, stopped: 0, other: 0, unused: null }, _connecting: true });
          }
        });
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

function mergePreservingSecrets(incoming, existing) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (Array.isArray(incoming)) {
    return incoming.map((item, i) => mergePreservingSecrets(item, Array.isArray(existing) ? existing[i] : undefined));
  }
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (SENSITIVE_KEYS.has(k) && (v === '__encrypted__' || v === '__set__')) {
      out[k] = existing?.[k] ?? v;
    } else if (typeof v === 'object' && v !== null) {
      out[k] = mergePreservingSecrets(v, existing?.[k]);
    } else {
      out[k] = v;
    }
  }
  return out;
}

app.get('/api/debug/docker', async (req, res) => {
  try { res.json(await getAllDockerData(config.docker || {})); }
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

app.get('/api/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(LOG_BUFFER.filter(l => l.t > since));
});

function buildPublicSummary(data) {
  const out = [];
  const nodes = data.proxmox?.nodes || [];
  if (nodes.length) {
    const online = nodes.filter(n => n.node?.online).length;
    const failedSvcs = nodes.reduce((a, n) => a + (n.services || []).filter(s => !s.active && !s.excluded).length, 0);
    const status = online === 0 ? 'down' : (online < nodes.length || failedSvcs > 0 ? 'warn' : 'ok');
    let meta = `${online}/${nodes.length} nodes online`;
    if (failedSvcs > 0) meta += `, ${failedSvcs} failed services`;
    out.push({ id: 'proxmox', title: 'Proxmox', status, meta });
  }
  if ((data.linux || []).length) {
    const up = data.linux.filter(l => l.online).length;
    const svcTotal = data.linux.reduce((a, l) => a + (l.services || []).filter(s => !s.excluded).length, 0);
    const svcUp = data.linux.reduce((a, l) => a + (l.services || []).filter(x => x.active && !x.excluded).length, 0);
    const failedSvcs = svcTotal - svcUp;
    const status = up === 0 ? 'down' : (up < data.linux.length || failedSvcs > 0 ? 'warn' : 'ok');
    out.push({ id: 'linux', title: 'Linux Servers', status, meta: `${up}/${data.linux.length} servers, ${svcUp}/${svcTotal} services` });
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
  if ((data.docker || []).length) {
    const up = data.docker.filter(h => h.online).length;
    const running = data.docker.reduce((a, h) => a + (h.summary?.running || 0), 0);
    const total = data.docker.reduce((a, h) => a + (h.summary?.total || 0), 0);
    const stopped = data.docker.reduce((a, h) => a + (h.summary?.stopped || 0), 0);
    const status = up < data.docker.length ? (up > 0 ? 'warn' : 'down') : (stopped > 0 ? 'warn' : 'ok');
    const meta = stopped > 0 ? `${running}/${total} running, ${stopped} stopped` : `${running}/${total} containers running`;
    out.push({ id: 'docker', title: 'Docker', status, meta });
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
  const titles = { proxmox: 'Proxmox', linux: 'Linux Servers', kubernetes: 'Kubernetes', snmp: 'SNMP', healthchecks: 'Healthchecks', docker: 'Docker', database: 'Databases' };
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
    if (!config.proxmox) return res.status(404).json({ error: 'proxmox not configured' });
    const output = await proxmoxServiceAction(config.proxmox, node, service, action);
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
    if (!['status', 'start', 'restart'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    const srv = (config.linux?.servers || []).find(s => s.host === host || s.name === host);
    if (!srv) return res.status(404).json({ error: 'server not found' });
    const output = await runServiceAction(srv, service, action);
    if (action !== 'status') {
      if (cache.data?.linux) {
        const s = cache.data.linux.find(x => x.host === host || x.name === host);
        if (s && s.services) {
          const svc = s.services.find(x => x.name === service);
          if (svc) svc.active = action === 'start';
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
    const host = (config.docker?.hosts || []).find(h => h.name === req.query.host);
    if (!host) return res.status(404).json({ error: 'host not found' });
    const result = await pruneImages(host);
    if (cache.data?.docker) {
      const h = cache.data.docker.find(x => x.name === req.query.host);
      if (h && h.summary) h.summary.unused = 0;
    }
    refreshPromise = null;
    backgroundRefresh();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/docker/logs', async (req, res) => {
  try {
    const { host, id } = req.query;
    if (!host || !id) return res.status(400).json({ error: 'host and id required' });
    if (!/^[\w.-]+$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    const logs = await getContainerLogs(config.docker || {}, host, id, req.query.tail);
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