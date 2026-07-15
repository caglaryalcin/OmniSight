const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const DEMO_SESSION_COOKIE = 'omnisight_demo_session';
const DEMO_USERNAME = String(process.env.OMNISIGHT_DEMO_USER || 'demo').trim() || 'demo';
const DEMO_PASSWORD = String(process.env.OMNISIGHT_DEMO_PASSWORD || 'demo') || 'demo';
const DEMO_DEFAULT_CREDENTIALS = DEMO_USERNAME === 'demo' && DEMO_PASSWORD === 'demo';

app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

function demoAppVersion() {
  try { return require('./package.json').version || '1.0.0'; }
  catch { return '1.0.0'; }
}
function demoVersionedStaticRequest(req) {
  const raw = String(req?.query?.v || '').trim();
  return raw && raw === demoAppVersion();
}
function setDemoStaticCacheHeaders(res, filePath = '', req = null) {
  if (String(filePath).endsWith('sw.js')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return;
  }
  if (/\.html$/i.test(filePath)) {
    if (demoVersionedStaticRequest(req)) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    return;
  }
  if (/\.(js|css)$/i.test(filePath)) {
    if (demoVersionedStaticRequest(req)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    return;
  }
  if (/\.(svg|png|webp|jpg|jpeg|ico|webmanifest)$/i.test(filePath)) {
    if (demoVersionedStaticRequest(req)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  }
}
const DEMO_PUBLIC_DIR = path.join(__dirname, 'public');
const DEMO_GZIP_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);
const demoGzipCache = new Map();
const demoHtmlCache = new Map();
function injectDemoRuntimeConstants(html) {
  return String(html).replace(/__OMNISIGHT_VERSION_JSON__/g, JSON.stringify(demoAppVersion()));
}
function injectDemoAssetVersion(html) {
  const v = encodeURIComponent(demoAppVersion());
  return String(html)
    .replace(/(<script\b[^>]*\bsrc=["'])\/i18n\.js(["'][^>]*>)/gi, `$1/i18n.js?v=${v}$2`)
    .replace(/(["'])\/assets\/omnisight-logo\.svg(\?v=[^"']*)?(["'])/gi, `$1/assets/omnisight-logo.svg?v=${v}$3`);
}
function renderDemoHtml(filePath, stat = null) {
  const cacheKey = stat ? `${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}:${demoAppVersion()}` : '';
  if (cacheKey) {
    const cached = demoHtmlCache.get(cacheKey);
    if (cached) return cached;
  }
  const html = injectDemoRuntimeConstants(injectDemoAssetVersion(fs.readFileSync(filePath, 'utf8')));
  if (cacheKey) {
    if (demoHtmlCache.size > 16) demoHtmlCache.delete(demoHtmlCache.keys().next().value);
    demoHtmlCache.set(cacheKey, html);
  }
  return html;
}
function demoPublicCandidate(reqPath) {
  let pathname = String(reqPath || '/').split('?')[0] || '/';
  try { pathname = decodeURIComponent(pathname); } catch { return null; }
  if (pathname.includes('\0')) return null;
  let rel = pathname === '/' ? 'index.html' : pathname === '/login' ? 'login.html' : pathname.replace(/^\/+/, '');
  if (!path.extname(rel)) rel += '.html';
  const filePath = path.resolve(DEMO_PUBLIC_DIR, rel);
  if (!filePath.startsWith(path.resolve(DEMO_PUBLIC_DIR) + path.sep)) return null;
  return filePath;
}
function compressedDemoStatic(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.headers.range) return next();
  const filePath = demoPublicCandidate(req.path);
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';
  if (!filePath || !DEMO_GZIP_TYPES.has(ext)) return next();
  const acceptsGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
  if (ext !== '.html' && !acceptsGzip) return next();
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return next();
  } catch { return next(); }
  if (ext === '.html') {
    let html;
    try { html = renderDemoHtml(filePath, stat); }
    catch { return next(); }
    const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}-${demoAppVersion()}-html"`;
    setDemoStaticCacheHeaders(res, filePath, req);
    res.setHeader('Content-Type', DEMO_GZIP_TYPES.get(ext));
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    if (acceptsGzip) {
      try {
        const cacheKey = `html-gzip:${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}:${demoAppVersion()}`;
        let gz = demoGzipCache.get(cacheKey);
        if (!gz) {
          gz = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 1 });
          if (demoGzipCache.size > 32) demoGzipCache.delete(demoGzipCache.keys().next().value);
          demoGzipCache.set(cacheKey, gz);
        }
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', gz.length);
        if (req.method === 'HEAD') return res.end();
        return res.end(gz);
      } catch {}
    }
    res.setHeader('Content-Length', Buffer.byteLength(html));
    if (req.method === 'HEAD') return res.end();
    return res.send(html);
  }
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}-gzip"`;
  setDemoStaticCacheHeaders(res, filePath, req);
  res.setHeader('Content-Type', DEMO_GZIP_TYPES.get(ext));
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  const cacheKey = `${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  let gz = demoGzipCache.get(cacheKey);
  if (!gz) {
    try { gz = zlib.gzipSync(fs.readFileSync(filePath), { level: 6 }); }
    catch { return next(); }
    if (demoGzipCache.size > 32) demoGzipCache.delete(demoGzipCache.keys().next().value);
    demoGzipCache.set(cacheKey, gz);
  }
  res.setHeader('Content-Length', gz.length);
  if (req.method === 'HEAD') return res.end();
  return res.end(gz);
}

const demoUser = {
  id: 'demo-user',
  username: DEMO_USERNAME,
  email: 'demo@example.invalid',
  role: 'admin',
  disabled: false,
  twoFactorEnabled: false,
};
const demoSessions = new Map();
const DEMO_PLATFORM_IDS = ['proxmox', 'kubernetes', 'linux', 'windows', 'synology', 'mikrotik', 'unifi', 'healthchecks', 'uptimekuma', 'checks', 'prometheus', 'docker', 'dockhand', 'firewall', 'truenas', 'qnap', 'ugreen', 'pbs', 'cloudflare', 'cicd', 'veeam', 'portainer', 'database'];
const DEMO_OVERVIEW_COLLAPSED = Object.fromEntries(DEMO_PLATFORM_IDS.map(id => [id, true]));

let demoTopology = {
  links: [
    { from: 'proxmox-guest:px-demo-01:101', to: 'kubernetes:cluster' },
    { from: 'proxmox-guest:px-demo-01:102', to: 'kubernetes:cluster' },
    { from: 'proxmox-guest:px-demo-02:201', to: 'kubernetes:cluster' },
    { from: 'proxmox-guest:px-demo-02:202', to: 'kubernetes:cluster' },
    { from: 'proxmox-guest:px-demo-03:301', to: 'kubernetes:cluster' },
    { from: 'proxmox-guest:px-demo-03:302', to: 'kubernetes:cluster' },
    { from: 'snmp:core-switch', to: 'proxmox-host:px-demo-01' },
    { from: 'snmp:core-switch', to: 'proxmox-host:px-demo-02' },
    { from: 'snmp:core-switch', to: 'proxmox-host:px-demo-03' },
    { from: 'snmp:core-switch', to: 'snmp:demo-nas' },
    { from: 'snmp:core-switch', to: 'snmp:demo-ap' },
    { from: 'snmp:core-switch', to: 'docker:demo-docker' },
    { from: 'snmp:core-switch', to: 'dockhand:dockhand-demo' },
    { from: 'docker:demo-docker', to: 'dockhand:dockhand-demo' },
  ],
  nodes: ['kubernetes:cluster', 'docker:demo-docker', 'dockhand:dockhand-demo', 'snmp:core-switch', 'snmp:demo-nas', 'snmp:demo-ap'],
  hidden: [],
  spacing: { proxmoxVmGap: 180 },
  positions: {
    'snmp:core-switch': { x: 700, y: 90 },
    'proxmox-host:px-demo-01': { x: 300, y: 250 },
    'proxmox-host:px-demo-02': { x: 700, y: 250 },
    'proxmox-host:px-demo-03': { x: 1100, y: 250 },
    'proxmox-guest:px-demo-01:101': { x: 185, y: 430 },
    'proxmox-guest:px-demo-01:102': { x: 415, y: 430 },
    'proxmox-guest:px-demo-02:201': { x: 585, y: 430 },
    'proxmox-guest:px-demo-02:202': { x: 815, y: 430 },
    'proxmox-guest:px-demo-03:301': { x: 985, y: 430 },
    'proxmox-guest:px-demo-03:302': { x: 1215, y: 430 },
    'kubernetes:cluster': { x: 700, y: 615 },
    'snmp:demo-nas': { x: 430, y: -23.33333333333333 },
    'snmp:demo-ap': { x: 920, y: -55 },
    'docker:demo-docker': { x: 1122.7777777777778, y: -83.33333333333334 },
    'dockhand:dockhand-demo': { x: 1575, y: 90 },
  },
  view: { scale: 0.9, x: -105, y: 143 },
};

let demoPrefs = {
  uptimekuma: { historyHours: 1 },
  checks: { historyHours: 1 },
  ui: { overviewCardCollapsed: { ...DEMO_OVERVIEW_COLLAPSED } },
  config: {
    preferredLanguage: 'en',
    publicStatus: true,
    publicTitle: 'OmniSight Demo Status',
    publicDescription: 'Isolated demo environment',
    publicStatusShowDetails: true,
    publicStatusShowHistory: true,
    publicPlatforms: [],
    alerts: {
      enabled: true,
      channels: { ntfy: { enabled: true, url: 'https://ntfy.sh', topics: ['omnisight-demo'] } },
      maintenanceWindows: [],
    },
  },
};

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function uptimeSeconds(days = 0, hours = 0, minutes = 0) {
  return (days * 86400) + (hours * 3600) + (minutes * 60);
}

function periodHours(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return clamp(n, 0.333333, 24);
}

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return value; }
}

function demoConfigFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function parseClockMinutes(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function dayMatches(rule, date) {
  const days = rule?.days || rule?.day || rule?.weekdays;
  if (!days || (Array.isArray(days) && !days.length)) return true;
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const cur = names[date.getDay()];
  return (Array.isArray(days) ? days : String(days).split(','))
    .map(d => String(d).trim().slice(0, 3).toLowerCase())
    .includes(cur);
}

function currentDemoMaintenanceWindow(now = Date.now()) {
  const windows = demoPrefs.config?.alerts?.maintenanceWindows || demoPrefs.config?.alerts?.maintenance || [];
  if (!Array.isArray(windows) || !windows.length) return null;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  return windows.find(w => {
    if (!w || w.enabled === false || !dayMatches(w, d)) return false;
    const start = parseClockMinutes(w.start || w.from);
    const end = parseClockMinutes(w.end || w.to);
    if (start == null || end == null) return false;
    return start <= end ? mins >= start && mins <= end : (mins >= start || mins <= end);
  }) || null;
}

function rememberDemoConfig(body = {}) {
  if (!body || typeof body !== 'object') return;
  demoPrefs.config.preferredLanguage = String(body.preferredLanguage || 'en').trim() || 'en';
  demoPrefs.config.publicStatus = body.publicStatus === true;
  demoPrefs.config.publicTitle = String(body.publicTitle || 'OmniSight Demo Status').trim() || 'OmniSight Demo Status';
  demoPrefs.config.publicDescription = String(body.publicDescription || '').trim();
  demoPrefs.config.publicStatusShowDetails = demoConfigFlag(body.publicStatusShowDetails, false);
  demoPrefs.config.publicStatusShowHistory = demoConfigFlag(body.publicStatusShowHistory, false);
  demoPrefs.config.publicPlatforms = Array.isArray(body.publicPlatforms) ? body.publicPlatforms.map(String).filter(Boolean) : [];
  if (body.alerts && typeof body.alerts === 'object') {
    demoPrefs.config.alerts = cloneJson(body.alerts);
  }
  if (body.uptimekuma && typeof body.uptimekuma === 'object' && body.uptimekuma.historyHours != null) {
    demoPrefs.uptimekuma.historyHours = periodHours(body.uptimekuma.historyHours);
  }
  if (body.checks && typeof body.checks === 'object' && body.checks.historyHours != null) {
    demoPrefs.checks.historyHours = periodHours(body.checks.historyHours);
  }
  if (body.ui && typeof body.ui === 'object') {
    demoPrefs.ui = { ...demoPrefs.ui, ...body.ui };
  }
}

function historyPointCount(hours, min = 120) {
  return Math.max(min, Math.ceil(periodHours(hours) * 60) + 12);
}

function seededNoise(seed, i, salt = 0) {
  const x = Math.sin((i + 1) * 12.9898 + seed * 78.233 + salt * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

function history(points = 80, seed = 30, spread = 8, extra = {}) {
  const out = [];
  const now = Date.now();
  const { rxBase, txBase, readBase, writeBase, ...pointExtra } = extra || {};
  const rx = rxBase || (900_000 + seed * 63_000);
  const tx = txBase || (420_000 + seed * 35_000);
  const read = readBase || (180_000 + seed * 24_000);
  const write = writeBase || (120_000 + seed * 18_000);
  let cpuWalk = seed;
  let memWalk = seed + spread;
  let ioWalk = 1;
  for (let i = points - 1; i >= 0; i -= 1) {
    const age = points - i;
    const dayCurve = Math.sin((age / points) * Math.PI);
    const minuteCurve = Math.sin(age / 8 + seed * 0.21);
    const cpuSpike = age % 29 === 0 ? spread * (0.9 + seededNoise(seed, age, 1.7)) : 0;
    const ioSpike = age % 34 === 0 || age % 53 === 0 ? 1.2 + seededNoise(seed, age, 2.1) : 0;
    cpuWalk = cpuWalk * 0.92 + (seed + dayCurve * spread * 1.1 + (seededNoise(seed, age, 0.2) - 0.5) * spread * 1.8) * 0.08;
    memWalk = memWalk * 0.96 + (seed + spread + dayCurve * spread * 0.55 + (seededNoise(seed, age, 0.8) - 0.5) * spread * 0.8) * 0.04;
    ioWalk = ioWalk * 0.88 + (0.65 + dayCurve * 0.55 + Math.max(0, minuteCurve) * 0.45 + seededNoise(seed, age, 1.2) * 0.45 + ioSpike) * 0.12;
    const cpu = clamp(cpuWalk + cpuSpike + Math.sin(age / 3.3 + seed) * spread * 0.18, 1, 98);
    const mem = clamp(memWalk + Math.sin(age / 21 + seed) * spread * 0.16, 1, 98);
    const disk = clamp(35 + seed * 0.22 + dayCurve * 2.2 + Math.sin(age / 19 + seed) * 1.6 + (seededNoise(seed, age, 3) - 0.5) * 1.1, 1, 98);
    const temp = 39 + seed * 0.2 + cpu * 0.08 + Math.sin(age / 11 + seed) * 1.6 + (seededNoise(seed, age, 4) - 0.5) * 1.8;
    const trafficPulse = clamp(ioWalk + Math.max(0, Math.sin(age / 7 + seed)) * 0.25, 0.15, 4.6);
    const diskPulse = clamp(ioWalk * 0.8 + Math.max(0, Math.cos(age / 9 + seed)) * 0.35, 0.1, 4.2);
    const bandwidthRxBps = Math.max(0, Math.round(rx * trafficPulse * (0.9 + seededNoise(seed, age, 5) * 0.24)));
    const bandwidthTxBps = Math.max(0, Math.round(tx * (trafficPulse * 0.7 + 0.22) * (0.88 + seededNoise(seed, age, 6) * 0.25)));
    const diskReadBps = Math.max(0, Math.round(read * diskPulse * (0.85 + seededNoise(seed, age, 7) * 0.35)));
    const diskWriteBps = Math.max(0, Math.round(write * (diskPulse * 0.78 + 0.18) * (0.82 + seededNoise(seed, age, 8) * 0.4)));
    out.push({
      time: now - i * 15000,
      cpu: Number(cpu.toFixed(1)),
      mem: Number(mem.toFixed(1)),
      ram: Number(mem.toFixed(1)),
      disk: Number(disk.toFixed(1)),
      temp: Number(temp.toFixed(1)),
      tempCpu: Number((temp + 1.2 + Math.sin(age / 7) * 1.6).toFixed(1)),
      tempNvme: Number((temp - 3.5 + Math.cos(age / 6) * 1.8).toFixed(1)),
      tempNvmeBackup: Number((temp - 1.1 + Math.sin(age / 10) * 1.4).toFixed(1)),
      tempSystem: Number((temp + 3.1 + Math.sin(age / 15) * 1.2).toFixed(1)),
      bandwidthRxBps,
      bandwidthTxBps,
      diskReadBps,
      diskWriteBps,
      diskIO: diskReadBps + diskWriteBps,
      bandwidth: bandwidthRxBps + bandwidthTxBps,
      ...pointExtra,
    });
  }
  return out;
}

function uptimeHistory(status = 'up', count = 120, seed = 1) {
  return Array.from({ length: count }, (_, i) => ({
    status,
    time: nowIso(-(count - i) * 60000),
    ping: status === 'up' ? 3 + ((i + seed) % 8) : null,
    message: status === 'down' ? 'Demo endpoint is intentionally down' : '',
  }));
}

function mixedUptimeHistory(count = 120, seed = 1, tailStatus = 'up') {
  return Array.from({ length: count }, (_, i) => {
    const pulse = seededNoise(seed, i, 24);
    const recent = i > count - 16;
    const degraded = !recent && (i % 43 === 0 || pulse > 0.985);
    const status = recent ? tailStatus : degraded ? 'down' : 'up';
    return {
      status,
      time: nowIso(-(count - i) * 60000),
      ping: status === 'up' ? Math.round(4 + seededNoise(seed, i, 25) * 16) : null,
      message: status === 'down' ? 'Brief demo outage recovered automatically' : '',
    };
  });
}

function demoLogStream(kind, name = 'demo-workload') {
  const safeName = String(name || 'demo-workload').replace(/[^\w.-]+/g, '-').slice(0, 64);
  const seed = safeName.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), kind.length);
  const levels = ['INFO', 'DEBUG', 'INFO', 'WARN', 'INFO', 'ERROR', 'INFO', 'NOTICE', 'DEBUG', 'INFO'];
  const dockerMessages = [
    `container="${safeName}" worker started on 10.10.4.21:8080`,
    'loaded config file="/etc/omnisight/demo.yaml" mode="readonly"',
    'HTTP probe completed status=200 latency=18ms path="/health"',
    'cache refresh took 426ms, using stale-safe fallback=false',
    'queue depth=12 processed=48 failed=0',
    'upstream retry triggered err="ECONNRESET" target=192.0.2.44:5432 attempt=1',
    '{"event":"metrics.flush","cpu":12.7,"memory":33.4,"disk_io":"1.8 MB/s"}',
    'image status current digest="sha256:7f8b2c9a0f1d" checked=true',
    'open file descriptors=42 goroutines=18',
    'graceful tick completed nextRun="15s"',
  ];
  const k8sMessages = [
    `pod="${safeName}" namespace="apps" container="api" ready=true`,
    'mounted secret "demo-api-token" at /var/run/secrets/omnisight',
    'GET /api/status 200 23ms client=10.244.3.18',
    'liveness probe jitter detected delta=4ms threshold=30ms',
    'processed batch size=64 duration=312ms',
    'transient database timeout err="context deadline exceeded" retry=1',
    '{"event":"kubernetes.reconcile","pods":12,"deployments":4,"services":5}',
    'config map reload completed version=demo-2026-06-20',
    'memory watermark=284MB cpu=18.4m restarts=0',
    'stream closed cleanly reason="client disconnected"',
  ];
  const messages = kind === 'kubernetes' ? k8sMessages : dockerMessages;
  return Array.from({ length: 48 }, (_, i) => {
    const level = levels[(i + seed) % levels.length];
    const msg = messages[(i + Math.floor(seed / 3)) % messages.length];
    const offset = -(48 - i) * 45000;
    const trace = level === 'ERROR'
      ? `\n    at demo.${kind}.collector (${kind}/collector.js:${80 + (i % 37)}:${12 + (i % 9)})\n    at async refreshDemoSnapshot (${kind}/runtime.js:${120 + (i % 29)}:${4 + (i % 5)})`
      : '';
    return `${nowIso(offset)} ${level} [${kind}] ${msg}${trace}`;
  }).join('\n');
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return ['', ''];
    return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
  }).filter(([k]) => k));
}

function demoToken(req) {
  return req.headers['x-session-token'] || parseCookies(req)[DEMO_SESSION_COOKIE] || '';
}

function demoRequestIsHttps(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return req.secure || forwardedProto === 'https' || String(req.headers['x-forwarded-ssl'] || '').toLowerCase() === 'on' || process.env.OMNISIGHT_DEMO_COOKIE_SECURE === '1';
}

function demoSessionCookie(value, maxAge, req) {
  const secure = demoRequestIsHttps(req) ? '; Secure' : '';
  return `${DEMO_SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function demoAuthenticated(req) {
  const token = demoToken(req);
  const session = token ? demoSessions.get(token) : null;
  if (!session || session.expires <= Date.now()) {
    if (token) demoSessions.delete(token);
    return false;
  }
  return true;
}

function isDemoStaticAssetPath(pathname) {
  return /\.(?:js|css|svg|png|webp|jpe?g|ico|webmanifest|woff2?|ttf|map)$/i.test(String(pathname || ''));
}

function requireDemoPageAuth(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const pathname = String(req.path || '/');
  if (
    pathname.startsWith('/api/')
    || pathname.startsWith('/assets/')
    || pathname === '/login'
    || pathname === '/status'
    || pathname === '/sw.js'
    || pathname === '/favicon.ico'
    || isDemoStaticAssetPath(pathname)
  ) return next();
  if (demoAuthenticated(req)) return next();
  return res.redirect(302, '/login');
}

function setDemoSession(req, res, remember = false) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + (remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
  demoSessions.set(token, { username: demoUser.username, role: demoUser.role, created: Date.now(), expires });
  const maxAge = Math.max(1, Math.floor((expires - Date.now()) / 1000));
  res.setHeader('Set-Cookie', demoSessionCookie(encodeURIComponent(token), maxAge, req));
  return token;
}

function demoConfig() {
  const cfg = demoPrefs.config || {};
  return {
    timezone: 'Europe/Istanbul',
    timeFormat: '24h',
    defaultTimePeriodHours: 1,
    historyRetentionDays: 1,
    preferredLanguage: cfg.preferredLanguage || 'en',
    publicStatus: cfg.publicStatus !== false,
    publicTitle: cfg.publicTitle || 'OmniSight Demo Status',
    publicDescription: cfg.publicDescription || '',
    publicStatusShowDetails: cfg.publicStatusShowDetails === true,
    publicStatusShowHistory: cfg.publicStatusShowHistory === true,
    publicPlatforms: Array.isArray(cfg.publicPlatforms) ? [...cfg.publicPlatforms] : [],
    appearance: { dashboardSidePanel: false },
    performance: { lowIoMode: true },
    security: { passwordResetEnabled: true },
    proxmox: { enabled: true, url: 'https://192.0.2.10:8006', tokenId: '__demo__', tokenSecret: '__demo__', tls: 'verify', sshMetrics: [] },
    linux: { enabled: true, agentToken: '__demo_agent_token__' },
    windows: { enabled: true, icon: 'windows' },
    kubernetes: { enabled: true, kubeconfig: '__demo_kubeconfig__' },
    snmp: { enabled: true, devices: [
      { name: 'core-switch', host: '192.0.2.2', profile: 'mikrotik', method: 'snmp', community: 'public' },
      { name: 'demo-ap', host: '192.0.2.3', profile: 'unifi', method: 'snmp', community: 'public' },
      { name: 'demo-nas', host: '192.0.2.20', profile: 'synology', method: 'snmp', community: 'public' },
    ] },
    healthchecks: { enabled: true, url: 'https://healthchecks.example.invalid' },
    uptimekuma: { enabled: true, url: 'https://kuma.example.invalid', historyHours: demoPrefs.uptimekuma.historyHours },
    checks: { enabled: true, historyHours: demoPrefs.checks.historyHours, services: [{ name: 'demo website', type: 'http', target: 'https://example.invalid' }] },
    prometheus: { enabled: true, instances: [{ name: 'prometheus-demo', url: 'https://prometheus.example.invalid' }] },
    docker: { enabled: true, hosts: [{ type: 'ssh', name: 'demo-docker', host: '192.0.2.30', port: 22 }] },
    dockhand: { enabled: true, instances: [{ name: 'dockhand-demo', url: 'https://dockhand.example.invalid' }] },
    firewall: { enabled: true, instances: [{ name: 'edge-opnsense', type: 'opnsense', url: 'https://firewall.example.invalid', apiKey: '__demo__', apiSecret: '__demo__' }] },
    truenas: { enabled: true, instances: [{ name: 'truenas-demo', url: 'https://truenas.example.invalid', apiMode: 'auto', method: 'auto', apiKey: '__demo__' }] },
    qnap: { enabled: true, instances: [{ name: 'qnap-demo', url: 'https://qnap.example.invalid', method: 'qts-api', username: 'monitoring', password: '__demo__' }] },
    ugreen: { enabled: true, instances: [{ name: 'ugreen-demo', url: 'https://ugreen.example.invalid', method: 'web' }] },
    pbs: { enabled: true, instances: [{ name: 'pbs-demo', url: 'https://pbs.example.invalid:8007', tokenId: 'root@pam!monitoring', tokenSecret: '__demo__' }] },
    cloudflare: { enabled: true, apiToken: '__demo__', accountId: 'demo-account', zones: ['example.com', 'internal.example.com'], includeTunnels: true, includeRegistrarDomains: true },
    cicd: { enabled: true, projects: [{ name: 'OmniSight', provider: 'github', owner: 'caglaryalcin', repo: 'OmniSight', branch: 'main', token: '__demo__' }, { name: 'infra-playbooks', provider: 'gitlab', projectId: 'ops/infra-playbooks', branch: 'main', token: '__demo__' }] },
    veeam: { enabled: true, instances: [{ name: 'veeam-demo', url: 'https://veeam.example.invalid:9419', username: 'DOMAIN\\monitoring', password: '__demo__', apiVersion: '1.3-rev1' }] },
    portainer: { enabled: true, instances: [{ name: 'portainer-demo', url: 'https://portainer.example.invalid:9443', apiKey: '__demo__' }] },
    database: { enabled: true, instances: [{ name: 'demo-postgres', type: 'postgresql', host: '192.0.2.40', port: 5432 }] },
    alerts: cloneJson(cfg.alerts || {
      enabled: true,
      channels: { ntfy: { enabled: true, url: 'https://ntfy.sh', topics: ['omnisight-demo'] } },
      maintenanceWindows: [],
    }),
    topology: { ...demoTopology },
    ui: demoPrefs.ui,
  };
}

function demoStatus() {
  const cfg = demoPrefs.config || {};
  const uptimeKumaHours = periodHours(demoPrefs.uptimekuma.historyHours);
  const checksHours = periodHours(demoPrefs.checks.historyHours);
  const uptimeKumaPoints = historyPointCount(uptimeKumaHours);
  const checksPoints = historyPointCount(checksHours);
  const h1 = history(96, 18, 5, { rxBase: 2_200_000, txBase: 1_100_000, readBase: 700_000, writeBase: 480_000 });
  const h2 = history(96, 32, 7, { rxBase: 1_800_000, txBase: 820_000, readBase: 520_000, writeBase: 390_000 });
  const h3 = history(96, 24, 4, { rxBase: 780_000, txBase: 260_000, readBase: 260_000, writeBase: 150_000 });
  const h4 = history(96, 31, 8, { rxBase: 1_100_000, txBase: 430_000, readBase: 360_000, writeBase: 210_000 });
  const h5 = history(96, 27, 6, { rxBase: 1_450_000, txBase: 610_000, readBase: 460_000, writeBase: 290_000 });
  const hDocker = history(96, 22, 5, { rxBase: 1_600_000, txBase: 680_000, readBase: 500_000, writeBase: 340_000 });
  const h1Now = h1[h1.length - 1] || {};
  const h2Now = h2[h2.length - 1] || {};
  const h3Now = h3[h3.length - 1] || {};
  const h4Now = h4[h4.length - 1] || {};
  const h5Now = h5[h5.length - 1] || {};
  const hDockerNow = hDocker[hDocker.length - 1] || {};
  const pxCpu = Number((((h1Now.cpu || 0) + (h2Now.cpu || 0) + (h5Now.cpu || 0)) / 3).toFixed(1));
  const pxMem = Number((((h1Now.mem || 0) + (h2Now.mem || 0) + (h5Now.mem || 0)) / 3).toFixed(1));
  const data = {
    timestamp: nowIso(),
    loading: false,
    refreshing: false,
    publicStatus: cfg.publicStatus !== false,
    configured: ['proxmox', 'linux', 'windows', 'kubernetes', 'synology', 'mikrotik', 'unifi', 'healthchecks', 'uptimekuma', 'checks', 'prometheus', 'docker', 'dockhand', 'firewall', 'truenas', 'qnap', 'ugreen', 'pbs', 'cloudflare', 'cicd', 'veeam', 'portainer', 'database'],
    preferredLanguage: cfg.preferredLanguage || 'en',
    timeFormat: '24h',
    defaultTimePeriodHours: 1,
    historyRetentionDays: 1,
    performance: { lowIoMode: true },
    appearance: { dashboardSidePanel: false },
    ui: demoPrefs.ui,
    notifyDisabled: [],
    notifyTopics: {},
    ntfyTopics: ['omnisight-demo', 'ops-demo'],
    alertMutes: {},
    topologyLinks: demoTopology.links,
    topologyNodes: demoTopology.nodes,
    topologyHidden: demoTopology.hidden,
    topologySpacing: demoTopology.spacing,
    topologyPositions: demoTopology.positions,
    topologyView: demoTopology.view,
    icons: {},
  };

  data.proxmox = {
    clusterSummary: {
      nodes: 3,
      totalNodes: 3,
      nodesOnline: 3,
      online: 3,
      totalVms: 6,
      runningVms: 6,
      stoppedVms: 0,
      totalCores: 48,
      usedCores: Number(((pxCpu / 100) * 48).toFixed(1)),
      totalRAM: 192 * 1024 ** 3,
      usedRAM: Math.round((pxMem / 100) * 192 * 1024 ** 3),
      cpu: pxCpu,
      memPct: pxMem,
    },
    ceph: {
      health: 'HEALTH_OK',
      checks: [],
      osd: { total: 6, up: 6, in: 6 },
      usage: { usedBytes: 18.4 * 1024 ** 4, totalBytes: 48 * 1024 ** 4, availBytes: 29.6 * 1024 ** 4, percent: 38.3 },
    },
    nodes: [
      {
        name: 'px-demo-01',
        host: '192.0.2.10:8006',
        online: true,
        node: {
          name: 'px-demo-01',
          online: true,
          cpu: h1Now.cpu || 18,
          memPct: h1Now.mem || 52,
          ram: { percent: h1Now.mem || 52, usedGB: '33.3', totalGB: '64' },
          maxcpu: 16,
          uptime: uptimeSeconds(18, 4, 12),
          temps: [
            { label: 'CPU temp', value: h1Now.tempCpu || 49, historyKey: 'tempCpu' },
            { label: 'NVMe Samsung 980 PRO temp', value: h1Now.tempNvme || 44, historyKey: 'tempNvme' },
            { label: 'NVMe WD Red SN700 temp', value: h1Now.tempNvmeBackup || 47, historyKey: 'tempNvmeBackup' },
            { label: 'System temp', value: h1Now.tempSystem || 52, historyKey: 'tempSystem' },
          ],
        },
        metrics: {
          bandwidth: { rxBps: h1Now.bandwidthRxBps || 2_900_000, txBps: h1Now.bandwidthTxBps || 1_800_000 },
          diskIO: { readBps: h1Now.diskReadBps || 940_000, writeBps: h1Now.diskWriteBps || 720_000 },
          smart: [
            { device: 'nvme0n1', health: 'PASSED', ok: true, model: 'Samsung 980 PRO', serial: 'S6Demo001', firmware: '5B2QGXA7', temperature: h1Now.tempNvme || 44, powerOnHours: 12842, percentageUsed: 7, mediaErrors: 0 },
            { device: 'nvme1n1', health: 'PASSED', ok: true, model: 'WD Red SN700', serial: 'WDDemo002', firmware: '111130WD', temperature: h1Now.tempNvmeBackup || 47, powerOnHours: 9844, percentageUsed: 11, mediaErrors: 0 },
          ],
        },
        history: h1,
        vms: [
          { id: 101, name: 'k8s-control-01', type: 'vm', status: 'running', running: true, os: 'debian' },
          { id: 102, name: 'k8s-worker-01', type: 'vm', status: 'running', running: true, os: 'debian' },
        ],
        services: [],
      },
      {
        name: 'px-demo-02',
        host: '192.0.2.11:8006',
        online: true,
        node: {
          name: 'px-demo-02',
          online: true,
          cpu: h2Now.cpu || 24,
          memPct: h2Now.mem || 57,
          ram: { percent: h2Now.mem || 57, usedGB: '35.8', totalGB: '64' },
          maxcpu: 16,
          uptime: uptimeSeconds(18, 3, 44),
          temps: [
            { label: 'CPU temp', value: h2Now.tempCpu || 51, historyKey: 'tempCpu' },
            { label: 'NVMe Kingston KC3000 temp', value: h2Now.tempNvme || 46, historyKey: 'tempNvme' },
            { label: 'NVMe Crucial P5 Plus temp', value: h2Now.tempNvmeBackup || 48, historyKey: 'tempNvmeBackup' },
            { label: 'System temp', value: h2Now.tempSystem || 53, historyKey: 'tempSystem' },
          ],
        },
        metrics: {
          bandwidth: { rxBps: h2Now.bandwidthRxBps || 2_100_000, txBps: h2Now.bandwidthTxBps || 1_100_000 },
          diskIO: { readBps: h2Now.diskReadBps || 720_000, writeBps: h2Now.diskWriteBps || 530_000 },
          smart: [
            { device: 'nvme0n1', health: 'PASSED', ok: true, model: 'Kingston KC3000', serial: 'KCDemo001', firmware: 'EIFK31.6', temperature: h2Now.tempNvme || 46, powerOnHours: 15110, percentageUsed: 9, mediaErrors: 0 },
            { device: 'nvme1n1', health: 'PASSED', ok: true, model: 'Crucial P5 Plus', serial: 'CTDemo002', firmware: 'P7CR403', temperature: h2Now.tempNvmeBackup || 48, powerOnHours: 8120, percentageUsed: 6, mediaErrors: 0 },
          ],
        },
        history: h2,
        vms: [
          { id: 201, name: 'k8s-control-02', type: 'vm', status: 'running', running: true, os: 'debian' },
          { id: 202, name: 'k8s-worker-02', type: 'vm', status: 'running', running: true, os: 'debian' },
        ],
        services: [],
      },
      {
        name: 'px-demo-03',
        host: '192.0.2.12:8006',
        online: true,
        node: {
          name: 'px-demo-03',
          online: true,
          cpu: h5Now.cpu || 21,
          memPct: h5Now.mem || 48,
          ram: { percent: h5Now.mem || 48, usedGB: '30.7', totalGB: '64' },
          maxcpu: 16,
          uptime: uptimeSeconds(18, 2, 36),
          temps: [
            { label: 'CPU temp', value: h5Now.tempCpu || 47, historyKey: 'tempCpu' },
            { label: 'NVMe Intel P4510 temp', value: h5Now.tempNvme || 43, historyKey: 'tempNvme' },
            { label: 'NVMe SK hynix P31 temp', value: h5Now.tempNvmeBackup || 45, historyKey: 'tempNvmeBackup' },
            { label: 'System temp', value: h5Now.tempSystem || 50, historyKey: 'tempSystem' },
          ],
        },
        metrics: {
          bandwidth: { rxBps: h5Now.bandwidthRxBps || 1_900_000, txBps: h5Now.bandwidthTxBps || 960_000 },
          diskIO: { readBps: h5Now.diskReadBps || 640_000, writeBps: h5Now.diskWriteBps || 440_000 },
          smart: [
            { device: 'nvme0n1', health: 'PASSED', ok: true, model: 'Intel P4510', serial: 'INTDemo003', firmware: 'VDV10170', temperature: h5Now.tempNvme || 43, powerOnHours: 10420, percentageUsed: 5, mediaErrors: 0 },
            { device: 'nvme1n1', health: 'PASSED', ok: true, model: 'SK hynix P31', serial: 'HYNIXDemo004', firmware: '41062C20', temperature: h5Now.tempNvmeBackup || 45, powerOnHours: 7560, percentageUsed: 4, mediaErrors: 0 },
          ],
        },
        history: h5,
        vms: [
          { id: 301, name: 'k8s-control-03', type: 'vm', status: 'running', running: true, os: 'debian' },
          { id: 302, name: 'k8s-worker-03', type: 'vm', status: 'running', running: true, os: 'debian' },
        ],
        services: [],
      },
    ],
  };

  data.linux = [
    { id: 'linux-demo-01', name: 'demo-linux-01', host: '192.0.2.50', ip: '192.0.2.50', online: true, cpu: h3Now.cpu || 12, ram: { percent: h3Now.mem || 43, used: 3.4, usedGB: 3.4, total: 8, totalGB: 8 }, disk: { percent: h3Now.disk || 46, used: 46, usedGB: 46, total: 100, totalGB: 100 }, temp: h3Now.tempCpu || 43, uptime: uptimeSeconds(9, 2, 18), metrics: { bandwidth: { rxBps: h3Now.bandwidthRxBps || 900_000, txBps: h3Now.bandwidthTxBps || 300_000 }, diskIO: { readBps: h3Now.diskReadBps || 300_000, writeBps: h3Now.diskWriteBps || 180_000 } }, history: h3, services: [
      { name: 'ssh', desc: 'OpenSSH server', active: true },
      { name: 'node-exporter', desc: 'Node exporter', active: true },
    ] },
    { id: 'linux-demo-02', name: 'demo-linux-02', host: '192.0.2.51', ip: '192.0.2.51', online: true, cpu: h4Now.cpu || 31, ram: { percent: h4Now.mem || 61, used: 4.9, usedGB: 4.9, total: 8, totalGB: 8 }, disk: { percent: h4Now.disk || 58, used: 116, usedGB: 116, total: 200, totalGB: 200 }, temp: h4Now.tempCpu || 46, uptime: uptimeSeconds(4, 7, 52), metrics: { bandwidth: { rxBps: h4Now.bandwidthRxBps || 1_200_000, txBps: h4Now.bandwidthTxBps || 500_000 }, diskIO: { readBps: h4Now.diskReadBps || 420_000, writeBps: h4Now.diskWriteBps || 230_000 } }, history: h4, services: [
      { name: 'docker', desc: 'Docker daemon', active: true },
      { name: 'backup.timer', desc: 'Nightly backup timer', active: true },
    ] },
  ];

  data.windows = [
    {
      id: 'windows-demo-01',
      name: 'demo-win-01',
      host: '192.0.2.60',
      ip: '192.0.2.60',
      online: true,
      os: 'Windows Server 2022 Datacenter',
      kernel: '10.0.20348',
      agentVersion: 'demo',
      cpu: h4Now.cpu || 31,
      ram: { percent: h4Now.mem || 61, used: 19.5, usedGB: 19.5, total: 32, totalGB: 32 },
      disk: { percent: h4Now.disk || 58, used: 348, usedGB: 348, total: 600, totalGB: 600 },
      uptime: uptimeSeconds(12, 5, 33),
      metrics: {
        bandwidth: { rxBps: h4Now.bandwidthRxBps || 1_200_000, txBps: h4Now.bandwidthTxBps || 500_000 },
        diskIO: { readBps: h4Now.diskReadBps || 420_000, writeBps: h4Now.diskWriteBps || 230_000 },
      },
      history: h4,
      services: [
        { name: 'WinRM', desc: 'Windows Remote Management', active: true, state: 'running' },
        { name: 'MSSQLSERVER', desc: 'SQL Server', active: true, state: 'running' },
        { name: 'VeeamTransportSvc', desc: 'Veeam transport service', active: true, state: 'running' },
      ],
    },
  ];

  const k8sPods = [
    ['api-demo-7d9f6c-8m2qf', 'apps', 'Running', '18m', '310 MB', 0],
    ['api-demo-7d9f6c-p91xa', 'apps', 'Running', '17m', '298 MB', 0],
    ['worker-demo-66dd9-9lz4k', 'apps', 'Running', '11m', '220 MB', 1],
    ['frontend-demo-5c48d-fq7n2', 'apps', 'Running', '7m', '164 MB', 0],
    ['ingress-nginx-controller-demo', 'default', 'Running', '23m', '286 MB', 0],
    ['redis-demo-0', 'default', 'Running', '4m', '112 MB', 0],
    ['postgres-demo-0', 'default', 'Running', '12m', '512 MB', 0],
    ['prometheus-server-demo', 'monitoring', 'Running', '34m', '744 MB', 0],
    ['grafana-demo-6f5c8', 'monitoring', 'Running', '9m', '256 MB', 0],
    ['node-exporter-demo-2qk1n', 'monitoring', 'Running', '2m', '86 MB', 0],
    ['backup-cron-2861', 'default', 'Succeeded', '0m', '0 MB', 0],
    ['cleanup-cron-2874', 'apps', 'Succeeded', '0m', '0 MB', 0],
  ].map(([name, namespace, phase, cpu, ram, restarts]) => ({
    name,
    namespace,
    phase,
    status: phase,
    running: phase === 'Running',
    ready: phase !== 'Pending' && phase !== 'Failed',
    cpu,
    ram,
    restarts,
    containers: name.includes('api-demo') ? ['api', 'sidecar'] : [name.replace(/-[a-z0-9]+(?:-[a-z0-9]+)?$/i, '') || 'app'],
  }));
  const k8sDeployments = [
    { name: 'api-demo', namespace: 'apps', ready: 2, desired: 2, healthy: true, status: 'Running' },
    { name: 'frontend-demo', namespace: 'apps', ready: 1, desired: 1, healthy: true, status: 'Running' },
    { name: 'prometheus-server', namespace: 'monitoring', ready: 1, desired: 1, healthy: true, status: 'Running' },
    { name: 'ingress-nginx-controller', namespace: 'default', ready: 1, desired: 1, healthy: true, status: 'Running' },
  ];
  const k8sServices = [
    { name: 'api-demo', namespace: 'apps', type: 'ClusterIP', ports: [{ port: 80, protocol: 'TCP' }], clusterIP: '198.51.100.80', status: 'Active' },
    { name: 'frontend-demo', namespace: 'apps', type: 'ClusterIP', ports: [{ port: 8080, protocol: 'TCP' }], clusterIP: '198.51.100.81', status: 'Active' },
    { name: 'prometheus-server', namespace: 'monitoring', type: 'ClusterIP', ports: [{ port: 9090, protocol: 'TCP' }], clusterIP: '198.51.100.82', status: 'Active' },
    { name: 'grafana-demo', namespace: 'monitoring', type: 'ClusterIP', ports: [{ port: 3000, protocol: 'TCP' }], clusterIP: '198.51.100.83', status: 'Active' },
    { name: 'ingress-nginx-controller', namespace: 'default', type: 'LoadBalancer', ports: [{ port: 443, protocol: 'TCP' }], clusterIP: '198.51.100.84', status: 'Active' },
  ];
  const namespaceSummary = Object.values(k8sPods.reduce((acc, pod) => {
    const ns = pod.namespace || 'default';
    acc[ns] ||= { namespace: ns, pods: 0, running: 0, succeeded: 0 };
    acc[ns].pods += 1;
    if (pod.phase === 'Running') acc[ns].running += 1;
    if (pod.phase === 'Succeeded') acc[ns].succeeded += 1;
    return acc;
  }, {}));
  data.kubernetes = {
    online: true,
    summary: {
      total: k8sPods.length,
      pods: k8sPods.length,
      running: k8sPods.filter(p => p.phase === 'Running').length,
      succeeded: k8sPods.filter(p => p.phase === 'Succeeded').length,
      pending: k8sPods.filter(p => p.phase === 'Pending').length,
      failed: k8sPods.filter(p => p.phase === 'Failed').length,
      deployments: k8sDeployments.length,
      services: k8sServices.length,
      namespaces: namespaceSummary.length,
    },
    namespaceSummary,
    pods: k8sPods,
    deployments: k8sDeployments,
    services: k8sServices,
  };

  const hSwitch = history(96, 9, 2, { rxBase: 3_600_000, txBase: 2_100_000, readBase: 20_000, writeBase: 12_000 });
  const hUnifi = history(96, 13, 4, { rxBase: 2_600_000, txBase: 1_500_000, readBase: 8_000, writeBase: 5_000 });
  const hNas = history(96, 17, 4, { rxBase: 4_400_000, txBase: 2_700_000, readBase: 1_400_000, writeBase: 760_000 });
  const hSwitchNow = hSwitch[hSwitch.length - 1] || {};
  const hUnifiNow = hUnifi[hUnifi.length - 1] || {};
  const hNasNow = hNas[hNas.length - 1] || {};
  data.snmp = [
    { name: 'core-switch', host: '192.0.2.2', online: true, profile: 'mikrotik', vendor: 'MikroTik', model: 'CRS', cpu: hSwitchNow.cpu || 9, ram: { percent: hSwitchNow.mem || 28, used: 0.3, total: 1 }, systemTemp: hSwitchNow.tempSystem || 42, metrics: { bandwidth: { rxBps: hSwitchNow.bandwidthRxBps || 3_200_000, txBps: hSwitchNow.bandwidthTxBps || 2_000_000 }, diskIO: { readBps: hSwitchNow.diskReadBps || 0, writeBps: hSwitchNow.diskWriteBps || 0 } }, history: hSwitch },
    { name: 'demo-ap', host: '192.0.2.5', online: true, profile: 'unifi', vendor: 'Ubiquiti', model: 'UniFi U6 Pro', cpu: hUnifiNow.cpu || 13, ram: { percent: hUnifiNow.mem || 41, used: 0.42, total: 1 }, systemTemp: hUnifiNow.tempSystem || 39, fanSpeeds: [], metrics: { bandwidth: { rxBps: hUnifiNow.bandwidthRxBps || 2_400_000, txBps: hUnifiNow.bandwidthTxBps || 1_300_000 }, diskIO: { readBps: hUnifiNow.diskReadBps || 0, writeBps: hUnifiNow.diskWriteBps || 0 } }, history: hUnifi },
    { name: 'demo-ap-legacy', host: '192.0.2.9', online: true, profile: 'unifi', vendor: 'Ubiquiti', model: 'UniFi U6 Pro', cpu: hUnifiNow.cpu || 13, ram: { percent: hUnifiNow.mem || 41, used: 0.42, total: 1 }, systemTemp: hUnifiNow.tempSystem || 39, fanSpeeds: [], metrics: { bandwidth: { rxBps: hUnifiNow.bandwidthRxBps || 2_400_000, txBps: hUnifiNow.bandwidthTxBps || 1_300_000 }, diskIO: { readBps: hUnifiNow.diskReadBps || 0, writeBps: hUnifiNow.diskWriteBps || 0 } }, history: hUnifi },
    { name: 'demo-nas', host: '192.0.2.20', online: true, profile: 'synology', vendor: 'Synology', model: 'DS Demo', cpu: hNasNow.cpu || 17, ram: { percent: hNasNow.mem || 36, used: 5.8, total: 16 }, systemTemp: hNasNow.tempSystem || 45, metrics: { bandwidth: { rxBps: hNasNow.bandwidthRxBps || 4_200_000, txBps: hNasNow.bandwidthTxBps || 2_600_000 }, diskIO: { readBps: hNasNow.diskReadBps || 1_600_000, writeBps: hNasNow.diskWriteBps || 840_000 } }, history: hNas },
  ];

  const healthChecks = [
    { name: 'database backup', status: 'up', lastPing: nowIso(-45_000), periodSec: 3600, graceSec: 900 },
    { name: 'nightly sync', status: 'grace', lastPing: nowIso(-75_000), periodSec: 86400, graceSec: 3600 },
    { name: 'certificate renewal', status: 'up', lastPing: nowIso(-125_000), periodSec: 604800, graceSec: 7200 },
    { name: 'media indexer', status: 'up', lastPing: nowIso(-95_000), periodSec: 7200, graceSec: 1200 },
  ];
  data.healthchecks = {
    online: true,
    summary: {
      total: healthChecks.length,
      up: healthChecks.filter(c => c.status === 'up').length,
      down: healthChecks.filter(c => c.status === 'down').length,
      grace: healthChecks.filter(c => c.status === 'grace').length,
      paused: healthChecks.filter(c => c.status === 'paused').length,
    },
    checks: healthChecks,
  };

  data.uptimekuma = {
    online: true,
    summary: { total: 4, up: 3, down: 1, pending: 0, maintenance: 0 },
    historyHours: uptimeKumaHours,
    monitors: [
      { id: 1, name: 'public website', status: 'up', lastHeartbeat: nowIso(-22_000), lastPing: nowIso(-22_000), ping: 4, history: mixedUptimeHistory(uptimeKumaPoints, 11, 'up') },
      { id: 2, name: 'api endpoint', status: 'up', lastHeartbeat: nowIso(-28_000), lastPing: nowIso(-28_000), ping: 7, history: mixedUptimeHistory(uptimeKumaPoints, 12, 'up') },
      { id: 3, name: 'nas portal', status: 'down', lastHeartbeat: nowIso(-40_000), lastPing: nowIso(-40_000), ping: null, history: uptimeHistory('down', uptimeKumaPoints, 13) },
      { id: 4, name: 'dns health', status: 'up', lastHeartbeat: nowIso(-32_000), lastPing: nowIso(-32_000), ping: 2, history: mixedUptimeHistory(uptimeKumaPoints, 14, 'up') },
    ],
  };

  data.checks = {
    online: true,
    summary: { total: 3, up: 3, down: 0 },
    historyHours: checksHours,
    checks: [
      { name: 'HTTPS gateway', type: 'tcp', target: '192.0.2.1:443', status: 'up', responseMs: 8, history: mixedUptimeHistory(checksPoints, 31, 'up') },
      { name: 'DNS resolver', type: 'dns', target: 'demo.example.invalid', status: 'up', responseMs: 4, history: mixedUptimeHistory(checksPoints, 32, 'up') },
      { name: 'ICMP core', type: 'ping', target: '192.0.2.2', status: 'up', responseMs: 1, history: mixedUptimeHistory(checksPoints, 33, 'up') },
    ],
  };

  const prometheusTargets = ['node-exporter', 'cadvisor', 'postgres', 'kubernetes', 'blackbox', 'traefik', 'healthchecks', 'dockhand']
    .map((job, i) => ({ name: `${job}:910${i}`, sourceName: 'prometheus-demo', sourceUrl: 'https://prometheus.example.invalid', prometheus: 'prometheus-demo', job, endpoint: `${job}:910${i}`, health: 'up', status: 'up', lastScrape: nowIso(-(i + 1) * 30000) }));
  data.prometheus = {
    online: true,
    summary: { instances: 1, instanceUp: 1, instanceDown: 0, total: prometheusTargets.length, up: prometheusTargets.filter(t => t.health === 'up').length, down: 0, unknown: 0 },
    instances: [{ name: 'prometheus-demo', url: 'https://prometheus.example.invalid', online: true, summary: { total: prometheusTargets.length, up: prometheusTargets.filter(t => t.health === 'up').length, down: 0, unknown: 0 } }],
    targets: prometheusTargets,
  };

  const containers = ['nginx', 'api', 'postgres', 'redis', 'prometheus', 'node-exporter'].map((name, i) => ({
    id: crypto.createHash('sha1').update(name).digest('hex').slice(0, 12),
    name,
    image: `${name}:demo`,
    imageShort: `${name}:demo`,
    imageUpdate: i === 1 || i === 4
      ? { status: 'update', checkedAt: nowIso(-300_000) }
      : { status: 'current', checkedAt: nowIso(-300_000) },
    state: 'running',
    status: 'running',
    color: 'green',
    cpu: Number((2 + i * 1.7).toFixed(1)),
    mem: Number((1.2 + i * 0.8).toFixed(1)),
    memPercent: Number((1.2 + i * 0.8).toFixed(1)),
    netIO: `${(i + 1) * 12} MB / ${(i + 1) * 8} MB`,
    blockIO: `${i * 3} MB / ${i * 2} MB`,
    ports: i === 0 ? ['443:443'] : [],
  }));
  data.docker = [{
    name: 'demo-docker',
    host: 'demo@192.0.2.30:22',
    online: true,
    summary: { total: containers.length, running: containers.length, stopped: 0, cpu: hDockerNow.cpu || 22, memPercent: hDockerNow.mem || 18, updates: 2, unused: 3 },
    history: hDocker,
    containers,
  }];
  data.dockhand = {
    online: true,
    summary: { servers: 1, serverUp: 1, serverDown: 0, total: containers.length, running: containers.length, stopped: 0, pending: 0 },
    instances: [{ name: 'dockhand-demo', url: 'https://dockhand.example.invalid', online: true, summary: { total: containers.length, running: containers.length, stopped: 0 } }],
    containers: containers.map((c, i) => ({
      ...c,
      sourceName: 'dockhand-demo',
      sourceUrl: 'https://dockhand.example.invalid',
      environmentId: 'demo-env',
      imageUpdate: i === 2 ? { status: 'update', checkedAt: nowIso(-240_000) } : { status: 'current', checkedAt: nowIso(-240_000) },
    })),
  };
  data.firewall = {
    online: true,
    summary: { instances: 1, up: 1, down: 0, interfaces: 4, interfacesUp: 4, interfacesDown: 0, updates: 2, rebootRequired: 0 },
    instances: [{
      name: 'edge-opnsense',
      type: 'opnsense',
      url: 'https://firewall.example.invalid',
      online: true,
      system: { hostname: 'edge-fw-01', version: 'OPNsense 24.1', cpuPercent: 14, memoryPercent: 46, updateCount: 2, rebootRequired: false },
      firewall: { states: 18423, maxStates: 1000000 },
      summary: { interfaces: 4, interfacesUp: 4, interfacesDown: 0, updates: 2, rebootRequired: 0 },
      interfaces: [
        { name: 'wan', description: 'WAN', address: '198.51.100.10/29', status: 'up', inBytes: 28.4 * 1024 ** 3, outBytes: 9.1 * 1024 ** 3 },
        { name: 'lan', description: 'LAN', address: '192.0.2.1/24', status: 'up', inBytes: 114.2 * 1024 ** 3, outBytes: 86.5 * 1024 ** 3 },
        { name: 'dmz', description: 'DMZ', address: '192.0.2.129/26', status: 'up', inBytes: 12.8 * 1024 ** 3, outBytes: 7.4 * 1024 ** 3 },
        { name: 'wg0', description: 'WireGuard', address: '10.6.0.1/24', status: 'up', inBytes: 3.2 * 1024 ** 3, outBytes: 2.1 * 1024 ** 3 },
      ],
    }],
  };

  // UniFi controller (Integration API collector shape from src/unifi.js).
  // Complements the SNMP-branded 'demo-ap' above — the dashboard merges both
  // into one UniFi card (controller rows first, SNMP rows below).
  data.unifi = (() => {
    const devHist = seed => history(96, seed, 5).map(p => ({ time: p.time, cpu: p.cpu, ram: p.mem }));
    const gwHist = devHist(21);
    const now = Date.now();
    const wanHistory = Array.from({ length: 96 }, (_, i) => {
      const time = now - (95 - i) * 15 * 60 * 1000 / 4;
      const down = i >= 60 && i < 63; // one short outage window in the demo story
      return { time, up: down ? 0 : 1, latency: down ? null : 9 + (i % 7), loss: down ? null : (i % 11 === 0 ? 0.2 : 0), rxBps: down ? 0 : 6_800_000 + (i % 9) * 400_000, txBps: down ? 0 : 1_900_000 + (i % 5) * 180_000 };
    });
    const downEdges = wanHistory.filter((p, i) => i > 0 && wanHistory[i - 1].up === 1 && p.up === 0).map(p => p.time);
    const dev = (id, name, model, ip, state, fw, extra = {}) => {
      const st = String(state).toUpperCase();
      const online = st === 'ONLINE';
      const warn = ['UPDATING', 'ADOPTING', 'GETTING_READY', 'PENDING_ADOPTION'].includes(st);
      return {
        id, name, model, mac: `28:70:4e:00:00:${id.slice(-2)}`, ip,
        state: online ? 'online' : (warn ? st.toLowerCase().replace(/_/g, ' ') : 'offline'),
        stateRaw: st, alertable: st === 'OFFLINE', warn, online,
        firmware: fw, firmwareUpdatable: false, isGateway: false,
        cpu: online ? null : null, ram: null, uptimeSeconds: online ? 41 * 86400 : null,
        history: [], ...extra,
      };
    };
    const devices = [
      dev('d-01', 'demo-gateway', 'UDM Pro', '192.0.2.1', 'ONLINE', '4.3.6', { isGateway: true, cpu: 22, ram: { percent: 61 }, history: gwHist, uplink: { rxBps: 7_200_000, txBps: 2_100_000 } }),
      dev('d-02', 'demo-switch', 'USW Pro 24', '192.0.2.2', 'ONLINE', '7.4.1', { cpu: 14, ram: { percent: 38 }, history: devHist(12) }),
      dev('d-03', 'demo-ap-warehouse', 'U6 Pro', '192.0.2.4', 'OFFLINE', '6.6.65'),
      dev('d-04', 'demo-ap-lobby', 'U6 Lite', '192.0.2.5', 'UPDATING', '6.6.65', { cpu: 48, ram: { percent: 52 }, history: devHist(33) }),
    ];
    const summary = {
      instances: 1, up: 1, down: 0,
      devices: devices.length,
      devicesOnline: devices.filter(d => d.online).length,
      devicesOffline: devices.filter(d => d.alertable).length,
      devicesWarn: devices.filter(d => d.warn).length,
      wanDown: 0,
    };
    return {
      online: true,
      summary,
      instances: [{
        online: true,
        name: 'unifi-demo',
        url: 'https://unifi.example.invalid',
        site: 'default',
        unifiOs: true,
        devices,
        devicesComplete: true,
        wan: { state: 'up', rxBps: 7_200_000, txBps: 2_100_000, latencyMs: 11, lossPct: 0, history: wanHistory, downEvents: { count: downEdges.length, recent: downEdges.slice(-5) } },
        wanQuality: 'ok',
        stale: false,
      }],
    };
  })();

  data.truenas = {
    online: true,
    summary: { instances: 1, up: 1, down: 0, pools: 2, poolsHealthy: 2, poolsWarn: 0, disks: 8, disksWarn: 0, alertsCritical: 0, alertsWarning: 1, usedPercent: 57 },
    instances: [{
      name: 'truenas-demo',
      url: 'https://truenas.example.invalid',
      apiMode: 'websocket',
      method: 'websocket',
      online: true,
      system: { hostname: 'truenas-demo', model: 'TrueNAS SCALE', version: '24.04.2', cpuPercent: 22, memoryPercent: 64, cpuTemp: 46 },
      summary: { pools: 2, poolsHealthy: 2, poolsWarn: 0, disks: 8, disksWarn: 0, alertsCritical: 0, alertsWarning: 1, usedPercent: 57 },
      pools: [
        { name: 'tank', health: 'ONLINE', status: 'ONLINE', usedPercent: 62, totalBytes: 42 * 1024 ** 4, scan: { state: 'FINISHED', errors: 0, endTime: nowIso(-18 * 60 * 60 * 1000) } },
        { name: 'backup', health: 'ONLINE', status: 'ONLINE', usedPercent: 41, totalBytes: 20 * 1024 ** 4, scan: { state: 'FINISHED', errors: 0, endTime: nowIso(-42 * 60 * 60 * 1000) } },
      ],
      disks: Array.from({ length: 8 }, (_, i) => ({ name: `sd${String.fromCharCode(97 + i)}`, health: 'ONLINE', status: 'ONLINE', model: i < 6 ? 'WD Red Plus 12TB' : 'Samsung 870 EVO 2TB', pool: i < 6 ? 'tank' : 'backup', temperature: 34 + (i % 4), sizeBytes: i < 6 ? 12 * 1024 ** 4 : 2 * 1024 ** 4 })),
      alerts: [{ level: 'WARNING', severity: 'WARNING', title: 'Scrub due soon', message: 'Pool tank scheduled scrub will run tonight.', source: 'storage', datetime: nowIso(-2 * 60 * 60 * 1000) }],
    }],
  };

  data.qnap = {
    online: true,
    summary: { instances: 1, up: 1, down: 0, volumes: 2, volumesHealthy: 2, disks: 4, disksWarn: 0, services: 5, usedPercent: 63 },
    instances: [{
      name: 'qnap-demo',
      url: 'https://qnap.example.invalid',
      method: 'qts-api',
      statusCode: 200,
      online: true,
      system: { hostname: 'qnap-demo', model: 'TS-464', version: 'QTS 5.1.8', firmware: '5.1.8.2823', cpuPercent: 18, memoryPercent: 52, cpuTemp: 44, uptimeSeconds: uptimeSeconds(31, 4, 12) },
      summary: { instances: 1, up: 1, down: 0, volumes: 2, volumesHealthy: 2, disks: 4, disksWarn: 0, services: 5, usedPercent: 63 },
      volumes: [
        { name: 'DataVol1', status: 'ready', health: 'online', usedPercent: 66, totalBytes: 18 * 1024 ** 4 },
        { name: 'Snapshots', status: 'ready', health: 'online', usedPercent: 38, totalBytes: 4 * 1024 ** 4 },
      ],
      disks: [
        { name: 'Disk 1', model: 'WD Red Plus 8TB', health: 'good', status: 'online', temperature: 36, sizeBytes: 8 * 1024 ** 4 },
        { name: 'Disk 2', model: 'WD Red Plus 8TB', health: 'good', status: 'online', temperature: 37, sizeBytes: 8 * 1024 ** 4 },
        { name: 'Disk 3', model: 'WD Red Plus 8TB', health: 'good', status: 'online', temperature: 35, sizeBytes: 8 * 1024 ** 4 },
        { name: 'Disk 4', model: 'WD Red Plus 8TB', health: 'good', status: 'online', temperature: 38, sizeBytes: 8 * 1024 ** 4 },
      ],
      services: [
        { name: 'SMB', status: 'running', active: true },
        { name: 'NFS', status: 'running', active: true },
        { name: 'File Station', status: 'running', active: true },
        { name: 'Hybrid Backup Sync', status: 'running', active: true },
        { name: 'Container Station', status: 'running', active: true },
      ],
    }],
  };

  data.ugreen = {
    online: true,
    summary: { instances: 1, up: 1, down: 0, pools: 1, volumes: 2, disks: 4, disksWarn: 0, services: 4, usedPercent: 54 },
    instances: [{
      name: 'ugreen-demo',
      url: 'https://ugreen.example.invalid',
      method: 'web',
      statusCode: 200,
      online: true,
      system: { hostname: 'ugreen-demo', model: 'DXP4800 Plus', version: 'UGOS Pro 1.2.0', cpuPercent: 23, memoryPercent: 48, cpuTemp: 41, uptimeSeconds: uptimeSeconds(16, 8, 5) },
      summary: { instances: 1, up: 1, down: 0, pools: 1, volumes: 2, disks: 4, disksWarn: 0, services: 4, usedPercent: 54 },
      pools: [{ name: 'Storage Pool 1', status: 'healthy', health: 'online', usedPercent: 54, totalBytes: 16 * 1024 ** 4 }],
      volumes: [
        { name: 'Media', status: 'mounted', health: 'online', usedPercent: 61, totalBytes: 10 * 1024 ** 4 },
        { name: 'Backups', status: 'mounted', health: 'online', usedPercent: 43, totalBytes: 6 * 1024 ** 4 },
      ],
      disks: [
        { name: 'Bay 1', model: 'Seagate IronWolf 6TB', health: 'good', status: 'online', temperature: 34, sizeBytes: 6 * 1024 ** 4 },
        { name: 'Bay 2', model: 'Seagate IronWolf 6TB', health: 'good', status: 'online', temperature: 35, sizeBytes: 6 * 1024 ** 4 },
        { name: 'Bay 3', model: 'Seagate IronWolf 6TB', health: 'good', status: 'online', temperature: 33, sizeBytes: 6 * 1024 ** 4 },
        { name: 'Bay 4', model: 'Seagate IronWolf 6TB', health: 'good', status: 'online', temperature: 36, sizeBytes: 6 * 1024 ** 4 },
      ],
      services: [
        { name: 'SMB', status: 'running', active: true },
        { name: 'Docker', status: 'running', active: true },
        { name: 'Photos', status: 'running', active: true },
        { name: 'Sync & Backup', status: 'running', active: true },
      ],
    }],
  };

  data.pbs = {
    online: true,
    summary: { instances: 1, up: 1, down: 0, datastores: 2, datastoresWarn: 0, snapshots: 148, groups: 31, failedTasks: 1, usedPercent: 58 },
    instances: [{
      name: 'pbs-demo',
      url: 'https://pbs.example.invalid:8007',
      online: true,
      version: { version: '3.2.7', release: 'demo' },
      nodes: [{ name: 'pbs-demo', cpuPercent: 16, memoryPercent: 42 }],
      summary: { datastores: 2, datastoresWarn: 0, snapshots: 148, groups: 31, failedTasks: 1, usedPercent: 58 },
      datastores: [
        { name: 'vm-backups', health: 'online', usedPercent: 61, totalBytes: 18 * 1024 ** 4, snapshots: 112, groups: 22, gcStatus: 'last GC OK' },
        { name: 'nas-backups', health: 'online', usedPercent: 47, totalBytes: 10 * 1024 ** 4, snapshots: 36, groups: 9, gcStatus: 'last GC OK' },
      ],
      tasks: [
        { id: 'UPID:demo:backup:101', name: 'backup - vm/101/2026-07-05T18:00:00Z', taskId: 'vm/101', type: 'backup', status: 'OK', failed: false, running: false, startTime: nowIso(-3 * 60 * 60 * 1000), endTime: nowIso(-2.7 * 60 * 60 * 1000) },
        { id: 'UPID:demo:verify:weekly', name: 'verify - vm/104/2026-07-05T12:00:00Z', taskId: 'vm/104', type: 'verify', status: 'WARNINGS', failed: true, running: false, startTime: nowIso(-7 * 60 * 60 * 1000), endTime: nowIso(-6.5 * 60 * 60 * 1000) },
      ],
    }],
  };

  data.cloudflare = {
    online: true,
    summary: { zones: 2, zonesActive: 2, zonesWarn: 0, tunnels: 2, tunnelsHealthy: 2, tunnelsDown: 0, domains: 3, domainsExpiring: 1, domainsExpired: 0, domainsAutoRenew: 3 },
    zones: [
      { name: 'example.com', status: 'active', paused: false, plan: 'Pro', accountName: 'Demo Ops', online: true },
      { name: 'internal.example.com', status: 'active', paused: false, plan: 'Free', accountName: 'Demo Ops', online: true },
    ],
    tunnels: [
      { name: 'home-lab-ingress', status: 'healthy', online: true, activeConnections: 4, pendingReconnect: 0, id: 'tun_demo_01' },
      { name: 'admin-access', status: 'healthy', online: true, activeConnections: 2, pendingReconnect: 0, id: 'tun_demo_02' },
    ],
    domains: [
      { name: 'example.com', daysToExpire: 241, expired: false, expiring: false, expiresAt: nowIso(241 * 24 * 60 * 60 * 1000), autoRenew: true, currentRegistrar: 'Cloudflare Registrar' },
      { name: 'omnisight.dev', daysToExpire: 18, expired: false, expiring: true, expiresAt: nowIso(18 * 24 * 60 * 60 * 1000), autoRenew: true, currentRegistrar: 'Cloudflare Registrar' },
      { name: 'ops-demo.net', daysToExpire: 93, expired: false, expiring: false, expiresAt: nowIso(93 * 24 * 60 * 60 * 1000), autoRenew: true, currentRegistrar: 'Cloudflare Registrar' },
    ],
  };

  data.cicd = {
    online: true,
    summary: { projects: 2, up: 2, down: 0, partial: 0, pipelines: 5, success: 3, failed: 1, running: 1, canceled: 0, jobs: 18, jobsFailed: 1, jobsRunning: 2 },
    projects: [
      {
        name: 'OmniSight',
        provider: 'github',
        branch: 'main',
        online: true,
        pipelines: [
          { name: 'build', workflowName: 'build', status: 'success', success: true, ref: 'main', actor: 'demo_admin', title: 'v2 demo refresh', updatedAt: nowIso(-18 * 60 * 1000) },
          { name: 'docker-publish', workflowName: 'docker-publish', status: 'running', running: true, ref: 'main', actor: 'demo_admin', title: 'publish demo image', updatedAt: nowIso(-4 * 60 * 1000) },
          { name: 'lint', workflowName: 'lint', status: 'success', success: true, ref: 'main', actor: 'demo_admin', title: 'lint dashboard', updatedAt: nowIso(-31 * 60 * 1000) },
        ],
        jobs: [{ name: 'unit tests', success: true }, { name: 'browser smoke', running: true }],
      },
      {
        name: 'infra-playbooks',
        provider: 'gitlab',
        branch: 'main',
        online: true,
        pipelines: [
          { name: 'syntax-check', status: 'success', success: true, ref: 'main', actor: 'ops-bot', title: 'ansible syntax', updatedAt: nowIso(-42 * 60 * 1000) },
          { name: 'staging-apply', status: 'failed', failed: true, ref: 'main', actor: 'ops-bot', title: 'demo failure for alert view', updatedAt: nowIso(-9 * 60 * 1000) },
        ],
        jobs: [{ name: 'staging-apply', failed: true }],
      },
    ],
  };

  data.veeam = {
    online: true,
    summary: { instances: 1, up: 1, down: 0, partial: 0, jobs: 5, jobsDisabled: 1, sessions: 6, failedSessions: 1, warningSessions: 1, runningSessions: 1, repositories: 2, repositoriesWarn: 0 },
    instances: [{
      name: 'veeam-demo',
      url: 'https://veeam.example.invalid:9419',
      online: true,
      summary: { jobs: 5, jobsDisabled: 1, sessions: 6, failedSessions: 1, warningSessions: 1, runningSessions: 1, repositories: 2, repositoriesWarn: 0 },
      sessions: [
        { name: 'VM Backup - Production', type: 'Backup', result: 'Success', success: true, creationTime: nowIso(-6 * 60 * 60 * 1000), endTime: nowIso(-5.4 * 60 * 60 * 1000) },
        { name: 'NAS Backup - Shares', type: 'Backup', state: 'Running', running: true, progressPercent: 72, creationTime: nowIso(-48 * 60 * 1000) },
        { name: 'Offsite Copy', type: 'Backup Copy', result: 'Warning', warning: true, creationTime: nowIso(-10 * 60 * 60 * 1000), endTime: nowIso(-9.2 * 60 * 60 * 1000) },
        { name: 'SQL Transaction Logs', type: 'Log Backup', result: 'Failed', failed: true, creationTime: nowIso(-90 * 60 * 1000), endTime: nowIso(-84 * 60 * 1000) },
      ],
      repositories: [
        { name: 'Primary Repository', path: '\\\\repo01\\veeam', usedPercent: 58, status: 'online' },
        { name: 'Object Archive', path: 's3://demo-veeam-archive', usedPercent: 34, status: 'online' },
      ],
    }],
  };

  data.portainer = {
    online: true,
    summary: { instances: 1, up: 1, down: 0, environments: 2, environmentsUp: 2, environmentsDown: 0, stacks: 4, stacksWarn: 1, containers: containers.length, running: containers.length, stopped: 0 },
    instances: [{
      name: 'portainer-demo',
      url: 'https://portainer.example.invalid:9443',
      online: true,
      summary: { environments: 2, environmentsUp: 2, environmentsDown: 0, stacks: 4, stacksWarn: 1, containers: containers.length, running: containers.length, stopped: 0 },
      environments: [
        { id: 1, name: 'docker-prod', type: 'Docker', url: 'tcp://192.0.2.30:2376', online: true, status: 'up' },
        { id: 2, name: 'edge-agent', type: 'Agent', url: 'tcp://192.0.2.31:9001', online: true, status: 'up' },
      ],
      stacks: [
        { name: 'monitoring', status: 'running', warning: false },
        { name: 'public-web', status: 'running', warning: false },
        { name: 'backup-tools', status: 'warning', warning: true },
        { name: 'databases', status: 'running', warning: false },
      ],
      containers: containers.map((c, i) => ({ ...c, endpointId: i < 4 ? 1 : 2, endpointName: i < 4 ? 'docker-prod' : 'edge-agent', sourceName: 'portainer-demo' })),
    }],
  };

  data.database = [{
    name: 'demo-postgres',
    type: 'postgresql',
    host: '192.0.2.40',
    online: true,
    connections: 18,
    maxConnections: 100,
    activeConnections: 5,
    idleConnections: 13,
    sizeBytes: Math.round(12.4 * 1024 ** 3),
    uptimeSeconds: uptimeSeconds(21, 6, 18),
    databaseCount: 7,
    tableCount: 142,
    queryCount: 1842300,
    slowQueries: 2,
    version: 'PostgreSQL 16.3',
    history: history(96, 18, 3),
  }];

  return data;
}

function publicSummary(data = demoStatus()) {
  return data.configured.map(id => {
    const names = {
      proxmox: 'Proxmox', linux: 'Linux Server', windows: 'Windows Server', kubernetes: 'Kubernetes', synology: 'Synology', mikrotik: 'MikroTik', unifi: 'UniFi', snmp: 'SNMP',
      healthchecks: 'Healthchecks', uptimekuma: 'Uptime Kuma', checks: 'Service checks',
      prometheus: 'Prometheus', docker: 'Docker', dockhand: 'Dockhand', firewall: 'Firewalls',
      truenas: 'TrueNAS', qnap: 'QNAP', ugreen: 'Ugreen', pbs: 'Proxmox Backup',
      cloudflare: 'Cloudflare', cicd: 'GitHub/GitLab CI', veeam: 'Veeam', portainer: 'Portainer',
      database: 'Databases',
    };
    const detail = (() => {
      if (id === 'proxmox') return `${data.proxmox.nodes.filter(n => n.online).length}/${data.proxmox.nodes.length} nodes up`;
      if (id === 'linux') return `${data.linux.filter(n => n.online).length}/${data.linux.length} servers\n${data.linux.reduce((n, h) => n + (h.services || []).filter(s => s.active).length, 0)}/${data.linux.reduce((n, h) => n + (h.services || []).length, 0)} services`;
      if (id === 'windows') return `${data.windows.filter(n => n.online).length}/${data.windows.length} servers\n${data.windows.reduce((n, h) => n + (h.services || []).filter(s => s.active).length, 0)}/${data.windows.reduce((n, h) => n + (h.services || []).length, 0)} services`;
      if (id === 'kubernetes') return `${data.kubernetes.summary.running}/${data.kubernetes.summary.pods} pods`;
      if (['synology', 'mikrotik', 'unifi', 'snmp'].includes(id)) {
        const rows = data.snmp.filter(d => {
          const profile = ['synology', 'mikrotik', 'unifi'].includes(String(d.profile || '').toLowerCase()) ? String(d.profile).toLowerCase() : 'snmp';
          return profile === id;
        });
        return `${rows.filter(d => d.online).length}/${rows.length} up`;
      }
      if (id === 'healthchecks') return `${data.healthchecks.summary.up}/${data.healthchecks.summary.total} up`;
      if (id === 'uptimekuma') return `${data.uptimekuma.summary.up}/${data.uptimekuma.summary.total} up`;
      if (id === 'checks') return `${data.checks.summary.up}/${data.checks.summary.total} up`;
      if (id === 'prometheus') return `${data.prometheus.summary.up}/${data.prometheus.summary.total} up`;
      if (id === 'docker') return `${data.docker.reduce((n, h) => n + (h.summary?.running || 0), 0)}/${data.docker.reduce((n, h) => n + (h.summary?.total || 0), 0)} containers`;
      if (id === 'dockhand') return `${data.dockhand.summary.running}/${data.dockhand.summary.total} running`;
      if (id === 'firewall') return `${data.firewall.summary.interfacesUp}/${data.firewall.summary.interfaces} interfaces up`;
      if (id === 'truenas') return `${data.truenas.summary.poolsHealthy}/${data.truenas.summary.pools} pools healthy`;
      if (id === 'qnap') return `${data.qnap.summary.up}/${data.qnap.summary.instances} systems up\n${data.qnap.summary.disks || 0} disks`;
      if (id === 'ugreen') return `${data.ugreen.summary.up}/${data.ugreen.summary.instances} systems up\n${data.ugreen.summary.disks || 0} disks`;
      if (id === 'pbs') return `${data.pbs.summary.datastores} DST\n${data.pbs.summary.snapshots} snapshots`;
      if (id === 'cloudflare') return `${data.cloudflare.summary.zonesActive}/${data.cloudflare.summary.zones} zones\n${data.cloudflare.summary.tunnelsHealthy}/${data.cloudflare.summary.tunnels} tunnels`;
      if (id === 'cicd') return `${data.cicd.summary.success}/${data.cicd.summary.pipelines} pipelines green`;
      if (id === 'veeam') return `${data.veeam.summary.jobs} jobs\n${data.veeam.summary.failedSessions}/${data.veeam.summary.sessions} failed`;
      if (id === 'portainer') return `${data.portainer.summary.environmentsUp}/${data.portainer.summary.environments} env\n${data.portainer.summary.running}/${data.portainer.summary.containers} containers`;
      if (id === 'database') return `${data.database.filter(d => d.online).length}/${data.database.length} up`;
      return 'demo data online';
    })();
    const status = (() => {
      if (id === 'healthchecks') {
        const sm = data.healthchecks.summary || {};
        const up = Number(sm.up || 0);
        const down = Number(sm.down || 0);
        return down > 0 && down >= up ? 'down' : (down > 0 || Number(sm.grace || 0) > 0 ? 'degraded' : 'healthy');
      }
      return id === 'uptimekuma' ? 'degraded' : 'healthy';
    })();
    return { id, name: names[id] || id, status, detail };
  });
}

function publicStatusCode(status) {
  if (status === 'healthy' || status === 'up' || status === 'ok') return 'ok';
  if (status === 'degraded' || status === 'warning' || status === 'warn') return 'warn';
  if (status === 'down' || status === 'offline') return 'down';
  return 'connecting';
}

function publicServiceHistory(status, seed = 1, count = 64) {
  const code = publicStatusCode(status);
  return Array.from({ length: count }, (_, i) => {
    const wave = Math.sin(i / 6 + seed) * 4;
    const jitter = (seededNoise(seed, i, 11) - 0.5) * 6;
    const recentIssue = code === 'warn' && i > count - 18;
    const downTail = code === 'down' && i > count - 22;
    const health = downTail
      ? clamp(8 + jitter, 0, 25)
      : recentIssue
        ? clamp(66 + wave + jitter, 45, 82)
        : clamp(94 + wave * 0.4 + jitter * 0.4, 85, 100);
    return { time: nowIso(-(count - i) * 60000), health: Number(health.toFixed(1)) };
  });
}

function publicServices(data = demoStatus()) {
  return publicSummary(data).map((item, index) => ({
    id: item.id,
    title: item.name,
    name: item.name,
    status: publicStatusCode(item.status),
    meta: item.detail,
    history: publicServiceHistory(item.status, index + 1),
  }));
}

function topologyData() {
  const d = demoStatus();
  return {
    timestamp: d.timestamp,
    loading: false,
    refreshing: false,
    configured: d.configured,
    topologyLinks: demoTopology.links,
    topologyNodes: demoTopology.nodes,
    topologyHidden: demoTopology.hidden,
    topologySpacing: demoTopology.spacing,
    topologyPositions: demoTopology.positions,
    topologyView: demoTopology.view,
    proxmox: {
      nodes: d.proxmox.nodes.map(n => ({
        name: n.name,
        online: true,
        node: { name: n.name, online: true },
        vms: n.vms.map(v => ({ id: v.id, name: v.name, status: v.status, type: v.type, os: v.os })),
      })),
    },
    linux: d.linux.map(s => ({ name: s.name, host: s.host, online: s.online, services: s.services })),
    windows: d.windows.map(s => ({ name: s.name, host: s.host, online: s.online, services: s.services })),
    kubernetes: { online: true, summary: d.kubernetes.summary, pods: d.kubernetes.pods.map(p => ({ name: p.name, namespace: p.namespace, status: p.status, containers: p.containers })) },
    docker: d.docker.map(h => ({ name: h.name, host: h.host, online: true, summary: h.summary, containers: h.containers })),
    dockhand: d.dockhand,
    firewall: d.firewall,
    truenas: d.truenas,
    qnap: d.qnap,
    ugreen: d.ugreen,
    pbs: d.pbs,
    cloudflare: d.cloudflare,
    cicd: d.cicd,
    veeam: d.veeam,
    portainer: d.portainer,
    snmp: d.snmp.map(s => ({ name: s.name, host: s.host, online: true, profile: s.profile, vendor: s.vendor, model: s.model })),
  };
}

const demoLogs = [
  { t: Date.now() - 120000, level: 'info', msg: 'Demo data generated from isolated sample fixtures' },
  { t: Date.now() - 65000, level: 'warn', msg: 'Demo alert: nas portal is intentionally degraded' },
  { t: Date.now() - 15000, level: 'info', msg: 'Demo collectors are simulated; no external systems are contacted' },
];
const demoAudit = [
  { id: 'audit-demo-1', t: Date.now() - 90000, actor: 'demo_admin', ip: '127.0.0.1', publicIp: '127.0.0.1', action: 'settings.changed', detail: { settings: ['appearance', 'alerts'], count: 2 } },
];
const demoAlerts = [
  { id: 'alert-demo-1', key: 'uptimekuma:nas', t: Date.now() - 60000, type: 'problem', severity: 'warning', title: 'nas portal degraded', message: 'Demo monitor is down by design', channels: ['ntfy'], status: 'sent' },
];

app.get(['/healthz', '/api/healthz'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, demo: true, version: demoAppVersion(), uptime: Math.round(process.uptime()), timestamp: nowIso() });
});
app.get('/api/about', (req, res) => res.json({ name: 'OmniSight Demo', version: require('./package.json').version, demo: true }));
app.get('/api/update-check', (req, res) => res.json({ updateAvailable: false }));
app.get('/api/auth-status', (req, res) => {
  const authenticated = demoAuthenticated(req);
  res.json({
    required: true,
    authenticated,
    username: authenticated ? demoUser.username : '',
    role: authenticated ? demoUser.role : '',
    user: authenticated ? demoUser : null,
    twoFactorEnabled: false,
    passwordResetEnabled: true,
    version: demoAppVersion(),
    demo: true,
    demoDefaultCredentials: DEMO_DEFAULT_CREDENTIALS,
  });
});
app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (username !== DEMO_USERNAME || password !== DEMO_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid demo credentials' });
  }
  setDemoSession(req, res, req.body?.remember === true);
  res.json({ ok: true, demo: true });
});
app.post('/api/logout', (req, res) => {
  const token = demoToken(req);
  if (token) demoSessions.delete(token);
  res.setHeader('Set-Cookie', demoSessionCookie('', 0, req));
  res.json({ ok: true, demo: true });
});
app.post('/api/password-reset/request', (req, res) => res.json({ ok: true, demo: true, message: 'Use the configured demo credentials.' }));
app.post('/api/password-reset/confirm', (req, res) => res.json({ ok: true, demo: true }));
app.get('/api/onboarding/status', (req, res) => res.json({ required: false, authenticated: true, demo: true }));

app.use('/api', (req, res, next) => {
  if (req.path === '/public/status') return next();
  if (demoAuthenticated(req)) return next();
  res.status(401).json({ ok: false, error: 'Unauthorized' });
});

app.get('/api/profile', (req, res) => res.json({ username: demoUser.username, email: demoUser.email, role: demoUser.role, avatar: '', twoFactorEnabled: false, passkeys: [] }));
app.get('/api/profile/summary', (req, res) => res.json({ username: demoUser.username, role: demoUser.role, avatar: '', mustChangePassword: false }));
app.post('/api/set-password', (req, res) => res.status(403).json({ ok: false, demo: true, error: 'Demo credentials cannot be changed.' }));

app.get('/api/config', (req, res) => res.json(demoConfig()));
app.post('/api/config', (req, res) => {
  rememberDemoConfig(req.body);
  res.json({ ok: true, fullData: false, data: demoStatus(), demo: true });
});
app.get('/api/settings/status', (req, res) => res.json(demoStatus()));
app.get('/api/settings/agents', (req, res) => res.json({ agents: [{ key: 'linux:demo-agent', kind: 'linux', id: 'demo-agent', name: 'demo-linux-01', ip: '192.0.2.50', online: true, version: 'demo', latest: true }] }));
app.get('/api/agents', (req, res) => res.json({ agents: [
  { id: 'demo-agent', name: 'demo-linux-01', ip: '192.0.2.50', online: true, agentVersion: 'demo', latestVersion: 'demo', updateAvailable: false },
  { id: 'demo-offline', name: 'demo-offline-01', ip: '192.0.2.51', online: false, agentVersion: '1.1.0', lastSeen: Date.now() - 3600_000, platform: 'linux' },
] }));
app.get('/api/agent/repair-commands', (req, res) => res.json({
  ok: true,
  id: req.query.id || 'demo-offline',
  name: req.query.id || 'demo-offline',
  commands: [
    { title: 'Query agent', description: 'Checks service state, recent logs and dashboard reachability on the offline host.', command: 'sudo bash -lc \'systemctl status omnisight-agent --no-pager -l || true\njournalctl -u omnisight-agent -n 120 --no-pager || true\nprintf "{\"id\":\"demo-offline\"}" > /tmp/omnisight-agent-ping-body.json\ncurl -sS -m 20 -w "http=%{http_code} time=%{time_total}s\\n" http://demo.local/api/agent/ping -o /tmp/omnisight-agent-ping.out -X POST -H "X-Agent-Token: demo-token" -H "Content-Type: application/json" --data-binary @/tmp/omnisight-agent-ping-body.json\ncat /tmp/omnisight-agent-ping.out\'' },
    { title: 'Repair systemd agent', description: 'Reinstalls the agent with the current dashboard token, keeps the same agent identity and restarts the service.', command: 'curl -fsSL http://demo.local/agent/install.sh | sudo OMNISIGHT_URL=http://demo.local OMNISIGHT_TOKEN=demo-token OMNISIGHT_AGENT_ID=demo-offline bash' },
  ],
}));
app.post('/api/agent/ping', (req, res) => res.json({ ok: true, demo: true, id: req.body?.id || '' }));
app.get('/api/users', (req, res) => res.json([demoUser]));
app.post('/api/users', (req, res) => res.status(403).json({ ok: false, demo: true, error: 'Demo users cannot be changed.' }));
app.post('/api/users/batch', (req, res) => res.status(403).json({ ok: false, demo: true, error: 'Demo users cannot be changed.' }));
app.put('/api/users/:id', (req, res) => res.status(403).json({ ok: false, demo: true, error: 'Demo users cannot be changed.', user: demoUser }));
app.delete('/api/users/:id', (req, res) => res.status(403).json({ ok: false, demo: true, error: 'Demo users cannot be changed.' }));
app.get('/api/sessions', (req, res) => res.json({
  currentPublicIp: '127.0.0.1',
  sessions: [{
    token: 'demo-session',
    username: demoUser.username,
    role: demoUser.role,
    createdAt: Date.now() - 20 * 60 * 1000,
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    ip: '127.0.0.1',
    publicIp: '127.0.0.1',
    userAgent: 'OmniSight demo browser',
    current: true,
  }],
}));
app.delete('/api/sessions/:token', (req, res) => res.json({ ok: true, demo: true }));
app.get('/api/certificates', (req, res) => res.json([
  { name: 'demo-root-ca.pem', size: 1842, trusted: true, commonName: 'OmniSight Demo Root CA' },
  { name: 'homelab-wildcard.pem', size: 2264, trusted: false, commonName: '*.example.invalid' },
]));
app.delete('/api/certificates/:name', (req, res) => res.json({ ok: true, demo: true }));

app.get('/api/status', (req, res) => res.json(demoStatus()));
app.get('/api/status/dashboard', (req, res) => res.json(demoStatus()));
app.get('/api/status/summary', (req, res) => {
  const d = demoStatus();
  res.json({ timestamp: d.timestamp, loading: false, refreshing: false, configured: d.configured, publicStatus: demoPrefs.config.publicStatus !== false, preferredLanguage: demoPrefs.config.preferredLanguage || 'en', appearance: d.appearance, ui: demoPrefs.ui, health: publicSummary(d) });
});
app.get('/api/status/topology', (req, res) => res.json(topologyData()));
app.get('/api/status/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.write(`event: status\ndata: ${JSON.stringify({ type: 'hello', timestamp: nowIso(), refreshing: false })}\n\n`);
  const timer = setInterval(() => res.write(`event: status\ndata: ${JSON.stringify({ type: 'status', timestamp: nowIso(), refreshing: false })}\n\n`), 15000);
  req.on('close', () => clearInterval(timer));
});
app.get('/api/refresh', (req, res) => res.json(demoStatus()));
app.get('/api/public/status', (req, res) => {
  if (demoPrefs.config.publicStatus === false) return res.status(404).json({ error: 'public status not enabled' });
  const d = demoStatus();
  const maintenanceWindow = currentDemoMaintenanceWindow();
  const visible = Array.isArray(demoPrefs.config.publicPlatforms) && demoPrefs.config.publicPlatforms.length
    ? new Set(demoPrefs.config.publicPlatforms.map(String))
    : null;
  const services = publicServices(d).filter(s => !visible || visible.has(s.id));
  res.json({
    title: demoPrefs.config.publicTitle || 'OmniSight Demo Status',
    description: demoPrefs.config.publicDescription || '',
    status: 'warn',
    preferredLanguage: d.preferredLanguage,
    timestamp: d.timestamp,
    version: demoAppVersion(),
    historyEnabled: true,
    maintenance: maintenanceWindow ? {
      active: true,
      start: maintenanceWindow.start || maintenanceWindow.from || '',
      end: maintenanceWindow.end || maintenanceWindow.to || '',
      days: maintenanceWindow.days || maintenanceWindow.day || maintenanceWindow.weekdays || '',
    } : { active: false },
    services,
  });
});

app.get('/api/logs', (req, res) => res.json(demoLogs));
app.get('/api/audit', (req, res) => res.json(demoAudit));
app.get('/api/alerts/history', (req, res) => res.json(demoAlerts));
app.get('/api/alerts/timeline', (req, res) => res.json(demoAlerts));
app.get('/api/events/initial', (req, res) => res.json({ logs: demoLogs, audit: demoAudit, alerts: demoAlerts }));
app.get('/api/events/delta', (req, res) => res.json({ logs: [], audit: [], alerts: [] }));

app.get('/api/docker/logs', (req, res) => {
  const name = req.query.name || req.query.id || 'docker-container';
  res.type('text/plain').send(demoLogStream('docker', name));
});
app.get('/api/dockhand/logs', (req, res) => {
  const name = req.query.name || req.query.id || 'dockhand-container';
  res.type('text/plain').send(demoLogStream('dockhand', name));
});
app.get(['/api/portainer/logs', '/api/portainer/container/logs'], (req, res) => {
  const name = req.query.name || req.query.id || 'portainer-container';
  res.type('text/plain').send(demoLogStream('portainer', name));
});
app.get('/api/kubernetes/logs', (req, res) => {
  const name = req.query.pod || req.query.name || 'kubernetes-pod';
  const container = req.query.container ? `/${req.query.container}` : '';
  res.type('text/plain').send(demoLogStream('kubernetes', `${name}${container}`));
});

app.post('/api/topology/links', (req, res) => {
  demoTopology = {
    links: Array.isArray(req.body?.links) ? req.body.links : [],
    nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : [],
    hidden: Array.isArray(req.body?.hidden) ? req.body.hidden : [],
    spacing: req.body?.spacing && typeof req.body.spacing === 'object' ? req.body.spacing : demoTopology.spacing,
    positions: req.body?.positions && typeof req.body.positions === 'object' ? req.body.positions : {},
    view: req.body?.view && typeof req.body.view === 'object' ? req.body.view : demoTopology.view,
  };
  res.json({ ok: true, ...demoTopology });
});

app.post('/api/preferences', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.ui && typeof body.ui === 'object') {
    demoPrefs.ui = { ...demoPrefs.ui, ...body.ui };
    if (body.ui.overviewCardCollapsed && typeof body.ui.overviewCardCollapsed === 'object') {
      demoPrefs.ui.overviewCardCollapsed = { ...body.ui.overviewCardCollapsed };
    }
    if (body.ui.overviewGroupOpen && typeof body.ui.overviewGroupOpen === 'object') {
      demoPrefs.ui.overviewGroupOpen = { ...body.ui.overviewGroupOpen };
    }
    if (body.ui.userOverride && typeof body.ui.userOverride === 'object') {
      demoPrefs.ui.userOverride = { ...body.ui.userOverride };
    }
  }
  if (body.uptimekuma && typeof body.uptimekuma === 'object' && body.uptimekuma.historyHours != null) {
    demoPrefs.uptimekuma.historyHours = periodHours(body.uptimekuma.historyHours);
  }
  if (body.checks && typeof body.checks === 'object' && body.checks.historyHours != null) {
    demoPrefs.checks.historyHours = periodHours(body.checks.historyHours);
  }
  res.json({ ok: true, demo: true, ui: demoPrefs.ui, data: demoStatus() });
});
app.post(['/api/notifications', '/api/alerts/ack', '/api/alerts/mute', '/api/alerts/history/clear', '/api/logout', '/api/agent/update'], (req, res) => res.json({ ok: true, demo: true }));
app.all('/api/*', (req, res) => res.json({ ok: true, demo: true }));

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
self.addEventListener('install', event => {
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    } catch {}
    await self.clients.claim();
  })());
});
`);
});

app.use(requireDemoPageAuth);
app.use(compressedDemoStatic);
app.get('/docs.md', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('text/markdown; charset=utf-8').sendFile(path.join(__dirname, 'DOCUMENTATION.md'));
});
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => setDemoStaticCacheHeaders(res, filePath, res.req),
}));
const pageRoutes = {
  '/settings': 'settings.html',
  '/event-center': 'event-center.html',
  '/topology': 'topology.html',
  '/agents': 'agents.html',
  '/profile': 'profile.html',
  '/about': 'about.html',
  '/status': 'status.html',
  '/onboarding': 'onboarding.html',
};
for (const [route, file] of Object.entries(pageRoutes)) {
  app.get(route, (req, res) => {
    setDemoStaticCacheHeaders(res, file, req);
    res.sendFile(path.join(__dirname, 'public', file));
  });
}
app.get('/login', (req, res) => {
  setDemoStaticCacheHeaders(res, 'login.html', req);
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/', (req, res) => {
  setDemoStaticCacheHeaders(res, 'index.html', req);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`OmniSight demo running at http://localhost:${PORT}`);
  });
  server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the existing demo server or set PORT=4001 before running npm run demo.`);
      process.exit(1);
    }
    throw err;
  });
}

module.exports = { app, demoStatus, demoConfig, topologyData };
