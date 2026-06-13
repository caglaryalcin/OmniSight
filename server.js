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
const { getAllUptimeKuma, debugUptimeKuma } = require('./src/uptimekuma');
const { getPrometheusData } = require('./src/prometheus');
const { getAllDatabaseData } = require('./src/database');
const { getProxmoxApiData } = require('./src/proxmox');
const { getDockerApiData, dockerLogs: dockerApiLogs, dockerPrune: dockerApiPrune } = require('./src/docker');
const { dispatchAlert } = require('./src/alerts');
const { decryptConfig, encryptConfigValue, isEncrypted, SENSITIVE_KEYS, encryptionEnabled } = require('./src/crypto');
const { loadHistoryMap, scheduleSaveHistoryMap } = require('./src/historyStore');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

const SVC_NAME = /^[a-zA-Z0-9@._:-]+$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;
const ONE_MB = 1024 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_AVATAR_BYTES = 512 * 1024;
const MAX_CERT_BYTES = 5 * ONE_MB;
const MAX_KUBECONFIG_BYTES = ONE_MB;
const DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.OMNISIGHT_DEBUG || '').toLowerCase());

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

function writePrivateText(file, text) {
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function writePrivateYaml(file, obj) {
  writePrivateText(file, yaml.dump(obj, { lineWidth: -1 }));
}

const NOTIFY_PATH = path.join(__dirname, 'data', 'notifications.yaml');
const ALERT_HISTORY_PATH = path.join(__dirname, 'data', 'alerts.yaml');
function loadNotify() {
  try { const a = yaml.load(fs.readFileSync(NOTIFY_PATH, 'utf8')); return new Set(Array.isArray(a) ? a : (a?.disabled || [])); }
  catch { return new Set(); }
}
function saveNotify() {
  try { writePrivateYaml(NOTIFY_PATH, Array.from(notifyDisabled)); }
  catch (e) { console.warn('notifications save failed:', e.message); }
}
let notifyDisabled = loadNotify();

const ALERT_HISTORY_MAX = 2000;
function loadAlertHistory() {
  try {
    const a = yaml.load(fs.readFileSync(ALERT_HISTORY_PATH, 'utf8'));
    return Array.isArray(a) ? a.slice(-ALERT_HISTORY_MAX) : [];
  } catch { return []; }
}
function saveAlertHistory() {
  try { writePrivateYaml(ALERT_HISTORY_PATH, alertHistory.slice(-ALERT_HISTORY_MAX)); }
  catch (e) { console.warn('alerts history save failed:', e.message); }
}
let alertHistory = loadAlertHistory();
function pushAlertHistory(entry = {}) {
  const item = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex'),
    t: Date.now(),
    type: 'problem',
    severity: 'normal',
    title: '',
    message: '',
    label: '',
    detail: '',
    ...entry,
  };
  alertHistory.push(item);
  if (alertHistory.length > ALERT_HISTORY_MAX) alertHistory = alertHistory.slice(-ALERT_HISTORY_MAX);
  saveAlertHistory();
  return item;
}

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
    writePrivateYaml(SESSIONS_PATH, obj);
  } catch {}
}

const sessions = loadSessions();
const loginAttempts = new Map();

function loginRateKey(req, username) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  return `${ip}:${String(username || '').toLowerCase().slice(0, 128)}`;
}

function loginRateCheck(req, username) {
  const key = loginRateKey(req, username);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 10;
  const rec = loginAttempts.get(key) || { count: 0, first: now };
  if (now - rec.first > windowMs) {
    loginAttempts.set(key, { count: 0, first: now });
    return { ok: true, key };
  }
  if (rec.count >= maxAttempts) return { ok: false, key, retryAfter: Math.ceil((windowMs - (now - rec.first)) / 1000) };
  return { ok: true, key };
}

function loginRateFail(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { count: 0, first: now };
  rec.count += 1;
  loginAttempts.set(key, rec);
}

function auditLogin(req, username, outcome, reason = '') {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const user = String(username || '').slice(0, 128).replace(/[\r\n\t]/g, ' ');
  const msg = `[auth] login ${outcome}: user="${user || '-'}" ip=${ip}${reason ? ` reason=${reason}` : ''}`;
  if (outcome === 'success') console.log(msg);
  else console.warn(msg);
}

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

function currentSessionToken(req) {
  return req.headers['x-session-token'] || req.cookies?.session || null;
}

function reloadSessionsFromDisk() {
  const fresh = loadSessions();
  sessions.clear();
  for (const [k, v] of fresh) sessions.set(k, v);
}

function validSession(req, auth = loadAuth()) {
  const token = currentSessionToken(req);
  if (!token) return null;
  let session = sessions.get(token);
  if (!session) {
    reloadSessionsFromDisk();
    session = sessions.get(token);
  }
  const expired = !session || Date.now() >= Number(session.expires || 0);
  const stalePassword = !!(auth?.passwordChangedAt && Number(session?.created || 0) < Number(auth.passwordChangedAt || 0));
  if (expired || stalePassword) {
    sessions.delete(token);
    saveSessions(sessions);
    return null;
  }
  return { token, session };
}

function keepOnlyCurrentSession(req) {
  const token = currentSessionToken(req);
  const current = token ? sessions.get(token) : null;
  sessions.clear();
  if (token && current && Date.now() < current.expires) sessions.set(token, current);
  saveSessions(sessions);
}

const TOTP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += TOTP_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += TOTP_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=|\s|-/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = TOTP_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid 2FA secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  let n = BigInt(counter);
  for (let i = 7; i >= 0; i--) { buf[i] = Number(n & 0xffn); n >>= 8n; }
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code, windowSteps = 1) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let i = -windowSteps; i <= windowSteps; i++) {
    const candidate = hotp(secret, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) return true;
  }
  return false;
}

function totpEnabled(auth) {
  return !!(auth?.totp?.enabled && auth.totp.secret);
}

function makeTotpUri(username, secret) {
  const issuer = 'OmniSight';
  const label = `${issuer}:${username || 'admin'}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function isSecureRequest(req) {
  return !!(req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

function sessionCookieOptions(req, remember = false) {
  const opts = {
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureRequest(req),
    path: '/',
  };
  if (remember) opts.maxAge = THIRTY_DAYS;
  return opts;
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  next();
}

function sameOriginGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return res.status(403).json({ error: 'cross-site request blocked' });
  }
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const got = new URL(origin);
    const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const expectedProto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
    if (got.host === expectedHost && got.protocol === `${expectedProto}:`) return next();
  } catch {}
  return res.status(403).json({ error: 'cross-origin request blocked' });
}

function readBase64Payload(dataUrl, maxBytes) {
  if (!dataUrl || typeof dataUrl !== 'string') throw new Error('No file content');
  const m = dataUrl.match(/^data:[^;]+;base64,([A-Za-z0-9+/=\s]+)$/);
  const b64 = (m ? m[1] : dataUrl).replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('Invalid base64 content');
  const approx = Math.floor((b64.length * 3) / 4);
  if (approx > maxBytes) throw new Error(`File is too large. Maximum size is ${Math.round(maxBytes / 1024)} KB`);
  return Buffer.from(b64, 'base64');
}

function isSafeSvg(buf) {
  const s = buf.toString('utf8', 0, Math.min(buf.length, 256 * 1024)).toLowerCase();
  return !/<\s*(script|foreignobject|iframe|object|embed|link|base)\b/.test(s)
    && !/\son[a-z]+\s*=/.test(s)
    && !/(javascript:|data:text\/html|<!doctype|<!entity)/.test(s);
}

function normalizeAvatarDataUrl(dataUrl) {
  if (!dataUrl) return '';
  const raw = String(dataUrl);
  const mime = (raw.match(/^data:([^;]+);base64,/i)?.[1] || '').toLowerCase();
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
  if (!allowed.has(mime)) throw new Error('Use PNG, JPG, WebP or SVG');
  const buf = readBase64Payload(raw, MAX_AVATAR_BYTES);
  if (mime === 'image/svg+xml' && !isSafeSvg(buf)) throw new Error('SVG contains unsafe active content');
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function publicProfile(auth) {
  return {
    username: auth?.username || null,
    avatar: typeof auth?.avatar === 'string' ? auth.avatar : '',
  };
}

function authMiddleware(req, res, next) {
  const auth = loadAuth();
  if (req.path.startsWith('/assets/')) return next();
  if (req.path.startsWith('/api/icons/')) return next();
  if (req.path.startsWith('/agent/') || ['/api/agent/report', '/api/agent/result', '/api/agent/commands'].includes(req.path)) return next();
  if (validSession(req, auth)) return next();
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
let refreshGeneration = 0;

const PLATFORM_HISTORY_MAX = 1440;
const PLATFORM_HISTORY = Object.fromEntries(loadHistoryMap('platform-history', PLATFORM_HISTORY_MAX));
function savePlatformHistory() {
  scheduleSaveHistoryMap('platform-history', new Map(Object.entries(PLATFORM_HISTORY)), PLATFORM_HISTORY_MAX);
}

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
    return normalizeDockerRow(prev ? { ...row, ...prev, source: row.source, name: row.name, host: prev.host || row.host } : row);
  });
  const configuredNames = new Set(configured.map(h => h.name));
  return [...configured, ...agentRows.filter(h => !configuredNames.has(h.name)).map(normalizeDockerRow)];
}

function normalizeDockerRow(row) {
  if (!row || typeof row !== 'object') return row;
  if (!row.online) return row;
  return { ...row, _connecting: false };
}

function normalizeDockerRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeDockerRow) : rows;
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

function findPreviousOnlineDockerRow(prevRows, next) {
  return prevRows.find(row => row?.online && sameDockerRow(row, next))
    || prevRows.find(row => row?.online && row?.name && next?.name && String(row.name).toLowerCase() === String(next.name).toLowerCase());
}

function keepPreviousDockerRow(prev, next, now) {
  if (!prev) return null;
  const staleSince = prev._staleSince || now;
  if (now - staleSince > STALE_KEEP_MS) return null;
  return {
    ...prev,
    _connecting: false,
    _stale: true,
    _staleSince: staleSince,
    error: next?._connecting ? 'refresh in progress' : (next?.error || 'temporary Docker refresh failure'),
  };
}

function preserveDockerOnTransient(nextRows) {
  nextRows = normalizeDockerRows(nextRows);
  const prevRows = Array.isArray(cache.data?.docker) ? cache.data.docker : [];
  if (!Array.isArray(nextRows) || !prevRows.length) return nextRows;
  const prevOnline = prevRows.filter(row => row?.online);
  if (!prevOnline.length) return nextRows;
  const configured = dockerConfigRows();
  if (!nextRows.length && configured.length) {
    const now = Date.now();
    const kept = prevOnline
      .filter(row => configured.some(cfg => sameDockerRow(cfg, row)))
      .map(row => keepPreviousDockerRow(row, { error: 'temporary Docker refresh failure' }, now))
      .filter(Boolean);
    if (kept.length) return kept;
  }
  const now = Date.now();
  return nextRows.map(next => {
    if (!next || next.online) return normalizeDockerRow(next);
    const isKnownConfigured = configured.some(row => sameDockerRow(row, next));
    const prev = findPreviousOnlineDockerRow(prevOnline, next);
    if (!isKnownConfigured && !prev) return next;
    return keepPreviousDockerRow(prev, next, now) || next;
  });
}

const DOCKER_HISTORY_MAX = 5760;
const dockerHistory = loadHistoryMap('docker-history', DOCKER_HISTORY_MAX);
function dockerHistoryKey(row = {}) {
  return dockerRowKeys(row)[0] || String(row.name || row.host || 'docker');
}
function mergeDockerHistory(nextRows) {
  const rows = normalizeDockerRows(nextRows);
  if (!Array.isArray(rows)) return rows;
  const prevRows = Array.isArray(cache.data?.docker) ? cache.data.docker : [];
  const now = Date.now();
  let changed = false;
  const merged = rows.map(row => {
    if (!row || !row.online) return row;
    const prev = findPreviousOnlineDockerRow(prevRows, row);
    let history = Array.isArray(row.history)
      ? row.history.slice()
      : (Array.isArray(prev?.history) ? prev.history.slice() : dockerHistory.get(dockerHistoryKey(row)) || []);
    if (!row._stale && !row._connecting) {
      const point = { time: now };
      if (Number.isFinite(Number(row.summary?.cpu))) point.cpu = Number(row.summary.cpu);
      if (Number.isFinite(Number(row.summary?.memPercent))) point.mem = Number(row.summary.memPercent);
      if (point.cpu != null || point.mem != null) {
        const last = history[history.length - 1];
        if (!last || now - Number(last.time || 0) > REFRESH_INTERVAL / 2) {
          if (!history.length) history.push({ ...point, time: now - REFRESH_INTERVAL });
          history.push(point);
          changed = true;
        }
      }
    }
    if (history.length > DOCKER_HISTORY_MAX) history = history.slice(-DOCKER_HISTORY_MAX);
    dockerHistory.set(dockerHistoryKey(row), history);
    return { ...row, history };
  });
  if (changed) scheduleSaveHistoryMap('docker-history', dockerHistory, DOCKER_HISTORY_MAX);
  return merged;
}

async function getProxmoxData() {
  if (hasProxmoxApi()) return getProxmoxApiData({ ...config.proxmox, excludedServices: config.excludedServices });
  return agents.getProxmoxData({ excludedServices: config.excludedServices });
}

function normalizedHostKeys(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return [];
  const keys = new Set([raw]);
  const withoutProto = raw.replace(/^[a-z]+:\/\//, '');
  keys.add(withoutProto);
  const hostPart = withoutProto.split('/')[0];
  if (hostPart) keys.add(hostPart);
  if (hostPart.includes(':')) keys.add(hostPart.replace(/:\d+$/, ''));
  return [...keys].filter(Boolean);
}

function addProxmoxLinuxKeys(keys, value) {
  normalizedHostKeys(value).forEach(k => keys.add(k));
}

function proxmoxLinuxKeys(proxmoxData = cache.data?.proxmox) {
  const keys = new Set();
  (config.proxmox?.sshMetrics || []).forEach(h => {
    addProxmoxLinuxKeys(keys, h.node || h.name);
    addProxmoxLinuxKeys(keys, h.sshHost);
  });
  (proxmoxData?.nodes || []).forEach(n => {
    addProxmoxLinuxKeys(keys, n.node?.name || n.name);
    addProxmoxLinuxKeys(keys, n.host);
  });
  return keys;
}

function filterLinuxProxmoxRows(rows = [], proxmoxData = cache.data?.proxmox) {
  const keys = proxmoxLinuxKeys(proxmoxData);
  if (!keys.size) return rows;
  return rows.filter(row => {
    if (row._connecting) return true;
    const vals = [row.id, row.name, row.host, row.ip].flatMap(normalizedHostKeys);
    return !vals.some(v => keys.has(v));
  });
}

function getLinuxData(proxmoxData = cache.data?.proxmox) {
  return filterLinuxProxmoxRows(
    agents.getAllAgentData({ ...config.linux, excludedServices: config.excludedServices }),
    proxmoxData,
  );
}

async function getDockerData() {
  const apiData = hasDockerApi() ? await getDockerApiData(config.docker) : [];
  const agentData = agents.getDockerData();
  const names = new Set(apiData.map(h => h.name));
  return [...apiData, ...agentData.filter(h => !names.has(h.name))];
}

function defaultTimePeriodHours() {
  return uptimeKumaHistoryHours(config.defaultTimePeriodHours || config.defaultPeriodHours || config.historyHours || 1);
}

function uptimeKumaConfig() {
  if (!config.uptimekuma) return config.uptimekuma;
  return {
    ...config.uptimekuma,
    historyHours: uptimeKumaHistoryHours(config.uptimekuma.historyHours || defaultTimePeriodHours()),
  };
}

function assignStatic(base) {
  base.publicStatus = !!config.publicStatus;
  base.configured = configuredList();
  base.notifyDisabled = Array.from(notifyDisabled);
  base.timeFormat = config.timeFormat || '24h';
  base.defaultTimePeriodHours = defaultTimePeriodHours();
  base.preferredLanguage = config.preferredLanguage || 'en';
  base.appearance = {
    dashboardSidePanel: config.appearance?.dashboardSidePanel !== false,
  };
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
  const add = (key, ok, label, detail, extra = {}) => m.set(key, { ok, label, detail, ...extra });
  const thresholds = alertThresholds();
  const addPct = (key, label, metric, value, threshold) => {
    const pct = pctNumber(value);
    if (pct == null || threshold == null) return;
    const severity = thresholdSeverity(pct, threshold);
    const thresholdValue = severity ? threshold[severity] : threshold.warning;
    add(key, !severity, `${label} ${metric}`, severity ? `${pct}% (${severity} ${thresholdValue}%)` : `${pct}%`, {
      kind: 'threshold',
      value: pct,
      threshold: thresholdValue,
      thresholds: threshold,
      severity: severity || 'normal',
      metric,
    });
  };
  (data.proxmox?.nodes || []).forEach(n => {
    if (n._connecting) return;
    const nm = n.node?.name || n.name || 'node';
    add('px:' + nm, !!n.node?.online, 'Proxmox node ' + nm, 'offline');
    if (n.node?.online) {
      addPct('px:' + nm + ':cpu', 'Proxmox node ' + nm, 'CPU usage', n.node?.cpu, thresholds.cpu);
      addPct('px:' + nm + ':ram', 'Proxmox node ' + nm, 'RAM usage', n.node?.ram?.percent, thresholds.ram);
      (n.storage || []).forEach(st => {
        if (st && st.active !== false) addPct('px:' + nm + ':storage:' + (st.name || 'storage'), 'Proxmox node ' + nm + ' storage ' + (st.name || 'storage'), 'disk usage', st.percent, thresholds.disk);
      });
      (n.services || []).forEach(s => {
        if (!s.excluded) add('px:' + nm + ':' + s.name, !!s.active, 'Proxmox ' + nm + ' / ' + s.name, 'inactive');
      });
    }
  });
  (data.linux || []).forEach(l => {
    if (l._connecting) return;
    add('lx:' + l.name, !!l.online, 'Server ' + l.name, 'unreachable');
    if (l.online) {
      addPct('lx:' + l.name + ':cpu', 'Server ' + l.name, 'CPU usage', l.cpu, thresholds.cpu);
      addPct('lx:' + l.name + ':ram', 'Server ' + l.name, 'memory usage', l.ram?.percent, thresholds.ram);
      addPct('lx:' + l.name + ':disk', 'Server ' + l.name, 'disk usage', l.disk?.percent, thresholds.disk);
      (l.services || []).forEach(s => {
        if (!s.excluded) add('lx:' + l.name + ':' + s.name, !!s.active, l.name + ' / ' + s.name, 'inactive');
      });
    }
  });
  const k = data.kubernetes;
  if (k && k.online !== undefined) {
    add('k8s', !!k.online, 'Kubernetes', 'unreachable');
    if (k.online) (k.pods || []).forEach(p => {
      const ok = p.running || p.phase === 'Succeeded';
      const detail = [p.phase, p.ready === false ? 'not ready' : '', p.restarts ? `${p.restarts} restarts` : ''].filter(Boolean).join(' / ');
      add('k8s:' + p.namespace + '/' + p.name, ok, 'Pod ' + p.namespace + '/' + p.name, detail || p.phase);
    });
  }
  (data.snmp || []).forEach(s => {
    add('snmp:' + s.name, !!s.online, 'SNMP ' + s.name, 'unreachable');
    if (s.online) {
      addPct('snmp:' + s.name + ':cpu', 'SNMP ' + s.name, 'CPU usage', s.cpu, thresholds.cpu);
      addPct('snmp:' + s.name + ':ram', 'SNMP ' + s.name, 'RAM usage', s.ram?.percent, thresholds.ram);
      (s.volumes || []).forEach(v => addPct('snmp:' + s.name + ':volume:' + (v.name || 'volume'), 'SNMP ' + s.name + ' volume ' + (v.name || 'volume'), 'disk usage', v.percent, thresholds.disk));
    }
  });
  (data.docker || []).forEach(h => {
    if (h._connecting) return;
    add('dk:' + h.name, !!h.online, 'Docker host ' + h.name, 'unreachable');
    if (h.online) (h.containers || []).forEach(c => {
      const ok = c.state === 'running';
      add('dk:' + h.name + ':' + c.name, ok, 'Container ' + c.name + ' @ ' + h.name, c.state);
    });
  });
  const hc = data.healthchecks;
  if (hc && Array.isArray(hc.checks)) hc.checks.forEach(c => {
    const nm = c.name || c.slug;
    add('hc:' + nm, c.status !== 'down', 'Healthcheck ' + nm, c.status);
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

const ALERT_STARTUP_GRACE_MS = 60000;
let prevChecks = null;
const alertFirstSeen = new Map();
function pctNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}
function thresholdValue(value, fallback = 80) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(100, Math.round(n)));
}
function thresholdPair(value, warningFallback = 80, criticalFallback = 90) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const warning = thresholdValue(value.warning ?? value.warn ?? value.value, warningFallback);
    const critical = thresholdValue(value.critical ?? value.crit, criticalFallback);
    return { warning, critical: Math.max(warning, critical) };
  }
  const warning = thresholdValue(value, warningFallback);
  return { warning, critical: Math.max(warning, criticalFallback) };
}
function thresholdSeverity(value, pair) {
  if (!pair) return null;
  if (value >= pair.critical) return 'critical';
  if (value >= pair.warning) return 'warning';
  return null;
}
function alertThresholds() {
  const t = config.alerts?.thresholds || {};
  return {
    cpu: thresholdPair(t.cpu, 80, 90),
    ram: thresholdPair(t.ram ?? t.memory, 80, 90),
    disk: thresholdPair(t.disk, 80, 90),
  };
}
function logAlertResult(rs) {
  (rs || []).forEach(r => { if (!r.ok) console.warn(`Alert ${r.channel} failed: ${r.error}`); });
}
function dispatchTrackedAlert(alertConfig, alert, meta = {}, only) {
  const entry = pushAlertHistory({
    ...meta,
    title: alert.title || '',
    message: alert.message || '',
    priority: alert.priority || '',
    tags: alert.tags || '',
    status: 'sending',
    channels: [],
  });
  dispatchAlert(alertConfig, alert, only)
    .then(results => {
      entry.channels = results;
      entry.status = results.length && results.every(r => !r.ok) ? 'failed' : 'sent';
      saveAlertHistory();
      logAlertResult(results);
    })
    .catch(err => {
      entry.status = 'failed';
      entry.error = err.message || String(err);
      saveAlertHistory();
    });
}
function runAlertChecks(data) {
  if (!config.alerts || config.alerts.enabled === false) return;
  const cur = extractChecks(data);
  const now = Date.now();
  for (const key of Array.from(alertFirstSeen.keys())) {
    if (!cur.has(key)) alertFirstSeen.delete(key);
  }
  for (const key of cur.keys()) {
    if (!alertFirstSeen.has(key)) alertFirstSeen.set(key, now);
  }
  if (prevChecks === null) { prevChecks = cur; return; }
  const sendProblem = c => {
    const threshold = c.kind === 'threshold';
    const critical = !threshold || c.severity === 'critical';
    dispatchTrackedAlert(config.alerts, {
      title: threshold
        ? `${critical ? '\u{1F534} CRITICAL' : '\u26A0\uFE0F WARNING'} \u2014 ${c.label}`
        : `\u{1F534} DOWN \u2014 ${c.label}`,
      message: threshold
        ? `${c.label} is ${c.severity}: ${c.detail}\n${new Date().toLocaleString()}`
        : `${c.label} is ${c.detail || 'down'}\n${new Date().toLocaleString()}`,
      priority: critical ? 'high' : 'default', tags: critical ? 'rotating_light' : 'warning',
    }, {
      type: 'problem',
      severity: threshold ? c.severity : 'critical',
      key: c.key,
      label: c.label,
      detail: c.detail,
      metric: c.metric || '',
      value: c.value ?? null,
      threshold: c.threshold ?? null,
    });
  };
  const sendRecovery = c => {
    const threshold = c.kind === 'threshold';
    dispatchTrackedAlert(config.alerts, {
      title: threshold ? `\u{1F7E2} NORMAL \u2014 ${c.label}` : `\u{1F7E2} UP \u2014 ${c.label}`,
      message: threshold
        ? `${c.label} is back below threshold\n${new Date().toLocaleString()}`
        : `${c.label} recovered\n${new Date().toLocaleString()}`,
      priority: 'default', tags: 'white_check_mark',
    }, {
      type: 'recovery',
      severity: 'normal',
      key: c.key,
      label: c.label,
      detail: c.detail,
      metric: c.metric || '',
      value: c.value ?? null,
      threshold: c.threshold ?? null,
    });
  };
  for (const [key, c] of cur) {
    c.key = key;
    if (notifyDisabled.has(key)) continue;
    if (now - (alertFirstSeen.get(key) || now) < ALERT_STARTUP_GRACE_MS) continue;
    const p = prevChecks.get(key);
    if (!p) {
      if (!c.ok) sendProblem(c);
      continue;
    }
    if (!c.ok && (p.ok || p.severity !== c.severity)) {
      sendProblem(c);
    } else if (!p.ok && c.ok) {
      sendRecovery(c);
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

const UPTIME_KUMA_HISTORY_MAX = 6000;
const uptimeKumaHistory = loadHistoryMap('uptimekuma-history', UPTIME_KUMA_HISTORY_MAX);
function heartbeatKey(h) {
  return [h?.time || '', h?.status || '', h?.ping ?? '', h?.message || ''].join('|');
}
function uptimeKumaHistoryHours(value) {
  const hours = Number(value || 1);
  if (!Number.isFinite(hours) || hours <= 0) return 1;
  return Math.min(Math.max(hours, 0.25), 24);
}
function mergeHeartbeatHistory(prevHistory = [], nextHistory = [], hours = 1) {
  const cutoff = Date.now() - (uptimeKumaHistoryHours(hours) * 60 * 60 * 1000);
  const byKey = new Map();
  [...prevHistory, ...nextHistory].forEach(h => {
    if (!h) return;
    byKey.set(heartbeatKey(h), h);
  });
  const sorted = [...byKey.values()]
    .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
  const recent = sorted.filter(h => {
    const t = new Date(h?.time || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  return (recent.length ? recent : sorted)
    .slice(-UPTIME_KUMA_HISTORY_MAX);
}
function uptimeKumaMonitorKeys(m = {}) {
  return [m.id, m.name, m.url].filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(v => String(v));
}
function uptimeKumaHistoryKey(m = {}) {
  return uptimeKumaMonitorKeys(m)[0] || 'monitor';
}
function observedUptimeKumaHeartbeat(m = {}, now = Date.now()) {
  if (!m.status) return null;
  return {
    status: m.status,
    time: new Date(now).toISOString(),
    ping: m.ping ?? null,
    message: m.message || '',
    source: 'omnisight',
  };
}
function mergeUptimeKumaHistory(next) {
  const prev = cache.data?.uptimekuma;
  if (!next?.monitors?.length) return next;
  const hours = uptimeKumaHistoryHours(next.historyHours || uptimeKumaConfig()?.historyHours || defaultTimePeriodHours());
  const keepHours = 24;
  const prevByKey = new Map();
  (prev?.monitors || []).forEach(m => {
    uptimeKumaMonitorKeys(m).forEach(k => prevByKey.set(k, m));
  });
  let changed = false;
  const now = Date.now();
  const monitors = next.monitors.map(m => {
    const keys = uptimeKumaMonitorKeys(m);
    const old = keys.map(k => prevByKey.get(k)).find(Boolean);
    const storeKey = uptimeKumaHistoryKey(m);
    const stored = uptimeKumaHistory.get(storeKey) || [];
    const observed = observedUptimeKumaHeartbeat(m, now);
    const lastStored = stored[stored.length - 1];
    const lastTime = new Date(lastStored?.time || 0).getTime();
    const addObserved = observed && (!lastStored || !Number.isFinite(lastTime) || now - lastTime > REFRESH_INTERVAL / 2);
    const history = mergeHeartbeatHistory(stored, old?.history || [], keepHours);
    const withLive = mergeHeartbeatHistory(history, [...(m.history || []), ...(addObserved ? [observed] : [])], keepHours);
    uptimeKumaHistory.set(storeKey, withLive);
    if (addObserved || (m.history || []).length) changed = true;
    return { ...m, history: withLive };
  });
  if (changed) scheduleSaveHistoryMap('uptimekuma-history', uptimeKumaHistory, UPTIME_KUMA_HISTORY_MAX);
  return {
    ...next,
    historyHours: hours,
    monitors,
  };
}
function preserveUptimeKumaOnTransient(next, err) {
  const prev = cache.data?.uptimekuma;
  const hasPrevious = prev?.online && Array.isArray(prev.monitors) && prev.monitors.length;
  if (!hasPrevious) return next;
  if (!next && !err) return next;
  if (next?._connecting) {
    return { ...prev, _stale: true, _staleSince: prev._staleSince || Date.now(), error: 'refresh in progress' };
  }
  const looksTransient = !next?.online && (next?.error || err);
  if (!looksTransient) return { ...next, _stale: false, _staleSince: null, error: undefined };
  const now = Date.now();
  const staleSince = prev._staleSince || now;
  if (now - staleSince > STALE_KEEP_MS) return next;
  return {
    ...prev,
    _stale: true,
    _staleSince: staleSince,
    error: next?.error || err?.message || 'temporary Uptime Kuma refresh failure',
  };
}

function backgroundRefresh(opts = {}) {
  const force = opts === true || opts.force === true;
  if (refreshPromise && !force) return refreshPromise;
  if (force) {
    refreshGeneration += 1;
    refreshPromise = null;
  }
  const enabled = c => c && c.enabled !== false;
  if (!cache.data) cache.data = { timestamp: new Date().toISOString(), proxmox: { clusterSummary: null, nodes: [] }, linux: [], kubernetes: null, snmp: [], healthchecks: null, uptimekuma: null, prometheus: null, docker: [], database: [], publicStatus: false, loading: true };
  const base = cache.data;
  const generation = refreshGeneration;
  assignStatic(base);
  const tasks = [
    ['proxmox',      enabled(config.proxmox)      ? getProxmoxData() : Promise.resolve({ clusterSummary: null, nodes: [] }), { clusterSummary: null, nodes: [] }],
    ['linux',        enabled(config.linux)        ? Promise.resolve(getLinuxData()) : Promise.resolve([]),   []],
    ['kubernetes',   enabled(config.kubernetes)   ? getAllKubernetesData(config.kubernetes)  : Promise.resolve(null), null],
    ['snmp',         enabled(config.snmp)         ? getAllSynologyData(config.snmp)          : Promise.resolve([]),   []],
    ['healthchecks', enabled(config.healthchecks) ? getAllHealthchecks(config.healthchecks) : Promise.resolve(null), null],
    ['uptimekuma',   enabled(config.uptimekuma)   ? getAllUptimeKuma(uptimeKumaConfig())     : Promise.resolve(null), null],
    ['prometheus',   enabled(config.prometheus)   ? getPrometheusData(config.prometheus)    : Promise.resolve(null), null],
    ['docker',       enabled(config.docker)       ? getDockerData()  : Promise.resolve([]),   []],
    ['database',     enabled(config.database)     ? getAllDatabaseData(config.database)      : Promise.resolve([]),   []],
  ];
  const ps = tasks.map(([key, p, fb]) =>
    p.then(v => {
      if (generation !== refreshGeneration) return;
      const next = (v == null ? fb : v);
      base[key] = key === 'proxmox' ? preserveProxmoxOnTransient(next)
        : key === 'docker' ? mergeDockerHistory(preserveDockerOnTransient(next))
        : key === 'uptimekuma' ? preserveUptimeKumaOnTransient(mergeUptimeKumaHistory(next))
        : next;
      base.timestamp = new Date().toISOString();
    })
     .catch(err => {
       if (generation !== refreshGeneration) return;
       if (key === 'proxmox') {
         base[key] = preserveProxmoxOnTransient(fb, err);
         if (base[key]?._stale) console.warn(`Proxmox refresh failed; keeping last data: ${err.message}`);
       } else if (key === 'docker') {
         base[key] = mergeDockerHistory(preserveDockerOnTransient(fb));
         if ((base[key] || []).some(h => h._stale)) console.warn(`Docker refresh failed; keeping last data: ${err.message}`);
       } else if (key === 'uptimekuma') {
         base[key] = preserveUptimeKumaOnTransient(fb, err);
         if (base[key]?._stale) console.warn(`Uptime Kuma refresh failed; keeping last data: ${err.message}`);
       } else {
         base[key] = fb;
       }
     })
  );
  refreshPromise = Promise.allSettled(ps)
    .then(() => { 
      if (generation !== refreshGeneration) return;
      base.linux = filterLinuxProxmoxRows(base.linux, base.proxmox);
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
        if (PLATFORM_HISTORY[s.id].length > PLATFORM_HISTORY_MAX) PLATFORM_HISTORY[s.id].splice(0, PLATFORM_HISTORY[s.id].length - PLATFORM_HISTORY_MAX);
      });
      savePlatformHistory();
    })
    .catch(err => { console.error(err.message); })
    .finally(() => { if (generation === refreshGeneration) refreshPromise = null; });
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

function uptimeKumaHistoryEmpty(data) {
  const monitors = data?.uptimekuma?.monitors;
  return Array.isArray(monitors) && monitors.length > 0 && monitors.every(m => !Array.isArray(m.history) || m.history.length === 0);
}

function applyUptimeKumaLive(live) {
  if (!live?.monitors?.length) return false;
  const merged = mergeUptimeKumaHistory(live);
  const hasHistory = merged.monitors.some(m => Array.isArray(m.history) && m.history.length > 0);
  if (!hasHistory) return false;
  if (!cache.data) cache.data = { ...EMPTY, timestamp: new Date().toISOString() };
  cache.data.uptimekuma = merged;
  cache.data.timestamp = new Date().toISOString();
  return true;
}

function uptimeKumaComparable(c = {}) {
  if (!c) return null;
  return {
    enabled: c.enabled !== false,
    url: c.url || '',
    slug: c.slug || '',
    apiKey: c.apiKey || '',
    username: c.username || '',
    password: c.password || '',
    authToken: c.authToken || '',
    historyHours: uptimeKumaHistoryHours(c.historyHours || 1),
    insecureTLS: c.insecureTLS === true || String(c.insecureTLS || '').toLowerCase() === 'true',
    socketPath: c.socketPath || '',
    socketTransport: c.socketTransport || '',
  };
}

function uptimeKumaConfigChanged(prev, next) {
  return JSON.stringify(uptimeKumaComparable(prev)) !== JSON.stringify(uptimeKumaComparable(next));
}

async function refreshUptimeKumaNow() {
  if (!config.uptimekuma || config.uptimekuma.enabled === false) return false;
  const live = await getAllUptimeKuma(uptimeKumaConfig());
  if (!cache.data) cache.data = { ...EMPTY, timestamp: new Date().toISOString() };
  const merged = mergeUptimeKumaHistory(live);
  cache.data.uptimekuma = merged;
  cache.data.timestamp = new Date().toISOString();
  assignStatic(cache.data);
  return true;
}

async function healUptimeKumaHistoryIfEmpty() {
  if (!cache.data || !config.uptimekuma) return;
  if (!uptimeKumaHistoryEmpty(cache.data)) return;
  try {
    const live = await getAllUptimeKuma(uptimeKumaConfig());
    applyUptimeKumaLive(live);
  } catch (err) {
    console.warn(`Uptime Kuma history self-heal failed: ${err.message}`);
  }
}

backgroundRefresh();
setInterval(backgroundRefresh, REFRESH_INTERVAL);

app.use(securityHeaders);
app.use(express.json({ limit: '5mb' }));
app.use(parseCookies);
app.use(sameOriginGuard);

function isLoopbackRequest(req) {
  const addr = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost';
}

app.get('/api/debug/docker', async (req, res, next) => {
  if (!DEBUG_ENABLED || !isLoopbackRequest(req)) return next();
  try {
    const started = Date.now();
    const live = await getDockerData();
    const configured = (config.docker?.hosts || []).map(h => ({
      type: h.type || (h.sshHost ? 'ssh' : 'api'),
      name: dockerConfigHostName(h),
      target: dockerConfigHostTarget(h),
      sshMode: h.sshMode || '',
      sudo: h.sudo === undefined ? 'auto' : !!h.sudo,
    }));
    res.json({
      ok: true,
      ms: Date.now() - started,
      refreshing: !!refreshPromise,
      configured,
      cache: normalizeDockerRows(cache.data?.docker || []),
      live: normalizeDockerRows(live),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.post('/api/login', (req, res) => {
  const auth = loadAuth();
  if (!auth) return res.json({ ok: true });
  const { username, password, code } = req.body || {};
  if (!username || !password) {
    auditLogin(req, username, 'failed', 'missing_credentials');
    return res.status(400).json({ error: 'Missing credentials' });
  }
  const rate = loginRateCheck(req, username);
  if (!rate.ok) {
    auditLogin(req, username, 'failed', 'rate_limited');
    return res.status(429).json({ error: 'Too many login attempts. Try again later.', retryAfter: rate.retryAfter });
  }
  if (username !== auth.username) {
    loginRateFail(rate.key);
    auditLogin(req, username, 'failed', 'unknown_user');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  try {
    if (!verifyPassword(password, auth.hash, auth.salt)) {
      loginRateFail(rate.key);
      auditLogin(req, username, 'failed', 'invalid_password');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch {
    loginRateFail(rate.key);
    auditLogin(req, username, 'failed', 'password_check_error');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (totpEnabled(auth)) {
    if (!code) {
      auditLogin(req, username, 'failed', 'two_factor_required');
      return res.status(401).json({ error: 'Two-factor code required', twoFactorRequired: true });
    }
    let totpOk = false;
    try { totpOk = verifyTotp(auth.totp.secret, code); } catch {}
    if (!totpOk) {
      loginRateFail(rate.key);
      auditLogin(req, username, 'failed', 'invalid_two_factor');
      return res.status(401).json({ error: 'Invalid two-factor code', twoFactorRequired: true });
    }
  }
  const token = genToken();
  const remember = req.body.remember === true;
  const expires = Date.now() + (remember ? THIRTY_DAYS : 24 * 60 * 60 * 1000);
  sessions.set(token, { username, created: Date.now(), expires });
  saveSessions(sessions);
  loginAttempts.delete(rate.key);
  res.cookie('session', token, sessionCookieOptions(req, remember));
  auditLogin(req, username, 'success');
  res.json({ ok: true, token });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'] || req.cookies?.session;
  if (token) { sessions.delete(token); saveSessions(sessions); }
  res.clearCookie('session', sessionCookieOptions(req));
  res.json({ ok: true });
});

app.get('/api/auth-status', (req, res) => {
  const auth = loadAuth();
  res.json({
    required: !!auth,
    authenticated: !!(auth && validSession(req, auth)),
    username: auth?.username || null,
    twoFactorEnabled: totpEnabled(auth),
  });
});

app.get('/api/profile', (req, res) => {
  const auth = loadAuth();
  if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
  res.json(publicProfile(auth));
});

app.post('/api/profile/avatar', (req, res) => {
  try {
    const auth = loadAuth();
    if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
    const avatar = normalizeAvatarDataUrl(req.body?.dataUrl || '');
    const nextAuth = { ...auth };
    if (avatar) nextAuth.avatar = avatar;
    else delete nextAuth.avatar;
    writePrivateYaml(AUTH_PATH, nextAuth);
    res.json(publicProfile(nextAuth));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
  const nextAuth = { username: finalUsername, hash, salt };
  if (password) nextAuth.passwordChangedAt = Date.now();
  else if (auth?.passwordChangedAt) nextAuth.passwordChangedAt = auth.passwordChangedAt;
  if (auth?.totp) nextAuth.totp = auth.totp;
  if (auth?.avatar) nextAuth.avatar = auth.avatar;
  writePrivateYaml(AUTH_PATH, nextAuth);
  res.json({ ok: true });
});

app.post('/api/2fa/setup', (req, res) => {
  const auth = loadAuth();
  if (!auth) return res.status(400).json({ error: 'Password setup required first' });
  const secret = base32Encode(crypto.randomBytes(20));
  res.json({ ok: true, secret, otpauth: makeTotpUri(auth.username, secret), enabled: totpEnabled(auth) });
});

app.post('/api/2fa/enable', (req, res) => {
  const auth = loadAuth();
  const { currentPassword, code, secret } = req.body || {};
  if (!auth) return res.status(400).json({ error: 'Password setup required first' });
  if (!currentPassword || !secret || !code) return res.status(400).json({ error: 'Current password, secret and code are required' });
  try {
    if (!verifyPassword(currentPassword, auth.hash, auth.salt)) return res.status(401).json({ error: 'Wrong current password' });
    if (!verifyTotp(secret, code)) return res.status(400).json({ error: 'Invalid two-factor code' });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not enable two-factor authentication' });
  }
  writePrivateYaml(AUTH_PATH, { ...auth, totp: { enabled: true, secret } });
  keepOnlyCurrentSession(req);
  res.json({ ok: true, enabled: true });
});

app.post('/api/2fa/disable', (req, res) => {
  const auth = loadAuth();
  const { currentPassword, code } = req.body || {};
  if (!auth) return res.status(400).json({ error: 'Password setup required first' });
  if (!totpEnabled(auth)) return res.json({ ok: true, enabled: false });
  if (!currentPassword || !code) return res.status(400).json({ error: 'Current password and code are required' });
  try {
    if (!verifyPassword(currentPassword, auth.hash, auth.salt)) return res.status(401).json({ error: 'Wrong current password' });
    if (!verifyTotp(auth.totp.secret, code)) return res.status(400).json({ error: 'Invalid two-factor code' });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not disable two-factor authentication' });
  }
  const nextAuth = { ...auth };
  delete nextAuth.totp;
  writePrivateYaml(AUTH_PATH, nextAuth);
  res.json({ ok: true, enabled: false });
});

app.get('/api/status', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    await healUptimeKumaHistoryIfEmpty();
    res.json(await getCachedData());
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/refresh', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const waitMs = Math.min(Math.max(Number(req.query.wait || 700), 0), 1000);
    const refresh = backgroundRefresh({ force: true });
    if (waitMs > 0) {
      await Promise.race([
        refresh.catch(() => {}),
        new Promise(resolve => setTimeout(resolve, waitMs)),
      ]);
    }
    res.json({ ...(await getCachedData()), refreshing: !!refreshPromise });
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

app.post('/api/config', async (req, res) => {
  try {
    const incoming = req.body;
    const existing = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};
    const previousConfig = config;

    if (existing.excludedServices) {
      incoming.excludedServices = existing.excludedServices;
    }

    const merged = mergePreservingSecrets(incoming, existing);
	if (merged.timezone) process.env.TZ = merged.timezone;
    const toSave = encryptionEnabled() ? encryptConfigObj(merged) : merged;
    writePrivateYaml(CONFIG_PATH, toSave);
    config = loadConfig();
    refreshGeneration += 1;
    refreshPromise = null;
    const uptimeKumaChanged = uptimeKumaConfigChanged(previousConfig?.uptimekuma, config.uptimekuma);

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
        cache.data.linux = getLinuxData(cache.data.proxmox);
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
        cache.data.docker = mergeDockerHistory(mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData()));
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

    if (uptimeKumaChanged && config.uptimekuma && config.uptimekuma.enabled !== false) {
      try {
        await refreshUptimeKumaNow();
      } catch (err) {
        console.warn(`Uptime Kuma immediate refresh failed: ${err.message}`);
      }
    }

    if (!refreshPromise) backgroundRefresh();

    res.json({ ok: true, data: cache.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/preferences', async (req, res) => {
  try {
    const incoming = req.body || {};
    const existing = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};
    const previousUptimeKuma = config.uptimekuma ? { ...config.uptimekuma } : null;

    if (incoming.preferredLanguage !== undefined) {
      const lang = String(incoming.preferredLanguage || 'en').toLowerCase();
      existing.preferredLanguage = ['en', 'tr'].includes(lang) ? lang : 'en';
    }

    if (incoming.defaultTimePeriodHours !== undefined) {
      existing.defaultTimePeriodHours = uptimeKumaHistoryHours(incoming.defaultTimePeriodHours);
    }

    if (incoming.uptimekuma && typeof incoming.uptimekuma === 'object' && incoming.uptimekuma.historyHours !== undefined) {
      existing.uptimekuma = existing.uptimekuma || {};
      existing.uptimekuma.historyHours = uptimeKumaHistoryHours(incoming.uptimekuma.historyHours);
    }

    if (incoming.appearance && typeof incoming.appearance === 'object') {
      existing.appearance = {
        ...(existing.appearance || {}),
        dashboardSidePanel: incoming.appearance.dashboardSidePanel !== false,
      };
    }

    writePrivateYaml(CONFIG_PATH, existing);
    config = loadConfig();
    const shouldRefreshUptimeKuma = uptimeKumaConfigChanged(previousUptimeKuma, config.uptimekuma);

    if (cache.data) {
      if (cache.data.uptimekuma) cache.data.uptimekuma.historyHours = uptimeKumaConfig().historyHours;
      assignStatic(cache.data);
      cache.data.timestamp = new Date().toISOString();
    }

    if (shouldRefreshUptimeKuma && config.uptimekuma && config.uptimekuma.enabled !== false) {
      try {
        await refreshUptimeKumaNow();
      } catch (err) {
        console.warn(`Uptime Kuma preference refresh failed: ${err.message}`);
      }
    }

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
      writePrivateYaml(CONFIG_PATH, toSave);
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
      writePrivateYaml(CONFIG_PATH, toSave);
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
    if (Buffer.byteLength(content, 'utf8') > MAX_KUBECONFIG_BYTES) return res.status(400).json({ error: 'Kubeconfig is too large' });
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
    const buf = readBase64Payload(dataUrl, MAX_ICON_BYTES);
    let base = path.basename(String(name || 'icon')).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/\.(png|svg|webp|jpg|jpeg|gif|ico)$/i.test(base)) base += '.png';
    if (/\.svg$/i.test(base) && !isSafeSvg(buf)) return res.status(400).json({ error: 'SVG contains unsafe active content' });
    const dir = path.join(__dirname, 'data', 'icons');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, base), buf, { mode: 0o600 });
    res.json({ path: '/api/icons/' + base });
  } catch (err) { res.status(400).json({ error: err.message }); }
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
    const buf = readBase64Payload(dataUrl, MAX_CERT_BYTES);
    let base = path.basename(String(name || 'ca.crt')).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/\.(crt|pem|cer|pfx|p12)$/i.test(base)) return res.status(400).json({ error: 'Use .crt, .pem, .cer, .pfx or .p12' });
    const dir = path.join(__dirname, 'data', 'certs');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, base);
    fs.writeFileSync(dest, buf, { mode: 0o600 });
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
  const dir = path.resolve(__dirname, 'data', 'icons');
  const fp = path.resolve(dir, path.basename(req.params.file));
  if (fp === dir || !fp.startsWith(dir + path.sep) || !fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=3600');
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
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug/kubernetes', async (req, res) => {
  try { res.json(await getAllKubernetesData(config.kubernetes)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug/snmp', async (req, res) => {
  try { res.json(await getAllSynologyData(config.snmp)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug/uptimekuma', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const [debug, live] = await Promise.all([
      debugUptimeKuma(uptimeKumaConfig()),
      getAllUptimeKuma(uptimeKumaConfig()).catch(() => null),
    ]);
    debug.cacheUpdated = applyUptimeKumaLive(live);
    debug.cacheHistorySource = cache.data?.uptimekuma?.historySource || null;
    debug.cacheHistoryHours = cache.data?.uptimekuma?.historyHours || null;
    debug.cacheHistoryCounts = (cache.data?.uptimekuma?.monitors || []).map(m => ({
      name: m.name,
      source: m.historySource || null,
      count: Array.isArray(m.history) ? m.history.length : 0,
      first: m.history?.[0]?.time || null,
      last: m.history?.at(-1)?.time || null,
    }));
    res.json(debug);
  }
  catch (err) { res.status(500).json({ error: err.message }); }
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
      cache.data.linux = en(config.linux) ? getLinuxData(cache.data.proxmox) : [];
      if (en(config.proxmox) && !hasProxmoxApi()) {
        cache.data.proxmox = preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
      } else if (!en(config.proxmox)) {
        cache.data.proxmox = { clusterSummary: null, nodes: [] };
      }
      cache.data.linux = en(config.linux) ? getLinuxData(cache.data.proxmox) : [];
      cache.data.docker = en(config.docker) ? mergeDockerHistory(mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData())) : [];
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

function manualAgentUpdateCommand() {
  return "sudo sh -c 'set -a; . /etc/omnisight-agent/agent.env; set +a; curl -fsS ${OMNISIGHT_INSECURE_TLS:+--insecure} \"$OMNISIGHT_URL/agent/install.sh\" -o /tmp/omnisight-install.sh && bash /tmp/omnisight-install.sh && systemctl restart omnisight-agent'";
}

app.get('/api/agents', (req, res) => {
  try {
    res.json({ latestVersion: agentLatestVersion(), agents: agents.listAgents() });
  } catch (err) {
    console.warn('agents list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
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
        manualCommand: manualAgentUpdateCommand(),
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
    writePrivateYaml(CONFIG_PATH, toSave);
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
        cache.data.linux = getLinuxData(cache.data.proxmox);
      }
      if (kind === 'proxmox') {
        cache.data.proxmox = preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
      }
      if (kind === 'docker') {
        cache.data.docker = mergeDockerHistory(mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData()));
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
      cache.data.proxmox = hasProxmoxApi()
        ? cache.data.proxmox
        : preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
      cache.data.linux = getLinuxData(cache.data.proxmox);
      cache.data.docker = mergeDockerHistory(mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData()));
      assignStatic(cache.data);
    }
    res.json({ ok, data: cache.data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(LOG_BUFFER.filter(l => l.t > since));
});

app.get('/api/alerts/history', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.setHeader('Cache-Control', 'no-store');
  res.json(alertHistory.filter(a => Number(a.t || 0) > since));
});

app.post('/api/alerts/history/clear', (req, res) => {
  alertHistory = [];
  saveAlertHistory();
  res.json({ ok: true });
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
    preferredLanguage: config.preferredLanguage || 'en',
    timestamp: data.timestamp || new Date().toISOString(),
    refreshing: !!refreshPromise,
    services,
  });
});

app.get('/api/about', (req, res) => {
  let version = '1.0.0', author = 'caglaryalcin';
  try { const pkg = require('./package.json'); version = pkg.version; author = pkg.author || author; } catch {}
  res.json({
    name: 'OmniSight',
    version,
    author,
    github: 'https://github.com/caglaryalcin/OmniSight',
    serverTime: new Date().toISOString(),
    timezone: config.timezone || process.env.TZ || process.env.TIMEZONE || 'UTC',
  });
});

app.post('/api/alerts/test', async (req, res) => {
  try {
    if (!config.alerts) return res.status(400).json({ error: 'alerts not configured' });
    const only = req.query.channel;
    const alert = {
      title: '\u{1F514} OmniSight test alert',
      message: 'This is a test notification from OmniSight.\n' + new Date().toLocaleString(),
      priority: 'default', tags: 'bell',
    };
    const entry = pushAlertHistory({
      type: 'test',
      severity: 'normal',
      label: 'OmniSight test alert',
      detail: only ? `channel: ${only}` : 'all channels',
      title: alert.title,
      message: alert.message,
      priority: alert.priority,
      tags: alert.tags,
      status: 'sending',
      channels: [],
    });
    const results = await dispatchAlert(config.alerts, alert, only);
    entry.channels = results;
    entry.status = results.length && results.every(r => !r.ok) ? 'failed' : 'sent';
    saveAlertHistory();
    results.forEach(r => { if (!r.ok) console.warn(`Alert test ${r.channel} failed: ${r.error}`); });
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/proxmox/service', async (req, res) => {
  try {
    const { node, service, action } = req.query;
    if (!['status', 'start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (!SVC_NAME.test(String(node || '')) || !SVC_NAME.test(String(service || ''))) return res.status(400).json({ error: 'invalid node or service' });
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
    if (!SVC_NAME.test(String(host || '')) || !SVC_NAME.test(String(service || ''))) return res.status(400).json({ error: 'invalid host or service' });
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
    if (!K8S_NAME.test(String(namespace)) || !K8S_NAME.test(String(pod)) || (container && !K8S_NAME.test(String(container)))) {
      return res.status(400).json({ error: 'invalid kubernetes resource name' });
    }
    const logs = await getPodLogs(config.kubernetes, namespace, pod, container, req.query.tail);
    res.type('text/plain; charset=utf-8').send(logs || '');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`OmniSight running at http://localhost:${PORT}`);
});
