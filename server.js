const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');
const { getAllProxmoxData } = require('./src/proxmox');
const { getAllLinuxData } = require('./src/linux');
const { getAllKubernetesData, getPodLogs } = require('./src/kubernetes');
const { getAllSynologyData } = require('./src/synology');
const { getAllHealthchecks } = require('./src/healthchecks');
const { getAllDockerData, getContainerLogs } = require('./src/docker');
const { dispatchAlert } = require('./src/alerts');
const { decryptConfig, encryptConfigValue, isEncrypted, SENSITIVE_KEYS, encryptionEnabled } = require('./src/crypto');

const app = express();
const PORT = process.env.PORT || 3000;

/* ── Log capture ── */
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
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
try { fs.mkdirSync(path.join(__dirname, 'credentials'), { recursive: true }); } catch {}
const AUTH_PATH  = path.join(__dirname, 'credentials', 'auth.yaml');

/* ── Auth ── */
const SESSIONS_PATH = path.join(__dirname, 'credentials', 'sessions.yaml');
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
  if (!auth) return next();
  const token = req.headers['x-session-token'] || req.cookies?.session;
  if (token && sessions.has(token) && Date.now() < sessions.get(token).expires) return next();
  if (config.publicStatus && (req.path === '/status' || req.path === '/api/public/status')) return next();
  if (req.path === '/login' || req.path === '/api/login') return next();
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

/* ── Config ── */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn('config.yaml not found — starting with empty config.');
    return {};
  }
  let text = fs.readFileSync(CONFIG_PATH, 'utf8');
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, name, def) => {
    const v = process.env[name];
    return v !== undefined ? v : (def !== undefined ? def : m);
  });
  const raw = yaml.load(text) || {};
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

/* ── Data refresh ── */
let cache = { data: null };
let refreshPromise = null;

async function fetchAllData() {
  const [proxmox, linux, kubernetes, synology, healthchecks, docker] = await Promise.allSettled([
    config.proxmox     ? getAllProxmoxData(config.proxmox)         : Promise.resolve({ clusterSummary: null, nodes: [] }),
    config.linux       ? getAllLinuxData(config.linux)             : Promise.resolve([]),
    config.kubernetes  ? getAllKubernetesData(config.kubernetes)   : Promise.resolve({ online: false }),
    config.snmp        ? getAllSynologyData(config.snmp)           : Promise.resolve([]),
    config.healthchecks? getAllHealthchecks(config.healthchecks)   : Promise.resolve(null),
    config.docker      ? getAllDockerData(config.docker)           : Promise.resolve([]),
  ]);

  return {
    timestamp: new Date().toISOString(),
    proxmox:      proxmox.value      || { clusterSummary: null, nodes: [] },
    linux:        linux.value        || [],
    kubernetes:   kubernetes.value   || { online: false },
    snmp:         synology.value     || [],
    healthchecks: healthchecks.value || null,
    docker:       docker.value       || [],
  };
}

function extractChecks(data) {
  const m = new Map();
  const add = (key, ok, label, detail) => m.set(key, { ok, label, detail });
  (data.proxmox?.nodes || []).forEach(n => {
    const nm = n.node?.name || n.name || 'node';
    add('px:' + nm, !!n.node?.online, 'Proxmox node ' + nm, 'offline');
  });
  (data.linux || []).forEach(l => {
    add('lx:' + l.name, !!l.online, 'Server ' + l.name, 'unreachable');
    if (l.online) (l.services || []).forEach(s => add('lx:' + l.name + ':' + s.name, !!s.active, l.name + ' / ' + s.name, 'inactive'));
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
  refreshPromise = fetchAllData()
    .then(data => { cache.data = data; runAlertChecks(data); })
    .catch(err => console.error('Refresh error:', err.message))
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

const EMPTY = {
  loading: true,
  proxmox: { clusterSummary: null, nodes: [] },
  linux: [],
  kubernetes: { online: false },
  snmp: [],
  healthchecks: null,
  docker: [],
};

function getCachedData() {
  if (!cache.data) {
    backgroundRefresh();
    return Promise.resolve({ ...EMPTY, timestamp: new Date().toISOString() });
  }
  return Promise.resolve(cache.data);
}

backgroundRefresh();
setInterval(backgroundRefresh, REFRESH_INTERVAL);

/* ── Middleware ── */
app.use(express.json());
app.use(parseCookies);
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ── Auth routes ── */
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

/* ── Data routes ── */
app.get('/api/status', async (req, res) => {
  try { res.json(await getCachedData()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/refresh', async (req, res) => {
  try {
    cache.data = null;
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
    const existing = fs.existsSync(CONFIG_PATH)
      ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}
      : {};
    const merged = mergePreservingSecrets(incoming, existing);
    const toSave = encryptionEnabled() ? encryptConfigObj(merged) : merged;
    fs.writeFileSync(CONFIG_PATH, yaml.dump(toSave, { lineWidth: -1 }), 'utf8');
    config = encryptionEnabled() ? decryptConfig(toSave) : toSave;
    cache.data = null;
    backgroundRefresh();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

/* ── Debug routes ── */
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
    out.push({ id: 'proxmox', title: 'Proxmox', status: online === nodes.length ? 'ok' : online > 0 ? 'warn' : 'down', meta: `${online}/${nodes.length} nodes online` });
  }
  if ((data.linux || []).length) {
    const up = data.linux.filter(l => l.online).length;
    const svcTotal = data.linux.reduce((a, l) => a + (l.services || []).length, 0);
    const svcUp = data.linux.reduce((a, l) => a + (l.services || []).filter(x => x.active).length, 0);
    out.push({ id: 'linux', title: 'Linux Servers', status: (up === data.linux.length && svcUp === svcTotal) ? 'ok' : up > 0 ? 'warn' : 'down', meta: `${up}/${data.linux.length} servers, ${svcUp}/${svcTotal} services` });
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
  return out;
}

app.get('/api/public/status', (req, res) => {
  if (!config.publicStatus) return res.status(404).json({ error: 'public status not enabled' });
  const data = cache.data || EMPTY;
  res.json({
    title: config.publicTitle || 'OmniSight Status',
    timestamp: data.timestamp || new Date().toISOString(),
    services: buildPublicSummary(data),
  });
});

app.get('/api/about', (req, res) => {
  let version = '1.0.0', author = 'caglaryalcin';
  try { const pkg = require('./package.json'); version = pkg.version; author = pkg.author || author; } catch {}
  res.json({ name: 'OmniSight', version, author });
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

/* \u2500\u2500 Log routes \u2500\u2500 */
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
