const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');
const childProcess = require('child_process');
const zlib = require('zlib');
const https = require('https');
const QRCode = require('qrcode');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}
const agents = require('./src/agents');
const { getAllKubernetesData, getPodLogs } = require('./src/kubernetes');
const { getAllSynologyData, sampleSnmpBandwidth } = require('./src/snmp');
const { getAllHealthchecks } = require('./src/healthchecks');
const { getAllUptimeKuma, debugUptimeKuma } = require('./src/uptimekuma');
const { getPrometheusData } = require('./src/prometheus');
const { getAllChecks } = require('./src/checks');
const { getAllDockhand, dockhandLogs, configInstances: dockhandConfigInstances } = require('./src/dockhand');
const { getAllDatabaseData } = require('./src/database');
const { getAllFirewallData } = require('./src/firewall');
const { getAllTrueNasData, configuredInstances: trueNasConfigInstances } = require('./src/truenas');
const { getAllQnapData, configuredInstances: qnapConfigInstances } = require('./src/qnap');
const { getAllUgreenData, configuredInstances: ugreenConfigInstances } = require('./src/ugreen');
const { getAllPbsData, configuredInstances: pbsConfigInstances } = require('./src/pbs');
const { getAllPortainerData, configuredInstances: portainerConfigInstances, portainerLogs } = require('./src/portainer');
const { getCloudflareData } = require('./src/cloudflare');
const { getAllCiData, configuredProjects: ciConfigProjects } = require('./src/cicd');
const { getAllVeeamData, configuredInstances: veeamConfigInstances } = require('./src/veeam');
const { getProxmoxApiData } = require('./src/proxmox');
const { getDockerApiData, dockerLogs: dockerApiLogs, dockerPrune: dockerApiPrune } = require('./src/docker');
const { dispatchAlert } = require('./src/alerts');
const { decryptConfig, encryptConfigValue, isEncrypted, SENSITIVE_KEYS, encryptionEnabled } = require('./src/crypto');
const { loadHistoryMap, scheduleSaveHistoryMap, setHistorySaveDelay, flushHistorySaves, cancelHistorySaves } = require('./src/historyStore');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const SVC_NAME = /^[a-zA-Z0-9@._:-]+$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;
const ONE_MB = 1024 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_AVATAR_BYTES = 512 * 1024;
const MAX_CERT_BYTES = 5 * ONE_MB;
const MAX_KUBECONFIG_BYTES = ONE_MB;
const DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.OMNISIGHT_DEBUG || '').toLowerCase());
const API_GZIP_MIN_BYTES = Math.max(1024, Number(process.env.OMNISIGHT_API_GZIP_MIN_BYTES || 2048));
const REQUIRE_HTTPS = envFlag('OMNISIGHT_REQUIRE_HTTPS');
const REQUIRE_AGENT_TLS = envFlag('OMNISIGHT_REQUIRE_AGENT_TLS', REQUIRE_HTTPS);
const RATE_LIMIT_DISABLED = envFlag('OMNISIGHT_DISABLE_RATE_LIMIT');

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
const DATA_DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

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
const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
const AUTH_PATH  = path.join(DATA_DIR, 'auth.yaml');
const USERS_PATH = path.join(DATA_DIR, 'users.yaml');
const PASSWORD_RESETS_PATH = path.join(DATA_DIR, 'password-resets.yaml');
const RUNTIME_SNAPSHOT_PATH = path.join(DATA_DIR, 'runtime-snapshot.json');
const UI_PREFS_PATH = path.join(DATA_DIR, 'ui-preferences.yaml');
const TOPOLOGY_PATH = path.join(DATA_DIR, 'topology.yaml');
const CONFIG_BACKUP_DIR = path.join(DATA_DIR, 'config-backups');
const FULL_BACKUP_MAX_BYTES = 50 * ONE_MB;
const FULL_BACKUP_EXPORT_TMP_DIR = path.join(DATA_DIR, '.backup-exports');
const FULL_BACKUP_SKIP = new Set(['sessions.yaml', 'password-resets.yaml', '.backup-exports']);

function backupConfigBeforeWrite() {
  try {
    if (!fs.existsSync(CONFIG_PATH) || !fs.statSync(CONFIG_PATH).isFile()) return;
    fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(CONFIG_BACKUP_DIR, `config-${stamp}.yaml`);
    fs.copyFileSync(CONFIG_PATH, backupPath);
    fs.chmodSync(backupPath, 0o600);
    const backups = fs.readdirSync(CONFIG_BACKUP_DIR)
      .filter(name => /^config-.*\.ya?ml$/i.test(name))
      .map(name => ({ name, path: path.join(CONFIG_BACKUP_DIR, name), mtime: fs.statSync(path.join(CONFIG_BACKUP_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    backups.slice(20).forEach(b => { try { fs.unlinkSync(b.path); } catch {} });
  } catch (err) {
    console.warn('config backup failed:', err.message);
  }
}

function writePrivateText(file, text) {
  if (path.resolve(file) === path.resolve(CONFIG_PATH)) backupConfigBeforeWrite();
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function writePrivateYaml(file, obj) {
  writePrivateText(file, yaml.dump(obj, { lineWidth: -1 }));
}

const NOTIFY_PATH = path.join(__dirname, 'data', 'notifications.yaml');
const ALERT_HISTORY_PATH = path.join(__dirname, 'data', 'alerts.yaml');
const ALERT_MUTES_PATH = path.join(__dirname, 'data', 'alert-mutes.yaml');
const AUDIT_PATH = path.join(__dirname, 'data', 'audit.yaml');
function loadNotify() {
  try {
    const a = yaml.load(fs.readFileSync(NOTIFY_PATH, 'utf8'));
    if (Array.isArray(a)) return { disabled: new Set(a), topics: new Map() };
    return {
      disabled: new Set(Array.isArray(a?.disabled) ? a.disabled : []),
      topics: new Map(Object.entries(a?.topics || {}).filter(([, v]) => String(v || '').trim())),
    };
  }
  catch { return { disabled: new Set(), topics: new Map() }; }
}
function saveNotify() {
  try {
    writePrivateYaml(NOTIFY_PATH, {
      disabled: Array.from(notifyDisabled),
      topics: Object.fromEntries(notifyTopics),
    });
  }
  catch (e) { console.warn('notifications save failed:', e.message); }
}
let notifyState = loadNotify();
let notifyDisabled = notifyState.disabled;
let notifyTopics = notifyState.topics;

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
let alertSentAtBySignature = new Map();
const AUDIT_MAX = 2000;
function loadAuditLog() {
  try {
    const a = yaml.load(fs.readFileSync(AUDIT_PATH, 'utf8'));
    return Array.isArray(a) ? a.slice(-AUDIT_MAX) : [];
  } catch { return []; }
}
function saveAuditLogNow() {
  try { writePrivateYaml(AUDIT_PATH, auditLog.slice(-AUDIT_MAX)); }
  catch (e) { console.warn('audit log save failed:', e.message); }
}
let auditLog = loadAuditLog();
let auditSaveTimer = null;
function saveAuditLog() {
  if (auditSaveTimer) return;
  auditSaveTimer = setTimeout(() => {
    auditSaveTimer = null;
    saveAuditLogNow();
  }, lowIoModeEnabled() ? 5000 : 1000);
}
function flushAuditLogSave() {
  if (auditSaveTimer) {
    clearTimeout(auditSaveTimer);
    auditSaveTimer = null;
  }
  saveAuditLogNow();
}
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}
function auditHashInput(item) {
  const { hash, ...rest } = item || {};
  return stableJson(rest);
}
function auditHash(item) {
  return crypto.createHash('sha256').update(auditHashInput(item)).digest('hex');
}
function appendAuditIntegrity(item) {
  const prevHash = auditLog.length ? String(auditLog.at(-1)?.hash || '') : '';
  item.prevHash = prevHash;
  item.hash = auditHash(item);
  return item;
}
function auditIntegrityReport() {
  let previous = '';
  let checked = 0;
  let legacy = 0;
  for (const item of auditLog) {
    if (!item?.hash) {
      legacy += 1;
      previous = '';
      continue;
    }
    checked += 1;
    const expectedPrev = String(item.prevHash || '');
    if (expectedPrev !== previous) {
      return { ok: false, checked, legacy, reason: 'prevHash mismatch', id: item.id || '', t: item.t || 0 };
    }
    const expectedHash = auditHash(item);
    if (expectedHash !== item.hash) {
      return { ok: false, checked, legacy, reason: 'hash mismatch', id: item.id || '', t: item.t || 0 };
    }
    previous = item.hash;
  }
  return { ok: true, checked, legacy, lastHash: previous };
}
function cleanIpValue(value) {
  let ip = String(value || '').trim();
  if (!ip) return '';
  ip = ip.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  const portMatch = ip.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  if (portMatch) ip = portMatch[1];
  return ip;
}
function isPrivateIp(ip) {
  ip = cleanIpValue(ip).toLowerCase();
  if (!ip) return true;
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
function requestIp(req) {
  return cleanIpValue(req?.ip || req?.socket?.remoteAddress || '');
}
function requestPublicIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',').map(cleanIpValue).filter(Boolean);
  const candidates = [
    cleanIpValue(req?.headers?.['cf-connecting-ip']),
    cleanIpValue(req?.headers?.['true-client-ip']),
    cleanIpValue(req?.headers?.['x-real-ip']),
    ...forwarded,
    requestIp(req),
  ].filter(Boolean);
  return candidates.find(ip => !isPrivateIp(ip)) || candidates[0] || '';
}
const PUBLIC_IP_LOOKUP_ENABLED = envFlag('OMNISIGHT_PUBLIC_IP_LOOKUP', true);
const PUBLIC_IP_LOOKUP_URLS = String(process.env.OMNISIGHT_PUBLIC_IP_LOOKUP_URLS || 'https://api.ipify.org,https://ifconfig.me/ip')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PUBLIC_IP_LOOKUP_TTL_MS = Math.max(60_000, Number(process.env.OMNISIGHT_PUBLIC_IP_LOOKUP_TTL_MS || 10 * 60_000));
let publicIpLookupCache = { ip: '', t: 0, pending: null };

function fetchPublicIpUrl(url, timeoutMs = 1800) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'user-agent': 'OmniSight public IP lookup' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 256) req.destroy();
      });
      res.on('end', () => resolve(cleanIpValue(body.trim())));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve('');
    });
  });
}

async function detectedOutboundPublicIp() {
  if (!PUBLIC_IP_LOOKUP_ENABLED || !PUBLIC_IP_LOOKUP_URLS.length) return '';
  const now = Date.now();
  if (publicIpLookupCache.ip && now - publicIpLookupCache.t < PUBLIC_IP_LOOKUP_TTL_MS) return publicIpLookupCache.ip;
  if (publicIpLookupCache.pending) return publicIpLookupCache.pending;
  publicIpLookupCache.pending = (async () => {
    for (const url of PUBLIC_IP_LOOKUP_URLS) {
      const ip = await fetchPublicIpUrl(url);
      if (ip && !isPrivateIp(ip)) {
        publicIpLookupCache = { ip, t: Date.now(), pending: null };
        return ip;
      }
    }
    publicIpLookupCache.pending = null;
    return '';
  })();
  return publicIpLookupCache.pending;
}

async function effectiveCurrentPublicIp(req) {
  const seen = cleanIpValue(requestPublicIp(req) || requestIp(req));
  if (seen && !isPrivateIp(seen)) return seen;
  return (await detectedOutboundPublicIp()) || seen || '';
}

async function currentPublicIpCandidates(req) {
  const seen = cleanIpValue(requestPublicIp(req) || requestIp(req));
  const direct = cleanIpValue(requestIp(req));
  const wan = seen && !isPrivateIp(seen) ? '' : await detectedOutboundPublicIp();
  return Array.from(new Set([wan, seen, direct].filter(Boolean)));
}
function privacyRedactIps() {
  let configRedact = false;
  try { configRedact = config?.security?.redactIpAddresses === true; } catch {}
  return envFlag('OMNISIGHT_REDACT_IPS') || configRedact;
}
let ipRedactionSecretCache = '';
function ipRedactionSecret() {
  if (ipRedactionSecretCache) return ipRedactionSecretCache;
  const envSecret = String(process.env.OMNISIGHT_SECRET || '').trim();
  if (envSecret) {
    ipRedactionSecretCache = envSecret;
    return ipRedactionSecretCache;
  }
  try {
    const fileSecret = String(fs.readFileSync(path.join(__dirname, 'data', 'secret.key'), 'utf8') || '').trim();
    if (fileSecret) {
      ipRedactionSecretCache = fileSecret;
      return ipRedactionSecretCache;
    }
  } catch {}
  return 'omnisight-ip-redaction';
}
function redactIpForPrivacy(value) {
  const raw = String(value || '').trim();
  if (raw.startsWith('redacted:')) return raw;
  const ip = cleanIpValue(value);
  if (!ip) return '';
  if (!privacyRedactIps()) return ip;
  const digest = crypto.createHmac('sha256', ipRedactionSecret()).update(ip).digest('hex').slice(0, 16);
  return `redacted:${digest}`;
}
const AUDIT_IP_DETAIL_KEYS = new Set(['ip', 'publicIp', 'currentPublicIp', 'clientIp', 'remoteIp']);
function redactAuditIpFields(value, depth = 0) {
  if (!privacyRedactIps() || value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.map(v => redactAuditIpFields(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = AUDIT_IP_DETAIL_KEYS.has(key) ? redactIpForPrivacy(child) : redactAuditIpFields(child, depth + 1);
  }
  return out;
}
function requestLogIp(req) {
  return redactIpForPrivacy(requestPublicIp(req) || requestIp(req)) || '-';
}

const DIAG_SLOW_REQUEST_MS = Math.max(1000, Number(process.env.OMNISIGHT_SLOW_REQUEST_MS || 5000));
const DIAG_SLOW_API_MS = Math.max(250, Number(process.env.OMNISIGHT_SLOW_API_MS || 1500));
const DIAG_EVENT_LOOP_LAG_MS = Math.max(500, Number(process.env.OMNISIGHT_EVENT_LOOP_LAG_MS || 2500));
const DIAG_LOG_WINDOW_MS = Math.max(5000, Number(process.env.OMNISIGHT_DIAG_LOG_WINDOW_MS || 60000));
const DIAG_LOG_BURST = Math.max(1, Number(process.env.OMNISIGHT_DIAG_LOG_BURST || 3));
const diagnosticLogState = new Map();

function warnDiagnostic(key, message) {
  if (DEBUG_ENABLED) {
    console.warn(message);
    return;
  }
  const now = Date.now();
  let state = diagnosticLogState.get(key);
  if (!state || now - state.startedAt >= DIAG_LOG_WINDOW_MS) {
    if (state?.suppressed) {
      const seconds = Math.max(1, Math.round((now - state.startedAt) / 1000));
      console.warn(`[diag] suppressed ${state.suppressed} repeated ${key} log(s) over ${seconds}s`);
    }
    state = { startedAt: now, emitted: 0, suppressed: 0 };
    diagnosticLogState.set(key, state);
  }
  if (state.emitted < DIAG_LOG_BURST) {
    state.emitted += 1;
    console.warn(message);
  } else {
    state.suppressed += 1;
  }
}

function diagnosticSnapshot() {
  let configured = '-';
  let inFlight = '-';
  try { configured = configuredList().join(',') || '-'; } catch {}
  try {
    inFlight = Object.entries(platformRefreshState || {})
      .filter(([, st]) => st?.inFlight)
      .map(([key]) => key)
      .join(',') || '-';
  } catch {}
  const mem = process.memoryUsage();
  const rss = Math.round(mem.rss / 1024 / 1024);
  const heap = Math.round(mem.heapUsed / 1024 / 1024);
  let busy = false;
  try { busy = refreshBusy(); } catch {}
  return `refresh=${busy} activeTasks=${Number(refreshActiveCount || 0)} inFlight=${inFlight} configured=${configured} rss=${rss}MB heap=${heap}MB uptime=${Math.round(process.uptime())}s`;
}

function requestDiagnosticActor(req) {
  try { return reqActor(req); } catch { return 'unknown'; }
}

function requestDiagnosticRole(req) {
  try { return sessionRole(req); } catch { return '-'; }
}

function requestDiagnostics(req, res, next) {
  const start = Date.now();
  const method = req.method || '-';
  const route = String(req.path || req.url || '').split('?')[0] || '/';
  let finished = false;
  const originalWriteHead = res.writeHead;
  res.writeHead = function patchedWriteHead(...args) {
    const ms = Date.now() - start;
    try {
      if (!res.headersSent) {
        res.setHeader('X-OmniSight-Response-Ms', String(ms));
        res.setHeader('Server-Timing', `omnisight;dur=${ms}`);
      }
    } catch {}
    return originalWriteHead.apply(this, args);
  };

  req.on('aborted', () => {
    const ms = Date.now() - start;
    warnDiagnostic(`http:aborted:${method}:${route}`, `[http] aborted ${method} ${route} ${ms}ms ip=${requestLogIp(req)} actor=${requestDiagnosticActor(req)} ${diagnosticSnapshot()}`);
  });

  res.on('finish', () => {
    finished = true;
    const ms = Date.now() - start;
    const status = Number(res.statusCode || 0);
    const slowLimit = route.startsWith('/api/') ? DIAG_SLOW_API_MS : DIAG_SLOW_REQUEST_MS;
    if (status >= 500 || ms >= slowLimit) {
      const kind = status >= 500 ? 'error' : 'slow';
      warnDiagnostic(`http:${kind}:${status}:${method}:${route}`, `[http] ${kind} status=${status} ${method} ${route} ${ms}ms ip=${requestLogIp(req)} actor=${requestDiagnosticActor(req)} role=${requestDiagnosticRole(req)} ${diagnosticSnapshot()}`);
    }
  });

  res.on('close', () => {
    if (finished || res.writableEnded) return;
    const ms = Date.now() - start;
    warnDiagnostic(`http:closed:${method}:${route}`, `[http] closed ${method} ${route} ${ms}ms ip=${requestLogIp(req)} actor=${requestDiagnosticActor(req)} ${diagnosticSnapshot()}`);
  });

  next();
}

function reqActor(req) {
  const token = req?.headers?.['x-session-token'] || req?.cookies?.session;
  const username = token ? sessions.get(token)?.username : '';
  return username || 'system';
}
function auditEvent(action, detail = {}, req = null) {
  const item = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex'),
    t: Date.now(),
    actor: req ? reqActor(req) : (detail.actor || 'system'),
    ip: req ? redactIpForPrivacy(requestIp(req)) : '',
    publicIp: req ? redactIpForPrivacy(requestPublicIp(req)) : '',
    action,
    detail: redactAuditIpFields(detail),
  };
  auditLog.push(appendAuditIntegrity(item));
  if (auditLog.length > AUDIT_MAX) auditLog = auditLog.slice(-AUDIT_MAX);
  saveAuditLog();
  return item;
}
function loadAlertMutes() {
  try {
    const a = yaml.load(fs.readFileSync(ALERT_MUTES_PATH, 'utf8')) || {};
    return new Map(Object.entries(a).filter(([, v]) => Number(v?.until || 0) > Date.now()));
  } catch { return new Map(); }
}
function saveAlertMutes() {
  try {
    const obj = {};
    for (const [k, v] of alertMutes) obj[k] = v;
    writePrivateYaml(ALERT_MUTES_PATH, obj);
  } catch (e) { console.warn('alert mutes save failed:', e.message); }
}
let alertMutes = loadAlertMutes();
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

function alertDeliverySucceeded(entry = {}) {
  if (entry.status === 'sent') return true;
  return Array.isArray(entry.channels) && entry.channels.some(r => r && r.ok && r.channel !== 'webhook');
}

function alertDeliverySignature(entry = {}) {
  const type = String(entry.type || '').trim();
  const key = String(entry.key || '').trim();
  const severity = String(entry.severity || '').trim();
  if (!type || !key || type === 'test') return '';
  return [type, key, severity || 'normal'].join('|');
}

const ALERT_NOTIFICATION_COOLDOWN_MS = Math.max(0, Number(process.env.OMNISIGHT_ALERT_COOLDOWN_MS || 60 * 60 * 1000));
function rebuildAlertSentCooldowns() {
  const cutoff = Date.now() - ALERT_NOTIFICATION_COOLDOWN_MS;
  alertSentAtBySignature = new Map();
  alertHistory
    .filter(alertDeliverySucceeded)
    .forEach(entry => {
      const sig = alertDeliverySignature(entry);
      const t = Number(entry.t || 0);
      if (!sig || !Number.isFinite(t) || t < cutoff) return;
      alertSentAtBySignature.set(sig, Math.max(alertSentAtBySignature.get(sig) || 0, t));
    });
}
rebuildAlertSentCooldowns();

function alertNotificationInCooldown(signature, now = Date.now()) {
  if (!signature || ALERT_NOTIFICATION_COOLDOWN_MS <= 0) return false;
  const last = Number(alertSentAtBySignature.get(signature) || 0);
  if (!last) return false;
  if (now - last >= ALERT_NOTIFICATION_COOLDOWN_MS) {
    alertSentAtBySignature.delete(signature);
    return false;
  }
  return true;
}

function clipText(value, max = 1000) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function webhookConfig() {
  return config.alerts?.webhook || config.webhook || {};
}

function webhookTokenFromReq(req) {
  const auth = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return String(req.headers['x-omnisight-webhook-token'] || '').trim();
}

function tokenMatches(got, expected) {
  if (!got || !expected) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function exposeErrorDetails() {
  return DEBUG_ENABLED || envFlag('OMNISIGHT_EXPOSE_ERRORS');
}
function serverErrorMessage(err) {
  return exposeErrorDetails() ? (err?.message || 'Internal server error') : 'Internal server error';
}
function sendServerError(res, err, extra = {}) {
  return res.status(500).json({ error: serverErrorMessage(err), ...extra });
}

function normalizeWebhookSeverity(value) {
  const v = String(value || '').toLowerCase();
  if (['critical', 'warning', 'normal', 'info'].includes(v)) return v;
  if (['error', 'down', 'failed', 'failure'].includes(v)) return 'critical';
  if (['warn', 'degraded'].includes(v)) return 'warning';
  if (['ok', 'up', 'resolved', 'recovery'].includes(v)) return 'normal';
  return 'info';
}

function normalizeWebhookType(value, severity) {
  const v = String(value || '').toLowerCase();
  if (['problem', 'recovery', 'info', 'test'].includes(v)) return v;
  if (['ok', 'up', 'resolved', 'normal', 'recovery'].includes(v)) return 'recovery';
  if (severity === 'critical' || severity === 'warning') return 'problem';
  return 'info';
}

function sanitizeWebhookPayload(body = {}) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (/token|password|secret|authorization/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function ntfyTopicList(ntfy = config.alerts?.ntfy) {
  const out = [];
  const add = value => {
    const topic = String(value || '').trim().replace(/^\/+|\/+$/g, '');
    if (topic && !out.includes(topic)) out.push(topic);
  };
  if (Array.isArray(ntfy?.topics)) ntfy.topics.forEach(add);
  add(ntfy?.topic);
  return out;
}

function normalizeNotifyTopic(topic) {
  const clean = String(topic || '').trim().replace(/^\/+|\/+$/g, '');
  if (!clean) return '';
  const allowed = ntfyTopicList();
  return !allowed.length || allowed.includes(clean) ? clean : '';
}

function notifyTopicForKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  const candidates = [raw];
  let cur = raw;
  while (cur.includes(':')) {
    cur = cur.slice(0, cur.lastIndexOf(':'));
    candidates.push(cur);
  }
  if (raw.startsWith('k8s:')) candidates.push('k8s');
  for (const candidate of candidates) {
    const topic = normalizeNotifyTopic(notifyTopics.get(candidate));
    if (topic) return topic;
  }
  return '';
}

function notifyDisabledForKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return false;
  if (notifyDisabled.has(raw)) return true;
  let cur = raw;
  while (cur.includes(':')) {
    cur = cur.slice(0, cur.lastIndexOf(':'));
    if (notifyDisabled.has(cur)) return true;
  }
  return raw.startsWith('k8s:') && notifyDisabled.has('k8s');
}

function alertConfigForKey(alertConfig, key) {
  const topic = notifyTopicForKey(key);
  if (!topic || !alertConfig?.ntfy) return alertConfig;
  return { ...alertConfig, ntfy: { ...alertConfig.ntfy, topic } };
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
let sessionsSaveTimer = null;
function scheduleSessionsSave(delay = 5000) {
  if (sessionsSaveTimer) return;
  sessionsSaveTimer = setTimeout(() => {
    sessionsSaveTimer = null;
    saveSessions(sessions);
  }, Math.max(500, Number(delay || 5000)));
  sessionsSaveTimer.unref?.();
}
function flushSessionsSave() {
  if (sessionsSaveTimer) {
    clearTimeout(sessionsSaveTimer);
    sessionsSaveTimer = null;
  }
  saveSessions(sessions);
}

const sessions = loadSessions();
const loginAttempts = new Map();
const passwordResetRequests = new Map();
const passkeyChallenges = new Map();

function normalizeAllowedPublicIps(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return Array.from(new Set(raw.map(cleanIpValue).filter(Boolean))).slice(0, 50);
}

function allowedPublicIpList() {
  return normalizeAllowedPublicIps(config?.security?.allowedPublicIps || []);
}

async function requestMatchesAllowedPublicIps(req) {
  const allowed = allowedPublicIpList();
  if (!allowed.length) return true;
  const candidates = await currentPublicIpCandidates(req);
  return candidates.some(ip => allowed.includes(ip));
}

function ipRestrictionBypass(req) {
  if (req.path.startsWith('/assets/') || req.path.startsWith('/api/icons/')) return true;
  if (req.path === '/i18n.js') return true;
  if (req.path.startsWith('/agent/')) return true;
  if (['/api/agent/report', '/api/agent/result', '/api/agent/commands', '/api/agent/ping', '/api/webhook/event'].includes(req.path)) return true;
  if (config.publicStatus && (req.path === '/status' || req.path === '/api/public/status')) return true;
  return false;
}

function browserLabel(userAgent = '') {
  const ua = String(userAgent || '');
  const browser =
    /\bEdg\//.test(ua) ? 'Edge' :
    /\bOPR\//.test(ua) ? 'Opera' :
    /\bFirefox\//.test(ua) ? 'Firefox' :
    /\bChrome\//.test(ua) ? 'Chrome' :
    /\bSafari\//.test(ua) ? 'Safari' : 'Unknown browser';
  const os =
    /Windows NT/i.test(ua) ? 'Windows' :
    /Mac OS X/i.test(ua) ? 'macOS' :
    /Android/i.test(ua) ? 'Android' :
    /(iPhone|iPad|iPod)/i.test(ua) ? 'iOS' :
    /Linux/i.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function sessionMetaFromRequest(req) {
  const rawIp = requestIp(req) || '';
  const ip = redactIpForPrivacy(rawIp);
  return {
    ip,
    publicIp: redactIpForPrivacy(requestPublicIp(req) || rawIp),
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
    lastSeen: Date.now(),
  };
}

function createSessionRecord(req, username, role, expires) {
  const now = Date.now();
  return {
    username,
    role: normalizeRole(role),
    created: now,
    expires,
    ...sessionMetaFromRequest(req),
    lastSeen: now,
  };
}

function touchSessionRecord(token, session, req) {
  if (!token || !session) return;
  const meta = sessionMetaFromRequest(req);
  const lastSeen = Number(session.lastSeen || 0);
  const changed = session.ip !== meta.ip
    || session.publicIp !== meta.publicIp
    || session.userAgent !== meta.userAgent
    || Date.now() - lastSeen > 60 * 1000;
  if (!changed) return;
  Object.assign(session, meta);
  sessions.set(token, session);
  scheduleSessionsSave(lowIoModeEnabled() ? 15000 : 5000);
}

function publicSessionRecord(token, session, currentToken) {
  return {
    token,
    username: session.username || '',
    role: normalizeRole(session.role, 'read-only'),
    created: Number(session.created || 0),
    expires: Number(session.expires || 0),
    lastSeen: Number(session.lastSeen || session.created || 0),
    ip: session.ip || '',
    publicIp: session.publicIp || session.ip || '',
    userAgent: session.userAgent || '',
    browser: browserLabel(session.userAgent),
    current: token === currentToken,
  };
}

function loginRateKey(req, username) {
  const ip = requestIp(req) || 'unknown';
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
  const rawIp = requestIp(req) || 'unknown';
  const rawPublicIp = requestPublicIp(req) || rawIp;
  const ip = redactIpForPrivacy(rawIp) || 'unknown';
  const publicIp = redactIpForPrivacy(rawPublicIp) || ip;
  const user = String(username || '').trim().slice(0, 128).replace(/[\r\n\t]/g, ' ');
  const maskedUser = user
    ? user.length <= 3
      ? `${user[0]}***`
      : user.length <= 6
        ? `${user.slice(0, 2)}***`
        : `${user.slice(0, 4)}***${user.slice(-2)}`
    : '-';
  const publicPart = publicIp && publicIp !== ip ? ` publicIp=${publicIp}` : '';
  const msg = `[auth] login ${outcome}: user="${maskedUser}" ip=${ip}${publicPart}${reason ? ` reason=${reason}` : ''}`;
  if (outcome === 'success') console.log(msg);
  else console.warn(msg);
  try { auditEvent('auth.login', { outcome, user: user || '-', reason, publicIp: rawPublicIp }, req); } catch {}
}

function maskEmail(email) {
  const [name = '', domain = ''] = String(email || '').split('@');
  if (!domain) return '-';
  const maskedName = name.length <= 2 ? `${name[0] || '*'}***` : `${name.slice(0, 2)}***${name.slice(-1)}`;
  const parts = domain.split('.');
  const first = parts.shift() || '';
  return `${maskedName}@${first.slice(0, 1)}***.${parts.join('.') || 'local'}`;
}

function clonePlain(obj) {
  if (obj == null) return obj;
  try { return JSON.parse(JSON.stringify(obj)); }
  catch { return obj; }
}

const yamlFileCache = new Map();
const YAML_CACHE_TTL_MS = Math.max(1000, Number(process.env.OMNISIGHT_YAML_CACHE_TTL_MS || 15000));
function loadYamlCached(file, fallback) {
  try {
    const now = Date.now();
    const cached = yamlFileCache.get(file);
    if (cached && now - Number(cached.checkedAt || 0) < YAML_CACHE_TTL_MS) return clonePlain(cached.value);
    if (!fs.existsSync(file)) {
      yamlFileCache.set(file, { mtimeMs: -1, checkedAt: now, value: fallback });
      return clonePlain(fallback);
    }
    const stat = fs.statSync(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      cached.checkedAt = now;
      return clonePlain(cached.value);
    }
    const value = yaml.load(fs.readFileSync(file, 'utf8')) || fallback;
    yamlFileCache.set(file, { mtimeMs: stat.mtimeMs, checkedAt: now, value });
    return clonePlain(value);
  } catch {
    return clonePlain(fallback);
  }
}

function invalidateYamlCache(file) {
  yamlFileCache.delete(file);
}

function loadAuth() {
  return loadYamlCached(AUTH_PATH, null);
}

const USER_ROLES = new Set(['admin', 'operator', 'read-only']);
function normalizeRole(role, fallback = 'admin') {
  const r = String(role || fallback || 'admin').toLowerCase();
  if (['readonly', 'read_only', 'viewer'].includes(r)) return 'read-only';
  return USER_ROLES.has(r) ? r : fallback;
}

function loadUsersDoc() {
  try {
    const raw = loadYamlCached(USERS_PATH, {});
    const users = Array.isArray(raw) ? raw : raw.users;
    return { users: Array.isArray(users) ? users : [] };
  } catch {
    return { users: [] };
  }
}

function saveUsersDoc(doc) {
  writePrivateYaml(USERS_PATH, { users: (doc.users || []).map(u => ({
    id: u.id,
    username: u.username,
    role: normalizeRole(u.role),
    disabled: u.disabled === true,
    hash: u.hash,
    salt: u.salt,
    passwordChangedAt: u.passwordChangedAt,
    mustChangePassword: u.mustChangePassword === true,
    recoveryEmail: u.recoveryEmail,
    avatar: u.avatar,
    totp: u.totp,
    passkeys: Array.isArray(u.passkeys) ? u.passkeys : undefined,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  })).filter(u => u.username && u.hash && u.salt) });
  invalidateYamlCache(USERS_PATH);
  normalizedUsersCache = null;
}

function ensureUsersDoc() {
  const doc = loadUsersDoc();
  if (doc.users.length) return doc;
  const legacy = legacyAuthUser();
  if (legacy) {
    doc.users = [{ ...legacy, id: legacy.id || 'legacy-admin', role: 'admin', _source: undefined, createdAt: Date.now() }];
    saveUsersDoc(doc);
  }
  return doc;
}

function legacyAuthUser() {
  const auth = loadAuth();
  if (!auth) return null;
  return { ...auth, id: 'legacy-admin', role: normalizeRole(auth.role, 'admin'), disabled: false, _source: 'legacy' };
}

let normalizedUsersCache = null;
function fileRevisionSig(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

function loadUsers() {
  const now = Date.now();
  if (normalizedUsersCache && now - Number(normalizedUsersCache.checkedAt || 0) < YAML_CACHE_TTL_MS) {
    return clonePlain(normalizedUsersCache.users);
  }
  const sig = `${fileRevisionSig(USERS_PATH)}|${fileRevisionSig(AUTH_PATH)}`;
  if (normalizedUsersCache && normalizedUsersCache.sig === sig) {
    normalizedUsersCache.checkedAt = now;
    return clonePlain(normalizedUsersCache.users);
  }
  const doc = loadUsersDoc();
  let users;
  if (doc.users.length) {
    users = doc.users
      .filter(u => u && u.username && u.hash && u.salt)
      .map((u, idx) => ({
        ...u,
        id: u.id || crypto.createHash('sha1').update(String(u.username)).digest('hex').slice(0, 12) || `user-${idx + 1}`,
        role: normalizeRole(u.role, idx === 0 ? 'admin' : 'read-only'),
        disabled: u.disabled === true,
        _source: 'users',
      }));
  } else {
    const legacy = legacyAuthUser();
    users = legacy ? [legacy] : [];
  }
  normalizedUsersCache = { sig, users, checkedAt: now };
  return clonePlain(users);
}

function authConfigured() {
  return loadUsers().length > 0;
}

function findAuthUser(username) {
  const want = String(username || '').trim().toLowerCase();
  if (!want) return null;
  return loadUsers().find(u => String(u.username || '').toLowerCase() === want) || null;
}

function findAuthUserByEmail(email) {
  const want = normalizeEmail(email);
  if (!validEmail(want)) return null;
  return loadUsers().find(u => authRecoveryEmail(u) === want) || null;
}

function currentAuthUser(req) {
  if (req?._authUser) return req._authUser;
  const token = currentSessionToken(req);
  const session = token ? sessions.get(token) : null;
  const user = session?.username ? findAuthUser(session.username) : null;
  if (req) req._authUser = user;
  return user;
}

function saveAuthUser(user) {
  if (!user || !user.username) throw new Error('User is invalid');
  if (user._source === 'users' || fs.existsSync(USERS_PATH)) {
    const doc = loadUsersDoc();
    const id = user.id || crypto.randomUUID?.() || crypto.randomBytes(12).toString('hex');
    const next = { ...user, id, role: normalizeRole(user.role), updatedAt: Date.now(), _source: undefined };
    const idx = doc.users.findIndex(u => u.id === id || String(u.username).toLowerCase() === String(user.username).toLowerCase());
    if (idx >= 0) doc.users[idx] = { ...doc.users[idx], ...next };
    else doc.users.push({ ...next, createdAt: next.createdAt || Date.now() });
    saveUsersDoc(doc);
    return { ...next, _source: 'users' };
  }
  const legacy = { ...user, role: normalizeRole(user.role, 'admin'), _source: undefined };
  writePrivateYaml(AUTH_PATH, legacy);
  invalidateYamlCache(AUTH_PATH);
  normalizedUsersCache = null;
  return { ...legacy, _source: 'legacy' };
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: normalizeRole(u.role),
    disabled: u.disabled === true,
    recoveryEmail: authRecoveryEmail(u),
    twoFactorEnabled: totpEnabled(u),
    passkeyCount: Array.isArray(u.passkeys) ? u.passkeys.length : 0,
    mustChangePassword: u.mustChangePassword === true,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
  };
}

function applyUserPatch(doc, idx, body = {}) {
  const cur = doc.users[idx];
  if (!cur) throw new Error('User not found');
  const next = { ...cur };
  if (body.username !== undefined) {
    const username = String(body.username || '').trim();
    if (!username) throw new Error('Username is required');
    if (doc.users.some((u, i) => i !== idx && String(u.username).toLowerCase() === username.toLowerCase())) {
      throw new Error('Username already exists');
    }
    next.username = username;
  }
  if (body.role !== undefined) next.role = normalizeRole(body.role, cur.role);
  if (body.disabled !== undefined) next.disabled = body.disabled === true;
  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (email && !validEmail(email)) throw new Error('Enter a valid e-mail address');
    if (email) next.recoveryEmail = email; else delete next.recoveryEmail;
  }
  if (body.password) {
    const pErr = validatePassword(String(body.password));
    if (pErr) throw new Error(pErr);
    const salt = crypto.randomBytes(16).toString('hex');
    next.salt = salt;
    next.hash = hashPassword(String(body.password), salt);
    next.passwordChangedAt = Date.now();
    next.mustChangePassword = true;
  }
  if (body.mustChangePassword !== undefined) next.mustChangePassword = body.mustChangePassword === true;
  next.updatedAt = Date.now();
  return next;
}

function adminCount(users) {
  return users.filter(u => normalizeRole(u.role) === 'admin' && u.disabled !== true).length;
}

function createUserRecord(username, password, role = 'read-only', extra = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex'),
    username: String(username || '').trim(),
    role: normalizeRole(role, 'read-only'),
    hash: hashPassword(password, salt),
    salt,
    passwordChangedAt: Date.now(),
    disabled: false,
    createdAt: Date.now(),
    mustChangePassword: extra.mustChangePassword === true,
    ...extra,
  };
}

function userMustChangePassword(user) {
  return user?.mustChangePassword === true;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  const e = normalizeEmail(email);
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function authRecoveryEmail(auth) {
  const saved = normalizeEmail(auth?.recoveryEmail);
  if (validEmail(saved)) return saved;
  const username = normalizeEmail(auth?.username);
  return validEmail(username) ? username : '';
}

function emailMatchesAuth(auth, email) {
  const target = authRecoveryEmail(auth);
  const incoming = normalizeEmail(email);
  return !!(target && validEmail(incoming) && target === incoming);
}

function passwordResetRateCheck(req, email) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const key = `${ip}:${normalizeEmail(email).slice(0, 128)}`;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 5;
  const rec = passwordResetRequests.get(key) || { count: 0, first: now };
  if (now - rec.first > windowMs) {
    passwordResetRequests.set(key, { count: 1, first: now });
    return { ok: true, retryAfter: 0 };
  }
  rec.count += 1;
  passwordResetRequests.set(key, rec);
  if (rec.count > maxAttempts) return { ok: false, retryAfter: Math.ceil((windowMs - (now - rec.first)) / 1000) };
  return { ok: true, retryAfter: 0 };
}

function loadPasswordResets() {
  try {
    const obj = yaml.load(fs.readFileSync(PASSWORD_RESETS_PATH, 'utf8')) || {};
    const active = obj.active || null;
    if (!active || Number(active.expires || 0) <= Date.now()) return {};
    return { active };
  } catch { return {}; }
}

function savePasswordResets(obj) {
  try {
    const active = obj?.active && Number(obj.active.expires || 0) > Date.now() ? { active: obj.active } : {};
    writePrivateYaml(PASSWORD_RESETS_PATH, active);
  } catch (e) { console.warn('password reset save failed:', e.message); }
}

function emailDigest(email) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function resetCodeDigest(email, code, salt) {
  return crypto.createHash('sha256').update(`${salt}:${normalizeEmail(email)}:${String(code || '').trim()}`).digest('hex');
}

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  catch { return false; }
}

function createPasswordResetRecord(email) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    code,
    record: {
      emailHash: emailDigest(email),
      salt,
      codeHash: resetCodeDigest(email, code, salt),
      expires: Date.now() + 10 * 60 * 1000,
      attempts: 0,
      created: Date.now(),
    },
  };
}

async function sendPasswordResetEmail(to, code) {
  const cfg = config.alerts?.smtp || {};
  if (cfg.enabled === false || !cfg.host) throw new Error('SMTP is not configured');
  if (!nodemailer) throw new Error('nodemailer not installed');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port || 587,
    secure: cfg.secure === true,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    tls: { rejectUnauthorized: cfg.rejectUnauthorized !== false },
  });
  await transport.sendMail({
    from: cfg.from || cfg.user,
    to,
    subject: 'OmniSight password reset code',
    text: [
      'Your OmniSight password reset code is:',
      '',
      code,
      '',
      'This code expires in 10 minutes. If you did not request a password reset, you can ignore this e-mail.',
    ].join('\n'),
  });
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

function validSession(req, auth = undefined, options = {}) {
  if (req && req._validSessionChecked) return req._validSessionResult || null;
  const token = currentSessionToken(req);
  if (!token) {
    if (req) {
      req._validSessionChecked = true;
      req._validSessionResult = null;
    }
    return null;
  }
  let session = sessions.get(token);
  if (!session) {
    reloadSessionsFromDisk();
    session = sessions.get(token);
  }
  const user = session?.username
    ? (findAuthUser(session.username) || (auth !== undefined && auth?.username === session.username ? auth : null))
    : null;
  const expired = !session || Date.now() >= Number(session.expires || 0);
  const stalePassword = !!(user?.passwordChangedAt && Number(session?.created || 0) < Number(user.passwordChangedAt || 0));
  const disabled = !!user?.disabled;
  if (expired || stalePassword || disabled || !user) {
    sessions.delete(token);
    saveSessions(sessions);
    if (req) {
      req._validSessionChecked = true;
      req._validSessionResult = null;
      req._authUser = null;
    }
    return null;
  }
  if (!session.role || session.role !== user.role) {
    session.role = normalizeRole(user.role);
    sessions.set(token, session);
    saveSessions(sessions);
  }
  if (options.touch !== false) touchSessionRecord(token, session, req);
  const result = { token, session };
  if (req) {
    req._validSessionChecked = true;
    req._validSessionResult = result;
    req._authUser = user;
  }
  return result;
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

async function makeTotpQrDataUrl(uri) {
  try {
    return await QRCode.toDataURL(uri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#111827', light: '#FFFFFF' },
    });
  } catch {
    return '';
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(s) {
  const clean = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(clean + '='.repeat((4 - clean.length % 4) % 4), 'base64');
}

function readCborLen(buf, offset, addl) {
  if (addl < 24) return { len: addl, offset };
  if (addl === 24) return { len: buf[offset], offset: offset + 1 };
  if (addl === 25) return { len: buf.readUInt16BE(offset), offset: offset + 2 };
  if (addl === 26) return { len: buf.readUInt32BE(offset), offset: offset + 4 };
  if (addl === 27) return { len: Number(buf.readBigUInt64BE(offset)), offset: offset + 8 };
  throw new Error('Unsupported CBOR length');
}

function cborDecode(buf, offset = 0) {
  const first = buf[offset++];
  const major = first >> 5;
  const addl = first & 31;
  const read = () => readCborLen(buf, offset, addl);
  if (major === 0) {
    const r = read(); return { value: r.len, offset: r.offset };
  }
  if (major === 1) {
    const r = read(); return { value: -1 - r.len, offset: r.offset };
  }
  if (major === 2) {
    const r = read(); return { value: buf.slice(r.offset, r.offset + r.len), offset: r.offset + r.len };
  }
  if (major === 3) {
    const r = read(); return { value: buf.toString('utf8', r.offset, r.offset + r.len), offset: r.offset + r.len };
  }
  if (major === 4) {
    const r = read();
    const arr = [];
    let o = r.offset;
    for (let i = 0; i < r.len; i++) { const d = cborDecode(buf, o); arr.push(d.value); o = d.offset; }
    return { value: arr, offset: o };
  }
  if (major === 5) {
    const r = read();
    const map = new Map();
    let o = r.offset;
    for (let i = 0; i < r.len; i++) {
      const k = cborDecode(buf, o); o = k.offset;
      const v = cborDecode(buf, o); o = v.offset;
      map.set(k.value, v.value);
    }
    return { value: map, offset: o };
  }
  if (major === 6) {
    const r = read();
    return cborDecode(buf, r.offset);
  }
  if (major === 7) {
    if (addl === 20) return { value: false, offset };
    if (addl === 21) return { value: true, offset };
    if (addl === 22 || addl === 23) return { value: null, offset };
  }
  throw new Error('Unsupported CBOR item');
}

function cborMapGet(map, key) {
  return map instanceof Map ? map.get(key) : undefined;
}

function parseAuthenticatorData(authData) {
  if (!Buffer.isBuffer(authData) || authData.length < 37) throw new Error('Invalid authenticator data');
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const out = { rpIdHash, flags, signCount };
  if (flags & 0x40) {
    let offset = 37;
    const aaguid = authData.slice(offset, offset + 16); offset += 16;
    const credLen = authData.readUInt16BE(offset); offset += 2;
    const credentialId = authData.slice(offset, offset + credLen); offset += credLen;
    const keyStart = offset;
    const key = cborDecode(authData, offset);
    out.aaguid = b64url(aaguid);
    out.credentialId = credentialId;
    out.credentialPublicKey = authData.slice(keyStart, key.offset);
  }
  return out;
}

function parseAttestationObject(attestationObject) {
  const decoded = cborDecode(fromB64url(attestationObject));
  const obj = decoded.value;
  const authData = cborMapGet(obj, 'authData');
  if (!Buffer.isBuffer(authData)) throw new Error('Attestation is missing authenticator data');
  return parseAuthenticatorData(authData);
}

function coseToKeyObject(cosePublicKey) {
  const key = cborDecode(fromB64url(cosePublicKey)).value;
  const kty = cborMapGet(key, 1);
  const alg = cborMapGet(key, 3);
  if (kty === 2 && alg === -7) {
    const x = cborMapGet(key, -2);
    const y = cborMapGet(key, -3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('Invalid EC passkey');
    return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y), ext: true }, format: 'jwk' });
  }
  if (kty === 3 && alg === -257) {
    const n = cborMapGet(key, -1);
    const e = cborMapGet(key, -2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('Invalid RSA passkey');
    return crypto.createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e), ext: true }, format: 'jwk' });
  }
  throw new Error('Unsupported passkey algorithm');
}

function webauthnRpId(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim().replace(/:\d+$/, '');
}

function requestHostCandidates(req) {
  const hosts = [
    req.headers['x-forwarded-host'],
    req.headers['x-original-host'],
    req.headers.host,
  ]
    .flatMap(v => String(v || '').split(','))
    .map(v => v.trim())
    .filter(Boolean);
  return [...new Set(hosts)];
}

function webauthnOrigin(req) {
  const proto = isSecureRequest(req) ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function browserRequestOrigin(req) {
  const hosts = requestHostCandidates(req);
  const candidates = [req.headers.origin, req.headers.referer];
  for (const candidate of candidates) {
    try {
      const u = new URL(String(candidate || ''));
      if (hosts.includes(u.host)) return `${u.protocol}//${u.host}`;
    } catch {}
  }
  return webauthnOrigin(req);
}

function webauthnExpectedOrigins(req) {
  const origins = new Set([webauthnOrigin(req)]);
  const hosts = requestHostCandidates(req);
  const candidates = [req.headers.origin, req.headers.referer];
  for (const candidate of candidates) {
    try {
      const u = new URL(String(candidate || ''));
      if ((u.protocol === 'https:' || u.protocol === 'http:') && hosts.includes(u.host)) {
        origins.add(`${u.protocol}//${u.host}`);
      }
    } catch {}
  }
  return [...origins];
}

function passkeyChallenge(type, username = '') {
  const challenge = b64url(crypto.randomBytes(32));
  passkeyChallenges.set(challenge, { type, username: String(username || '').toLowerCase(), expires: Date.now() + 2 * 60 * 1000 });
  return challenge;
}

function takePasskeyChallenge(challenge, type) {
  const rec = passkeyChallenges.get(challenge);
  passkeyChallenges.delete(challenge);
  if (!rec || rec.type !== type || Number(rec.expires || 0) < Date.now()) throw new Error('Invalid or expired passkey challenge');
  return rec;
}

function verifyClientData(clientDataJSON, type, req) {
  const json = JSON.parse(fromB64url(clientDataJSON).toString('utf8'));
  if (json.type !== type) throw new Error('Unexpected passkey response type');
  if (!webauthnExpectedOrigins(req).includes(json.origin)) throw new Error('Unexpected passkey origin');
  return json;
}

function publicPasskeys(auth) {
  return (Array.isArray(auth?.passkeys) ? auth.passkeys : []).map(k => ({
    id: k.id,
    name: k.name || 'Passkey',
    createdAt: k.createdAt || null,
    lastUsedAt: k.lastUsedAt || null,
    transports: Array.isArray(k.transports) ? k.transports : [],
  }));
}

function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.headers['x-forwarded-scheme'] || req.headers['x-url-scheme'] || '').split(',')[0].trim().toLowerCase();
  const ssl = String(req.headers['x-forwarded-ssl'] || '').toLowerCase();
  const port = String(req.headers['x-forwarded-port'] || '').split(',')[0].trim();
  return !!(req.secure || proto === 'https' || ssl === 'on' || port === '443');
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
  const cspNonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = cspNonce;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), publickey-credentials-create=(self), publickey-credentials-get=(self)');
  if (REQUIRE_HTTPS || isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${cspNonce}'`,
    `script-src-elem 'self' 'nonce-${cspNonce}'`,
    "script-src-attr 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  next();
}

function httpsRequirement(req, res, next) {
  if (!REQUIRE_HTTPS || isSecureRequest(req) || isLoopbackRequest(req)) return next();
  if (['/healthz', '/api/healthz', '/readyz', '/api/readyz'].includes(req.path)) return next();
  const host = String(req.headers.host || '').trim();
  if ((req.method === 'GET' || req.method === 'HEAD') && host && !req.path.startsWith('/api/')) {
    const rawPath = String(req.originalUrl || req.url || '/');
    const targetPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    return res.redirect(308, `https://${host}${targetPath}`);
  }
  return res.status(403).json({ error: 'HTTPS is required' });
}

const apiRateBuckets = new Map();
function apiRateLimitConfig(req) {
  if (!req.path.startsWith('/api/') || ['/api/healthz', '/api/readyz'].includes(req.path)) return null;
  if (req.path.startsWith('/api/agent/')) return { name: 'agent', windowMs: 60_000, max: Number(process.env.OMNISIGHT_AGENT_RATE_LIMIT || 600) };
  if (req.path === '/api/webhook/event') return { name: 'webhook', windowMs: 60_000, max: Number(process.env.OMNISIGHT_WEBHOOK_RATE_LIMIT || 120) };
  if (['/api/login', '/api/register', '/api/password-reset/request', '/api/password-reset/confirm', '/api/passkeys/auth/options', '/api/passkeys/auth/verify'].includes(req.path)) {
    return { name: 'auth', windowMs: 60_000, max: Number(process.env.OMNISIGHT_AUTH_RATE_LIMIT || 60) };
  }
  if (req.path.startsWith('/api/status') || req.path.startsWith('/api/events')) {
    return { name: 'status', windowMs: 60_000, max: Number(process.env.OMNISIGHT_STATUS_RATE_LIMIT || 240) };
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return { name: 'write', windowMs: 60_000, max: Number(process.env.OMNISIGHT_WRITE_RATE_LIMIT || 120) };
  }
  return { name: 'api', windowMs: 60_000, max: Number(process.env.OMNISIGHT_API_RATE_LIMIT || 300) };
}
function apiRateLimit(req, res, next) {
  if (RATE_LIMIT_DISABLED) return next();
  const cfg = apiRateLimitConfig(req);
  if (!cfg || !Number.isFinite(cfg.max) || cfg.max <= 0) return next();
  const now = Date.now();
  const ip = requestPublicIp(req) || requestIp(req) || 'unknown';
  const key = `${cfg.name}:${ip}`;
  let rec = apiRateBuckets.get(key);
  if (!rec || rec.reset <= now) rec = { count: 0, reset: now + cfg.windowMs };
  rec.count += 1;
  apiRateBuckets.set(key, rec);
  if (apiRateBuckets.size > 5000) {
    for (const [bucketKey, bucket] of apiRateBuckets) {
      if (bucket.reset <= now) apiRateBuckets.delete(bucketKey);
    }
  }
  const remaining = Math.max(0, cfg.max - rec.count);
  res.setHeader('X-RateLimit-Limit', String(cfg.max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(rec.reset / 1000)));
  if (rec.count > cfg.max) {
    const retryAfter = Math.max(1, Math.ceil((rec.reset - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter });
  }
  next();
}

function appendVary(res, value) {
  const existing = String(res.getHeader('Vary') || '').trim();
  if (!existing) return res.setHeader('Vary', value);
  const parts = existing.split(',').map(s => s.trim().toLowerCase());
  if (!parts.includes(String(value).toLowerCase())) res.setHeader('Vary', `${existing}, ${value}`);
}

function apiJsonCompression(req, res, next) {
  if (!req.path.startsWith('/api/') || req.method === 'HEAD' || !/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) return next();
  const originalSend = res.send.bind(res);
  res.send = function compressedSend(body) {
    try {
      if (res.headersSent || res.getHeader('Content-Encoding')) return originalSend(body);
      const status = Number(res.statusCode || 200);
      if (status < 200 || status === 204 || status === 304 || status >= 500) return originalSend(body);
      const type = String(res.getHeader('Content-Type') || '').toLowerCase();
      if (!type.includes('application/json')) return originalSend(body);
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
      if (buf.length < API_GZIP_MIN_BYTES) return originalSend(body);
      const gz = zlib.gzipSync(buf, { level: 1 });
      appendVary(res, 'Accept-Encoding');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', gz.length);
      return originalSend(gz);
    } catch {
      return originalSend(body);
    }
  };
  next();
}

function sameOriginGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.path === '/api/webhook/event') return next();
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return res.status(403).json({ error: 'cross-site request blocked' });
  }
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const got = new URL(origin);
    const expectedHosts = requestHostCandidates(req);
    const expectedHost = expectedHosts[0] || '';
    const expectedProto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
    if (expectedHosts.includes(got.host)) return next();
    if (got.host === expectedHost && got.protocol === `${expectedProto}:`) return next();
  } catch {}
  return res.status(403).json({ error: 'cross-origin request blocked' });
}

function dataAccessProblem() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (err) {
    return `Cannot access data directory ${DATA_DIR}: ${err.message}`;
  }
  for (const file of [CONFIG_PATH, AUTH_PATH, USERS_PATH, path.join(DATA_DIR, 'secret.key')]) {
    try {
      if (fs.existsSync(file)) fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      return `Cannot access data file ${file}: ${err.message}`;
    }
  }
  return '';
}

const DATA_ACCESS_CHECK_TTL_MS = Math.max(1000, Number(process.env.OMNISIGHT_DATA_ACCESS_CHECK_TTL_MS || 30000));
let dataAccessCheckCache = { checkedAt: 0, problem: '' };
function cachedDataAccessProblem() {
  const now = Date.now();
  if (now - Number(dataAccessCheckCache.checkedAt || 0) < DATA_ACCESS_CHECK_TTL_MS) {
    return dataAccessCheckCache.problem;
  }
  const problem = dataAccessProblem();
  dataAccessCheckCache = { checkedAt: now, problem };
  return problem;
}

function dataAccessGuard(req, res, next) {
  if (['/healthz', '/api/healthz', '/readyz', '/api/readyz'].includes(req.path)) return next();
  const problem = cachedDataAccessProblem();
  if (!problem) return next();
  const message = 'OmniSight data volume is not readable/writable by the container user. Fix /app/data ownership and restart the container.';
  console.error(`[data] ${problem}`);
  res.setHeader('Cache-Control', 'no-store');
  if (req.path && req.path.startsWith('/api/')) return res.status(503).json({ error: message, detail: problem });
  return res.status(503).type('text/plain; charset=utf-8').send(`${message}\n${problem}\n`);
}

function resolveDataFileForDelete(rawPath, fallbackName) {
  const dataDir = path.resolve(__dirname, 'data');
  const raw = String(rawPath || '').trim() || path.join(dataDir, fallbackName);
  const resolved = path.resolve(raw.startsWith('.') ? path.join(__dirname, raw) : raw);
  if (resolved !== dataDir && !resolved.startsWith(dataDir + path.sep)) {
    throw new Error('Only files inside the OmniSight data directory can be deleted from the UI');
  }
  return resolved;
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
    && !/(javascript:|data:text\/html|<!doctype|<!entity)/.test(s)
    && !/\b(?:href|xlink:href)\s*=\s*["']?\s*(?:https?:|\/\/|data:)/.test(s)
    && !/url\s*\(\s*["']?\s*(?:https?:|\/\/|data:|javascript:)/.test(s);
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
    recoveryEmail: authRecoveryEmail(auth),
    avatar: typeof auth?.avatar === 'string' ? auth.avatar : '',
    role: normalizeRole(auth?.role, 'admin'),
    mustChangePassword: userMustChangePassword(auth),
    passkeys: publicPasskeys(auth),
  };
}

function avatarMeta(auth) {
  const avatar = typeof auth?.avatar === 'string' ? auth.avatar : '';
  const m = avatar.match(/^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  const mime = String(m[1] || '').toLowerCase();
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
  if (!allowed.has(mime)) return null;
  const hash = crypto.createHash('sha1').update(avatar).digest('hex').slice(0, 16);
  return { mime, hash };
}

function publicProfileSummary(auth) {
  const meta = avatarMeta(auth);
  return {
    username: auth?.username || null,
    role: normalizeRole(auth?.role, 'admin'),
    mustChangePassword: userMustChangePassword(auth),
    avatar: meta ? `/api/profile/avatar/current?v=${meta.hash}` : '',
  };
}

async function authMiddleware(req, res, next) {
  const authPublicPaths = ['/login', '/onboarding', '/api/login', '/api/register', '/api/auth-status', '/api/onboarding/status', '/api/onboarding/complete', '/api/onboarding/import', '/api/backup/import', '/api/password-reset/request', '/api/password-reset/confirm', '/api/passkeys/auth/options', '/api/passkeys/auth/verify', '/api/webhook/event'];
  if (req.path === '/sw.js' || req.path === '/manifest.webmanifest') return next();
  if (req.path.startsWith('/assets/')) return next();
  if (req.path === '/i18n.js') return next();
  if (req.path.startsWith('/api/icons/')) return next();
  if (req.path.startsWith('/agent/') || ['/api/agent/report', '/api/agent/result', '/api/agent/commands', '/api/agent/ping'].includes(req.path)) return next();
  if (!ipRestrictionBypass(req) && !(await requestMatchesAllowedPublicIps(req))) {
    const publicIp = await effectiveCurrentPublicIp(req);
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Access from this public IP is not allowed', publicIp });
    return res.status(403).send('Access from this public IP is not allowed');
  }
  const valid = validSession(req);
  if (valid) {
    const sessionUser = req._authUser || (valid.session?.username ? findAuthUser(valid.session.username) : null);
    const allowedWhileTemporary = req.path === '/profile'
      || req.path === '/i18n.js'
      || req.path === '/api/auth-status'
      || req.path === '/api/profile'
      || req.path === '/api/set-password'
      || req.path === '/api/logout'
      || req.path.startsWith('/api/profile/')
      || req.path.startsWith('/api/2fa/')
      || req.path.startsWith('/api/passkeys/')
      || req.path.startsWith('/assets/');
    if (userMustChangePassword(sessionUser) && !allowedWhileTemporary) {
      if (req.path.startsWith('/api/')) return res.status(423).json({ error: 'Password change required', mustChangePassword: true });
      return res.redirect('/profile?mustChangePassword=1');
    }
    return next();
  }
  if (config.publicStatus && (req.path === '/status' || req.path === '/api/public/status')) return next();
  if (!authConfigured()) {
    if ([...authPublicPaths, '/api/set-password'].includes(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Setup required' });
    return res.redirect('/onboarding');
  }
  if (authPublicPaths.includes(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

function sessionRole(req) {
  const token = currentSessionToken(req);
  const session = token ? sessions.get(token) : null;
  if (session?.role) return normalizeRole(session.role);
  const user = req?._authUser || currentAuthUser(req);
  return normalizeRole(user?.role, 'read-only');
}

const READ_ONLY_REDACTED = '••••••';
const READ_ONLY_REDACT_TEXT_KEYS = new Set([
  'agenttoken', 'tokenid', 'tokensecret', 'apikey', 'token', 'bearertoken',
  'password', 'sshpassword', 'privatekey', 'sshkey', 'authpassword', 'privpassword',
  'community', 'secret', 'bottoken',
  'user', 'username', 'sshuser',
  'host', 'hostname', 'sshhost', 'ip', 'publicip', 'url', 'baseurl', 'serverurl', 'sourceurl', 'scrapeurl',
  'target', 'address', 'endpoint', 'socketpath', 'dsn', 'databaseurl', 'clusterip',
  'externalip', 'nodeip',
]);
const READ_ONLY_REDACT_EMPTY_KEYS = new Set(['port', 'ports', 'sshport', 'nodeport', 'targetport']);

function redactKeyName(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scrubReadOnlyText(value) {
  return String(value)
    .replace(/\b[\w.-]+@(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, READ_ONLY_REDACTED)
    .replace(/https?:\/\/[^\s"'<>]+/gi, READ_ONLY_REDACTED)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, READ_ONLY_REDACTED);
}

function redactReadOnlyValue(value, key = '') {
  const normalizedKey = redactKeyName(key);
  if (READ_ONLY_REDACT_EMPTY_KEYS.has(normalizedKey) || normalizedKey.endsWith('port')) {
    if (value == null || value === '') return value;
    return Array.isArray(value) ? [] : '';
  }
  if (READ_ONLY_REDACT_TEXT_KEYS.has(normalizedKey)) {
    if (value == null || value === '') return value;
    return READ_ONLY_REDACTED;
  }
  if (Array.isArray(value)) return value.map(item => redactReadOnlyValue(item, ''));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactReadOnlyValue(childValue, childKey);
    }
    return out;
  }
  if (typeof value === 'string') return scrubReadOnlyText(value);
  return value;
}

function redactForRole(req, payload) {
  return sessionRole(req) === 'read-only' ? redactReadOnlyValue(payload) : payload;
}

function operatorCanMutate(path) {
  return path.startsWith('/api/alerts/')
    || path === '/api/notifications'
    || path === '/api/preferences'
    || path === '/api/logout'
    || path.startsWith('/api/profile/')
    || path.startsWith('/api/2fa/')
    || path.startsWith('/api/passkeys/')
    || path.startsWith('/api/topology/')
    || path === '/api/set-password';
}

function ownAccountMutation(path) {
  return path === '/api/logout'
    || path === '/api/preferences'
    || path.startsWith('/api/profile/')
    || path.startsWith('/api/2fa/')
    || path.startsWith('/api/passkeys/')
    || path === '/api/set-password';
}

function rbacMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (['/api/login', '/api/register', '/api/onboarding/complete', '/api/password-reset/request', '/api/password-reset/confirm', '/api/passkeys/auth/options', '/api/passkeys/auth/verify', '/api/webhook/event'].includes(req.path)) return next();
  if (!authConfigured() && req.path === '/api/onboarding/import') return next();
  if (!authConfigured() && req.path === '/api/backup/import') return next();
  if (!authConfigured() && req.path === '/api/set-password') return next();
  if (req.path.startsWith('/agent/') || ['/api/agent/report', '/api/agent/result', '/api/agent/commands', '/api/agent/ping'].includes(req.path)) return next();
  const role = sessionRole(req);
  if (role === 'admin') return next();
  if (role === 'operator' && operatorCanMutate(req.path)) return next();
  if (role === 'read-only' && ownAccountMutation(req.path)) return next();
  return res.status(403).json({ error: 'Forbidden', role });
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

function stripDeprecatedConfig(obj) {
  if (obj?.appearance && typeof obj.appearance === 'object') {
    delete obj.appearance['dashboard' + 'Preset'];
  }
  if (obj && typeof obj === 'object') delete obj.collectors;
  return obj;
}

const UI_PLATFORM_IDS = new Set(['proxmox','kubernetes','linux','windows','synology','mikrotik','unifi','snmp','healthchecks','uptimekuma','checks','prometheus','docker','dockhand','database','firewall','truenas','qnap','ugreen','pbs','cloudflare','cicd','veeam','portainer']);
const UI_GROUP_KEYS = new Set(['pods','deps','svcs','synologyDevices','mikrotikDevices','unifiDevices','snmpDevices','snmpServers','dockerHosts','dockerContainers','checksServices','prometheusServers','prometheusTargets','firewallGateways','firewallLinks','truenasSystems','truenasPools','qnapSystems','ugreenSystems','pbsServers','pbsDatastores','pbsTasks','cloudflareZones','cloudflareTunnels','cloudflareDomains','cicdProjects','cicdPipelines','veeamServers','veeamSessions','veeamRepositories','portainerServers','portainerEnvironments','portainerContainers','databaseServers']);
const UI_SORT_KEYS = new Set(['state','name','cpu','memory','disk','network','status','restarts']);
const UI_KPI_KEYS = new Set(['cpu','memory','disk','bandwidth']);

function cleanBoolMap(obj, allowedKeys, max = 80) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [key, value] of Object.entries(obj)) {
    const k = String(key || '').slice(0, 80);
    if (allowedKeys && !allowedKeys.has(k)) continue;
    out[k] = !!value;
    if (Object.keys(out).length >= max) break;
  }
  return out;
}

function cleanStringArray(list, allowedKeys, max = 80) {
  const seen = new Set();
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const value = String(item || '').trim().slice(0, 80);
    if (!value || seen.has(value)) continue;
    if (allowedKeys && !allowedKeys.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function cleanLayoutColumns(cols, maxCols = 6) {
  if (!Array.isArray(cols)) return [];
  return cols.slice(0, maxCols).map(col => cleanStringArray(col, UI_PLATFORM_IDS, 40));
}

function cleanLayoutMap(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  ['side', 'wide'].forEach(key => {
    const cols = cleanLayoutColumns(obj[key]);
    if (cols.length) out[key] = cols;
  });
  return out;
}

function cleanStringMap(obj, allowedKeys, allowedValues, max = 80) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [key, value] of Object.entries(obj)) {
    const k = String(key || '').slice(0, 80);
    const v = String(value || '').slice(0, 80);
    if (allowedKeys && !allowedKeys.has(k)) continue;
    if (allowedValues && !allowedValues.has(v)) continue;
    out[k] = v;
    if (Object.keys(out).length >= max) break;
  }
  return out;
}

function cleanUiPreferences(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ui = {};
  const keepEmptyArrays = new Set(['dashboardHiddenPlatforms', 'panelOrder', 'sidebarPanelOrder', 'dashboardPanelOrder']);
  ui.overviewGroupOpen = cleanBoolMap(src.overviewGroupOpen, UI_GROUP_KEYS, 40);
  ui.overviewCardCollapsed = cleanBoolMap(src.overviewCardCollapsed, UI_PLATFORM_IDS, 40);
  ui.settingsCardOpen = cleanBoolMap(src.settingsCardOpen, null, 120);
  ui.dashboardHiddenPlatforms = cleanStringArray(src.dashboardHiddenPlatforms, UI_PLATFORM_IDS, 40);
  ui.panelOrder = cleanStringArray(src.panelOrder, UI_PLATFORM_IDS, 40);
  ui.sidebarPanelOrder = cleanStringArray(src.sidebarPanelOrder, UI_PLATFORM_IDS, 40);
  ui.dashboardPanelOrder = cleanStringArray(src.dashboardPanelOrder, UI_PLATFORM_IDS, 40);
  ui.overviewLayouts = cleanLayoutMap(src.overviewLayouts);
  ui.timeLimits = {};
  if (src.timeLimits && typeof src.timeLimits === 'object' && !Array.isArray(src.timeLimits)) {
    for (const [key, value] of Object.entries(src.timeLimits)) {
      const k = String(key || '').slice(0, 80);
      const n = Math.round(Number(value));
      if (!k || !Number.isFinite(n) || n <= 0) continue;
      ui.timeLimits[k] = Math.max(1, Math.min(5760, n));
      if (Object.keys(ui.timeLimits).length >= 80) break;
    }
  }
  ui.dockerContainerSort = UI_SORT_KEYS.has(String(src.dockerContainerSort || '')) ? String(src.dockerContainerSort) : undefined;
  ui.k8sPodSort = UI_SORT_KEYS.has(String(src.k8sPodSort || '')) ? String(src.k8sPodSort) : undefined;
  ui.k8sNamespaceFilter = String(src.k8sNamespaceFilter || '').trim().slice(0, 80);
  if (!ui.k8sNamespaceFilter) delete ui.k8sNamespaceFilter;
  ui.overviewKpiPlatforms = cleanStringMap(src.overviewKpiPlatforms, UI_KPI_KEYS, new Set(['all', ...UI_PLATFORM_IDS]), 20);
  ui.userOverride = cleanBoolMap(src.userOverride, null, 600);
  if (src.railCollapsed !== undefined) ui.railCollapsed = !!src.railCollapsed;
  if (src.navCollapsed !== undefined) ui.navCollapsed = !!src.navCollapsed;
  const railWidth = Math.round(Number(src.railWidth));
  if (Number.isFinite(railWidth)) ui.railWidth = Math.max(238, Math.min(440, railWidth));
  return Object.fromEntries(Object.entries(ui).filter(([key, value]) => {
    if (value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0 || keepEmptyArrays.has(key);
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }));
}

function readYamlObject(file) {
  const obj = loadYamlCached(file, {});
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
}

function loadUiPreferencesSidecar(fallback = {}) {
  return loadUiPreferenceStore(fallback).global;
}

function saveUiPreferencesSidecar(ui = {}) {
  const clean = normalizeUiPreferenceStore(ui);
  writePrivateYaml(UI_PREFS_PATH, serializeUiPreferenceStore(clean));
  invalidateYamlCache(UI_PREFS_PATH);
  return clean.global;
}

function uiPreferenceKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.@-]/g, '_')
    .slice(0, 120);
}

function uiPreferenceKeyFromRequest(req) {
  const user = currentAuthUser(req);
  const token = currentSessionToken(req);
  const session = token ? sessions.get(token) : null;
  return uiPreferenceKey(user?.id || user?.username || session?.username || '');
}

function normalizeUiPreferenceStore(raw = {}, fallback = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hasStoreShape = src.global && typeof src.global === 'object' && !Array.isArray(src.global)
    || src.users && typeof src.users === 'object' && !Array.isArray(src.users);
  if (!hasStoreShape) {
    return {
      global: cleanUiPreferences(Object.keys(src).length ? src : fallback),
      users: {},
    };
  }
  const users = {};
  for (const [key, value] of Object.entries(src.users || {})) {
    const cleanKey = uiPreferenceKey(key);
    if (!cleanKey || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const clean = cleanUiPreferences(value);
    if (Object.keys(clean).length) users[cleanKey] = clean;
  }
  return {
    global: cleanUiPreferences(src.global || fallback),
    users,
  };
}

function serializeUiPreferenceStore(store = {}) {
  const clean = normalizeUiPreferenceStore(store);
  if (!Object.keys(clean.users || {}).length) return clean.global;
  return {
    global: clean.global || {},
    users: clean.users || {},
  };
}

function loadUiPreferenceStore(fallback = {}) {
  const sidecar = readYamlObject(UI_PREFS_PATH);
  return normalizeUiPreferenceStore(Object.keys(sidecar).length ? sidecar : fallback, fallback);
}

function uiPreferencesForRequest(req) {
  const store = loadUiPreferenceStore(config.ui || {});
  const key = uiPreferenceKeyFromRequest(req);
  const userUi = key ? store.users?.[key] : null;
  return cleanUiPreferences({
    ...(store.global || {}),
    ...(userUi || {}),
  });
}

function saveUiPreferencesForRequest(req, incoming = {}) {
  const store = loadUiPreferenceStore(config.ui || {});
  const key = uiPreferenceKeyFromRequest(req);
  if (key) {
    store.users = store.users || {};
    store.users[key] = cleanUiPreferences({
      ...(store.users[key] || {}),
      ...incoming,
    });
  } else {
    store.global = cleanUiPreferences({
      ...(store.global || {}),
      ...incoming,
    });
  }
  writePrivateYaml(UI_PREFS_PATH, serializeUiPreferenceStore(store));
  invalidateYamlCache(UI_PREFS_PATH);
  return key
    ? cleanUiPreferences({ ...(store.global || {}), ...(store.users[key] || {}) })
    : cleanUiPreferences(store.global || {});
}

function withRequestUiPreferences(req, payload = {}) {
  const out = clonePlain(payload || {});
  out.ui = uiPreferencesForRequest(req);
  return out;
}

function cleanTopologyConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const links = [];
  const seenLinks = new Set();
  for (const item of Array.isArray(src.links) ? src.links : []) {
    const from = String(item?.from || '').trim().slice(0, 160);
    const to = String(item?.to || '').trim().slice(0, 160);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    links.push({ from, to, label: String(item?.label || '').trim().slice(0, 80) });
    if (links.length >= 200) break;
  }
  const seenNodes = new Set();
  const nodes = [];
  for (const item of Array.isArray(src.nodes) ? src.nodes : []) {
    const node = String(item || '').trim().slice(0, 160);
    if (!node || seenNodes.has(node)) continue;
    seenNodes.add(node);
    nodes.push(node);
    if (nodes.length >= 200) break;
  }
  const seenHidden = new Set();
  const hidden = [];
  for (const item of Array.isArray(src.hidden) ? src.hidden : []) {
    const node = String(item || '').trim().slice(0, 160);
    if (!node || seenHidden.has(node)) continue;
    seenHidden.add(node);
    hidden.push(node);
    if (hidden.length >= 500) break;
  }
  const positions = {};
  if (src.positions && typeof src.positions === 'object' && !Array.isArray(src.positions)) {
    for (const [key, value] of Object.entries(src.positions)) {
      const ref = String(key || '').trim().slice(0, 160);
      const x = Number(value?.x);
      const y = Number(value?.y);
      if (!ref || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      positions[ref] = {
        x: Math.max(-100000, Math.min(100000, Math.round(x))),
        y: Math.max(-100000, Math.min(100000, Math.round(y))),
      };
      if (Object.keys(positions).length >= 500) break;
    }
  }
  let view;
  if (src.view && typeof src.view === 'object') {
    const scale = Number(src.view.scale);
    const x = Number(src.view.x);
    const y = Number(src.view.y);
    if (Number.isFinite(scale) && Number.isFinite(x) && Number.isFinite(y)) {
      view = {
        scale: Math.max(0.1, Math.min(5, scale)),
        x: Math.max(-100000, Math.min(100000, Math.round(x))),
        y: Math.max(-100000, Math.min(100000, Math.round(y))),
      };
    }
  }
  let spacing;
  if (src.spacing && typeof src.spacing === 'object' && !Array.isArray(src.spacing)) {
    const proxmoxVmGap = Number(src.spacing.proxmoxVmGap ?? src.spacing.proxmoxGuestGap);
    if (Number.isFinite(proxmoxVmGap)) {
      spacing = {
        proxmoxVmGap: Math.max(110, Math.min(260, Math.round(proxmoxVmGap))),
      };
    }
  }
  return {
    ...(links.length ? { links } : {}),
    ...(nodes.length ? { nodes } : {}),
    ...(hidden.length ? { hidden } : {}),
    ...(Object.keys(positions).length ? { positions } : {}),
    ...(view ? { view } : {}),
    ...(spacing ? { spacing } : {}),
  };
}

function loadTopologySidecar(fallback = {}) {
  const sidecar = readYamlObject(TOPOLOGY_PATH);
  const src = Object.keys(sidecar).length ? sidecar : fallback;
  return cleanTopologyConfig(src || {});
}

function saveTopologySidecar(topology = {}) {
  const clean = cleanTopologyConfig(topology);
  writePrivateYaml(TOPOLOGY_PATH, clean);
  invalidateYamlCache(TOPOLOGY_PATH);
  return clean;
}

function stripSidecarConfig(obj = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  delete obj.ui;
  delete obj.topology;
  return obj;
}

function mergeSidecarConfig(obj = {}) {
  const out = obj && typeof obj === 'object' ? obj : {};
  const ui = loadUiPreferencesSidecar(out.ui);
  const topology = loadTopologySidecar(out.topology);
  out.ui = ui;
  out.topology = topology;
  return out;
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
  if (!encryptionEnabled()) return mergeSidecarConfig(stripDeprecatedConfig(raw));
  try { return mergeSidecarConfig(stripDeprecatedConfig(decryptConfig(raw))); } catch { return mergeSidecarConfig(stripDeprecatedConfig(raw)); }
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
applyDiskWritePolicy();

let cache = { data: null };
let refreshPromise = null;
let refreshGeneration = 0;
let refreshActiveCount = 0;
const statusStreamClients = new Set();
let configRevision = 1;
const viewCache = new Map();
const jsonResponseCache = new Map();

function clearViewCache() {
  viewCache.clear();
  jsonResponseCache.clear();
}

function markConfigChanged() {
  configRevision += 1;
  clearViewCache();
}

function cachedView(name, signature, factory) {
  const sig = String(signature || '');
  const hit = viewCache.get(name);
  if (hit && hit.signature === sig) return hit.value;
  const value = factory();
  viewCache.set(name, { signature: sig, value });
  return value;
}

function sendCachedJson(req, res, name, signature, factory, opts = {}) {
  const sig = String(signature || '');
  let hit = jsonResponseCache.get(name);
  if (!hit || hit.signature !== sig) {
    const body = JSON.stringify(factory());
    const etag = `W/"${crypto.createHash('sha1').update(sig).update(body).digest('hex').slice(0, 20)}"`;
    hit = {
      signature: sig,
      body,
      gzip: body.length >= API_GZIP_MIN_BYTES ? zlib.gzipSync(Buffer.from(body), { level: 1 }) : null,
      etag,
    };
    jsonResponseCache.set(name, hit);
    if (jsonResponseCache.size > 80) {
      const first = jsonResponseCache.keys().next().value;
      if (first) jsonResponseCache.delete(first);
    }
  }
  const cacheControl = opts.cacheControl || 'no-store';
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const can304 = opts.allow304 && !/\bno-store\b/i.test(cacheControl);
  if (can304) {
    res.setHeader('ETag', hit.etag);
    if (req.headers['if-none-match'] === hit.etag) return res.status(304).end();
  }
  if (hit.gzip && /\bgzip\b/i.test(req.headers['accept-encoding'] || '')) {
    appendVary(res, 'Accept-Encoding');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', hit.gzip.length);
    return res.end(hit.gzip);
  }
  res.setHeader('Content-Length', Buffer.byteLength(hit.body));
  return res.end(hit.body);
}

function runtimeViewSignature(data = cache.data || EMPTY) {
  return [
    configRevision,
    typeof agents.revision === 'function' ? agents.revision() : 0,
    data?.timestamp || '',
    data?.loading ? 'loading' : 'ready',
    refreshBusy() ? 'refreshing' : 'idle',
  ].join('|');
}

function runtimeDataViewSignature(data = cache.data || EMPTY) {
  return [
    configRevision,
    typeof agents.revision === 'function' ? agents.revision() : 0,
    data?.timestamp || '',
    data?.loading ? 'loading' : 'ready',
  ].join('|');
}

function agentsViewSignature() {
  return [
    configRevision,
    typeof agents.revision === 'function' ? agents.revision() : 0,
    agentLatestVersion(),
  ].join('|');
}

function eventsViewSignature(limit) {
  return [
    limit,
    LOG_BUFFER.length,
    LOG_BUFFER.at(-1)?.t || 0,
    auditLog.length,
    auditLog.at(-1)?.t || 0,
    alertHistory.length,
    alertHistory.at(-1)?.t || 0,
  ].join('|');
}

const PLATFORM_REFRESH_KEYS = ['proxmox','linux','windows','kubernetes','snmp','healthchecks','uptimekuma','checks','prometheus','docker','dockhand','database','firewall','truenas','qnap','ugreen','pbs','cloudflare','cicd','veeam','portainer'];
const platformRefreshState = Object.fromEntries(PLATFORM_REFRESH_KEYS.map(k => [k, { inFlight: false, nextDue: 0, failures: 0, lastStarted: 0, lastFinished: 0 }]));
const forceConnectingPlatforms = new Set();
const CONFIG_CHANGE_CONNECTING_MS = Math.max(30000, Number(process.env.OMNISIGHT_CONFIG_CHANGE_CONNECTING_MS || 120000));
const configChangeConnectingUntil = Object.fromEntries(PLATFORM_REFRESH_KEYS.map(k => [k, 0]));

function refreshBusy() {
  return refreshActiveCount > 0 || !!refreshPromise;
}

function maxRefreshActiveTasks() {
  return Math.max(collectorConcurrencyLimit() * 2, collectorConcurrencyLimit() + 1);
}

function collectorConcurrencyLimit() {
  const n = Number(config.performance?.collectorConcurrency || config.collectorConcurrency || 3);
  return Math.max(1, Math.min(8, Number.isFinite(n) ? Math.round(n) : 3));
}

function platformRefreshIntervalMs(key) {
  const raw = config.performance?.refreshIntervals?.[key] ?? config.refreshIntervals?.[key];
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 5) return Math.min(seconds * 1000, 15 * 60 * 1000);
  return REFRESH_INTERVAL;
}

function platformBackoffMs(key) {
  const st = platformRefreshState[key] || { failures: 0 };
  if (!st.failures) return 0;
  return Math.min(60000, 30000 * Math.max(1, Number(st.failures || 0)));
}

function shouldRunPlatformRefresh(key, force = false) {
  const st = platformRefreshState[key] || (platformRefreshState[key] = { inFlight: false, nextDue: 0, failures: 0 });
  if (st.inFlight) return false;
  return force || Date.now() >= Number(st.nextDue || 0);
}

function markPlatformRefreshStart(key) {
  const st = platformRefreshState[key] || (platformRefreshState[key] = {});
  st.inFlight = true;
  st.lastStarted = Date.now();
}

function markPlatformRefreshDone(key, ok = true) {
  const st = platformRefreshState[key] || (platformRefreshState[key] = {});
  st.inFlight = false;
  st.lastFinished = Date.now();
  st.failures = ok ? 0 : Math.min(4, Number(st.failures || 0) + 1);
  st.nextDue = st.lastFinished + (ok ? platformRefreshIntervalMs(key) : platformBackoffMs(key));
}

function platformResultLooksFailed(key, value, enabled) {
  if (!enabled) return false;
  if (key === 'snmp') return Array.isArray(value) && value.length > 0 && value.every(d => !d._stale && (d.online === false || d.error || d._connecting));
  if (key === 'docker') return Array.isArray(value) && value.length > 0 && value.every(d => d.online === false || d.error || d._connecting);
  if (key === 'dockhand') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'prometheus') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'firewall') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'truenas') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'qnap') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'ugreen') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'pbs') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'cloudflare') return value && value.online === false && (value.error || value._connecting);
  if (key === 'cicd') return value?.projects?.length && value.projects.every(i => i.online === false || i.error || i._connecting);
  if (key === 'veeam') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'portainer') return value?.instances?.length && value.instances.every(i => i.online === false || i.error || i._connecting);
  if (key === 'kubernetes') return value && ((value.online === false && (value.error || value._connecting)) || value._empty || value.resourceError);
  if (key === 'uptimekuma' || key === 'healthchecks' || key === 'checks') return value && value.online === false && (value.error || value._connecting);
  if (key === 'proxmox') return value?._stale === true || (Array.isArray(value?.nodes) && value.nodes.length > 0 && value.nodes.every(n => n.node?.online === false || n.error));
  return false;
}

async function runLimited(taskFns, limit) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, taskFns.length) }, async () => {
    while (idx < taskFns.length) {
      const current = taskFns[idx++];
      await current();
    }
  });
  await Promise.allSettled(workers);
}

function lowIoModeEnabled(conf = config) {
  return conf?.performance?.lowIoMode === true || conf?.lowIoMode === true;
}

function runtimeSnapshotFlushDelayMs(force = false) {
  if (force) return 1000;
  return lowIoModeEnabled() ? 60000 : REFRESH_INTERVAL;
}

function applyDiskWritePolicy() {
  const low = lowIoModeEnabled(config);
  setHistorySaveDelay(low ? 60000 : 2500);
  if (typeof agents.setSaveDelay === 'function') agents.setSaveDelay(low ? 30000 : 2000);
}

function broadcastStatusEvent(type = 'updated') {
  if (!statusStreamClients.size) return;
  const payload = JSON.stringify({
    type,
    timestamp: cache.data?.timestamp || new Date().toISOString(),
    refreshing: refreshBusy(),
    snapshot: !!cache.data?._snapshot,
  });
  for (const client of [...statusStreamClients]) {
    try {
      client.write(`event: status\ndata: ${payload}\n\n`);
    } catch {
      statusStreamClients.delete(client);
    }
  }
}

const HISTORY_STORE_MAX = 30 * 24 * 60 * 4;
function historyRetentionDays() {
  const n = Number(config.historyRetentionDays || config.retention?.historyDays || 1);
  if (n <= 1) return 1;
  if (n <= 7) return 7;
  return 30;
}
function historyRetentionMaxPoints() {
  return historyRetentionDays() * 24 * 60 * 4;
}
function trimHistoryRetention(history = []) {
  return Array.isArray(history) ? history.slice(-historyRetentionMaxPoints()) : [];
}
function configFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}
const PLATFORM_HISTORY = Object.fromEntries(loadHistoryMap('platform-history', HISTORY_STORE_MAX));
function savePlatformHistory() {
  scheduleSaveHistoryMap('platform-history', new Map(Object.entries(PLATFORM_HISTORY)), historyRetentionMaxPoints());
}

function replaceObjectContents(target, source) {
  Object.keys(target).forEach(key => delete target[key]);
  Object.assign(target, source || {});
}

function replaceMapContents(target, source) {
  target.clear();
  for (const [key, value] of source || []) target.set(key, value);
}

function reloadRuntimeHistoryMaps() {
  cancelHistorySaves(['platform-history', 'docker-history', 'uptimekuma-history']);
  replaceObjectContents(PLATFORM_HISTORY, Object.fromEntries(loadHistoryMap('platform-history', HISTORY_STORE_MAX)));
  replaceMapContents(dockerHistory, loadHistoryMap('docker-history', HISTORY_STORE_MAX));
  replaceMapContents(uptimeKumaHistory, loadHistoryMap('uptimekuma-history', HISTORY_STORE_MAX));
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

const dockerHistory = loadHistoryMap('docker-history', HISTORY_STORE_MAX);
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
    history = trimHistoryRetention(history);
    dockerHistory.set(dockerHistoryKey(row), history);
    return { ...row, history };
  });
  if (changed) scheduleSaveHistoryMap('docker-history', dockerHistory, historyRetentionMaxPoints());
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

function getWindowsData() {
  return agents.getWindowsData({ ...config.windows, excludedServices: config.excludedServices });
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
    historyHours: uptimeKumaHistoryHours(config.uptimekuma.historyHours ?? defaultTimePeriodHours()),
  };
}

function checksConfig() {
  if (!config.checks) return config.checks;
  return {
    ...config.checks,
    historyHours: uptimeKumaHistoryHours(config.checks.historyHours ?? defaultTimePeriodHours()),
  };
}

function passwordResetEnabled() {
  return config.security?.passwordResetEnabled !== false;
}

function selfRegistrationEnabled() {
  return config.security?.selfRegistrationEnabled !== false;
}

function publicIconValue(icon) {
  const value = String(icon || '').trim();
  if (!value) return undefined;
  const match = value.match(/^\/api\/icons\/([^?#/]+)/);
  if (!match) return value;
  let file = match[1];
  try { file = decodeURIComponent(file); } catch {}
  const dir = path.resolve(__dirname, 'data', 'icons');
  const fp = path.resolve(dir, path.basename(file));
  return fp !== dir && fp.startsWith(dir + path.sep) && fs.existsSync(fp) ? value : undefined;
}

function assignStatic(base) {
  base.publicStatus = !!config.publicStatus;
  base.configured = configuredList();
  base.notifyDisabled = Array.from(notifyDisabled);
  base.notifyTopics = Object.fromEntries(notifyTopics);
  base.ntfyTopics = ntfyTopicList();
  base.alertMutes = Object.fromEntries([...alertMutes.entries()].filter(([, v]) => Number(v?.until || 0) > Date.now()));
  base.topologyLinks = topologyLinksConfig();
  base.topologyNodes = topologyNodesConfig();
  base.topologyHidden = topologyHiddenConfig();
  base.topologySpacing = topologySpacingConfig();
  base.topologyPositions = topologyPositionsConfig();
  base.topologyView = topologyViewConfig();
  base.timeFormat = config.timeFormat || '24h';
  base.defaultTimePeriodHours = defaultTimePeriodHours();
  base.historyRetentionDays = historyRetentionDays();
  base.preferredLanguage = config.preferredLanguage || 'en';
  base.performance = {
    lowIoMode: lowIoModeEnabled(),
  };
  if (base.checks && config.checks) base.checks.historyHours = checksConfig().historyHours;
  base.appearance = {
    dashboardSidePanel: config.appearance?.dashboardSidePanel !== false,
  };
  base.ui = cleanUiPreferences(config.ui || {});
  base.icons = {
    proxmox: publicIconValue(config.proxmox?.icon), linux: publicIconValue(config.linux?.icon), windows: publicIconValue(config.windows?.icon), kubernetes: publicIconValue(config.kubernetes?.icon),
    snmp: publicIconValue(config.snmp?.icon), healthchecks: publicIconValue(config.healthchecks?.icon), uptimekuma: publicIconValue(config.uptimekuma?.icon), checks: publicIconValue(config.checks?.icon), prometheus: publicIconValue(config.prometheus?.icon), docker: publicIconValue(config.docker?.icon), dockhand: publicIconValue(config.dockhand?.icon),
    firewall: publicIconValue(config.firewall?.icon),
    truenas: publicIconValue(config.truenas?.icon),
    qnap: publicIconValue(config.qnap?.icon),
    ugreen: publicIconValue(config.ugreen?.icon),
    pbs: publicIconValue(config.pbs?.icon),
    cloudflare: publicIconValue(config.cloudflare?.icon),
    cicd: publicIconValue(config.cicd?.icon),
    veeam: publicIconValue(config.veeam?.icon),
    portainer: publicIconValue(config.portainer?.icon),
    database: publicIconValue(config.database?.icon),
  };
}

function kubernetesConnectingData() {
  return {
    _connecting: true,
    online: false,
    summary: { total: 0, running: 0, failed: 0, pending: 0 },
    pods: [],
    services: [],
    deployments: [],
  };
}

function keepKubernetesConnectingAfterConfigChange(next, err) {
  const deadline = Number(configChangeConnectingUntil.kubernetes || 0);
  if (!deadline || Date.now() > deadline) return next;
  const failed = platformResultLooksFailed('kubernetes', next, true) || !!err;
  if (!failed) {
    configChangeConnectingUntil.kubernetes = 0;
    return next;
  }
  return {
    ...kubernetesConnectingData(),
    error: next?.error || err?.message || 'waiting for Kubernetes API after config change',
  };
}

function markKubernetesConnectingForNextConfigSave() {
  forceConnectingPlatforms.add('kubernetes');
}

function settingsStatusData(data = cache.data || EMPTY) {
  const slimServices = services => (services || [])
    .filter(s => !s.active || s.excluded)
    .slice(0, 20)
    .map(s => ({ active: !!s.active, excluded: !!s.excluded }));
  const pxNodes = (data.proxmox?.nodes || []).map(n => ({
    name: n.node?.name || n.name,
    host: n.host,
    _connecting: !!n._connecting,
    metricsError: n.metricsError || '',
    node: { online: !!n.node?.online, name: n.node?.name },
    services: slimServices(n.services),
  }));
  const linuxRows = (data.linux || []).map(l => ({
    online: !!l.online,
    _connecting: !!l._connecting,
    services: slimServices(l.services),
  }));
  const windowsRows = (data.windows || []).map(w => ({
    online: !!w.online,
    _connecting: !!w._connecting,
    services: slimServices(w.services),
  }));
  const dockerRows = (data.docker || []).map(h => ({
    name: h.name,
    host: h.host,
    online: !!h.online,
    _connecting: !!h._connecting,
    error: h.error || '',
    summary: {
      total: h.summary?.total || 0,
      running: h.summary?.running || 0,
      stopped: h.summary?.stopped || 0,
      unused: Number(h.summary?.unused) || 0,
    },
  }));
  const dbRows = (data.database || []).map(d => ({
    name: d.name,
    online: !!d.online,
    _connecting: !!d._connecting,
    connections: d.connections,
    maxConnections: d.maxConnections,
  }));
  return {
    loading: !!data.loading,
    refreshing: refreshBusy(),
    configured: data.configured || configuredList(),
    publicStatus: !!config.publicStatus,
    proxmox: { _connecting: !!data.proxmox?._connecting, nodes: pxNodes },
    linux: linuxRows,
    windows: windowsRows,
    kubernetes: data.kubernetes ? {
      online: !!data.kubernetes.online,
      _connecting: !!data.kubernetes._connecting,
      empty: !!data.kubernetes._empty,
      error: data.kubernetes.error || data.kubernetes.resourceError || null,
      summary: data.kubernetes.summary || {},
      pods: (data.kubernetes.pods || []).filter(p => p.failed).slice(0, 20).map(p => ({ failed: !!p.failed })),
      services: Array.isArray(data.kubernetes.services) ? data.kubernetes.services.length : 0,
      deployments: Array.isArray(data.kubernetes.deployments) ? data.kubernetes.deployments.length : 0,
    } : null,
    snmp: (data.snmp || []).map(d => ({ name: d.name, host: d.host, profile: d.profile || d.preset || 'generic', online: !!d.online, _connecting: !!d._connecting })),
    healthchecks: data.healthchecks ? {
      online: !!data.healthchecks.online,
      _connecting: !!data.healthchecks._connecting,
      summary: data.healthchecks.summary || {},
    } : null,
    uptimekuma: data.uptimekuma ? {
      online: !!data.uptimekuma.online,
      _connecting: !!data.uptimekuma._connecting,
    } : null,
    checks: data.checks ? {
      online: !!data.checks.online,
      summary: data.checks.summary || {},
      checks: (data.checks.checks || []).map(c => ({ status: c.status, _connecting: !!c._connecting })),
    } : null,
    prometheus: data.prometheus ? {
      online: !!data.prometheus.online,
      _connecting: !!data.prometheus._connecting,
      summary: data.prometheus.summary || {},
      instances: (data.prometheus.instances || []).map(i => ({ online: !!i.online, _connecting: !!i._connecting })),
    } : null,
    docker: dockerRows,
    dockhand: data.dockhand ? {
      online: !!data.dockhand.online,
      _connecting: !!data.dockhand._connecting,
      summary: data.dockhand.summary || {},
      instances: (data.dockhand.instances || []).map(i => ({ online: !!i.online, _connecting: !!i._connecting })),
    } : null,
    firewall: data.firewall ? {
      online: !!data.firewall.online,
      _connecting: !!data.firewall._connecting,
      summary: data.firewall.summary || {},
      instances: (data.firewall.instances || []).map(i => ({
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        summary: i.summary || {},
      })),
    } : null,
    truenas: data.truenas ? {
      online: !!data.truenas.online,
      _connecting: !!data.truenas._connecting,
      summary: data.truenas.summary || {},
      instances: (data.truenas.instances || []).map(i => ({
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        summary: i.summary || {},
      })),
    } : null,
    qnap: data.qnap ? {
      online: !!data.qnap.online,
      _connecting: !!data.qnap._connecting,
      summary: data.qnap.summary || {},
      instances: (data.qnap.instances || []).map(i => ({
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        summary: i.summary || {},
      })),
    } : null,
    ugreen: data.ugreen ? {
      online: !!data.ugreen.online,
      _connecting: !!data.ugreen._connecting,
      summary: data.ugreen.summary || {},
      instances: (data.ugreen.instances || []).map(i => ({
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        summary: i.summary || {},
      })),
    } : null,
    pbs: data.pbs ? {
      online: !!data.pbs.online,
      _connecting: !!data.pbs._connecting,
      summary: data.pbs.summary || {},
      instances: (data.pbs.instances || []).map(i => ({
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        summary: i.summary || {},
        tasks: Array.isArray(i.tasks) ? i.tasks.slice(0, 10).map(t => ({
          id: t.id || '',
          name: t.name || '',
          taskId: t.taskId || '',
          type: t.type || '',
          status: t.status || '',
          failed: !!t.failed,
          running: !!t.running,
          starttime: t.starttime || t.startTime || null,
          endtime: t.endtime || t.endTime || null,
        })) : [],
      })),
    } : null,
    cloudflare: data.cloudflare ? {
      online: !!data.cloudflare.online,
      _connecting: !!data.cloudflare._connecting,
      partial: !!data.cloudflare.partial,
      summary: data.cloudflare.summary || {},
      zones: Array.isArray(data.cloudflare.zones) ? data.cloudflare.zones.length : 0,
      tunnels: Array.isArray(data.cloudflare.tunnels) ? data.cloudflare.tunnels.length : 0,
      domains: Array.isArray(data.cloudflare.domains) ? data.cloudflare.domains.length : 0,
    } : null,
    cicd: data.cicd ? {
      online: !!data.cicd.online,
      _connecting: !!data.cicd._connecting,
      summary: data.cicd.summary || {},
      projects: (data.cicd.projects || []).map(i => ({
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        provider: i.provider || '',
      })),
    } : null,
    veeam: data.veeam ? {
      online: !!data.veeam.online,
      _connecting: !!data.veeam._connecting,
      summary: data.veeam.summary || {},
      instances: (data.veeam.instances || []).map(i => ({
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        summary: i.summary || {},
      })),
    } : null,
    portainer: data.portainer ? {
      online: !!data.portainer.online,
      _connecting: !!data.portainer._connecting,
      summary: data.portainer.summary || {},
      instances: (data.portainer.instances || []).map(i => ({
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        summary: i.summary || {},
      })),
    } : null,
    database: dbRows,
  };
}

function topologyStatusData(data = cache.data || EMPTY) {
  return {
    timestamp: data.timestamp || new Date().toISOString(),
    loading: !!data.loading,
    refreshing: refreshBusy(),
    configured: data.configured || configuredList(),
    topologyLinks: topologyLinksConfig(),
    topologyNodes: topologyNodesConfig(),
    topologyHidden: topologyHiddenConfig(),
    topologySpacing: topologySpacingConfig(),
    topologyPositions: topologyPositionsConfig(),
    topologyView: topologyViewConfig(),
    proxmox: {
      nodes: (data.proxmox?.nodes || []).map(n => ({
        name: n.name || n.node?.name || '',
        online: !!(n.online || n.node?.online),
        _connecting: !!n._connecting,
        node: {
          name: n.node?.name || n.name || '',
          online: !!(n.node?.online || n.online),
        },
        vms: (n.vms || []).map(v => ({
          id: v.id,
          name: v.name,
          status: v.status,
          type: v.type,
          os: v.os,
          ostype: v.ostype,
          osType: v.osType,
          tags: v.tags,
        })),
      })),
    },
    kubernetes: data.kubernetes ? {
      online: data.kubernetes.online !== false,
      _connecting: !!data.kubernetes._connecting,
      empty: !!data.kubernetes._empty,
      error: data.kubernetes.error || data.kubernetes.resourceError || null,
      summary: data.kubernetes.summary || {},
      pods: Array.isArray(data.kubernetes.pods) ? data.kubernetes.pods.map(p => ({ name: p.name, status: p.status, failed: !!p.failed })) : [],
      services: Array.isArray(data.kubernetes.services) ? data.kubernetes.services.map(s => ({ name: s.name, namespace: s.namespace })) : [],
      deployments: Array.isArray(data.kubernetes.deployments) ? data.kubernetes.deployments.map(d => ({ name: d.name, namespace: d.namespace, healthy: !!d.healthy })) : [],
    } : null,
    docker: (data.docker || []).map(h => ({
      name: h.name,
      host: h.host,
      online: !!h.online,
      _connecting: !!h._connecting,
      summary: h.summary || {},
      containers: Array.isArray(h.containers) ? h.containers.map(c => ({ id: c.id, name: c.name, state: c.state, status: c.status })) : [],
    })),
    dockhand: data.dockhand ? {
      instances: (data.dockhand.instances || []).map(i => ({ name: i.name, url: i.url, online: !!i.online, _connecting: !!i._connecting })),
      containers: (data.dockhand.containers || []).map(c => ({ name: c.name, state: c.state, sourceName: c.sourceName, sourceUrl: c.sourceUrl })),
    } : null,
    firewall: data.firewall ? {
      instances: (data.firewall.instances || []).map(i => ({
        name: i.name,
        url: i.url,
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        summary: i.summary || {},
      })),
    } : null,
    truenas: data.truenas ? {
      instances: (data.truenas.instances || []).map(i => ({
        name: i.name,
        url: i.url,
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        pools: Array.isArray(i.pools) ? i.pools.map(p => ({ name: p.name, health: p.health, status: p.status })) : [],
        disks: Array.isArray(i.disks) ? i.disks.map(d => ({ name: d.name, health: d.health, status: d.status })) : [],
      })),
    } : null,
    qnap: data.qnap ? {
      instances: (data.qnap.instances || []).map(i => ({
        name: i.name,
        url: i.url,
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        system: i.system || {},
      })),
    } : null,
    ugreen: data.ugreen ? {
      instances: (data.ugreen.instances || []).map(i => ({
        name: i.name,
        url: i.url,
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        statusCode: i.statusCode,
        system: i.system || {},
      })),
    } : null,
    pbs: data.pbs ? {
      instances: (data.pbs.instances || []).map(i => ({
        name: i.name,
        url: i.url,
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        datastores: Array.isArray(i.datastores) ? i.datastores.map(d => ({ name: d.name, health: d.health, usedPercent: d.usedPercent })) : [],
        tasks: Array.isArray(i.tasks) ? i.tasks.slice(0, 10).map(t => ({
          id: t.id || '',
          name: t.name || '',
          taskId: t.taskId || '',
          type: t.type || '',
          status: t.status || '',
          failed: !!t.failed,
          running: !!t.running,
          starttime: t.starttime || t.startTime || null,
          endtime: t.endtime || t.endTime || null,
        })) : [],
      })),
    } : null,
    portainer: data.portainer ? {
      instances: (data.portainer.instances || []).map(i => ({
        name: i.name,
        url: i.url,
        online: !!i.online,
        _connecting: !!i._connecting,
        partial: !!i.partial,
        environments: Array.isArray(i.environments) ? i.environments.map(e => ({ name: e.name, type: e.type, online: e.online })) : [],
      })),
    } : null,
    snmp: (data.snmp || []).map(s => ({
      name: s.name,
      host: s.host,
      online: !!s.online,
      _connecting: !!s._connecting,
      profile: s.profile,
      preset: s.preset,
      type: s.type,
      vendor: s.vendor,
      model: s.model,
      sysDescr: s.sysDescr,
      systemDescription: s.systemDescription,
    })),
  };
}

function dashboardHistoryPointLimit() {
  const periods = [defaultTimePeriodHours()];
  try { periods.push(uptimeKumaHistoryHours(uptimeKumaConfig()?.historyHours || 1)); } catch {}
  try { periods.push(Number(checksConfig()?.historyHours || 1)); } catch {}
  const hours = Math.max(1, ...periods.filter(n => Number.isFinite(Number(n)) && Number(n) > 0).map(Number));
  const points = Math.ceil(hours * 60 * 4);
  return Math.max(120, Math.min(historyRetentionMaxPoints(), points, Number(process.env.OMNISIGHT_VIEW_HISTORY_POINTS || 1440)));
}

function compactDashboardHistoryPointLimit() {
  const n = Number(process.env.OMNISIGHT_DASHBOARD_COMPACT_HISTORY_POINTS || 120);
  return Math.max(30, Math.min(240, Number.isFinite(n) ? Math.round(n) : 120));
}

function cloneDashboardValue(value, key = '', limit = dashboardHistoryPointLimit()) {
  if (Array.isArray(value)) {
    const arr = key === 'history' ? value.slice(-limit) : value;
    return arr.map(item => cloneDashboardValue(item, '', limit));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 4000) return value.slice(0, 4000) + '…';
    return value;
  }
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === 'logs' || childKey === 'raw' || childKey === 'rawOutput') continue;
    out[childKey] = cloneDashboardValue(childValue, childKey, limit);
  }
  return out;
}

function dashboardStatusData(data = cache.data || EMPTY, opts = {}) {
  const limit = Number(opts.historyLimit || dashboardHistoryPointLimit());
  const out = cloneDashboardValue(data || EMPTY, '', limit) || {};
  delete out.topologyLinks;
  delete out.topologyNodes;
  delete out.topologyHidden;
  delete out.topologySpacing;
  delete out.topologyPositions;
  delete out.topologyView;
  out._viewHistoryLimit = limit;
  if (opts.compact) out._compact = true;
  return out;
}

function settingsAgentRows() {
  const pending = typeof agents.listPendingInstalls === 'function' ? agents.listPendingInstalls() : [];
  const rows = agents.listAgents().map(a => {
    const kind = a.pveNode || a.platform === 'proxmox' || a.role === 'proxmox'
      ? 'proxmox'
      : a.platform === 'windows' || a.role === 'windows'
      ? 'windows'
      : a.role === 'docker' || a.hasDocker
      ? 'docker'
      : 'linux';
    return {
      key: `${kind}:${a.id}`,
      kind,
      id: a.id,
      name: a.name,
      ip: a.ip || '',
      os: a.os || '',
      platform: a.platform || '',
      online: !!a.online,
      connecting: !!a.connecting,
      lastSeen: a.lastSeen || 0,
      meta: kind === 'docker' ? 'Docker agent' : kind === 'windows' ? 'Windows agent' : '',
    };
  });
  for (const p of pending) {
    rows.push({
      key: `${p.kind}:${p.id}`,
      kind: p.kind,
      id: p.id,
      name: p.name,
      ip: '',
      os: '',
      platform: '',
      online: false,
      connecting: true,
      lastSeen: p.createdAt || 0,
      meta: 'pending install',
    });
  }
  return rows;
}

function topologyLinksConfig() {
  const links = Array.isArray(config.topology?.links) ? config.topology.links : [];
  return links
    .filter(link => link && link.from && link.to && link.from !== link.to)
    .slice(0, 200)
    .map(link => ({
      from: String(link.from).slice(0, 160),
      to: String(link.to).slice(0, 160),
      label: String(link.label || '').slice(0, 80),
    }));
}

function topologyNodesConfig() {
  const nodes = Array.isArray(config.topology?.nodes) ? config.topology.nodes : [];
  const seen = new Set();
  return nodes
    .map(node => String(node || '').trim().slice(0, 160))
    .filter(node => {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      return true;
    })
    .slice(0, 200);
}

function topologyHiddenConfig() {
  const hidden = Array.isArray(config.topology?.hidden) ? config.topology.hidden : [];
  const seen = new Set();
  return hidden
    .map(node => String(node || '').trim().slice(0, 160))
    .filter(node => {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      return true;
    })
    .slice(0, 500);
}

function topologySpacingConfig() {
  const raw = config.topology?.spacing && typeof config.topology.spacing === 'object' ? config.topology.spacing : {};
  const proxmoxVmGap = Number(raw.proxmoxVmGap ?? raw.proxmoxGuestGap);
  return {
    proxmoxVmGap: Number.isFinite(proxmoxVmGap) ? Math.max(110, Math.min(260, Math.round(proxmoxVmGap))) : 150,
  };
}

function topologyPositionsConfig() {
  const raw = config.topology?.positions && typeof config.topology.positions === 'object' ? config.topology.positions : {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const ref = String(key || '').trim().slice(0, 160);
    const x = Number(value?.x);
    const y = Number(value?.y);
    if (!ref || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[ref] = {
      x: Math.max(-100000, Math.min(100000, Math.round(x))),
      y: Math.max(-100000, Math.min(100000, Math.round(y))),
    };
    if (Object.keys(out).length >= 500) break;
  }
  return out;
}

function topologyViewConfig() {
  const raw = config.topology?.view && typeof config.topology.view === 'object' ? config.topology.view : null;
  if (!raw) return null;
  const scale = Number(raw.scale);
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(scale) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    scale: Math.max(0.1, Math.min(5, scale)),
    x: Math.max(-100000, Math.min(100000, Math.round(x))),
    y: Math.max(-100000, Math.min(100000, Math.round(y))),
  };
}

function configuredList() {
  const en = c => c && c.enabled !== false;
  const hasPrometheus = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasDockhand = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasFirewall = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasTrueNas = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasQnap = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasUgreen = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasPbs = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasCloudflare = c => !!(c && (c.apiToken || c.token || c.bearerToken));
  const hasCiCd = c => !!(c && ((Array.isArray(c.projects) && c.projects.length) || (Array.isArray(c.instances) && c.instances.length)));
  const hasVeeam = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasPortainer = c => !!(c && (c.url || (Array.isArray(c.instances) && c.instances.length)));
  const hasCachedRows = key => {
    const value = cache.data?.[key];
    if (Array.isArray(value)) return value.length > 0;
    if (key === 'proxmox') return (value?.nodes || []).length > 0;
    if (key === 'dockhand') return (value?.instances || []).length > 0 || (value?.containers || []).length > 0;
    return !!value;
  };
  const ids = [];
  const snmpProfileId = device => {
    const p = String(device?.profile || device?.preset || '').trim().toLowerCase();
    return ['synology', 'mikrotik', 'unifi'].includes(p) ? p : 'snmp';
  };
  if (en(config.proxmox)      && (agents.hasPve() || hasCachedRows('proxmox') || (config.proxmox.url && config.proxmox.tokenId && config.proxmox.tokenSecret))) ids.push('proxmox');
  if (en(config.kubernetes)   && config.kubernetes.kubeconfig)          ids.push('kubernetes');
  if (en(config.linux)        && config.linux.agentToken && (agents.hasLinux?.() || hasCachedRows('linux'))) ids.push('linux');
  if (en(config.windows)      && config.linux?.agentToken && (agents.hasWindows?.() || hasCachedRows('windows'))) ids.push('windows');
  if (en(config.snmp)         && (config.snmp.devices || []).length) {
    const profiles = new Set((config.snmp.devices || []).map(snmpProfileId));
    ['synology', 'mikrotik', 'unifi', 'snmp'].forEach(id => { if (profiles.has(id)) ids.push(id); });
  }
  if (en(config.healthchecks) && config.healthchecks.url)               ids.push('healthchecks');
  if (en(config.uptimekuma)   && config.uptimekuma.url)                 ids.push('uptimekuma');
  if (en(config.checks)       && ((config.checks.services || config.checks.checks || []).length)) ids.push('checks');
  if (en(config.prometheus)   && hasPrometheus(config.prometheus))       ids.push('prometheus');
  if (en(config.docker)       && (agents.hasDocker() || hasCachedRows('docker') || (config.docker.hosts || []).length)) ids.push('docker');
  if (en(config.dockhand)     && hasDockhand(config.dockhand))           ids.push('dockhand');
  if (en(config.database)     && (config.database.instances || []).length) ids.push('database');
  if (en(config.firewall)     && hasFirewall(config.firewall))           ids.push('firewall');
  if (en(config.truenas)      && hasTrueNas(config.truenas))             ids.push('truenas');
  if (en(config.qnap)         && hasQnap(config.qnap))                   ids.push('qnap');
  if (en(config.ugreen)       && hasUgreen(config.ugreen))               ids.push('ugreen');
  if (en(config.pbs)          && hasPbs(config.pbs))                     ids.push('pbs');
  if (en(config.cloudflare)   && hasCloudflare(config.cloudflare))        ids.push('cloudflare');
  if (en(config.cicd)         && hasCiCd(config.cicd))                   ids.push('cicd');
  if (en(config.veeam)        && hasVeeam(config.veeam))                  ids.push('veeam');
  if (en(config.portainer)    && hasPortainer(config.portainer))         ids.push('portainer');
  return ids;
}

function trueNasConnectingData(conf = config.truenas) {
  const instances = trueNasConfigInstances(conf || {});
  const rows = instances.map((inst, idx) => ({
    name: inst.name || inst.url || `TrueNAS ${idx + 1}`,
    url: inst.url || '',
    apiMode: inst.apiMode || 'auto',
    online: false,
    _connecting: true,
    system: {},
    pools: [],
    disks: [],
    alerts: [],
    summary: { instances: 1, up: 0, down: 0, pools: 0, poolsHealthy: 0, poolsWarn: 0, disks: 0, disksWarn: 0, alertsCritical: 0, alertsWarning: 0 },
  }));
  return {
    online: false,
    _connecting: true,
    summary: {
      instances: rows.length,
      up: 0,
      down: 0,
      pools: 0,
      poolsHealthy: 0,
      poolsWarn: 0,
      disks: 0,
      disksWarn: 0,
      alertsCritical: 0,
      alertsWarning: 0,
    },
    instances: rows,
  };
}

function pbsConnectingData(conf = config.pbs) {
  const instances = pbsConfigInstances(conf || {});
  const rows = instances.map((inst, idx) => ({
    name: inst.name || inst.url || `PBS ${idx + 1}`,
    url: inst.url || '',
    online: false,
    _connecting: true,
    version: {},
    nodes: [],
    datastores: [],
    tasks: [],
    summary: { instances: 1, up: 0, down: 0, datastores: 0, datastoresWarn: 0, snapshots: 0, groups: 0, failedTasks: 0 },
  }));
  return {
    online: false,
    _connecting: true,
    summary: { instances: rows.length, up: 0, down: 0, datastores: 0, datastoresWarn: 0, snapshots: 0, groups: 0, failedTasks: 0 },
    instances: rows,
  };
}

function simpleNasConnectingData(conf, configuredInstancesFn, fallbackName) {
  const instances = configuredInstancesFn(conf || {});
  const rows = instances.map((inst, idx) => ({
    name: inst.name || inst.url || `${fallbackName} ${idx + 1}`,
    url: inst.url || '',
    online: false,
    _connecting: true,
    system: {},
    summary: { instances: 1, up: 0, down: 0 },
  }));
  return {
    online: false,
    _connecting: true,
    summary: { instances: rows.length, up: 0, down: 0 },
    instances: rows,
  };
}

function qnapConnectingData(conf = config.qnap) {
  return simpleNasConnectingData(conf, qnapConfigInstances, 'QNAP');
}

function ugreenConnectingData(conf = config.ugreen) {
  return simpleNasConnectingData(conf, ugreenConfigInstances, 'Ugreen');
}

function portainerConnectingData(conf = config.portainer) {
  const instances = portainerConfigInstances(conf || {});
  const rows = instances.map((inst, idx) => ({
    name: inst.name || inst.url || `Portainer ${idx + 1}`,
    url: inst.url || '',
    online: false,
    _connecting: true,
    version: '',
    environments: [],
    stacks: [],
    containers: [],
    summary: { instances: 1, up: 0, down: 0, environments: 0, environmentsUp: 0, environmentsDown: 0, stacks: 0, stacksWarn: 0, containers: 0, running: 0, stopped: 0 },
  }));
  return {
    online: false,
    _connecting: true,
    summary: { instances: rows.length, up: 0, down: 0, environments: 0, environmentsUp: 0, environmentsDown: 0, stacks: 0, stacksWarn: 0, containers: 0, running: 0, stopped: 0 },
    instances: rows,
  };
}

function cloudflareConnectingData(conf = config.cloudflare) {
  const zones = Array.isArray(conf?.zones) ? conf.zones.filter(Boolean).map(z => ({
    id: '',
    name: String(z),
    status: 'connecting',
    online: false,
    _connecting: true,
  })) : [];
  return {
    online: false,
    _connecting: true,
    summary: { zones: zones.length, zonesActive: 0, zonesWarn: 0, tunnels: 0, tunnelsHealthy: 0, tunnelsDown: 0, domains: 0, domainsExpiring: 0, domainsExpired: 0, domainsAutoRenew: 0, errors: 0 },
    zones,
    tunnels: [],
    domains: [],
  };
}

function cicdConnectingData(conf = config.cicd) {
  const projects = ciConfigProjects(conf || {});
  const rows = projects.map((row, idx) => ({
    name: row.name || row.repo || row.projectId || `CI Project ${idx + 1}`,
    provider: row.provider || 'github',
    branch: row.branch || row.ref || '',
    online: false,
    _connecting: true,
    pipelines: [],
    jobs: [],
  }));
  return {
    online: false,
    _connecting: true,
    summary: { projects: rows.length, up: 0, down: 0, partial: 0, pipelines: 0, success: 0, failed: 0, running: 0, canceled: 0, jobs: 0, jobsFailed: 0, jobsRunning: 0 },
    projects: rows,
  };
}

function veeamConnectingData(conf = config.veeam) {
  const instances = veeamConfigInstances(conf || {});
  const rows = instances.map((inst, idx) => ({
    name: inst.name || inst.url || `Veeam ${idx + 1}`,
    url: inst.url || '',
    online: false,
    _connecting: true,
    jobs: [],
    sessions: [],
    repositories: [],
    summary: { instances: 1, up: 0, down: 0, partial: 0, jobs: 0, jobsDisabled: 0, sessions: 0, failedSessions: 0, warningSessions: 0, runningSessions: 0, repositories: 0, repositoriesWarn: 0 },
  }));
  return {
    online: false,
    _connecting: true,
    summary: { instances: rows.length, up: 0, down: 0, partial: 0, jobs: 0, jobsDisabled: 0, sessions: 0, failedSessions: 0, warningSessions: 0, runningSessions: 0, repositories: 0, repositoriesWarn: 0 },
    instances: rows,
  };
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

function mergeDockhandConfigured(current, cfg = {}) {
  const configured = dockhandConfigInstances(cfg);
  const currentInstances = current?.instances || [];
  const instances = configured.map(inst => {
    const existing = currentInstances.find(row => row.name === inst.name || row.url === inst.url);
    return existing || {
      name: inst.name,
      url: inst.url,
      online: false,
      _connecting: true,
      summary: { total: 0, running: 0, stopped: 0, pending: 0, images: 0, unusedImages: 0 },
      containers: [],
      images: [],
    };
  });
  const containers = (current?.containers || []).filter(c => instances.some(i => i.name === c.sourceName || i.url === c.sourceUrl));
  const images = (current?.images || []).filter(i => instances.some(inst => inst.name === i.sourceName || inst.url === i.sourceUrl));
  const online = instances.some(i => i.online);
  const running = containers.filter(c => c.state === 'running').length;
  const stopped = containers.filter(c => ['exited', 'dead'].includes(c.state)).length;
  const pending = containers.filter(c => ['paused', 'restarting'].includes(c.state)).length;
  const unusedImages = images.filter(i => i.unused).length;
  return {
    online,
    _connecting: instances.some(i => i._connecting),
    summary: {
      servers: instances.length,
      serverUp: instances.filter(i => i.online).length,
      serverDown: instances.filter(i => !i.online && !i._connecting).length,
      total: containers.length,
      running,
      stopped,
      pending,
      images: images.length,
      unusedImages,
    },
    instances,
    containers,
    images,
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
  const durationText = (seconds) => {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n === 0) return '0 seconds';
    const units = [
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
      ['second', 1],
    ];
    const parts = [];
    let rest = Math.round(n);
    for (const [name, size] of units) {
      const value = Math.floor(rest / size);
      if (!value) continue;
      parts.push(`${value} ${name}${value === 1 ? '' : 's'}`);
      rest -= value * size;
      if (parts.length === 2) break;
    }
    return parts.join(' ');
  };
  const healthcheckInfoLines = (c = {}) => [
    c.project ? `Project: ${c.project}` : '',
    c.tags ? `Tags: ${c.tags}` : '',
    durationText(c.periodSec) ? `Period: ${durationText(c.periodSec)}` : '',
    durationText(c.graceSec) ? `Grace: ${durationText(c.graceSec)}` : '',
    Number.isFinite(Number(c.totalPings)) ? `Total Pings: ${Number(c.totalPings)}` : '',
  ].filter(Boolean);
  const healthcheckDeadlineMs = (c = {}) => {
    const lastPingMs = c.lastPing ? new Date(c.lastPing).getTime() : NaN;
    const periodSec = Number(c.periodSec);
    const graceSec = Number(c.graceSec);
    if (!Number.isFinite(lastPingMs) || !Number.isFinite(periodSec)) return null;
    return lastPingMs + Math.max(0, periodSec + (Number.isFinite(graceSec) ? graceSec : 0)) * 1000;
  };
  const healthcheckAlertOk = (c = {}, nowMs = Date.now()) => {
    if (String(c.status || '').toLowerCase() !== 'down') return true;
    const deadline = healthcheckDeadlineMs(c);
    return deadline != null && nowMs < deadline;
  };
  const dockerContainerLabels = (c = {}) => {
    if (c.labels && typeof c.labels === 'object' && !Array.isArray(c.labels)) return c.labels;
    if (c.Labels && typeof c.Labels === 'object' && !Array.isArray(c.Labels)) return c.Labels;
    const out = {};
    String(c.labelsText || c.labels || c.Labels || '').split(',').forEach(part => {
      const idx = part.indexOf('=');
      if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    });
    return out;
  };
  const suppressDockerContainerAlert = (c = {}) => {
    const state = String(c.state || '').toLowerCase();
    if (state === 'created') return true;
    const labels = dockerContainerLabels(c);
    if (Object.keys(labels).some(k => k.startsWith('io.kubernetes.') || k.startsWith('io.cri-containerd.'))) return true;
    const name = String(c.name || '');
    return /^k8s[_-]/i.test(name) || /(?:^|[_.-])k8s[_.-]/i.test(name);
  };
  const suppressKubernetesPodAlert = (p) => {
    const phase = String(p?.phase || '');
    const reason = String(p?.reason || '');
    if (phase === 'Succeeded' || reason === 'Completed') return true;
    const ownerKind = String(p?.ownerKind || '').toLowerCase();
    const restartPolicy = String(p?.restartPolicy || '').toLowerCase();
    const jobLike = ownerKind === 'job' || ownerKind === 'cronjob' || restartPolicy === 'never' || restartPolicy === 'onfailure';
    return jobLike && phase !== 'Failed';
  };
  const thresholds = alertThresholds();
  const anomaly = anomalySettings();
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
  const addAnomaly = (key, label, metric, value, history, historyKey) => {
    const result = anomalyResult(value, history, historyKey, anomaly);
    if (!result) return;
    add(key, result.ok, `${label} ${metric} anomaly`, result.ok
      ? `${result.current}% (normal ${result.average}%)`
      : `${result.current}% vs normal ${result.average}% (+${result.delta}%)`, {
        kind: 'anomaly',
        value: result.current,
        baseline: result.average,
        delta: result.delta,
        threshold: result.trigger,
        severity: result.severity,
        metric: metric.toLowerCase().includes('ram') || metric.toLowerCase().includes('memory') ? 'ram' : 'cpu',
        durationSeconds: anomaly.durationSeconds,
      });
  };
  (data.proxmox?.nodes || []).forEach(n => {
    if (n._connecting) return;
    const nm = n.node?.name || n.name || 'node';
    add('px:' + nm, !!n.node?.online, 'Proxmox node ' + nm, 'offline');
    if (n.node?.online) {
      addPct('px:' + nm + ':cpu', 'Proxmox node ' + nm, 'CPU usage', n.node?.cpu, thresholds.cpu);
      addPct('px:' + nm + ':ram', 'Proxmox node ' + nm, 'RAM usage', n.node?.ram?.percent, thresholds.ram);
      addAnomaly('px:' + nm + ':cpu:anomaly', 'Proxmox node ' + nm, 'CPU usage', n.node?.cpu, n.history, 'cpu');
      addAnomaly('px:' + nm + ':ram:anomaly', 'Proxmox node ' + nm, 'RAM usage', n.node?.ram?.percent, n.history, 'mem');
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
      addPct('lx:' + l.name + ':ram', 'Server ' + l.name, 'RAM usage', l.ram?.percent, thresholds.ram);
      addPct('lx:' + l.name + ':disk', 'Server ' + l.name, 'disk usage', l.disk?.percent, thresholds.disk);
      addAnomaly('lx:' + l.name + ':cpu:anomaly', 'Server ' + l.name, 'CPU usage', l.cpu, l.history, 'cpu');
      addAnomaly('lx:' + l.name + ':ram:anomaly', 'Server ' + l.name, 'RAM usage', l.ram?.percent, l.history, 'ram');
      (l.services || []).forEach(s => {
        if (!s.excluded) add('lx:' + l.name + ':' + s.name, !!s.active, l.name + ' / ' + s.name, 'inactive');
      });
    }
  });
  (data.windows || []).forEach(w => {
    if (w._connecting) return;
    add('win:' + w.name, !!w.online, 'Windows host ' + w.name, 'unreachable');
    if (w.online) {
      addPct('win:' + w.name + ':cpu', 'Windows host ' + w.name, 'CPU usage', w.cpu, thresholds.cpu);
      addPct('win:' + w.name + ':ram', 'Windows host ' + w.name, 'RAM usage', w.ram?.percent, thresholds.ram);
      addPct('win:' + w.name + ':disk', 'Windows host ' + w.name, 'disk usage', w.disk?.percent, thresholds.disk);
      addAnomaly('win:' + w.name + ':cpu:anomaly', 'Windows host ' + w.name, 'CPU usage', w.cpu, w.history, 'cpu');
      addAnomaly('win:' + w.name + ':ram:anomaly', 'Windows host ' + w.name, 'RAM usage', w.ram?.percent, w.history, 'ram');
      (w.services || []).forEach(s => {
        if (!s.excluded) add('win:' + w.name + ':' + s.name, !!s.active, w.name + ' / ' + s.name, 'inactive');
      });
    }
  });
  const k = data.kubernetes;
  if (k && k.online !== undefined) {
    add('k8s', !!k.online, 'Kubernetes', 'unreachable');
    if (k.online && (k._empty || k.error || k.resourceError)) {
      add('k8s:resources', false, 'Kubernetes', k.error || k.resourceError || 'no resources found');
    }
    if (k.online) (k.pods || []).forEach(p => {
      if (suppressKubernetesPodAlert(p)) return;
      const ok = !!p.running;
      const detail = [p.phase, p.ready === false ? 'not ready' : '', p.restarts ? `${p.restarts} restarts` : ''].filter(Boolean).join(' / ');
      add('k8s:' + p.namespace + '/' + p.name, ok, 'Pod ' + p.namespace + '/' + p.name, detail || p.phase);
    });
  }
  (data.snmp || []).forEach(s => {
    const snmpOk = !!s.online && !s._stale;
    add('snmp:' + s.name, snmpOk, 'SNMP ' + s.name, s._stale ? (s.error || 'temporary SNMP refresh failure') : 'unreachable');
    if (s.online && !s._stale) {
      addPct('snmp:' + s.name + ':cpu', 'SNMP ' + s.name, 'CPU usage', s.cpu, thresholds.cpu);
      addPct('snmp:' + s.name + ':ram', 'SNMP ' + s.name, 'RAM usage', s.ram?.percent, thresholds.ram);
      addAnomaly('snmp:' + s.name + ':cpu:anomaly', 'SNMP ' + s.name, 'CPU usage', s.cpu, s.history, 'cpu');
      addAnomaly('snmp:' + s.name + ':ram:anomaly', 'SNMP ' + s.name, 'RAM usage', s.ram?.percent, s.history, 'ram');
      (s.volumes || []).forEach(v => addPct('snmp:' + s.name + ':volume:' + (v.name || 'volume'), 'SNMP ' + s.name + ' volume ' + (v.name || 'volume'), 'disk usage', v.percent, thresholds.disk));
    }
  });
  (data.docker || []).forEach(h => {
    if (h._connecting) return;
    add('dk:' + h.name, !!h.online, 'Docker host ' + h.name, 'unreachable');
    if (h.online) {
      addAnomaly('dk:' + h.name + ':cpu:anomaly', 'Docker host ' + h.name, 'CPU usage', h.summary?.cpu, h.history, 'cpu');
      addAnomaly('dk:' + h.name + ':ram:anomaly', 'Docker host ' + h.name, 'RAM usage', h.summary?.memPercent, h.history, 'mem');
      (h.containers || []).forEach(c => {
        if (suppressDockerContainerAlert(c)) return;
        const ok = c.state === 'running';
        add('dk:' + h.name + ':' + c.name, ok, 'Container ' + c.name + ' @ ' + h.name, c.state);
      });
    }
  });
  const hc = data.healthchecks;
  if (hc && Array.isArray(hc.checks)) hc.checks.forEach(c => {
    const nm = c.name || c.slug;
    add('hc:' + nm, healthcheckAlertOk(c), 'Healthcheck ' + nm, c.status, {
      kind: 'healthchecks',
      durationSeconds: 0,
      infoLines: healthcheckInfoLines(c),
    });
  });
  const uk = data.uptimekuma;
  if (uk && Array.isArray(uk.monitors)) uk.monitors.forEach(m => {
    const nm = m.name || m.id;
    add('uk:' + nm, m.status !== 'down', 'Uptime Kuma ' + nm, m.status);
  });
  const builtin = data.checks;
  if (builtin && Array.isArray(builtin.checks)) builtin.checks.forEach(c => {
    const nm = c.name || c.target || 'check';
    add('check:' + nm, c.status === 'up', 'Service check ' + nm, c.error || c.status);
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
  const fw = data.firewall;
  if (fw && Array.isArray(fw.instances)) fw.instances.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.url || 'Firewall';
    add('firewall:' + nm, !!i.online && !i.partial, 'Firewall ' + nm, i.error || (i.partial ? 'partial API data' : 'unreachable'));
    if (i.online && Number(i.summary?.interfacesDown || 0) > 0) add('firewall-link:' + nm, false, 'Firewall link ' + nm, `${i.summary.interfacesDown} link(s) down`);
    if (i.online && Number(i.summary?.updates || 0) > 0) add('firewall-update:' + nm, false, 'Firewall updates ' + nm, `${i.summary.updates} update(s) available`);
    if (i.online && i.summary?.rebootRequired) add('firewall-reboot:' + nm, false, 'Firewall reboot ' + nm, 'reboot required');
  });
  const tn = data.truenas;
  if (tn && Array.isArray(tn.instances)) tn.instances.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.url || 'TrueNAS';
    add('truenas:' + nm, !!i.online && !i.partial, 'TrueNAS ' + nm, i.error || (i.partial ? 'partial API data' : 'unreachable'));
    if (i.online && Number(i.summary?.poolsWarn || 0) > 0) add('truenas-pool:' + nm, false, 'TrueNAS pool ' + nm, `${i.summary.poolsWarn} pool(s) need attention`);
    if (i.online && Number(i.summary?.disksWarn || 0) > 0) add('truenas-disk:' + nm, false, 'TrueNAS disk ' + nm, `${i.summary.disksWarn} disk(s) need attention`);
    if (i.online && Number(i.summary?.alertsCritical || 0) > 0) add('truenas-alert:' + nm, false, 'TrueNAS alert ' + nm, `${i.summary.alertsCritical} critical alert(s)`);
  });
  const qnap = data.qnap;
  if (qnap && Array.isArray(qnap.instances)) qnap.instances.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.url || 'QNAP';
    add('qnap:' + nm, !!i.online && !i.partial, 'QNAP ' + nm, i.error || (i.partial ? 'partial API data' : 'unreachable'));
  });
  const ugreen = data.ugreen;
  if (ugreen && Array.isArray(ugreen.instances)) ugreen.instances.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.url || 'Ugreen';
    add('ugreen:' + nm, !!i.online && !i.partial, 'Ugreen ' + nm, i.error || (i.partial ? 'partial API data' : 'unreachable'));
  });
  const pbs = data.pbs;
  if (pbs && Array.isArray(pbs.instances)) pbs.instances.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.url || 'PBS';
    add('pbs:' + nm, !!i.online && !i.partial, 'Proxmox Backup ' + nm, i.error || (i.partial ? 'partial API data' : 'unreachable'));
    if (i.online && Number(i.summary?.datastoresWarn || 0) > 0) add('pbs-datastore:' + nm, false, 'PBS datastore ' + nm, `${i.summary.datastoresWarn} datastore(s) need attention`);
    if (i.online && Number(i.summary?.failedTasks || 0) > 0) add('pbs-task:' + nm, false, 'PBS task ' + nm, `${i.summary.failedTasks} failed task(s)`);
  });
  const cf = data.cloudflare;
  if (cf && cf.online !== undefined) {
    const sm = cf.summary || {};
    if (!cf._connecting) {
      add('cloudflare', !!cf.online && !cf.partial, 'Cloudflare', cf.error || (cf.partial ? 'partial API data' : 'unreachable'));
      if (cf.online && Number(sm.zonesWarn || 0) > 0) add('cloudflare-zones', false, 'Cloudflare zones', `${sm.zonesWarn} zone(s) need attention`);
      if (cf.online && Number(sm.tunnelsDown || 0) > 0) add('cloudflare-tunnels', false, 'Cloudflare tunnels', `${sm.tunnelsDown} tunnel(s) down`);
      if (cf.online && Number(sm.domainsExpired || 0) > 0) add('cloudflare-domains-expired', false, 'Cloudflare domains', `${sm.domainsExpired} domain(s) expired`);
      if (cf.online && Number(sm.domainsExpiring || 0) > 0) add('cloudflare-domains-expiring', false, 'Cloudflare domains', `${sm.domainsExpiring} domain(s) expiring soon`);
    }
  }
  const ci = data.cicd;
  if (ci && Array.isArray(ci.projects)) ci.projects.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.repo || i.projectId || 'CI/CD';
    const sm = i.summary || {};
    add('cicd:' + nm, !!i.online && !i.partial, 'CI/CD ' + nm, i.error || (i.partial ? 'partial API data' : 'unreachable'));
    const failed = (i.pipelines || []).filter(p => p.failed).length || Number(sm.failed || 0);
    if (i.online && failed > 0) add('cicd-failed:' + nm, false, 'CI/CD failed ' + nm, `${failed} failed run(s)`);
  });
  const veeam = data.veeam;
  if (veeam && Array.isArray(veeam.instances)) veeam.instances.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.url || 'Veeam';
    const sm = i.summary || {};
    add('veeam:' + nm, !!i.online && !i.partial, 'Veeam ' + nm, i.error || (i.partial ? 'partial API data' : 'unreachable'));
    if (i.online && Number(sm.failedSessions || 0) > 0) add('veeam-session:' + nm, false, 'Veeam session ' + nm, `${sm.failedSessions} failed session(s)`);
    if (i.online && Number(sm.warningSessions || 0) > 0) add('veeam-warning:' + nm, false, 'Veeam warning ' + nm, `${sm.warningSessions} warning session(s)`);
    if (i.online && Number(sm.repositoriesWarn || 0) > 0) add('veeam-repo:' + nm, false, 'Veeam repository ' + nm, `${sm.repositoriesWarn} repository(s) need attention`);
  });
  const portainer = data.portainer;
  if (portainer && Array.isArray(portainer.instances)) portainer.instances.forEach(i => {
    if (i._connecting) return;
    const nm = i.name || i.url || 'Portainer';
    add('portainer:' + nm, !!i.online && !i.partial, 'Portainer ' + nm, i.error || (i.partial ? 'partial API data' : 'unreachable'));
    if (i.online && Number(i.summary?.environmentsDown || 0) > 0) add('portainer-env:' + nm, false, 'Portainer environment ' + nm, `${i.summary.environmentsDown} environment(s) down`);
    if (i.online && Number(i.summary?.stacksWarn || 0) > 0) add('portainer-stack:' + nm, false, 'Portainer stack ' + nm, `${i.summary.stacksWarn} stack(s) need attention`);
  });
  (data.database || []).forEach(d => add('db:' + d.name, !!d.online, 'Database ' + d.name, 'unreachable'));
  return m;
}

const ALERT_STARTUP_GRACE_MS = 60000;
let prevChecks = null;
const alertFirstSeen = new Map();
const alertProblemSince = new Map();
const alertActiveSeverity = new Map();
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
function anomalySettings() {
  const a = config.alerts?.anomaly || {};
  return {
    enabled: a.enabled === true,
    minSamples: Math.max(6, Math.min(240, Math.round(Number(a.minSamples || 12)))),
    minIncrease: Math.max(5, Math.min(100, Math.round(Number(a.minIncrease || a.minDelta || 25)))),
    sensitivity: Math.max(1, Math.min(6, Number(a.sensitivity || 2))),
    minValue: Math.max(1, Math.min(100, Math.round(Number(a.minValue || 50)))),
    durationSeconds: secondsValue(a.durationSeconds ?? a.forSeconds ?? 120, 120),
  };
}
function historyMetricValues(history, key, current) {
  let vals = (Array.isArray(history) ? history : [])
    .map(p => Number(p?.[key]))
    .filter(Number.isFinite)
    .map(v => Math.max(0, Math.min(100, v)));
  if (vals.length > 1 && Number.isFinite(Number(current)) && Math.abs(vals[vals.length - 1] - Number(current)) < 0.05) {
    vals = vals.slice(0, -1);
  }
  return vals;
}
function anomalyResult(value, history, historyKey, settings = anomalySettings()) {
  if (!settings.enabled) return null;
  const current = pctNumber(value);
  if (current == null) return null;
  const vals = historyMetricValues(history, historyKey, current);
  if (vals.length < settings.minSamples) return null;
  const avgRaw = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + Math.pow(b - avgRaw, 2), 0) / vals.length;
  const std = Math.sqrt(variance);
  const average = Math.round(avgRaw * 10) / 10;
  const delta = Math.round((current - average) * 10) / 10;
  const trigger = Math.round(Math.max(settings.minValue, average + settings.minIncrease, average + Math.max(8, std * settings.sensitivity)) * 10) / 10;
  const active = current >= trigger && delta >= settings.minIncrease;
  return {
    ok: !active,
    current,
    average,
    delta,
    trigger,
    severity: current >= Math.min(100, trigger + settings.minIncrease) ? 'critical' : 'warning',
  };
}
function secondsValue(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.max(0, Math.round(n));
}
const DEFAULT_ALERT_RULE = { durationSeconds: 60 };
const DEFAULT_SNMP_ALERT_RULE = { durationSeconds: 120 };
function configuredAlertRule(rules, key) {
  const rule = rules?.[key];
  return rule && typeof rule === 'object' ? rule : null;
}
function alertRuleForCheck(key, check = {}) {
  const rules = config.alerts?.rules || {};
  const defaultRule = configuredAlertRule(rules, 'default') || DEFAULT_ALERT_RULE;
  const metric = String(check.metric || '').toLowerCase();
  if (check.kind === 'anomaly') return config.alerts?.anomaly?.rules?.[metric] || config.alerts?.anomaly || configuredAlertRule(rules, 'anomaly') || defaultRule;
  if (check.kind === 'threshold' && metric) return configuredAlertRule(rules, metric) || defaultRule;
  if (String(key || '').startsWith('snmp:')) return configuredAlertRule(rules, 'snmp') || DEFAULT_SNMP_ALERT_RULE;
  if (String(key || '').startsWith('k8s:')) return configuredAlertRule(rules, 'pod') || defaultRule;
  if (String(key || '').startsWith('dk:') && String(key || '').split(':').length >= 3) return configuredAlertRule(rules, 'container') || defaultRule;
  if (String(key || '').startsWith('prom:') && !String(key || '').startsWith('prom:instance:')) return configuredAlertRule(rules, 'target') || defaultRule;
  if (String(key || '').startsWith('check:')) return configuredAlertRule(rules, 'target') || defaultRule;
  return defaultRule;
}
function alertDelayMs(key, check) {
  if (check && check.durationSeconds != null) return secondsValue(check.durationSeconds, 0) * 1000;
  const rule = alertRuleForCheck(key, check);
  return secondsValue(rule.durationSeconds ?? rule.forSeconds ?? rule.delaySeconds, 0) * 1000;
}
function parseClockMinutes(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
function dayMatches(rule, date) {
  const days = rule.days || rule.day || rule.weekdays;
  if (!days || (Array.isArray(days) && !days.length)) return true;
  const names = ['sun','mon','tue','wed','thu','fri','sat'];
  const cur = names[date.getDay()];
  return (Array.isArray(days) ? days : String(days).split(',')).map(d => String(d).trim().slice(0,3).toLowerCase()).includes(cur);
}
function inMaintenanceWindow(now = Date.now()) {
  return !!currentMaintenanceWindow(now);
}
function currentMaintenanceWindow(now = Date.now()) {
  const windows = config.alerts?.maintenanceWindows || config.alerts?.maintenance || [];
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
function isAlertMuted(key, now = Date.now()) {
  const rec = alertMutes.get(key);
  if (!rec) return false;
  if (Number(rec.until || 0) <= now) {
    alertMutes.delete(key);
    saveAlertMutes();
    return false;
  }
  return true;
}
function logAlertResult(rs) {
  (rs || []).forEach(r => { if (!r.ok) console.warn(`Alert ${r.channel} failed: ${r.error}`); });
}
function dispatchTrackedAlert(alertConfig, alert, meta = {}, only) {
  const signature = alertDeliverySignature(meta);
  const now = Date.now();
  if (signature && alertNotificationInCooldown(signature, now)) return null;
  if (signature) alertSentAtBySignature.set(signature, now);
  const effectiveConfig = alertConfigForKey(alertConfig, meta.key || alert.key || '');
  const entry = pushAlertHistory({
    ...meta,
    title: alert.title || '',
    message: alert.message || '',
    priority: alert.priority || '',
    tags: alert.tags || '',
    status: 'sending',
    channels: [],
  });
  dispatchAlert(effectiveConfig, alert, only)
    .then(results => {
      entry.channels = results;
      entry.status = results.some(r => r.ok) ? 'sent' : 'failed';
      if (signature) {
        if (entry.status === 'sent') alertSentAtBySignature.set(signature, Number(entry.t || Date.now()));
        else alertSentAtBySignature.delete(signature);
      }
      saveAlertHistory();
      logAlertResult(results);
    })
    .catch(err => {
      if (signature) alertSentAtBySignature.delete(signature);
      entry.status = 'failed';
      entry.error = err.message || String(err);
      saveAlertHistory();
    });
}
function alertInfoText(check = {}) {
  return Array.isArray(check.infoLines) && check.infoLines.length ? `\n${check.infoLines.join('\n')}` : '';
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
  for (const key of Array.from(alertProblemSince.keys())) {
    if (!cur.has(key) || cur.get(key)?.ok) alertProblemSince.delete(key);
  }
  if (prevChecks === null) { prevChecks = cur; return; }
  const sendProblem = c => {
    const threshold = c.kind === 'threshold';
    const anomaly = c.kind === 'anomaly';
    const critical = (!threshold && !anomaly) || c.severity === 'critical';
    dispatchTrackedAlert(config.alerts, {
      title: anomaly
        ? `${critical ? '\u{1F534} CRITICAL' : '\u26A0\uFE0F WARNING'} ANOMALY \u2014 ${c.label}`
        : threshold
        ? `${critical ? '\u{1F534} CRITICAL' : '\u26A0\uFE0F WARNING'} \u2014 ${c.label}`
        : `\u{1F534} DOWN \u2014 ${c.label}`,
      message: anomaly
        ? `${c.label} is outside normal range: ${c.detail}\n${new Date().toLocaleString()}`
        : threshold
        ? `${c.label} is ${c.severity}: ${c.detail}\n${new Date().toLocaleString()}`
        : `${c.label} is ${c.detail || 'down'}${alertInfoText(c)}\n${new Date().toLocaleString()}`,
      priority: critical ? 'high' : 'default', tags: critical ? 'rotating_light' : 'warning',
    }, {
      type: 'problem',
      severity: (threshold || anomaly) ? c.severity : 'critical',
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
    const anomaly = c.kind === 'anomaly';
    dispatchTrackedAlert(config.alerts, {
      title: (threshold || anomaly) ? `\u{1F7E2} NORMAL \u2014 ${c.label}` : `\u{1F7E2} UP \u2014 ${c.label}`,
      message: anomaly
        ? `${c.label} is back in its normal range\n${new Date().toLocaleString()}`
        : threshold
        ? `${c.label} is back below threshold\n${new Date().toLocaleString()}`
        : `${c.label} recovered${alertInfoText(c)}\n${new Date().toLocaleString()}`,
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
    const activeSeverity = alertActiveSeverity.get(key);
    const muted = notifyDisabledForKey(key) || isAlertMuted(key, now);
    if (c.ok) {
      alertProblemSince.delete(key);
      if (activeSeverity && !muted) sendRecovery(c);
      alertActiveSeverity.delete(key);
      continue;
    }
    if (!alertProblemSince.has(key)) alertProblemSince.set(key, now);
    if (muted || inMaintenanceWindow(now)) continue;
    if (now - (alertFirstSeen.get(key) || now) < ALERT_STARTUP_GRACE_MS) continue;
    if (now - (alertProblemSince.get(key) || now) < alertDelayMs(key, c)) continue;
    const severity = c.kind === 'threshold' ? c.severity : 'critical';
    sendProblem(c);
    alertActiveSeverity.set(key, severity || 'critical');
  }
  prevChecks = cur;
}

const STALE_KEEP_MS = 120000;
function preserveSnmpOnTransient(nextRows, err) {
  const prevRows = Array.isArray(cache.data?.snmp) ? cache.data.snmp : [];
  if (!prevRows.some(row => row?.online)) return nextRows;
  const rows = Array.isArray(nextRows) ? nextRows : [];
  const now = Date.now();
  if (!rows.length && err) {
    return prevRows.map(row => {
      if (!row?.online) return row;
      const staleSince = row._staleSince || now;
      const error = err?.message || 'temporary SNMP refresh failure';
      if (now - staleSince > STALE_KEEP_MS) {
        return {
          name: row.name,
          host: row.host,
          profile: row.profile,
          snmpVersion: row.snmpVersion,
          online: false,
          error,
          _stale: false,
          _staleSince: null,
        };
      }
      return { ...row, _stale: true, _staleSince: staleSince, error };
    });
  }
  return rows.map(row => {
    if (!row) return row;
    const prev = prevRows.find(old => sameSnmpDevice(old, row));
    const failed = row.online === false || row._connecting || (!!row.error && !row.online);
    if (!failed || !prev?.online) return { ...row, _stale: false, _staleSince: null };
    const staleSince = prev._staleSince || now;
    if (now - staleSince > STALE_KEEP_MS) return { ...row, _stale: false, _staleSince: null };
    return {
      ...prev,
      _stale: true,
      _staleSince: staleSince,
      error: row.error || err?.message || 'temporary SNMP refresh failure',
    };
  });
}

function preserveHealthchecksOnTransient(next, err) {
  const prev = cache.data?.healthchecks;
  const hasPrevious = prev?.online && Array.isArray(prev.checks) && prev.checks.length;
  if (!hasPrevious) return next;
  if (!next && !err) return next;
  if (next?._connecting) {
    return { ...prev, _stale: true, _staleSince: prev._staleSince || Date.now(), error: 'refresh in progress' };
  }
  const emptyDrop = next?.online && Array.isArray(next.checks) && next.checks.length === 0;
  const failed = !next?.online && (next?.error || err);
  const looksTransient = emptyDrop || failed;
  if (!looksTransient) return { ...next, _stale: false, _staleSince: null, error: undefined };
  const now = Date.now();
  const staleSince = prev._staleSince || now;
  if (now - staleSince > STALE_KEEP_MS) return next;
  return {
    ...prev,
    _stale: true,
    _staleSince: staleSince,
    error: emptyDrop ? 'temporary empty Healthchecks response' : (next?.error || err?.message || 'temporary Healthchecks refresh failure'),
  };
}

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

const uptimeKumaHistory = loadHistoryMap('uptimekuma-history', HISTORY_STORE_MAX);
function heartbeatKey(h) {
  return [h?.time || '', h?.status || '', h?.ping ?? '', h?.message || ''].join('|');
}
function normalizeUptimeStatusValue(value, fallback = 'unknown') {
  if (value === undefined || value === null || value === '') return fallback || 'unknown';
  if (typeof value === 'boolean') return value ? 'up' : 'down';
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric === 1) return 'up';
    if (numeric === 0) return 'down';
    if (numeric === 2) return 'pending';
    if (numeric === 3) return 'maintenance';
  }
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback || 'unknown';
  if (['up', 'ok', 'online', 'healthy', 'success', 'passing'].includes(s)) return 'up';
  if (['down', 'offline', 'fail', 'failed', 'error', 'critical'].includes(s)) return 'down';
  if (['pending', 'paused', 'waiting'].includes(s)) return 'pending';
  if (s.includes('maintenance') || s === 'maint') return 'maintenance';
  if (s === 'unknown') return 'unknown';
  return fallback || 'unknown';
}
function normalizeUptimeHistoryPoint(h, fallbackStatus = 'unknown') {
  if (!h) return h;
  const fallback = normalizeUptimeStatusValue(fallbackStatus, 'unknown');
  let status = normalizeUptimeStatusValue(h.status ?? h.state, fallback);
  if (status === 'unknown' && fallback !== 'unknown' && h.source === 'omnisight') status = fallback;
  return { ...h, status };
}
function uptimeKumaHistoryHours(value) {
  const hours = Number(value || 1);
  if (!Number.isFinite(hours) || hours <= 0) return 1;
  return Math.min(Math.max(hours, 0.25), 24);
}
function mergeHeartbeatHistory(prevHistory = [], nextHistory = [], hours = 1, fallbackStatus = 'unknown') {
  const cutoff = Date.now() - (uptimeKumaHistoryHours(hours) * 60 * 60 * 1000);
  const byKey = new Map();
  [...prevHistory, ...nextHistory].forEach(h => {
    if (!h) return;
    const point = normalizeUptimeHistoryPoint(h, fallbackStatus);
    byKey.set(heartbeatKey(point), point);
  });
  const sorted = [...byKey.values()]
    .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
  const recent = sorted.filter(h => {
    const t = new Date(h?.time || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  return (recent.length ? recent : sorted)
    .slice(-historyRetentionMaxPoints());
}
function uptimeKumaMonitorKeys(m = {}) {
  return [m.id, m.name, m.url].filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(v => String(v));
}
function uptimeKumaHistoryKey(m = {}) {
  return uptimeKumaMonitorKeys(m)[0] || 'monitor';
}
function observedUptimeKumaHeartbeat(m = {}, now = Date.now()) {
  const status = normalizeUptimeStatusValue(m.status ?? m.state, 'unknown');
  if (status === 'unknown') return null;
  return {
    status,
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
    const fallbackStatus = normalizeUptimeStatusValue(m.status ?? m.state, old?.status || 'unknown');
    const observed = observedUptimeKumaHeartbeat(m, now);
    const lastStored = stored[stored.length - 1];
    const lastTime = new Date(lastStored?.time || 0).getTime();
    const addObserved = observed && (!lastStored || !Number.isFinite(lastTime) || now - lastTime > REFRESH_INTERVAL / 2);
    const history = mergeHeartbeatHistory(stored, old?.history || [], keepHours, fallbackStatus);
    const withLive = mergeHeartbeatHistory(history, [...(m.history || []), ...(addObserved ? [observed] : [])], keepHours, fallbackStatus);
    uptimeKumaHistory.set(storeKey, withLive);
    if (addObserved || (m.history || []).length) changed = true;
    return { ...m, status: fallbackStatus, history: withLive };
  });
  if (changed) scheduleSaveHistoryMap('uptimekuma-history', uptimeKumaHistory, historyRetentionMaxPoints());
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

const OBJECT_INSTANCE_PLATFORMS = new Set(['prometheus', 'dockhand', 'firewall', 'truenas', 'qnap', 'ugreen', 'pbs', 'cloudflare', 'cicd', 'veeam', 'portainer']);
function objectPlatformHasUsableData(value) {
  if (!value || typeof value !== 'object') return false;
  const instances = Array.isArray(value.instances) ? value.instances : [];
  if (instances.some(inst => inst && !inst._connecting && inst.online !== false)) return true;
  if (Array.isArray(value.targets) && value.targets.length) return true;
  if (Array.isArray(value.containers) && value.containers.length) return true;
  return value.online === true && !value._connecting;
}

function objectPlatformLooksTransient(next, err) {
  if (!next || err) return true;
  if (next._connecting) return true;
  const instances = Array.isArray(next.instances) ? next.instances : [];
  if (instances.length && instances.every(inst => inst?._connecting || inst?.error || inst?.online === false)) return true;
  return next.online === false && !!next.error;
}

function preserveObjectPlatformOnTransient(key, next, err) {
  const prev = cache.data?.[key];
  if (!objectPlatformHasUsableData(prev)) return next;
  if (!objectPlatformLooksTransient(next, err)) return { ...next, _stale: false, _staleSince: null, error: undefined };
  const now = Date.now();
  const staleSince = prev._staleSince || now;
  if (now - staleSince > STALE_KEEP_MS) return next;
  return {
    ...prev,
    _stale: true,
    _staleSince: staleSince,
    error: next?.error || err?.message || `temporary ${key} refresh failure`,
  };
}

function arrayPlatformHasUsableData(rows) {
  return Array.isArray(rows) && rows.some(row => row && !row._connecting && row.online !== false);
}

function preserveArrayPlatformOnTransient(key, nextRows, err) {
  const prevRows = Array.isArray(cache.data?.[key]) ? cache.data[key] : [];
  if (!arrayPlatformHasUsableData(prevRows)) return nextRows;
  const rows = Array.isArray(nextRows) ? nextRows : [];
  const failed = !!err || !rows.length || rows.every(row => row?._connecting || row?.error || row?.online === false);
  if (!failed) return rows.map(row => row ? { ...row, _stale: false, _staleSince: null } : row);
  const now = Date.now();
  return prevRows.map(row => {
    if (!row || row.online === false) return row;
    const staleSince = row._staleSince || now;
    if (now - staleSince > STALE_KEEP_MS) return row;
    return {
      ...row,
      _stale: true,
      _staleSince: staleSince,
      error: err?.message || `temporary ${key} refresh failure`,
    };
  });
}

function preservePlatformOnTransient(key, next, err) {
  if (OBJECT_INSTANCE_PLATFORMS.has(key)) return preserveObjectPlatformOnTransient(key, next, err);
  if (key === 'database') return preserveArrayPlatformOnTransient(key, next, err);
  return next;
}

function backgroundRefresh(opts = {}) {
  const force = opts === true || opts.force === true;
  if (refreshActiveCount >= maxRefreshActiveTasks()) {
    return refreshPromise || Promise.resolve(ensureRuntimeShell(cache.data));
  }
  if (force && refreshBusy()) {
    return refreshPromise || Promise.resolve({ ...ensureRuntimeShell(cache.data), refreshing: true });
  }
  if (force) {
    refreshGeneration += 1;
  }
  const enabled = c => c && c.enabled !== false;
  cache.data = ensureRuntimeShell(cache.data);
  const base = cache.data;
  const generation = refreshGeneration;
  base.loading = false;
  assignStatic(base);
  broadcastStatusEvent('refreshing');

  const taskDefs = [
    ['proxmox',      enabled(config.proxmox),      () => getProxmoxData(),                      { clusterSummary: null, nodes: [] }],
    ['linux',        enabled(config.linux),        () => Promise.resolve(getLinuxData()),        []],
    ['windows',      enabled(config.windows),      () => Promise.resolve(getWindowsData()),      []],
    ['kubernetes',   enabled(config.kubernetes),   () => getAllKubernetesData(config.kubernetes), null],
    ['snmp',         enabled(config.snmp),         () => getAllSynologyData(config.snmp),         []],
    ['healthchecks', enabled(config.healthchecks), () => getAllHealthchecks(config.healthchecks), null],
    ['uptimekuma',   enabled(config.uptimekuma),   () => getAllUptimeKuma(uptimeKumaConfig()),    null],
    ['checks',       enabled(config.checks),       () => getAllChecks(checksConfig()),            null],
    ['prometheus',   enabled(config.prometheus),   () => getPrometheusData(config.prometheus),    null],
    ['docker',       enabled(config.docker),       () => getDockerData(),                        []],
    ['dockhand',     enabled(config.dockhand),     () => getAllDockhand(config.dockhand),         null],
    ['database',     enabled(config.database),     () => getAllDatabaseData(config.database),     []],
    ['firewall',     enabled(config.firewall),     () => getAllFirewallData(config.firewall),     null],
    ['truenas',      enabled(config.truenas),      () => getAllTrueNasData(config.truenas),       null],
    ['qnap',         enabled(config.qnap),         () => getAllQnapData(config.qnap),             null],
    ['ugreen',       enabled(config.ugreen),       () => getAllUgreenData(config.ugreen),         null],
    ['pbs',          enabled(config.pbs),          () => getAllPbsData(config.pbs),               null],
    ['cloudflare',   enabled(config.cloudflare),   () => getCloudflareData(config.cloudflare),    null],
    ['cicd',         enabled(config.cicd),         () => getAllCiData(config.cicd),               null],
    ['veeam',        enabled(config.veeam),        () => getAllVeeamData(config.veeam),           null],
    ['portainer',    enabled(config.portainer),    () => getAllPortainerData(config.portainer),   null],
  ];

  const taskFns = [];
  for (const [key, isEnabled, factory, fb] of taskDefs) {
    if (!isEnabled) {
      base[key] = fb;
      const st = platformRefreshState[key];
      if (st) { st.inFlight = false; st.failures = 0; st.nextDue = Date.now() + platformRefreshIntervalMs(key); }
      continue;
    }
    if (!shouldRunPlatformRefresh(key, force)) continue;
    markPlatformRefreshStart(key);
    taskFns.push(async () => {
      let ok = true;
      try {
        const v = await factory();
        if (generation !== refreshGeneration) return;
        const next = (v == null ? fb : v);
        base[key] = key === 'proxmox' ? preserveProxmoxOnTransient(next)
          : key === 'kubernetes' ? keepKubernetesConnectingAfterConfigChange(next)
          : key === 'docker' ? mergeDockerHistory(preserveDockerOnTransient(next))
          : key === 'healthchecks' ? preserveHealthchecksOnTransient(next)
          : key === 'uptimekuma' ? preserveUptimeKumaOnTransient(mergeUptimeKumaHistory(next))
          : key === 'snmp' ? preserveSnmpOnTransient(next)
          : key === 'checks' && next ? { ...next, historyHours: checksConfig().historyHours }
          : OBJECT_INSTANCE_PLATFORMS.has(key) || key === 'database' ? preservePlatformOnTransient(key, next)
          : next;
        ok = !platformResultLooksFailed(key, base[key], isEnabled);
        base.timestamp = new Date().toISOString();
      } catch (err) {
        ok = false;
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
        } else if (key === 'healthchecks') {
          base[key] = preserveHealthchecksOnTransient(fb, err);
          if (base[key]?._stale) console.warn(`Healthchecks refresh failed; keeping last data: ${err.message}`);
        } else if (key === 'snmp') {
          base[key] = preserveSnmpOnTransient(fb, err);
          if ((base[key] || []).some(row => row._stale)) console.warn(`SNMP refresh failed; keeping last data: ${err.message}`);
        } else if (key === 'kubernetes') {
          base[key] = keepKubernetesConnectingAfterConfigChange(fb, err);
        } else if (OBJECT_INSTANCE_PLATFORMS.has(key) || key === 'database') {
          base[key] = preservePlatformOnTransient(key, fb, err);
          const kept = Array.isArray(base[key]) ? base[key].some(row => row?._stale) : base[key]?._stale;
          if (kept) console.warn(`${key} refresh failed; keeping last data: ${err.message}`);
        } else {
          base[key] = fb;
        }
      } finally {
        markPlatformRefreshDone(key, ok);
      }
    });
  }

  const finalize = () => {
    if (generation !== refreshGeneration) return;
    base.linux = filterLinuxProxmoxRows(base.linux, base.proxmox);
    base.loading = false;
    base.timestamp = new Date().toISOString();
    runAlertChecks(base);
    const svcs = buildPublicSummary(base);
    svcs.forEach(s => {
      if (!PLATFORM_HISTORY[s.id]) PLATFORM_HISTORY[s.id] = [];
      let score = 100;
      if (s.status === 'down') score = 0;
      else if (s.status === 'warn') score = 65;
      PLATFORM_HISTORY[s.id].push({ health: score, time: Date.now() });
      const maxHist = historyRetentionMaxPoints();
      if (PLATFORM_HISTORY[s.id].length > maxHist) PLATFORM_HISTORY[s.id].splice(0, PLATFORM_HISTORY[s.id].length - maxHist);
    });
    savePlatformHistory();
    base._snapshot = false;
    clearViewCache();
    scheduleRuntimeSnapshotSave(base);
    broadcastStatusEvent('updated');
  };

  if (!taskFns.length) {
    if (base.loading) finalize();
    return Promise.resolve(base);
  }

  refreshActiveCount += taskFns.length;
  const currentPromise = runLimited(taskFns, collectorConcurrencyLimit())
    .then(() => { 
      finalize();
    })
    .catch(err => { console.error(err.message); })
    .finally(() => {
      refreshActiveCount = Math.max(0, refreshActiveCount - taskFns.length);
      if (refreshPromise === currentPromise) refreshPromise = null;
    });
  refreshPromise = currentPromise;
  return currentPromise;
}

const EMPTY = {
  loading: false,
  proxmox: { clusterSummary: null, nodes: [] },
  linux: [],
  windows: [],
  kubernetes: null,
  snmp: [],
  healthchecks: null,
  uptimekuma: null,
  checks: null,
  prometheus: null,
  docker: [],
  dockhand: null,
  database: [],
  firewall: null,
  truenas: null,
  qnap: null,
  ugreen: null,
  pbs: null,
  cloudflare: null,
  cicd: null,
  veeam: null,
  portainer: null,
  publicStatus: false,
};

function runtimeEmptyFor(id) {
  return {
    proxmox: { clusterSummary: null, nodes: [] },
    linux: [],
    windows: [],
    kubernetes: null,
    snmp: [],
    healthchecks: null,
    uptimekuma: null,
    checks: null,
    prometheus: null,
    docker: [],
    dockhand: null,
    database: [],
    firewall: null,
    truenas: null,
    qnap: null,
    ugreen: null,
    pbs: null,
    cloudflare: null,
    cicd: null,
    veeam: null,
    portainer: null,
  }[id];
}

function ensureRuntimeShell(data = cache.data) {
  const out = data && typeof data === 'object'
    ? data
    : { ...EMPTY, timestamp: new Date().toISOString() };
  const en = c => c && c.enabled !== false;
  out.loading = false;
  out.timestamp = out.timestamp || new Date().toISOString();

  if (en(config.proxmox)) {
    if (hasProxmoxApi()) {
      const prev = out.proxmox && typeof out.proxmox === 'object' ? out.proxmox : null;
      out.proxmox = prev && Array.isArray(prev.nodes)
        ? { clusterSummary: prev.clusterSummary || null, ...prev, _connecting: prev.nodes.length ? !!prev._connecting : true }
        : { clusterSummary: null, nodes: [], _connecting: true };
    } else {
      out.proxmox = preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
    }
  } else {
    out.proxmox = { clusterSummary: null, nodes: [] };
  }

  if (en(config.linux)) out.linux = filterLinuxProxmoxRows(Array.isArray(out.linux) ? out.linux : getLinuxData(out.proxmox), out.proxmox);
  else out.linux = [];

  if (en(config.windows)) out.windows = Array.isArray(out.windows) ? out.windows : getWindowsData();
  else out.windows = [];

  if (en(config.kubernetes)) {
    if (!out.kubernetes) out.kubernetes = kubernetesConnectingData();
  } else {
    out.kubernetes = null;
  }

  if (en(config.snmp)) {
    const current = Array.isArray(out.snmp) ? out.snmp : [];
    const devices = Array.isArray(config.snmp?.devices) ? config.snmp.devices : [];
    out.snmp = devices.map(dev => {
      const existing = current.find(d => d.name === dev.name || d.host === dev.host);
      return {
        ...(existing || {}),
        name: dev.name || existing?.name || dev.host || 'SNMP',
        host: dev.host || existing?.host || '',
        profile: dev.profile || dev.preset || existing?.profile || 'generic',
        snmpVersion: dev.snmpVersion || existing?.snmpVersion,
        online: existing ? !!existing.online : false,
        _connecting: existing ? !!existing._connecting : true,
      };
    });
  } else {
    out.snmp = [];
  }

  if (en(config.healthchecks)) {
    out.healthchecks = out.healthchecks || { _connecting: true, online: false, summary: { total: 0, up: 0, down: 0, grace: 0, paused: 0 }, checks: [] };
  } else {
    out.healthchecks = null;
  }

  if (en(config.uptimekuma)) {
    out.uptimekuma = out.uptimekuma || { _connecting: true, online: false, summary: { total: 0, up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0 }, monitors: [] };
    out.uptimekuma.historyHours = uptimeKumaConfig().historyHours;
  } else {
    out.uptimekuma = null;
  }

  if (en(config.checks)) {
    const services = config.checks.services || config.checks.checks || [];
    const current = out.checks && typeof out.checks === 'object' ? out.checks : { _connecting: true, online: true, summary: { total: 0, up: 0, down: 0 }, checks: [] };
    const existingChecks = Array.isArray(current.checks) ? current.checks : [];
    current.checks = services.map(s => {
      const name = s.name || s.target || s.host || 'check';
      const target = s.target || s.url || s.host || '';
      const existing = existingChecks.find(c => c.name === name || c.target === target);
      return existing || { name, type: s.type || 'http', target, status: 'connecting', healthy: false, _connecting: true };
    });
    current.summary = { ...(current.summary || {}), total: services.length };
    current.historyHours = checksConfig().historyHours;
    out.checks = current;
  } else {
    out.checks = null;
  }

  out.prometheus = en(config.prometheus) ? mergePrometheusConfigured(out.prometheus, config.prometheus) : null;
  out.docker = en(config.docker) ? mergeDockerHistory(mergeDockerConfiguredRows(Array.isArray(out.docker) ? out.docker : [], agents.getDockerData())) : [];
  out.dockhand = en(config.dockhand) ? mergeDockhandConfigured(out.dockhand, config.dockhand) : null;
  out.firewall = en(config.firewall)
    ? (out.firewall || { _connecting: true, online: false, summary: { instances: 0, up: 0, down: 0, interfaces: 0, interfacesUp: 0, interfacesDown: 0, updates: 0, rebootRequired: 0 }, instances: [] })
    : null;
  out.truenas = en(config.truenas)
    ? (out.truenas || trueNasConnectingData(config.truenas))
    : null;
  out.qnap = en(config.qnap)
    ? (out.qnap || qnapConnectingData(config.qnap))
    : null;
  out.ugreen = en(config.ugreen)
    ? (out.ugreen || ugreenConnectingData(config.ugreen))
    : null;
  out.pbs = en(config.pbs)
    ? (out.pbs || pbsConnectingData(config.pbs))
    : null;
  out.cloudflare = en(config.cloudflare)
    ? (out.cloudflare || cloudflareConnectingData(config.cloudflare))
    : null;
  out.cicd = en(config.cicd)
    ? (out.cicd || cicdConnectingData(config.cicd))
    : null;
  out.veeam = en(config.veeam)
    ? (out.veeam || veeamConnectingData(config.veeam))
    : null;
  out.portainer = en(config.portainer)
    ? (out.portainer || portainerConnectingData(config.portainer))
    : null;

  if (en(config.database)) {
    const current = Array.isArray(out.database) ? out.database : [];
    const instances = Array.isArray(config.database?.instances) ? config.database.instances : [];
    out.database = instances.map(i => {
      const existing = current.find(d => d.name === i.name || (d.host && d.host === i.host));
      return existing || { name: i.name, type: i.type, host: i.host, online: false, _connecting: true };
    });
  } else {
    out.database = [];
  }

  assignStatic(out);
  return out;
}

function pruneRuntimeSnapshot(data = {}) {
  const out = { ...EMPTY, ...(data || {}) };
  const configured = new Set(configuredList());
  for (const id of ['proxmox','linux','windows','kubernetes','snmp','healthchecks','uptimekuma','checks','prometheus','docker','dockhand','database','firewall','truenas','qnap','ugreen','pbs','cloudflare','cicd','veeam','portainer']) {
    if (!configured.has(id)) out[id] = runtimeEmptyFor(id);
  }
  out.loading = false;
  out._snapshot = true;
  out._snapshotLoadedAt = new Date().toISOString();
  out.timestamp = out.timestamp || out._snapshotLoadedAt;
  assignStatic(out);
  return out;
}

function loadRuntimeSnapshot() {
  try {
    if (!fs.existsSync(RUNTIME_SNAPSHOT_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(RUNTIME_SNAPSHOT_PATH, 'utf8'));
    const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (!data || typeof data !== 'object') return null;
    const pruned = pruneRuntimeSnapshot(data);
    runtimeSnapshotLastSig = runtimeSnapshotSignature(pruned);
    return pruned;
  } catch (err) {
    console.warn(`Runtime snapshot load failed: ${err.message}`);
    return null;
  }
}

let runtimeSnapshotSaveTimer = null;
let runtimeSnapshotSaveDue = 0;
let runtimeSnapshotPending = null;
let runtimeSnapshotLastSig = '';

function runtimeSnapshotSignature(data = {}) {
  try {
    const summary = buildPublicSummary(data).map(s => [s.id, s.status, s.detail || ''].join(':')).join('|');
    return JSON.stringify({
      configured: data.configured || configuredList(),
      publicStatus: !!data.publicStatus,
      summary,
    });
  } catch {
    return '';
  }
}

function runtimePlatformPresent(data = {}, id) {
  const value = data[id];
  if (Array.isArray(value)) return value.length > 0;
  if (id === 'proxmox') return Array.isArray(value?.nodes) && value.nodes.length > 0;
  if (id === 'kubernetes') return !!value;
  if (id === 'healthchecks') return !!value;
  if (id === 'uptimekuma') return !!value;
  if (id === 'checks') return !!value;
  if (OBJECT_INSTANCE_PLATFORMS.has(id)) return !!value && (Array.isArray(value.instances) ? value.instances.length > 0 : true);
  return !!value;
}

function runtimePlatformObserved(data = {}, id) {
  const value = data[id];
  if (Array.isArray(value)) return value.some(row => row && !row._connecting);
  if (id === 'proxmox') return (value?.nodes || []).some(row => row && !row._connecting);
  if (id === 'kubernetes') return !!value && !value._connecting && (value.online !== undefined || value.error || value.resourceError || value.summary);
  if (id === 'healthchecks') return !!value && !value._connecting && (value.online !== undefined || value.error || (value.checks || []).length);
  if (id === 'uptimekuma') return !!value && !value._connecting && (value.online !== undefined || value.error || (value.monitors || []).length);
  if (id === 'checks') return !!value && !value._connecting && (value.online !== undefined || value.error || (value.checks || []).some(c => !c?._connecting && c?.status !== 'connecting'));
  if (OBJECT_INSTANCE_PLATFORMS.has(id)) {
    if (!value || value._connecting) return false;
    const instances = Array.isArray(value.instances) ? value.instances : [];
    return value.online !== undefined || value.error || instances.some(inst => inst && !inst._connecting);
  }
  return !!value && !value._connecting;
}

function runtimeSnapshotLooksLikeConnectingShell(data = {}) {
  const ids = configuredList().filter(id => id !== 'linux');
  if (ids.length < 3) return false;
  const present = ids.filter(id => runtimePlatformPresent(data, id)).length;
  const observed = ids.filter(id => runtimePlatformObserved(data, id)).length;
  return present >= Math.max(2, Math.floor(ids.length * 0.5)) && observed === 0;
}

function writeRuntimeSnapshotNow(data = runtimeSnapshotPending || cache.data) {
  if (!data || data.loading) return;
  try {
    const snapshot = clonePlain(data);
    if (!snapshot || typeof snapshot !== 'object') return;
    if (runtimeSnapshotLooksLikeConnectingShell(snapshot)) return;
    delete snapshot._snapshot;
    delete snapshot._snapshotLoadedAt;
    const payload = JSON.stringify({
      version: appVersion(),
      savedAt: new Date().toISOString(),
      data: snapshot,
    });
    const tmp = `${RUNTIME_SNAPSHOT_PATH}.tmp`;
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, RUNTIME_SNAPSHOT_PATH);
    runtimeSnapshotLastSig = runtimeSnapshotSignature(snapshot);
  } catch (err) {
    console.warn(`Runtime snapshot save failed: ${err.message}`);
  }
}

function scheduleRuntimeSnapshotSave(data = cache.data) {
  if (!data || data.loading) return;
  runtimeSnapshotPending = data;
  const sig = runtimeSnapshotSignature(data);
  const meaningfulChange = !!sig && sig !== runtimeSnapshotLastSig;
  const forceSoon = meaningfulChange || !fs.existsSync(RUNTIME_SNAPSHOT_PATH);
  const delay = runtimeSnapshotFlushDelayMs(forceSoon);
  const now = Date.now();
  if (runtimeSnapshotSaveTimer) {
    if (forceSoon && runtimeSnapshotSaveDue - now > delay) {
      clearTimeout(runtimeSnapshotSaveTimer);
      runtimeSnapshotSaveTimer = null;
    } else {
      return;
    }
  }
  runtimeSnapshotSaveDue = now + delay;
  runtimeSnapshotSaveTimer = setTimeout(() => {
    runtimeSnapshotSaveTimer = null;
    runtimeSnapshotSaveDue = 0;
    writeRuntimeSnapshotNow(runtimeSnapshotPending || cache.data);
    runtimeSnapshotPending = null;
  }, delay);
}

function flushRuntimeSnapshotSave() {
  if (runtimeSnapshotSaveTimer) {
    clearTimeout(runtimeSnapshotSaveTimer);
    runtimeSnapshotSaveTimer = null;
    runtimeSnapshotSaveDue = 0;
  }
  writeRuntimeSnapshotNow(runtimeSnapshotPending || cache.data);
  runtimeSnapshotPending = null;
}

function getCachedData() {
  if (!cache.data) {
    cache.data = ensureRuntimeShell(null);
    backgroundRefresh();
    return Promise.resolve(cache.data);
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

let uptimeKumaHistoryHealPending = false;
function scheduleUptimeKumaHistoryHeal() {
  if (uptimeKumaHistoryHealPending) return;
  if (!cache.data || !config.uptimekuma || !uptimeKumaHistoryEmpty(cache.data)) return;
  uptimeKumaHistoryHealPending = true;
  setImmediate(async () => {
    try {
      await healUptimeKumaHistoryIfEmpty();
    } finally {
      uptimeKumaHistoryHealPending = false;
    }
  });
}

let snmpBandwidthSamplePromise = null;
let snmpBandwidthLastSampleAt = 0;

function snmpBandwidthSampleIntervalMs() {
  const raw = config.performance?.snmpBandwidthSampleSeconds ?? config.snmp?.bandwidthSampleSeconds ?? 5;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(3, Math.min(60, seconds)) * 1000;
}

function sameSnmpDevice(row = {}, sample = {}) {
  const a = [row.host, row.name].filter(Boolean).map(v => String(v).trim().toLowerCase());
  const b = [sample.host, sample.name].filter(Boolean).map(v => String(v).trim().toLowerCase());
  return a.some(x => b.includes(x));
}

function mergeSnmpBandwidthSamples(samples = []) {
  if (!cache.data || !Array.isArray(cache.data.snmp) || !samples.length) return false;
  const now = Date.now();
  let changed = false;
  for (const sample of samples) {
    const bandwidth = sample?.metrics?.bandwidth;
    if (!sample?.online || !bandwidth) continue;
    const row = cache.data.snmp.find(d => sameSnmpDevice(d, sample));
    if (!row) continue;
    const total = (Number(bandwidth.rxBps) || 0) + (Number(bandwidth.txBps) || 0);
    row.online = true;
    row._connecting = false;
    row.network = sample.network || row.network;
    row.networkDiagnostics = sample.networkDiagnostics || row.networkDiagnostics;
    row.metrics = { ...(row.metrics || {}), bandwidth };
    if (Number.isFinite(total) && total >= 0) {
      const history = Array.isArray(row.history) ? row.history : [];
      const last = history[history.length - 1];
      if (!last || now - Number(last.time || 0) >= 2500) {
        history.push({ time: now, cpu: null, ram: null, temp: null, diskIO: null, bandwidth: total });
        if (history.length > 5760) history.splice(0, history.length - 5760);
        row.history = history;
      }
    }
    changed = true;
  }
  if (changed) {
    cache.data.timestamp = new Date().toISOString();
    clearViewCache();
    broadcastStatusEvent('updated');
  }
  return changed;
}

function maybeSampleSnmpBandwidth() {
  const interval = snmpBandwidthSampleIntervalMs();
  if (!interval) return;
  if (!config.snmp || config.snmp.enabled === false || !(config.snmp.devices || []).length) return;
  if (Date.now() - snmpBandwidthLastSampleAt < interval) return;
  if (snmpBandwidthSamplePromise || platformRefreshState.snmp?.inFlight) return;
  snmpBandwidthLastSampleAt = Date.now();
  snmpBandwidthSamplePromise = sampleSnmpBandwidth(config.snmp)
    .then(samples => mergeSnmpBandwidthSamples(samples))
    .catch(err => console.warn(`SNMP bandwidth sample failed: ${err.message}`))
    .finally(() => { snmpBandwidthSamplePromise = null; });
}

const startupSnapshot = loadRuntimeSnapshot();
if (startupSnapshot) {
  cache.data = startupSnapshot;
  const enabled = c => c && c.enabled !== false;
  if (enabled(config.proxmox) && !hasProxmoxApi()) {
    cache.data.proxmox = preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
  }
  if (enabled(config.linux)) {
    cache.data.linux = filterLinuxProxmoxRows(getLinuxData(cache.data.proxmox), cache.data.proxmox);
  }
  if (enabled(config.windows)) {
    cache.data.windows = getWindowsData();
  }
  if (enabled(config.docker)) {
    cache.data.docker = mergeDockerHistory(mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData()));
  }
  assignStatic(cache.data);
  console.log(`Loaded runtime snapshot from ${path.relative(__dirname, RUNTIME_SNAPSHOT_PATH)}`);
} else {
  cache.data = ensureRuntimeShell(null);
}
backgroundRefresh();
setInterval(backgroundRefresh, REFRESH_INTERVAL);
setInterval(maybeSampleSnmpBandwidth, 1000);

function sendHealthz(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/json; charset=utf-8').send(JSON.stringify({
    ok: true,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptime: Math.round(process.uptime()),
  }));
}

function sendReadyz(req, res) {
  const problem = cachedDataAccessProblem();
  res.setHeader('Cache-Control', 'no-store');
  if (problem) {
    return res.status(503).type('application/json; charset=utf-8').send(JSON.stringify({
      ok: false,
      error: 'OmniSight data volume is not readable/writable by the container user',
      detail: problem,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptime: Math.round(process.uptime()),
    }));
  }
  return res.type('application/json; charset=utf-8').send(JSON.stringify({
    ok: true,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptime: Math.round(process.uptime()),
  }));
}

app.get(['/healthz', '/api/healthz'], sendHealthz);
app.get(['/readyz', '/api/readyz'], sendReadyz);

app.use(securityHeaders);
app.use(httpsRequirement);
app.use(apiRateLimit);
app.use(express.json({ limit: '80mb' }));
app.use((err, req, res, next) => {
  if (!err) return next();
  const status = Number(err.status || err.statusCode || 400);
  const message = status >= 500 ? serverErrorMessage(err) : (err.message || 'Invalid request');
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(status).json({ error: message });
  }
  return res.status(status).send(message);
});
app.use(parseCookies);
app.use(requestDiagnostics);
app.use(apiJsonCompression);
app.use(sameOriginGuard);
app.use(dataAccessGuard);

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
      refreshing: refreshBusy(),
      configured,
      cache: normalizeDockerRows(cache.data?.docker || []),
      live: normalizeDockerRows(live),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(authMiddleware);
app.use(rbacMiddleware);
app.get('/logs', (req, res) => res.redirect(302, '/event-center'));
app.get('/alerts', (req, res) => res.redirect(302, '/event-center#alerts'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_GZIP_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);
const staticGzipCache = new Map();
const staticHtmlCache = new Map();
const PREFETCHABLE_HTML_PATHS = new Set(['/', '/about', '/agents', '/docs', '/event-center', '/profile', '/settings', '/topology']);
function requestCachePath(req) {
  return String(req?.path || '').replace(/\/+$/, '') || '/';
}
function versionedStaticRequest(req) {
  const raw = String(req?.query?.v || '').trim();
  return raw && raw === appVersion();
}
function setPublicStaticCacheHeaders(res, filePath, req = null) {
  if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (filePath.endsWith('sw.js')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (filePath.endsWith('manifest.webmanifest')) {
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  } else if (/\.(svg|png|webp|jpg|jpeg|ico)$/i.test(filePath)) {
    if (versionedStaticRequest(req)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
    if (versionedStaticRequest(req)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
  }
}
function compressedPublicCandidate(reqPath) {
  let pathname = String(reqPath || '/').split('?')[0] || '/';
  try { pathname = decodeURIComponent(pathname); } catch { return null; }
  if (pathname.includes('\0')) return null;
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!path.extname(rel)) rel += '.html';
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) return null;
  return filePath;
}
function injectCspNonce(html, nonce) {
  if (!nonce) return html;
  return String(html).replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}
function injectAssetVersion(html) {
  const v = encodeURIComponent(appVersion());
  return String(html)
    .replace(/(<script\b[^>]*\bsrc=["'])\/i18n\.js(["'][^>]*>)/gi, `$1/i18n.js?v=${v}$2`)
    .replace(/(["'])\/assets\/omnisight-logo\.svg(\?v=[^"']*)?(["'])/gi, `$1/assets/omnisight-logo.svg?v=${v}$3`);
}
function injectRuntimeConstants(html) {
  return String(html).replace(/__OMNISIGHT_VERSION_JSON__/g, JSON.stringify(appVersion()));
}
function readPublicHtmlCached(filePath, stat) {
  const cacheKey = `${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  const hit = staticHtmlCache.get(cacheKey);
  if (hit) return hit;
  const html = fs.readFileSync(filePath, 'utf8');
  if (staticHtmlCache.size > 16) staticHtmlCache.delete(staticHtmlCache.keys().next().value);
  staticHtmlCache.set(cacheKey, html);
  return html;
}
function publicHtmlStatic(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/agent/')) return next();
  const filePath = compressedPublicCandidate(req.path);
  if (!filePath || path.extname(filePath).toLowerCase() !== '.html') return next();
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return next();
  } catch { return next(); }
  let html;
  try { html = injectCspNonce(injectRuntimeConstants(injectAssetVersion(readPublicHtmlCached(filePath, stat))), res.locals.cspNonce); }
  catch { return next(); }
  setPublicStaticCacheHeaders(res, filePath, req);
  res.setHeader('Content-Type', STATIC_GZIP_TYPES.get('.html'));
  if (/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) {
    return zlib.gzip(Buffer.from(html, 'utf8'), { level: 1 }, (err, gz) => {
      if (!err && gz) {
        appendVary(res, 'Accept-Encoding');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', gz.length);
        if (req.method === 'HEAD') return res.end();
        return res.end(gz);
      }
      res.removeHeader('Content-Encoding');
      appendVary(res, 'Accept-Encoding');
      res.setHeader('Content-Length', Buffer.byteLength(html));
      if (req.method === 'HEAD') return res.end();
      return res.send(html);
    });
  }
  res.setHeader('Content-Length', Buffer.byteLength(html));
  if (req.method === 'HEAD') return res.end();
  return res.send(html);
}
function compressedPublicStatic(req, res, next) {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/agent/')) return next();
  if (req.headers.range) return next();
  const filePath = compressedPublicCandidate(req.path);
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';
  if (ext === '.html') return next();
  if (!filePath || !STATIC_GZIP_TYPES.has(ext)) return next();
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return next();
  } catch { return next(); }
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}-gzip"`;
  setPublicStaticCacheHeaders(res, filePath, req);
  res.setHeader('Content-Type', STATIC_GZIP_TYPES.get(ext));
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  const cacheKey = `${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  let gz = staticGzipCache.get(cacheKey);
  if (!gz) {
    try { gz = zlib.gzipSync(fs.readFileSync(filePath), { level: 6 }); }
    catch { return next(); }
    if (staticGzipCache.size > 32) staticGzipCache.delete(staticGzipCache.keys().next().value);
    staticGzipCache.set(cacheKey, gz);
  }
  res.setHeader('Content-Length', gz.length);
  if (req.method === 'HEAD') return res.end();
  return res.end(gz);
}
app.use(publicHtmlStatic);
app.use(compressedPublicStatic);
const publicStaticMiddleware = express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => setPublicStaticCacheHeaders(res, filePath, res.req)
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/agent/')) return next();
  return publicStaticMiddleware(req, res, next);
});

app.get('/docs.md', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('text/markdown; charset=utf-8').sendFile(path.join(__dirname, 'DOCUMENTATION.md'));
});

function onboardingPlatformConfig(input = {}) {
  const type = String(input.type || '').toLowerCase();
  const name = String(input.name || '').trim();
  const url = String(input.url || '').trim();
  const host = String(input.host || '').trim();
  const token = String(input.token || input.apiKey || '').trim();
  const out = {};
  if (type === 'proxmox' && url && input.tokenId && input.tokenSecret) {
    out.proxmox = { enabled: true, url, tokenId: String(input.tokenId).trim(), tokenSecret: String(input.tokenSecret).trim(), insecureTLS: input.insecureTLS === true };
  } else if (type === 'docker-api' && (url || host)) {
    out.docker = { enabled: true, hosts: [{ type: 'api', name: name || 'Docker', url: url || host, insecureTLS: input.insecureTLS === true }] };
  } else if (type === 'docker-ssh' && host) {
    out.docker = { enabled: true, hosts: [{ type: 'ssh', name: name || host, sshHost: host, sshUser: input.sshUser || 'root', sshPort: Number(input.sshPort || 22), sshPassword: input.sshPassword || undefined, sudo: input.sudo !== false }] };
  } else if (type === 'snmp' && host) {
    out.snmp = { enabled: true, devices: [{ name: name || host, host, community: String(input.community || '').trim(), version: input.version || '2c', profile: input.profile || 'generic' }] };
  } else if (type === 'healthchecks' && url && token) {
    out.healthchecks = { enabled: true, url, apiKey: token, insecureTLS: input.insecureTLS === true };
  } else if (type === 'uptimekuma' && url) {
    out.uptimekuma = { enabled: true, url, slug: input.slug || undefined, apiKey: token || undefined, insecureTLS: input.insecureTLS === true };
  } else if (type === 'prometheus' && url) {
    out.prometheus = { enabled: true, instances: [{ name: name || 'Prometheus', url, token: token || undefined, insecureTLS: input.insecureTLS === true }] };
  } else if (type === 'check' && (url || host)) {
    out.checks = { enabled: true, services: [{ name: name || 'First check', type: input.checkType || 'http', target: url || host, port: input.port || undefined }] };
  } else if (type === 'dockhand' && url) {
    out.dockhand = { enabled: true, instances: [{ name: name || 'Dockhand', url, token: token || undefined, insecureTLS: input.insecureTLS === true }] };
  }
  return out;
}

function saveConfigObject(obj) {
  if (obj.timezone) process.env.TZ = obj.timezone;
  stripDeprecatedConfig(obj);
  if (obj.ui) saveUiPreferencesSidecar(obj.ui);
  if (obj.topology) saveTopologySidecar(obj.topology);
  const baseConfig = stripSidecarConfig(clonePlain(obj) || {});
  const toSave = encryptionEnabled() ? encryptConfigObj(baseConfig) : baseConfig;
  writePrivateYaml(CONFIG_PATH, toSave);
  config = loadConfig();
  applyDiskWritePolicy();
  markConfigChanged();
  refreshGeneration += 1;
  refreshPromise = null;
}

function saveTopologyOnly(topology) {
  config.topology = saveTopologySidecar(topology);
  markConfigChanged();
}

app.get('/api/onboarding/status', (req, res) => {
  const configured = authConfigured();
  res.json({ required: !configured, configured, authenticated: configured ? !!validSession(req) : false });
});

app.post('/api/onboarding/complete', (req, res) => {
  try {
    if (authConfigured()) return res.status(409).json({ error: 'Onboarding is already complete' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const pErr = validatePassword(password);
    if (pErr) return res.status(400).json({ error: pErr });
    const email = normalizeEmail(req.body?.email);
    if (email && !validEmail(email)) return res.status(400).json({ error: 'Enter a valid e-mail address' });
    const user = createUserRecord(username, password, 'admin');
    if (email) user.recoveryEmail = email;
    saveUsersDoc({ users: [user] });

    const existing = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};
    const alerts = req.body?.alerts || {};
    const nextConfig = {
      ...existing,
      timezone: String(req.body?.timezone || existing.timezone || process.env.TZ || process.env.TIMEZONE || 'UTC'),
      timeFormat: req.body?.timeFormat === '12h' ? '12h' : '24h',
      preferredLanguage: req.body?.preferredLanguage === 'tr' ? 'tr' : 'en',
      defaultTimePeriodHours: Number(req.body?.defaultTimePeriodHours || existing.defaultTimePeriodHours || 1),
      historyRetentionDays: Number(req.body?.historyRetentionDays || existing.historyRetentionDays || 1),
      ...onboardingPlatformConfig(req.body?.platform || {}),
    };
    if (alerts.enabled) {
      nextConfig.alerts = {
        ...(existing.alerts || {}),
        enabled: true,
        ntfy: alerts.ntfy?.topic ? { enabled: true, url: alerts.ntfy.url || 'https://ntfy.sh', topic: alerts.ntfy.topic, priority: alerts.ntfy.priority || 'default' } : existing.alerts?.ntfy,
        smtp: alerts.smtp?.host && alerts.smtp?.to ? { enabled: true, host: alerts.smtp.host, port: Number(alerts.smtp.port || 587), secure: alerts.smtp.secure === true, user: alerts.smtp.user || '', password: alerts.smtp.password || '', from: alerts.smtp.from || alerts.smtp.user || '', to: Array.isArray(alerts.smtp.to) ? alerts.smtp.to : [alerts.smtp.to] } : existing.alerts?.smtp,
      };
    }
    saveConfigObject(nextConfig);
    const token = genToken();
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    sessions.set(token, createSessionRecord(req, username, 'admin', expires));
    saveSessions(sessions);
    res.cookie('session', token, sessionCookieOptions(req, false));
    auditEvent('onboarding.complete', { username }, req);
    res.json({ ok: true, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/onboarding/import', (req, res) => {
  try {
    if (authConfigured()) return res.status(409).json({ error: 'Onboarding is already complete' });
    const result = importFullBackupText(String(req.body?.backup || req.body?.yaml || req.body?.text || ''));
    auditEvent('backup.full_import', { files: result.files, bytes: result.bytes, actor: 'initial-setup', agentTokenPreserved: result.agentTokenPreserved === true }, null);
    res.clearCookie('session', sessionCookieOptions(req));
    res.json({ ok: true, ...result, loggedOut: true, restartRecommended: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  if (!authConfigured()) return res.json({ ok: true });
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
  const auth = findAuthUser(username);
  if (!auth || auth.disabled) {
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
  sessions.set(token, createSessionRecord(req, auth.username, auth.role, expires));
  saveSessions(sessions);
  loginAttempts.delete(rate.key);
  res.cookie('session', token, sessionCookieOptions(req, remember));
  auditLogin(req, username, 'success');
  res.json({ ok: true, token, role: normalizeRole(auth.role), mustChangePassword: userMustChangePassword(auth) });
});

app.post('/api/passkeys/auth/options', (req, res) => {
  try {
    if (!authConfigured()) return res.status(400).json({ error: 'Password setup required first' });
    const username = String(req.body?.username || '').trim();
    const users = username
      ? [findAuthUser(username)].filter(Boolean)
      : loadUsers().filter(u => !u.disabled && Array.isArray(u.passkeys) && u.passkeys.length);
    const credentials = users
      .filter(u => !u.disabled)
      .flatMap(u => (Array.isArray(u.passkeys) ? u.passkeys : []).map(k => ({
        type: 'public-key',
        id: k.id,
        transports: Array.isArray(k.transports) ? k.transports : undefined,
      })));
    if (!credentials.length) return res.status(400).json({ error: 'No passkeys are registered for this account' });
    const challenge = passkeyChallenge('auth', username);
    res.json({
      ok: true,
      publicKey: {
        challenge,
        timeout: 60000,
        rpId: webauthnRpId(req),
        userVerification: 'preferred',
        allowCredentials: credentials,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/passkeys/auth/verify', (req, res) => {
  try {
    const response = req.body?.response || {};
    const client = verifyClientData(response.clientDataJSON, 'webauthn.get', req);
    const challenge = takePasskeyChallenge(client.challenge, 'auth');
    const credentialId = req.body?.rawId || req.body?.id;
    const authData = fromB64url(response.authenticatorData);
    const parsed = parseAuthenticatorData(authData);
    const expectedRpHash = crypto.createHash('sha256').update(webauthnRpId(req)).digest();
    if (!crypto.timingSafeEqual(parsed.rpIdHash, expectedRpHash)) throw new Error('Invalid passkey relying party');
    if (!(parsed.flags & 0x01)) throw new Error('Passkey user presence is required');
    let foundUser = null;
    let foundKey = null;
    for (const user of loadUsers()) {
      const key = (Array.isArray(user.passkeys) ? user.passkeys : []).find(k => k.id === credentialId);
      if (key) { foundUser = user; foundKey = key; break; }
    }
    if (!foundUser || !foundKey || foundUser.disabled) throw new Error('Passkey is not registered');
    if (challenge.username && String(foundUser.username).toLowerCase() !== challenge.username) throw new Error('Passkey does not belong to this account');
    const publicKey = coseToKeyObject(foundKey.publicKey);
    const signed = Buffer.concat([authData, crypto.createHash('sha256').update(fromB64url(response.clientDataJSON)).digest()]);
    const signature = fromB64url(response.signature);
    if (!crypto.verify('sha256', signed, publicKey, signature)) throw new Error('Invalid passkey signature');
    const doc = loadUsersDoc();
    const idx = doc.users.findIndex(u => u.id === foundUser.id || String(u.username).toLowerCase() === String(foundUser.username).toLowerCase());
    if (idx >= 0) {
      const keys = Array.isArray(doc.users[idx].passkeys) ? doc.users[idx].passkeys : [];
      const kidx = keys.findIndex(k => k.id === credentialId);
      if (kidx >= 0) {
        keys[kidx] = { ...keys[kidx], counter: parsed.signCount || keys[kidx].counter || 0, lastUsedAt: Date.now() };
        doc.users[idx] = { ...doc.users[idx], passkeys: keys, updatedAt: Date.now() };
        saveUsersDoc(doc);
      }
    } else if (foundUser._source === 'legacy') {
      const keys = (Array.isArray(foundUser.passkeys) ? foundUser.passkeys : []).map(k => k.id === credentialId ? { ...k, counter: parsed.signCount || k.counter || 0, lastUsedAt: Date.now() } : k);
      saveAuthUser({ ...foundUser, passkeys: keys });
    }
    const token = genToken();
    const remember = req.body?.remember === true;
    const expires = Date.now() + (remember ? THIRTY_DAYS : 24 * 60 * 60 * 1000);
    sessions.set(token, createSessionRecord(req, foundUser.username, foundUser.role, expires));
    saveSessions(sessions);
    res.cookie('session', token, sessionCookieOptions(req, remember));
    auditLogin(req, foundUser.username, 'success', 'passkey');
    res.json({ ok: true, token, role: normalizeRole(foundUser.role), mustChangePassword: userMustChangePassword(foundUser) });
  } catch (err) {
    auditLogin(req, '', 'failed', 'passkey');
    res.status(401).json({ error: err.message || 'Passkey sign-in failed' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'] || req.cookies?.session;
  try { auditEvent('auth.logout', {}, req); } catch {}
  if (token) { sessions.delete(token); saveSessions(sessions); }
  res.clearCookie('session', sessionCookieOptions(req));
  res.json({ ok: true });
});

app.get('/api/auth-status', (req, res) => {
  const required = authConfigured();
  const session = required ? validSession(req) : null;
  const auth = req._authUser || (session?.session?.username ? findAuthUser(session.session.username) : (loadUsers()[0] || null));
  res.json({
    required,
    authenticated: !!session,
    username: auth?.username || null,
    role: normalizeRole(auth?.role, 'admin'),
    twoFactorEnabled: totpEnabled(auth),
    mustChangePassword: userMustChangePassword(auth),
    passwordResetEnabled: passwordResetEnabled(),
    selfRegistrationEnabled: required && selfRegistrationEnabled(),
    version: appVersion(),
  });
});

app.get('/api/sessions', async (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const now = Date.now();
  let changed = false;
  for (const [token, session] of [...sessions.entries()]) {
    if (now >= Number(session.expires || 0)) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) saveSessions(sessions);
  const currentToken = currentSessionToken(req);
  res.json({
    sessions: [...sessions.entries()].map(([token, session]) => publicSessionRecord(token, session, currentToken)),
    currentPublicIp: await effectiveCurrentPublicIp(req),
    allowedPublicIps: allowedPublicIpList(),
  });
});

app.delete('/api/sessions/:token', (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const token = String(req.params.token || '').trim();
  const session = sessions.get(token);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  sessions.delete(token);
  saveSessions(sessions);
  auditEvent('session.force_sign_out', { username: session.username || '', current: token === currentSessionToken(req) }, req);
  if (token === currentSessionToken(req)) res.clearCookie('session', sessionCookieOptions(req));
  res.json({ ok: true });
});

app.get('/api/profile', (req, res) => {
  const auth = currentAuthUser(req);
  if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
  res.json(publicProfile(auth));
});

app.get('/api/profile/summary', (req, res) => {
  const auth = currentAuthUser(req);
  if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
  const sig = `${auth.username || ''}|${auth.role || ''}|${auth.passwordChangedAt || ''}|${avatarMeta(auth)?.hash || ''}|${userMustChangePassword(auth) ? 'must' : 'ok'}`;
  sendCachedJson(req, res, `profile:summary:${auth.id || auth.username}`, sig, () => publicProfileSummary(auth), {
    cacheControl: 'private, max-age=30, stale-while-revalidate=300',
  });
});

app.get('/api/profile/avatar/current', (req, res) => {
  const auth = currentAuthUser(req);
  if (!auth) return res.status(404).end();
  const avatar = typeof auth.avatar === 'string' ? auth.avatar : '';
  const meta = avatarMeta(auth);
  if (!meta) return res.status(404).end();
  try {
    const buf = readBase64Payload(avatar, MAX_AVATAR_BYTES);
    const etag = `W/"avatar-${meta.hash}"`;
    res.setHeader('Cache-Control', 'private, max-age=300, stale-while-revalidate=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.send(buf);
  } catch {
    return res.status(404).end();
  }
});

app.post('/api/profile/avatar', (req, res) => {
  try {
    const auth = currentAuthUser(req);
    if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
    const avatar = normalizeAvatarDataUrl(req.body?.dataUrl || '');
    const nextAuth = { ...auth };
    if (avatar) nextAuth.avatar = avatar;
    else delete nextAuth.avatar;
    saveAuthUser(nextAuth);
    auditEvent(avatar ? 'profile.avatar.update' : 'profile.avatar.remove', {}, req);
    res.json(publicProfile(nextAuth));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/profile/recovery-email', (req, res) => {
  const auth = currentAuthUser(req);
  const { email } = req.body || {};
  if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
  const clean = normalizeEmail(email);
  const nextAuth = { ...auth };
  if (clean) {
    if (!validEmail(clean)) return res.status(400).json({ error: 'Enter a valid e-mail address' });
    nextAuth.recoveryEmail = clean;
  } else {
    delete nextAuth.recoveryEmail;
  }
  saveAuthUser(nextAuth);
  auditEvent('profile.email.update', { email: clean ? maskEmail(clean) : '' }, req);
  res.json(publicProfile(nextAuth));
});

app.post('/api/passkeys/register/options', (req, res) => {
  try {
    const auth = currentAuthUser(req);
    if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
    const challenge = passkeyChallenge('register', auth.username);
    const userId = auth.id || crypto.createHash('sha256').update(String(auth.username)).digest('hex').slice(0, 24);
    res.json({
      ok: true,
      publicKey: {
        challenge,
        rp: { name: 'OmniSight', id: webauthnRpId(req) },
        user: { id: b64url(Buffer.from(String(userId))), name: auth.username, displayName: auth.username },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        excludeCredentials: publicPasskeys(auth).map(k => ({ type: 'public-key', id: k.id, transports: k.transports })),
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/passkeys/register/verify', (req, res) => {
  try {
    const auth = currentAuthUser(req);
    if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
    const response = req.body?.response || {};
    const client = verifyClientData(response.clientDataJSON, 'webauthn.create', req);
    const challenge = takePasskeyChallenge(client.challenge, 'register');
    if (challenge.username && String(auth.username).toLowerCase() !== challenge.username) throw new Error('Passkey setup user changed');
    const parsed = parseAttestationObject(response.attestationObject);
    const expectedRpHash = crypto.createHash('sha256').update(webauthnRpId(req)).digest();
    if (!crypto.timingSafeEqual(parsed.rpIdHash, expectedRpHash)) throw new Error('Invalid passkey relying party');
    if (!(parsed.flags & 0x01)) throw new Error('Passkey user presence is required');
    if (!parsed.credentialId || !parsed.credentialPublicKey) throw new Error('Passkey registration did not include a credential');
    const id = b64url(parsed.credentialId);
    const existing = Array.isArray(auth.passkeys) ? auth.passkeys : [];
    const passkey = {
      id,
      name: String(req.body?.name || 'Passkey').trim().slice(0, 80) || 'Passkey',
      publicKey: b64url(parsed.credentialPublicKey),
      counter: parsed.signCount || 0,
      transports: Array.isArray(response.transports) ? response.transports.map(String).slice(0, 8) : [],
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    const nextAuth = { ...auth, passkeys: [...existing.filter(k => k.id !== id), passkey] };
    saveAuthUser(nextAuth);
    auditEvent('auth.passkey.add', { name: passkey.name }, req);
    res.json({ ok: true, passkeys: publicPasskeys(nextAuth) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/passkeys/:id', (req, res) => {
  try {
    const auth = currentAuthUser(req);
    if (!auth) return res.status(404).json({ error: 'Profile is not configured' });
    const currentPassword = String(req.body?.currentPassword || '');
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    try {
      if (!verifyPassword(currentPassword, auth.hash, auth.salt)) return res.status(400).json({ error: 'Wrong current password' });
    } catch {
      return res.status(400).json({ error: 'Wrong current password' });
    }
    const id = String(req.params.id || '');
    const passkeys = (Array.isArray(auth.passkeys) ? auth.passkeys : []).filter(k => k.id !== id);
    const nextAuth = { ...auth, passkeys };
    saveAuthUser(nextAuth);
    auditEvent('auth.passkey.remove', {}, req);
    res.json({ ok: true, passkeys: publicPasskeys(nextAuth) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/password-reset/request', async (req, res) => {
  if (!passwordResetEnabled()) {
    return res.status(404).json({ error: 'Password reset is disabled by the administrator' });
  }
  const email = normalizeEmail(req.body?.email);
  const generic = {
    ok: true,
    message: 'If this e-mail is configured, a reset code has been sent. If it does not arrive, use terminal instructions.',
  };
  const rate = passwordResetRateCheck(req, email);
  if (!rate.ok) return res.status(429).json({ error: 'Too many reset requests. Try again later.', retryAfter: rate.retryAfter });
  const auth = findAuthUserByEmail(email);
  auditEvent('auth.password_reset.request', { email: maskEmail(email), matched: !!auth }, req);
  if (!auth) return res.json(generic);
  const { code, record } = createPasswordResetRecord(email);
  savePasswordResets({ active: record });
  try {
    await sendPasswordResetEmail(email, code);
    console.log(`[auth] password reset code sent: email="${maskEmail(email)}" ip=${String(req.ip || req.socket?.remoteAddress || 'unknown')}`);
    auditEvent('auth.password_reset.email_sent', { email: maskEmail(email) }, req);
  } catch (err) {
    savePasswordResets({});
    console.warn(`[auth] password reset e-mail failed: email="${maskEmail(email)}" error=${err.message}`);
    auditEvent('auth.password_reset.email_failed', { email: maskEmail(email), error: err.message }, req);
  }
  res.json(generic);
});

app.post('/api/password-reset/confirm', (req, res) => {
  if (!passwordResetEnabled()) {
    return res.status(404).json({ error: 'Password reset is disabled by the administrator' });
  }
  const email = normalizeEmail(req.body?.email);
  const auth = findAuthUserByEmail(email);
  const code = String(req.body?.code || '').replace(/\s/g, '');
  const password = String(req.body?.password || '');
  if (!auth || !validEmail(email) || !emailMatchesAuth(auth, email)) return res.status(400).json({ error: 'Invalid or expired reset code' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Invalid or expired reset code' });
  const resets = loadPasswordResets();
  const rec = resets.active;
  if (!rec || Number(rec.expires || 0) <= Date.now()) {
    savePasswordResets({});
    return res.status(400).json({ error: 'Invalid or expired reset code' });
  }
  if (rec.emailHash !== emailDigest(email)) return res.status(400).json({ error: 'Invalid or expired reset code' });
  if (Number(rec.attempts || 0) >= 5) {
    savePasswordResets({});
    return res.status(429).json({ error: 'Too many invalid codes. Request a new reset code.' });
  }
  const expected = resetCodeDigest(email, code, rec.salt);
  if (!safeEqualHex(expected, rec.codeHash)) {
    rec.attempts = Number(rec.attempts || 0) + 1;
    savePasswordResets({ active: rec });
    return res.status(400).json({ error: 'Invalid or expired reset code' });
  }
  const pErr = validatePassword(password);
  if (pErr) return res.status(400).json({ error: pErr });
  const salt = crypto.randomBytes(16).toString('hex');
  const nextAuth = { ...auth, salt, hash: hashPassword(password, salt), passwordChangedAt: Date.now(), mustChangePassword: false };
  saveAuthUser(nextAuth);
  sessions.clear();
  saveSessions(sessions);
  savePasswordResets({});
  console.log(`[auth] password reset success: email="${maskEmail(email)}"`);
  auditEvent('auth.password_reset.success', { email: maskEmail(email), actor: maskEmail(email) });
  res.json({ ok: true });
});

app.post('/api/register', (req, res) => {
  try {
    if (!authConfigured()) return res.status(409).json({ error: 'Initial setup is required first' });
    if (!selfRegistrationEnabled()) return res.status(404).json({ error: 'Registration is disabled' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    if (findAuthUser(username)) return res.status(400).json({ error: 'Username already exists' });
    const pErr = validatePassword(password);
    if (pErr) return res.status(400).json({ error: pErr });
    const doc = ensureUsersDoc();
    if (doc.users.some(u => String(u.username).toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const user = createUserRecord(username, password, 'read-only');
    doc.users.push(user);
    saveUsersDoc(doc);
    auditEvent('user.self_register', { username, role: 'read-only' }, req);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/set-password', (req, res) => {
  const { username, password, currentPassword } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing fields' });
  const auth = authConfigured() ? currentAuthUser(req) : null;
  if (auth && password) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    try {
      if (!verifyPassword(currentPassword, auth.hash, auth.salt))
        return res.status(400).json({ error: 'Wrong current password' });
    } catch { return res.status(400).json({ error: 'Wrong current password' }); }
  } else if (!auth && !password) {
    return res.status(400).json({ error: 'Password required for initial setup' });
  }
  if (password) {
    const pErr = validatePassword(password);
    if (pErr) return res.status(400).json({ error: pErr });
  }
  const finalUsername = (username === '__current__' && auth?.username) ? auth.username : username;
  if (auth && finalUsername !== auth.username && findAuthUser(finalUsername)) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  const salt = password ? crypto.randomBytes(16).toString('hex') : auth.salt;
  const hash = password ? hashPassword(password, salt) : auth.hash;
  const nextAuth = { ...(auth || {}), username: finalUsername, hash, salt, role: normalizeRole(auth?.role, 'admin') };
  if (!auth) nextAuth.role = 'admin';
  if (password) {
    nextAuth.passwordChangedAt = Date.now();
    nextAuth.mustChangePassword = false;
  }
  else if (auth?.passwordChangedAt) nextAuth.passwordChangedAt = auth.passwordChangedAt;
  if (auth?.totp) nextAuth.totp = auth.totp;
  if (auth?.avatar) nextAuth.avatar = auth.avatar;
  if (auth?.recoveryEmail) nextAuth.recoveryEmail = auth.recoveryEmail;
  if (!auth && req.body?.email) {
    const clean = normalizeEmail(req.body.email);
    if (clean) {
      if (!validEmail(clean)) return res.status(400).json({ error: 'Enter a valid e-mail address' });
      nextAuth.recoveryEmail = clean;
    }
  }
  saveAuthUser(nextAuth);
  auditEvent(auth ? 'auth.credentials.update' : 'auth.initial_setup', {
    usernameChanged: !!(auth && finalUsername !== auth.username),
    passwordChanged: !!password,
  }, req);
  res.json({ ok: true });
});

app.post('/api/2fa/setup', async (req, res) => {
  const auth = currentAuthUser(req);
  if (!auth) return res.status(400).json({ error: 'Password setup required first' });
  const secret = base32Encode(crypto.randomBytes(20));
  const otpauth = makeTotpUri(auth.username, secret);
  res.json({
    ok: true,
    secret,
    otpauth,
    qrDataUrl: await makeTotpQrDataUrl(otpauth),
    enabled: totpEnabled(auth),
  });
});

app.post('/api/2fa/enable', (req, res) => {
  const auth = currentAuthUser(req);
  const { currentPassword, code, secret } = req.body || {};
  if (!auth) return res.status(400).json({ error: 'Password setup required first' });
  if (!currentPassword || !secret || !code) return res.status(400).json({ error: 'Current password, secret and code are required' });
  try {
    if (!verifyPassword(currentPassword, auth.hash, auth.salt)) return res.status(400).json({ error: 'Wrong current password' });
    if (!verifyTotp(secret, code)) return res.status(400).json({ error: 'Invalid two-factor code' });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not enable two-factor authentication' });
  }
  saveAuthUser({ ...auth, totp: { enabled: true, secret } });
  keepOnlyCurrentSession(req);
  auditEvent('auth.2fa.enable', {}, req);
  res.json({ ok: true, enabled: true });
});

app.post('/api/2fa/disable', (req, res) => {
  const auth = currentAuthUser(req);
  const { currentPassword, code } = req.body || {};
  if (!auth) return res.status(400).json({ error: 'Password setup required first' });
  if (!totpEnabled(auth)) return res.json({ ok: true, enabled: false });
  if (!currentPassword || !code) return res.status(400).json({ error: 'Current password and code are required' });
  try {
    if (!verifyPassword(currentPassword, auth.hash, auth.salt)) return res.status(400).json({ error: 'Wrong current password' });
    if (!verifyTotp(auth.totp.secret, code)) return res.status(400).json({ error: 'Invalid two-factor code' });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not disable two-factor authentication' });
  }
  const nextAuth = { ...auth };
  delete nextAuth.totp;
  saveAuthUser(nextAuth);
  auditEvent('auth.2fa.disable', {}, req);
  res.json({ ok: true, enabled: false });
});

app.get('/api/users', (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  res.json(loadUsers().map(publicUser));
});

app.post('/api/users', (req, res) => {
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const role = normalizeRole(req.body?.role, 'read-only');
    const email = normalizeEmail(req.body?.email);
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    if (findAuthUser(username)) return res.status(400).json({ error: 'Username already exists' });
    const pErr = validatePassword(password);
    if (pErr) return res.status(400).json({ error: pErr });
    const doc = ensureUsersDoc();
    const user = createUserRecord(username, password, role, { mustChangePassword: true });
    if (email) {
      if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid e-mail address' });
      user.recoveryEmail = email;
    }
    doc.users.push(user);
    saveUsersDoc(doc);
    auditEvent('user.create', { username, role }, req);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/batch', (req, res) => {
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const doc = ensureUsersDoc();
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    const createPayload = req.body?.create && typeof req.body.create === 'object' ? req.body.create : null;
    const changedUsers = [];
    const createdUsers = [];

    if (createPayload) {
      const username = String(createPayload.username || '').trim();
      const password = String(createPayload.password || '');
      const role = normalizeRole(createPayload.role, 'read-only');
      const email = normalizeEmail(createPayload.email);
      if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
      if (doc.users.some(u => String(u.username).toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: 'Username already exists' });
      const pErr = validatePassword(password);
      if (pErr) return res.status(400).json({ error: pErr });
      const user = createUserRecord(username, password, role, { mustChangePassword: true });
      if (email) {
        if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid e-mail address' });
        user.recoveryEmail = email;
      }
      doc.users.push(user);
      createdUsers.push(user);
    }

    for (const item of updates) {
      const id = String(item?.id || '').trim();
      if (!id) continue;
      const idx = doc.users.findIndex(u => u.id === id || u.username === id);
      if (idx < 0) return res.status(404).json({ error: `User not found: ${id}` });
      const before = doc.users[idx];
      const next = applyUserPatch(doc, idx, item);
      doc.users[idx] = next;
      changedUsers.push({ before, next });
    }

    if (adminCount(doc.users) < 1) return res.status(400).json({ error: 'At least one active admin is required' });
    if (!createdUsers.length && !changedUsers.length) return res.json({ ok: true, users: loadUsers().map(publicUser), changed: 0, created: 0 });

    saveUsersDoc(doc);

    for (const [token, session] of sessions) {
      const changed = changedUsers.find(pair => pair.before.username === session.username);
      if (changed && (
        changed.next.disabled ||
        changed.next.passwordChangedAt !== changed.before.passwordChangedAt ||
        changed.next.username !== changed.before.username ||
        normalizeRole(changed.next.role) !== normalizeRole(changed.before.role)
      )) sessions.delete(token);
    }
    saveSessions(sessions);

    for (const user of createdUsers) auditEvent('user.create', { username: user.username, role: user.role }, req);
    for (const pair of changedUsers) auditEvent('user.update', { username: pair.next.username, role: pair.next.role, disabled: pair.next.disabled }, req);

    const users = loadUsers().map(publicUser);
    res.json({ ok: true, users, changed: changedUsers.length, created: createdUsers.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/users/:id', (req, res) => {
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const doc = ensureUsersDoc();
    const idx = doc.users.findIndex(u => u.id === req.params.id || u.username === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'User not found' });
    const cur = doc.users[idx];
    const next = applyUserPatch(doc, idx, req.body || {});
    const candidate = doc.users.map((u, i) => i === idx ? next : u);
    if (adminCount(candidate) < 1) return res.status(400).json({ error: 'At least one active admin is required' });
    doc.users[idx] = next;
    saveUsersDoc(doc);
    for (const [token, session] of sessions) {
      if (session.username === cur.username && (next.disabled || next.passwordChangedAt !== cur.passwordChangedAt || next.username !== cur.username || next.role !== cur.role)) sessions.delete(token);
    }
    saveSessions(sessions);
    auditEvent('user.update', { username: next.username, role: next.role, disabled: next.disabled }, req);
    res.json({ ok: true, user: publicUser(next) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', (req, res) => {
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const doc = ensureUsersDoc();
    const idx = doc.users.findIndex(u => u.id === req.params.id || u.username === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'User not found' });
    const removed = doc.users[idx];
    const current = currentAuthUser(req);
    if (current && removed.username === current.username) return res.status(400).json({ error: 'You cannot delete your own user' });
    const nextUsers = doc.users.filter((_, i) => i !== idx);
    if (adminCount(nextUsers) < 1) return res.status(400).json({ error: 'At least one active admin is required' });
    doc.users = nextUsers;
    saveUsersDoc(doc);
    for (const [token, session] of sessions) {
      if (session.username === removed.username) sessions.delete(token);
    }
    saveSessions(sessions);
    auditEvent('user.delete', { username: removed.username }, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.fast !== '1') scheduleUptimeKumaHistoryHeal();
    res.json(redactForRole(req, withRequestUiPreferences(req, await getCachedData())));
  }
  catch (err) { sendServerError(res, err); }
});

app.get('/api/status/dashboard', async (req, res) => {
  try {
    const data = await getCachedData();
    const detailed = req.query.detail === '1' || req.query.full === '1';
    const historyLimit = detailed ? dashboardHistoryPointLimit() : compactDashboardHistoryPointLimit();
    const requestUi = uiPreferencesForRequest(req);
    const uiSig = JSON.stringify(requestUi);
    const sig = `${runtimeDataViewSignature(data)}|ui:${uiSig}`;
    const view = cachedView(`status:dashboard:${detailed ? 'full' : 'compact'}:${historyLimit}`, sig, () => dashboardStatusData(data, {
      compact: !detailed,
      historyLimit,
    }));
    view.ui = requestUi;
    const role = sessionRole(req);
    const uiKey = uiPreferenceKeyFromRequest(req) || 'global';
    sendCachedJson(req, res, `status:dashboard:${role}:${uiKey}:${detailed ? 'full' : 'compact'}:${historyLimit}`, sig, () => redactForRole(req, view), {
      cacheControl: 'no-store',
    });
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/status/summary', async (req, res) => {
  try {
    const data = await getCachedData();
    const requestUi = uiPreferencesForRequest(req);
    const uiSig = JSON.stringify(requestUi);
    const sig = `${runtimeViewSignature(data)}|ui:${uiSig}`;
    const view = cachedView('status:summary', sig, () => ({
      timestamp: data.timestamp || new Date().toISOString(),
      loading: !!data.loading,
      refreshing: refreshBusy(),
      snapshot: !!data._snapshot,
      configured: data.configured || configuredList(),
      publicStatus: !!data.publicStatus,
      preferredLanguage: data.preferredLanguage || config.preferredLanguage || 'en',
      appearance: data.appearance || { dashboardSidePanel: config.appearance?.dashboardSidePanel !== false },
      ui: requestUi,
      health: buildPublicSummary(data).map(s => ({
        id: s.id,
        name: s.name || s.title,
        status: s.status,
        detail: s.detail || s.meta || '',
      })),
    }));
    const role = sessionRole(req);
    const uiKey = uiPreferenceKeyFromRequest(req) || 'global';
    sendCachedJson(req, res, `status:summary:${role}:${uiKey}`, sig, () => redactForRole(req, view), {
      cacheControl: 'no-store',
    });
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/status/topology', async (req, res) => {
  try {
    const data = await getCachedData();
    const sig = runtimeViewSignature(data);
    const view = cachedView('status:topology', sig, () => topologyStatusData(data));
    const role = sessionRole(req);
    sendCachedJson(req, res, `status:topology:${role}`, sig, () => redactForRole(req, view), {
      cacheControl: 'no-store',
    });
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/status/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const write = chunk => res.write(chunk);
  statusStreamClients.add({ write });
  write(`event: status\ndata: ${JSON.stringify({
    type: 'hello',
    timestamp: cache.data?.timestamp || new Date().toISOString(),
    refreshing: refreshBusy(),
    snapshot: !!cache.data?._snapshot,
  })}\n\n`);
  const heartbeat = setInterval(() => {
    try { write(': ping\n\n'); } catch {}
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    for (const client of [...statusStreamClients]) {
      if (client.write === write) statusStreamClients.delete(client);
    }
  });
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
    const data = await getCachedData();
    const view = cachedView('status:dashboard', runtimeViewSignature(data), () => dashboardStatusData(data));
    res.json(redactForRole(req, { ...view, refreshing: refreshBusy() }));
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/config', (req, res) => {
  const masked = cachedView('config:masked', configRevision, () => {
    const raw = clonePlain(config || {});

    if (!raw.timezone && process.env.TZ) {
      raw.timezone = process.env.TZ;
    }

    return maskConfig(raw);
  });
  const role = sessionRole(req);
  const requestUi = uiPreferencesForRequest(req);
  const uiSig = JSON.stringify(requestUi);
  const uiKey = uiPreferenceKeyFromRequest(req) || 'global';
  sendCachedJson(req, res, `config:masked:${role}:${uiKey}`, `${configRevision}|ui:${uiSig}`, () => {
    const out = clonePlain(masked);
    out.ui = requestUi;
    return redactForRole(req, out);
  });
});

app.get('/api/settings/status', (req, res) => {
  if (!cache.data) backgroundRefresh();
  const data = cache.data || EMPTY;
  const sig = runtimeViewSignature(data);
  const view = cachedView('settings:status', sig, () => settingsStatusData(data));
  const role = sessionRole(req);
  sendCachedJson(req, res, `settings:status:${role}`, sig, () => redactForRole(req, view));
});

app.get('/api/settings/agents', (req, res) => {
  const sig = agentsViewSignature();
  const view = cachedView('settings:agents', sig, () => ({ agents: settingsAgentRows() }));
  const role = sessionRole(req);
  sendCachedJson(req, res, `settings:agents:${role}`, sig, () => redactForRole(req, view));
});

app.get('/api/config/export', (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const rawConfig = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : yaml.dump({});
  const files = { 'config.yaml': rawConfig };
  if (fs.existsSync(UI_PREFS_PATH)) files['ui-preferences.yaml'] = fs.readFileSync(UI_PREFS_PATH, 'utf8');
  if (fs.existsSync(TOPOLOGY_PATH)) files['topology.yaml'] = fs.readFileSync(TOPOLOGY_PATH, 'utf8');
  let version = '1.0.0';
  try { version = require('./package.json').version || version; } catch {}
  const backup = {
    kind: 'omnisight-config-backup',
    version,
    generatedAt: new Date().toISOString(),
    encryptedFields: encryptionEnabled(),
    files,
  };
  auditEvent('config.export', {}, req);
  res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="omnisight-config-backup-${new Date().toISOString().slice(0,10)}.yaml"`);
  res.send(yaml.dump(backup, { lineWidth: -1 }));
});

function backupVersion() {
  try { return require('./package.json').version || '1.0.0'; } catch { return '1.0.0'; }
}

function containsEncryptedValue(value) {
  if (typeof value === 'string') return isEncrypted(value);
  if (Array.isArray(value)) return value.some(containsEncryptedValue);
  if (value && typeof value === 'object') return Object.values(value).some(containsEncryptedValue);
  return false;
}

function preserveExistingAgentTokenAfterRestore(previousConfig) {
  const previousToken = String(previousConfig?.linux?.agentToken || '');
  if (!previousToken) return false;
  if (!config?.linux || typeof config.linux !== 'object' || Array.isArray(config.linux)) return false;
  const restoredToken = String(config.linux.agentToken || '');
  if (restoredToken === previousToken) return false;
  config.linux.agentToken = previousToken;
  saveConfigObject(config);
  return true;
}

function restoreConfigBackupText(text) {
  if (!text || typeof text !== 'string') throw new Error('Backup file is empty');
  const previousConfig = clonePlain(config);
  const doc = yaml.load(text);
  if (!doc || typeof doc !== 'object') throw new Error('Backup file is invalid');
  if (doc.kind !== 'omnisight-config-backup' && doc.kind !== 'omnisight-full-backup') throw new Error('This is not an OmniSight backup');
  let rawConfig = doc.files?.['config.yaml'];
  if (doc.kind === 'omnisight-full-backup' && rawConfig && typeof rawConfig === 'object') {
    if (rawConfig.encoding === 'base64' && rawConfig.content) rawConfig = Buffer.from(String(rawConfig.content), 'base64').toString('utf8');
    else rawConfig = rawConfig.content;
  }
  if (typeof rawConfig !== 'string') throw new Error('Backup does not contain config.yaml');
  const rawUi = typeof doc.files?.['ui-preferences.yaml'] === 'string' ? doc.files['ui-preferences.yaml'] : '';
  const rawTopology = typeof doc.files?.['topology.yaml'] === 'string' ? doc.files['topology.yaml'] : '';
  const parsed = yaml.load(rawConfig) || {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.yaml must be a YAML object');
  const encrypted = doc.encryptedFields === true || containsEncryptedValue(parsed);
  let agentTokenPreserved = false;
  if (encrypted) {
    if (!encryptionEnabled()) throw new Error('This backup contains encrypted fields. Enable encryption or restore the matching data/secret.key first.');
    try { decryptConfig(parsed); }
    catch { throw new Error('Encrypted fields cannot be decrypted with the current secret key. Use the matching data/secret.key or a full backup.'); }
    writePrivateText(CONFIG_PATH, rawConfig);
    if (rawUi) {
      writePrivateText(UI_PREFS_PATH, rawUi);
      invalidateYamlCache(UI_PREFS_PATH);
    }
    if (rawTopology) {
      writePrivateText(TOPOLOGY_PATH, rawTopology);
      invalidateYamlCache(TOPOLOGY_PATH);
    }
    config = loadConfig();
    agentTokenPreserved = preserveExistingAgentTokenAfterRestore(previousConfig);
    applyDiskWritePolicy();
    if (config.timezone) process.env.TZ = config.timezone;
    markConfigChanged();
    refreshGeneration += 1;
    refreshPromise = null;
  } else {
    saveConfigObject(parsed);
    if (rawUi) saveUiPreferencesSidecar(yaml.load(rawUi) || {});
    if (rawTopology) saveTopologySidecar(yaml.load(rawTopology) || {});
    config = loadConfig();
    agentTokenPreserved = preserveExistingAgentTokenAfterRestore(previousConfig);
    applyDiskWritePolicy();
    markConfigChanged();
  }
  return { encrypted, agentTokenPreserved };
}

app.post('/api/config/import', (req, res) => {
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const text = String(req.body?.backup || req.body?.yaml || req.body?.text || '');
    const result = restoreConfigBackupText(text);
    auditEvent('config.import', { encrypted: result.encrypted === true, agentTokenPreserved: result.agentTokenPreserved === true }, req);
    res.json({ ok: true, encrypted: result.encrypted === true, agentTokenPreserved: result.agentTokenPreserved === true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function collectFullBackupFiles(dir, base = dir, out = {}, state = { total: 0 }) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (FULL_BACKUP_SKIP.has(name)) continue;
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      collectFullBackupFiles(file, base, out, state);
      continue;
    }
    if (!st.isFile()) continue;
    state.total += st.size;
    if (state.total > FULL_BACKUP_MAX_BYTES) throw new Error('Full backup is larger than 50 MB. Reduce history retention or copy the data volume directly.');
    const rel = path.relative(base, file).split(path.sep).join('/');
    out[rel] = {
      encoding: 'base64',
      mode: (st.mode & 0o777).toString(8),
      size: st.size,
      content: fs.readFileSync(file).toString('base64'),
    };
  }
  return out;
}

async function collectFullBackupEntries(dir, base = dir, out = [], state = { total: 0 }) {
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    if (FULL_BACKUP_SKIP.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const st = await fs.promises.lstat(file);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      await collectFullBackupEntries(file, base, out, state);
      continue;
    }
    if (!st.isFile()) continue;
    state.total += st.size;
    if (state.total > FULL_BACKUP_MAX_BYTES) throw new Error('Full backup is larger than 50 MB. Reduce history retention or copy the data volume directly.');
    out.push({
      file,
      rel: path.relative(base, file).split(path.sep).join('/'),
      mode: (st.mode & 0o777).toString(8),
      size: st.size,
    });
  }
  return out;
}

function safeDataRestorePath(rel) {
  const raw = String(rel || '').replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error(`Unsafe backup path: ${rel}`);
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.includes('..')) throw new Error(`Unsafe backup path: ${rel}`);
  const target = path.resolve(__dirname, 'data', ...parts);
  const root = path.resolve(__dirname, 'data') + path.sep;
  if (!target.startsWith(root)) throw new Error(`Unsafe backup path: ${rel}`);
  return { target, rel: parts.join('/') };
}

function decodeFullBackupFile(rel, file) {
  if (!file || typeof file !== 'object') throw new Error(`Invalid backup file entry: ${rel}`);
  if (file.encoding !== 'base64') throw new Error(`Unsupported backup file encoding: ${rel}`);
  if (typeof file.content !== 'string') throw new Error(`Missing backup file content: ${rel}`);
  const buf = Buffer.from(file.content, 'base64');
  if (!Number.isFinite(Number(file.size)) || Number(file.size) !== buf.length) throw new Error(`Backup file size mismatch: ${rel}`);
  return buf;
}

function importFullBackupText(text) {
  if (!text || typeof text !== 'string') throw new Error('Backup file is empty');
  const previousConfig = authConfigured() ? clonePlain(config) : null;
  const doc = yaml.load(text);
  if (!doc || typeof doc !== 'object') throw new Error('Backup file is invalid');
  if (doc.kind !== 'omnisight-full-backup') throw new Error('This is not an OmniSight full backup');
  if (!doc.files || typeof doc.files !== 'object' || Array.isArray(doc.files)) throw new Error('Full backup does not contain files');
  let total = 0;
  let count = 0;
  const writes = [];
  for (const [rel, file] of Object.entries(doc.files)) {
    const safe = safeDataRestorePath(rel);
    if (FULL_BACKUP_SKIP.has(path.basename(safe.rel))) continue;
    const buf = decodeFullBackupFile(safe.rel, file);
    total += buf.length;
    if (total > FULL_BACKUP_MAX_BYTES) throw new Error('Full backup is larger than 50 MB. Restore the data volume directly instead.');
    const mode = Number.parseInt(String(file.mode || '600'), 8);
    writes.push({ ...safe, buf, mode: Number.isFinite(mode) ? mode : 0o600 });
  }
  const hasConfig = writes.some(w => w.rel === 'config.yaml');
  if (!hasConfig) throw new Error('Full backup does not contain config.yaml');
  for (const w of writes) {
    fs.mkdirSync(path.dirname(w.target), { recursive: true });
    fs.writeFileSync(w.target, w.buf, { mode: w.mode });
    try { fs.chmodSync(w.target, w.mode); } catch {}
    count += 1;
  }
  yamlFileCache.clear();
  normalizedUsersCache = null;
  reloadExtraCA();
  notifyState = loadNotify();
  notifyDisabled = notifyState.disabled;
  notifyTopics = notifyState.topics;
  alertHistory = loadAlertHistory();
  rebuildAlertSentCooldowns();
  auditLog = loadAuditLog();
  alertMutes = loadAlertMutes();
  config = loadConfig();
  const agentTokenPreserved = previousConfig ? preserveExistingAgentTokenAfterRestore(previousConfig) : false;
  applyDiskWritePolicy();
  process.env.TZ = config.timezone || process.env.TZ || process.env.TIMEZONE || 'UTC';
  try { agents.reload?.(); } catch (err) { console.warn('agents reload after backup import failed:', err.message); }
  try { reloadRuntimeHistoryMaps(); } catch (err) { console.warn('history reload after backup import failed:', err.message); }
  forceConnectingPlatforms.clear();
  markConfigChanged();
  refreshGeneration += 1;
  refreshPromise = null;
  cache = { data: null };
  sessions.clear();
  saveSessions(sessions);
  savePasswordResets({});
  return { files: count, bytes: total, agentTokenPreserved };
}

function verifyAdminPassword(req, password) {
  const auth = currentAuthUser(req);
  if (!auth || normalizeRole(auth.role) !== 'admin') throw new Error('Admin account required');
  if (!password) throw new Error('Current admin password is required');
  try {
    if (!verifyPassword(String(password), auth.hash, auth.salt)) throw new Error('Wrong current password');
  } catch (err) {
    if (err.message === 'Wrong current password') throw err;
    throw new Error('Wrong current password');
  }
  return auth;
}

function yamlJson(value) {
  return JSON.stringify(String(value ?? ''));
}

function backupExportFilename() {
  return `omnisight-full-backup-${new Date().toISOString().slice(0,10)}.yaml`;
}

async function writeStreamChunk(stream, chunk) {
  if (stream.write(chunk)) return;
  await new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

async function endWriteStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.once('error', reject);
  });
}

async function writeBase64FileBlock(stream, file, onBytes) {
  let carry = Buffer.alloc(0);
  let line = '';
  const flushBase64 = async text => {
    line += text;
    while (line.length >= 76) {
      await writeStreamChunk(stream, `      ${line.slice(0, 76)}\n`);
      line = line.slice(76);
    }
  };
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const encodeLen = data.length - (data.length % 3);
    if (encodeLen > 0) await flushBase64(data.subarray(0, encodeLen).toString('base64'));
    carry = data.subarray(encodeLen);
    if (onBytes) onBytes(chunk.length);
  }
  if (carry.length) await flushBase64(carry.toString('base64'));
  if (line.length) await writeStreamChunk(stream, `      ${line}\n`);
}

function safeUnlink(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

async function writeFullBackupArchive(job, entries, state) {
  fs.mkdirSync(FULL_BACKUP_EXPORT_TMP_DIR, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(FULL_BACKUP_EXPORT_TMP_DIR, `${job.id || crypto.randomBytes(12).toString('hex')}.yaml`);
  const stream = fs.createWriteStream(tmpPath, { encoding: 'utf8', mode: 0o600 });
  let bytesDone = 0;
  let filesDone = 0;
  const generatedAt = new Date().toISOString();
  const header = [
    'kind: omnisight-full-backup',
    `version: ${yamlJson(backupVersion())}`,
    `generatedAt: ${yamlJson(generatedAt)}`,
    `encryptedFields: ${encryptionEnabled() ? 'true' : 'false'}`,
    'excludedFiles:',
    ...Array.from(FULL_BACKUP_SKIP).map(name => `  - ${yamlJson(name)}`),
    `restore: ${yamlJson('Stop OmniSight, restore these files into the data/ volume, keep file permissions private, then start OmniSight.')}`,
    'files:',
  ].join('\n') + '\n';
  try {
    await writeStreamChunk(stream, header);
    for (const entry of entries) {
      await writeStreamChunk(stream, `  ${yamlJson(entry.rel)}:\n`);
      await writeStreamChunk(stream, '    encoding: base64\n');
      await writeStreamChunk(stream, `    mode: ${yamlJson(entry.mode)}\n`);
      await writeStreamChunk(stream, `    size: ${Number(entry.size || 0)}\n`);
      await writeStreamChunk(stream, '    content: |-\n');
      await writeBase64FileBlock(stream, entry.file, readBytes => {
        bytesDone += readBytes;
        job.bytesDone = bytesDone;
        const ratio = Number(state.total || 0) > 0 ? bytesDone / state.total : filesDone / Math.max(1, entries.length);
        job.progress = 5 + Math.floor(Math.max(0, Math.min(1, ratio)) * 83);
      });
      filesDone += 1;
      job.filesDone = filesDone;
      if (entry.size === 0) await writeStreamChunk(stream, '      \n');
      await new Promise(resolve => setImmediate(resolve));
    }
    await endWriteStream(stream);
    try { fs.chmodSync(tmpPath, 0o600); } catch {}
    return tmpPath;
  } catch (err) {
    stream.destroy();
    safeUnlink(tmpPath);
    throw err;
  }
}

const fullBackupExportJobs = new Map();
const FULL_BACKUP_EXPORT_JOB_TTL_MS = 10 * 60 * 1000;

function fullBackupJobSnapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: Math.max(0, Math.min(100, Math.round(Number(job.progress || 0)))),
    phase: job.phase || '',
    filesDone: Number(job.filesDone || 0),
    filesTotal: Number(job.filesTotal || 0),
    bytesDone: Number(job.bytesDone || 0),
    bytesTotal: Number(job.bytesTotal || 0),
    error: job.error || '',
    filename: job.filename || '',
  };
}

function cleanupFullBackupJobs() {
  const now = Date.now();
  for (const [id, job] of fullBackupExportJobs) {
    if (now - Number(job.createdAt || 0) > FULL_BACKUP_EXPORT_JOB_TTL_MS) {
      safeUnlink(job.path);
      fullBackupExportJobs.delete(id);
    }
  }
}

async function buildFullBackupExportJob(job) {
  try {
    job.status = 'running';
    job.phase = 'Scanning data files';
    job.progress = 1;
    const state = { total: 0 };
    const entries = await collectFullBackupEntries(DATA_DIR, DATA_DIR, [], state);
    job.filesTotal = entries.length;
    job.bytesTotal = state.total;
    job.progress = 5;
    job.phase = 'Reading backup files';

    job.path = await writeFullBackupArchive(job, entries, state);
    job.phase = 'Finalizing backup archive';
    job.progress = Math.max(job.progress, 95);
    job.filename = backupExportFilename();
    try { job.archiveBytes = fs.statSync(job.path).size; } catch {}
    job.progress = 100;
    job.phase = 'Ready to download';
    job.status = 'done';
    auditEvent('backup.full_export', { files: entries.length, job: true, actor: job.actor || 'system' }, null);
  } catch (err) {
    safeUnlink(job.path);
    job.status = 'failed';
    job.phase = 'Failed';
    job.error = err.message || String(err);
    job.progress = Math.max(1, Number(job.progress || 0));
  }
}

app.post('/api/backup/export/start', (req, res) => {
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    verifyAdminPassword(req, req.body?.password || req.body?.currentPassword);
    cleanupFullBackupJobs();
    const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const job = {
      id,
      status: 'queued',
      progress: 0,
      phase: 'Queued',
      createdAt: Date.now(),
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      actor: reqActor(req),
    };
    fullBackupExportJobs.set(id, job);
    setImmediate(() => buildFullBackupExportJob(job));
    res.json({ ok: true, job: fullBackupJobSnapshot(job) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/backup/export/status/:id', (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  cleanupFullBackupJobs();
  const job = fullBackupExportJobs.get(String(req.params.id || ''));
  if (!job) return res.status(404).json({ error: 'Backup export job not found' });
  res.json({ ok: true, job: fullBackupJobSnapshot(job) });
});

app.get('/api/backup/export/download/:id', (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const id = String(req.params.id || '');
  const job = fullBackupExportJobs.get(id);
  if (!job) return res.status(404).json({ error: 'Backup export job not found' });
  if (job.status !== 'done' || !job.path || !fs.existsSync(job.path)) return res.status(409).json({ error: 'Backup export is not ready yet' });
  res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename || `omnisight-full-backup-${new Date().toISOString().slice(0,10)}.yaml`}"`);
  const stream = fs.createReadStream(job.path);
  const cleanup = () => {
    safeUnlink(job.path);
    fullBackupExportJobs.delete(id);
  };
  stream.on('error', err => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  res.on('finish', cleanup);
  res.on('close', () => { if (!res.writableEnded) cleanup(); });
  stream.pipe(res);
});

app.post('/api/backup/export', async (req, res) => {
  let tmpPath = '';
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    verifyAdminPassword(req, req.body?.password || req.body?.currentPassword);
    const state = { total: 0 };
    const entries = await collectFullBackupEntries(DATA_DIR, DATA_DIR, [], state);
    const directJob = {
      id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      progress: 0,
      bytesDone: 0,
      bytesTotal: state.total,
      filesDone: 0,
      filesTotal: entries.length,
    };
    tmpPath = await writeFullBackupArchive(directJob, entries, state);
    auditEvent('backup.full_export', { files: entries.length }, req);
    res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${backupExportFilename()}"`);
    const stream = fs.createReadStream(tmpPath);
    const cleanup = () => { safeUnlink(tmpPath); tmpPath = ''; };
    stream.on('error', err => {
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.destroy(err);
    });
    res.on('finish', cleanup);
    res.on('close', () => { if (!res.writableEnded) cleanup(); });
    stream.pipe(res);
  } catch (err) {
    safeUnlink(tmpPath);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backup/import', (req, res) => {
  try {
    const initialSetup = !authConfigured();
    let actor = null;
    if (!initialSetup) {
      if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
      actor = verifyAdminPassword(req, req.body?.password || req.body?.currentPassword);
    }
    const result = importFullBackupText(String(req.body?.backup || req.body?.yaml || req.body?.text || ''));
    auditEvent('backup.full_import', { files: result.files, bytes: result.bytes, actor: actor?.username || 'initial-setup', agentTokenPreserved: result.agentTokenPreserved === true }, null);
    res.clearCookie('session', sessionCookieOptions(req));
    res.json({ ok: true, ...result, loggedOut: true, restartRecommended: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

const CONFIG_AUDIT_LABELS = {
  timezone: 'timezone',
  timeFormat: 'time format',
  defaultTimePeriodHours: 'default time period',
  defaultPeriodHours: 'default time period',
  historyRetentionDays: 'history retention',
  preferredLanguage: 'language',
  appearance: 'appearance',
  performance: 'performance',
  security: 'security',
  proxmox: 'Proxmox',
  linux: 'Linux Server',
  windows: 'Windows Server',
  kubernetes: 'Kubernetes',
  snmp: 'SNMP',
  healthchecks: 'Healthchecks',
  uptimekuma: 'Uptime Kuma',
  checks: 'Service checks',
  prometheus: 'Prometheus',
  docker: 'Docker',
  dockhand: 'Dockhand',
  firewall: 'Firewalls',
  truenas: 'TrueNAS',
  qnap: 'QNAP',
  ugreen: 'Ugreen',
  pbs: 'Proxmox Backup',
  cloudflare: 'Cloudflare',
  cicd: 'GitHub/GitLab CI',
  veeam: 'Veeam',
  portainer: 'Portainer',
  database: 'Databases',
  alerts: 'alerts',
  publicStatus: 'public status',
  publicTitle: 'public status title',
  publicPlatforms: 'public platforms',
  publicStatusShowDetails: 'public status details',
  publicStatusShowHistory: 'public status history',
};

function configAuditValue(value) {
  try { return JSON.stringify(maskConfig(value ?? null)); }
  catch { return String(value); }
}

function configChangeSummary(previous = {}, incoming = {}, merged = {}) {
  const skip = new Set(['excludedServices', 'topology']);
  return Object.keys(incoming || {})
    .filter(k => !skip.has(k))
    .filter(k => configAuditValue(previous?.[k]) !== configAuditValue(merged?.[k]))
    .map(k => CONFIG_AUDIT_LABELS[k] || k);
}

const CONNECTION_CONFIG_IGNORED_KEYS = new Set(['icon', 'historyHours']);

function connectionConfigComparable(value) {
  if (Array.isArray(value)) return value.map(connectionConfigComparable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (CONNECTION_CONFIG_IGNORED_KEYS.has(key)) continue;
      out[key] = connectionConfigComparable(child);
    }
    return out;
  }
  return value === undefined ? null : value;
}

function connectionConfigSignature(value) {
  try { return JSON.stringify(connectionConfigComparable(value ?? null)); }
  catch { return String(value); }
}

function changedConnectionPlatforms(previous = {}, next = {}, incoming = {}) {
  const changed = new Set();
  for (const key of PLATFORM_REFRESH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(incoming || {}, key)) continue;
    if (connectionConfigSignature(previous?.[key]) !== connectionConfigSignature(next?.[key])) changed.add(key);
  }
  return changed;
}

function preservePlatformsOnPartialConfig(incoming = {}, existing = {}) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const incomingHasPlatform = PLATFORM_REFRESH_KEYS.some(key => Object.prototype.hasOwnProperty.call(incoming, key));
  if (incomingHasPlatform) return incoming;
  PLATFORM_REFRESH_KEYS.forEach(key => {
    if (existing && Object.prototype.hasOwnProperty.call(existing, key)) incoming[key] = clonePlain(existing[key]);
  });
  return incoming;
}

app.post('/api/config', async (req, res) => {
  try {
    const incoming = req.body;
    const existing = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};
    const previousConfig = config;

    if (existing.excludedServices) {
      incoming.excludedServices = existing.excludedServices;
    }
    if (existing.topology && !incoming.topology) {
      incoming.topology = existing.topology;
    }
    preservePlatformsOnPartialConfig(incoming, existing);

    const merged = mergePreservingSecrets(incoming, existing);
    merged.security = merged.security && typeof merged.security === 'object' ? merged.security : {};
    merged.security.allowedPublicIps = normalizeAllowedPublicIps(merged.security.allowedPublicIps || []);
    if (merged.security.allowedPublicIps.length) {
      const currentPublicIp = cleanIpValue(await effectiveCurrentPublicIp(req));
      const currentIpCandidates = await currentPublicIpCandidates(req);
      if (!currentIpCandidates.length || !currentIpCandidates.some(ip => merged.security.allowedPublicIps.includes(ip))) {
        return res.status(400).json({
          error: `Allowed public IPs must include your current public IP (${currentPublicIp || 'unknown'})`,
          currentPublicIp,
        });
      }
    }
	if (merged.timezone) process.env.TZ = merged.timezone;
    const toSave = encryptionEnabled() ? encryptConfigObj(merged) : merged;
    writePrivateYaml(CONFIG_PATH, toSave);
    const changedSettings = configChangeSummary(previousConfig || {}, incoming || {}, merged || {});
    if (changedSettings.length) {
      auditEvent('settings.changed', {
        settings: changedSettings.slice(0, 10),
        count: changedSettings.length,
      }, req);
    }
    config = loadConfig();
    applyDiskWritePolicy();
    const connectingPlatforms = changedConnectionPlatforms(previousConfig || {}, config || {}, incoming || {});
    for (const key of forceConnectingPlatforms) connectingPlatforms.add(key);
    forceConnectingPlatforms.clear();
    if (connectingPlatforms.has('kubernetes')) {
      configChangeConnectingUntil.kubernetes = Date.now() + CONFIG_CHANGE_CONNECTING_MS;
    }
    markConfigChanged();
    refreshGeneration += 1;
    refreshPromise = null;
    const uptimeKumaChanged = uptimeKumaConfigChanged(previousConfig?.uptimekuma, config.uptimekuma);

    if (!cache.data) {
      cache.data = { ...EMPTY, timestamp: new Date().toISOString() };
    }

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

      if (en(config.windows)) {
        cache.data.windows = getWindowsData();
      } else { cache.data.windows = []; }

      if (en(config.kubernetes)) {
        if (connectingPlatforms.has('kubernetes') || !cache.data.kubernetes) {
          cache.data.kubernetes = kubernetesConnectingData();
        }
      } else { cache.data.kubernetes = null; }

      if (en(config.snmp)) {
        const devices = config.snmp.devices || [];
        cache.data.snmp = (cache.data.snmp || []).filter(d => devices.some(dev => dev.name === d.name));
        devices.forEach(dev => {
          const existing = cache.data.snmp.find(d => d.name === dev.name);
          if (existing) {
            Object.assign(existing, {
              host: dev.host,
              profile: dev.profile || dev.preset || 'generic',
              snmpVersion: dev.snmpVersion,
              ...(connectingPlatforms.has('snmp') ? { online: false, _connecting: true } : {}),
            });
          } else {
            cache.data.snmp.push({
              name: dev.name,
              host: dev.host,
              profile: dev.profile || dev.preset || 'generic',
              snmpVersion: dev.snmpVersion,
              online: false,
              _connecting: true
            });
          }
        });
      } else { cache.data.snmp = []; }

      if (en(config.healthchecks)) {
        if (connectingPlatforms.has('healthchecks') || !cache.data.healthchecks) {
          cache.data.healthchecks = { _connecting: true, online: false, summary: { total: 0, up: 0, down: 0, grace: 0, paused: 0 }, checks: [] };
        }
      } else { cache.data.healthchecks = null; }

      if (en(config.uptimekuma)) {
        if (connectingPlatforms.has('uptimekuma') || !cache.data.uptimekuma) {
          cache.data.uptimekuma = { _connecting: true, online: false, summary: { total: 0, up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0 }, monitors: [] };
        }
      } else { cache.data.uptimekuma = null; }

      if (en(config.checks)) {
        const services = config.checks.services || config.checks.checks || [];
        cache.data.checks = cache.data.checks || { _connecting: true, online: true, summary: { total: 0, up: 0, down: 0 }, checks: [], historyHours: checksConfig().historyHours };
        cache.data.checks.historyHours = checksConfig().historyHours;
        cache.data.checks.checks = (cache.data.checks.checks || []).filter(c => services.some(s => (s.name || s.target || s.host) === c.name || (s.name || s.target || s.host) === c.target));
        services.forEach(s => {
          const name = s.name || s.target || s.host || 'check';
          const existing = cache.data.checks.checks.find(c => c.name === name);
          if (existing && connectingPlatforms.has('checks')) {
            Object.assign(existing, { type: s.type || existing.type || 'http', target: s.target || s.url || s.host || existing.target || '', status: 'connecting', healthy: false, _connecting: true });
          } else if (!existing) {
            cache.data.checks.checks.push({ name, type: s.type || 'http', target: s.target || s.url || s.host || '', status: 'connecting', healthy: false, _connecting: true });
          }
        });
        cache.data.checks.summary = { total: services.length, up: 0, down: 0 };
      } else { cache.data.checks = null; }

      if (en(config.prometheus)) {
        cache.data.prometheus = mergePrometheusConfigured(connectingPlatforms.has('prometheus') ? null : cache.data.prometheus, config.prometheus);
      } else { cache.data.prometheus = null; }

      if (en(config.docker)) {
        cache.data.docker = mergeDockerHistory(mergeDockerConfiguredRows(connectingPlatforms.has('docker') ? [] : cache.data.docker, agents.getDockerData()));
      } else { cache.data.docker = []; }

      if (en(config.dockhand)) {
        cache.data.dockhand = mergeDockhandConfigured(connectingPlatforms.has('dockhand') ? null : cache.data.dockhand, config.dockhand);
      } else { cache.data.dockhand = null; }

      if (en(config.firewall)) {
        const instances = Array.isArray(config.firewall?.instances) && config.firewall.instances.length ? config.firewall.instances : (config.firewall?.url ? [config.firewall] : []);
        const current = !connectingPlatforms.has('firewall') && cache.data.firewall?.instances ? cache.data.firewall.instances : [];
        const rows = instances.map((i, idx) => {
          const existing = current.find(r => r.name === i.name || r.url === i.url);
          return existing || { name: i.name || i.url || `Firewall ${idx + 1}`, type: i.type || 'opnsense', url: i.url || '', online: false, _connecting: true, summary: { interfaces: 0, interfacesUp: 0, interfacesDown: 0 } };
        });
        cache.data.firewall = { online: rows.some(r => r.online), _connecting: rows.some(r => r._connecting), instances: rows, summary: { instances: rows.length, up: rows.filter(r => r.online).length, down: rows.filter(r => !r.online && !r._connecting).length, interfaces: rows.reduce((a, r) => a + Number(r.summary?.interfaces || 0), 0), interfacesUp: rows.reduce((a, r) => a + Number(r.summary?.interfacesUp || 0), 0), interfacesDown: rows.reduce((a, r) => a + Number(r.summary?.interfacesDown || 0), 0), updates: rows.reduce((a, r) => a + Number(r.summary?.updates || 0), 0), rebootRequired: rows.filter(r => r.summary?.rebootRequired).length } };
      } else { cache.data.firewall = null; }

      if (en(config.truenas)) {
        if (connectingPlatforms.has('truenas') || !cache.data.truenas) {
          cache.data.truenas = trueNasConnectingData(config.truenas);
        }
      } else { cache.data.truenas = null; }

      if (en(config.qnap)) {
        if (connectingPlatforms.has('qnap') || !cache.data.qnap) {
          cache.data.qnap = qnapConnectingData(config.qnap);
        }
      } else { cache.data.qnap = null; }

      if (en(config.ugreen)) {
        if (connectingPlatforms.has('ugreen') || !cache.data.ugreen) {
          cache.data.ugreen = ugreenConnectingData(config.ugreen);
        }
      } else { cache.data.ugreen = null; }

      if (en(config.pbs)) {
        if (connectingPlatforms.has('pbs') || !cache.data.pbs) {
          cache.data.pbs = pbsConnectingData(config.pbs);
        }
      } else { cache.data.pbs = null; }

      if (en(config.cloudflare)) {
        if (connectingPlatforms.has('cloudflare') || !cache.data.cloudflare) {
          cache.data.cloudflare = cloudflareConnectingData(config.cloudflare);
        }
      } else { cache.data.cloudflare = null; }

      if (en(config.cicd)) {
        if (connectingPlatforms.has('cicd') || !cache.data.cicd) {
          cache.data.cicd = cicdConnectingData(config.cicd);
        }
      } else { cache.data.cicd = null; }

      if (en(config.veeam)) {
        if (connectingPlatforms.has('veeam') || !cache.data.veeam) {
          cache.data.veeam = veeamConnectingData(config.veeam);
        }
      } else { cache.data.veeam = null; }

      if (en(config.portainer)) {
        if (connectingPlatforms.has('portainer') || !cache.data.portainer) {
          cache.data.portainer = portainerConnectingData(config.portainer);
        }
      } else { cache.data.portainer = null; }

      if (en(config.database)) {
        const instances = config.database.instances || [];
        cache.data.database = (cache.data.database || []).filter(d => instances.some(i => i.name === d.name));
        instances.forEach(i => {
          const existing = cache.data.database.find(d => d.name === i.name);
          if (existing && connectingPlatforms.has('database')) {
            Object.assign(existing, { name: i.name, type: i.type, host: i.host, online: false, _connecting: true });
          } else if (!existing) {
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

    const refreshForResponse = backgroundRefresh({ force: true });
    let responseData = cache.data || EMPTY;
    try {
      await Promise.race([
        refreshForResponse.then(() => { responseData = cache.data || EMPTY; }),
        new Promise(resolve => setTimeout(resolve, Number(req.query.wait || 7000))),
      ]);
    } catch {
      responseData = cache.data || EMPTY;
    }

    if (req.query.slim === '1') {
      res.json({ ok: true, fullData: false, data: { ...settingsStatusData(responseData), ui: uiPreferencesForRequest(req) } });
    } else {
      res.json({ ok: true, fullData: true, data: { ...responseData, ui: uiPreferencesForRequest(req) } });
    }
  } catch (err) {
    sendServerError(res, err);
  }
});

app.post('/api/preferences', async (req, res) => {
  try {
    const incoming = req.body || {};
    const incomingKeys = Object.keys(incoming);
    const uiOnly = incomingKeys.length === 1 && incomingKeys[0] === 'ui';
    const existing = uiOnly ? {} : (fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {});
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

    if (incoming.checks && typeof incoming.checks === 'object' && incoming.checks.historyHours !== undefined) {
      existing.checks = existing.checks || {};
      existing.checks.historyHours = uptimeKumaHistoryHours(incoming.checks.historyHours);
    }

    if (incoming.appearance && typeof incoming.appearance === 'object') {
      existing.appearance = {
        ...(existing.appearance || {}),
        dashboardSidePanel: incoming.appearance.dashboardSidePanel !== false,
      };
    }

    let savedRequestUi = null;
    if (incoming.ui && typeof incoming.ui === 'object') {
      savedRequestUi = saveUiPreferencesForRequest(req, incoming.ui);
      config.ui = loadUiPreferencesSidecar(config.ui || {});
      markConfigChanged();
    }

    if (!uiOnly) {
      stripDeprecatedConfig(existing);
      writePrivateYaml(CONFIG_PATH, stripSidecarConfig(existing));
      config = loadConfig();
      applyDiskWritePolicy();
      markConfigChanged();
    }
    const shouldRefreshUptimeKuma = uptimeKumaConfigChanged(previousUptimeKuma, config.uptimekuma);

    if (cache.data) {
      if (cache.data.uptimekuma) cache.data.uptimekuma.historyHours = uptimeKumaConfig().historyHours;
      if (cache.data.checks) cache.data.checks.historyHours = checksConfig().historyHours;
      assignStatic(cache.data);
      cache.data.timestamp = new Date().toISOString();
    }

    if (uiOnly) {
      return res.json({ ok: true, ui: savedRequestUi || uiPreferencesForRequest(req) });
    }

    if (shouldRefreshUptimeKuma && config.uptimekuma && config.uptimekuma.enabled !== false) {
      try {
        await refreshUptimeKumaNow();
      } catch (err) {
        console.warn(`Uptime Kuma preference refresh failed: ${err.message}`);
      }
    }

    res.json({ ok: true, fullData: false });
  } catch (err) {
    sendServerError(res, err);
  }
});

app.post('/api/topology/links', (req, res) => {
  try {
    if (!['admin', 'operator'].includes(sessionRole(req))) return res.status(403).json({ error: 'Forbidden' });
    const rawLinks = Array.isArray(req.body?.links) ? req.body.links : [];
    const seen = new Set();
    const links = [];
    for (const item of rawLinks) {
      const from = String(item?.from || '').trim().slice(0, 160);
      const to = String(item?.to || '').trim().slice(0, 160);
      if (!from || !to || from === to) continue;
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ from, to, label: String(item?.label || '').trim().slice(0, 80) });
      if (links.length >= 200) break;
    }
    const rawNodes = Array.isArray(req.body?.nodes) ? req.body.nodes : (config.topology?.nodes || []);
    const seenNodes = new Set();
    const nodes = [];
    for (const item of rawNodes) {
      const node = String(item || '').trim().slice(0, 160);
      if (!node || seenNodes.has(node)) continue;
      seenNodes.add(node);
      nodes.push(node);
      if (nodes.length >= 200) break;
    }
    const rawHidden = Array.isArray(req.body?.hidden) ? req.body.hidden : (config.topology?.hidden || []);
    const seenHidden = new Set();
    const hidden = [];
    for (const item of rawHidden) {
      const node = String(item || '').trim().slice(0, 160);
      if (!node || seenHidden.has(node)) continue;
      seenHidden.add(node);
      hidden.push(node);
      if (hidden.length >= 500) break;
    }
    const rawPositions = req.body?.positions && typeof req.body.positions === 'object'
      ? req.body.positions
      : (config.topology?.positions || {});
    const positions = {};
    for (const [key, value] of Object.entries(rawPositions)) {
      const ref = String(key || '').trim().slice(0, 160);
      const x = Number(value?.x);
      const y = Number(value?.y);
      if (!ref || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      positions[ref] = {
        x: Math.max(-100000, Math.min(100000, Math.round(x))),
        y: Math.max(-100000, Math.min(100000, Math.round(y))),
      };
      if (Object.keys(positions).length >= 500) break;
    }
    let view = config.topology?.view;
    if (req.body?.view && typeof req.body.view === 'object') {
      const scale = Number(req.body.view.scale);
      const x = Number(req.body.view.x);
      const y = Number(req.body.view.y);
      view = Number.isFinite(scale) && Number.isFinite(x) && Number.isFinite(y)
        ? {
            scale: Math.max(0.1, Math.min(5, scale)),
            x: Math.max(-100000, Math.min(100000, Math.round(x))),
            y: Math.max(-100000, Math.min(100000, Math.round(y))),
          }
        : undefined;
    }
    let spacing = config.topology?.spacing;
    if (req.body?.spacing && typeof req.body.spacing === 'object') {
      const proxmoxVmGap = Number(req.body.spacing.proxmoxVmGap ?? req.body.spacing.proxmoxGuestGap);
      spacing = Number.isFinite(proxmoxVmGap)
        ? { proxmoxVmGap: Math.max(110, Math.min(260, Math.round(proxmoxVmGap))) }
        : undefined;
    }
    const topology = { ...(config.topology || {}), links, nodes, hidden, positions, ...(view ? { view } : {}), ...(spacing ? { spacing } : {}) };
    saveTopologyOnly(topology);
    if (cache.data) assignStatic(cache.data);
    auditEvent('topology.links.update', { count: links.length, nodes: nodes.length }, req);
    res.json({ ok: true, links: topologyLinksConfig(), nodes: topologyNodesConfig(), hidden: topologyHiddenConfig(), spacing: topologySpacingConfig(), positions: topologyPositionsConfig(), view: topologyViewConfig() });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
  } else if (platform === 'windows' && cache.data.windows) {
    const srv = cache.data.windows.find(s => s.host === host || s.name === host);
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
      applyDiskWritePolicy();
      markConfigChanged();
    }
    patchCacheExclude(platform, host, service, true);
    res.json({ ok: true, data: cache.data });
  } catch (err) {
    sendServerError(res, err);
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
      applyDiskWritePolicy();
      markConfigChanged();
    }
    patchCacheExclude(platform, host, service, false);
    res.json({ ok: true, data: cache.data });
  } catch (err) {
    sendServerError(res, err);
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
    markKubernetesConnectingForNextConfigSave();
    res.json({ path: dest });
  } catch (err) {
    sendServerError(res, err);
  }
});

app.delete('/api/upload/kubeconfig', (req, res) => {
  try {
    const target = resolveDataFileForDelete(config.kubernetes?.kubeconfig, 'kube.bin');
    const removed = fs.existsSync(target);
    if (removed) fs.unlinkSync(target);
    config.kubernetes = { ...(config.kubernetes || {}), kubeconfig: '' };
    forceConnectingPlatforms.delete('kubernetes');
    if (cache?.data) cache.data.kubernetes = null;
    saveConfigObject(config);
    auditEvent('kubernetes.kubeconfig.delete', { removed }, req);
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/upload/icon', (req, res) => {
  try {
    const { name, dataUrl } = req.body || {};
    const buf = readBase64Payload(dataUrl, MAX_ICON_BYTES);
    let base = path.basename(String(name || 'icon')).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/\.(png|svg|webp|jpg|jpeg|gif|ico)$/i.test(base)) base += '.png';
    if (/\.svg$/i.test(base) && !isSafeSvg(buf)) return res.status(400).json({ error: 'SVG contains unsafe active content' });
    base = `${Date.now()}-${base}`;
    const dir = path.join(__dirname, 'data', 'icons');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, base), buf, { mode: 0o600 });
    res.json({ path: '/api/icons/' + base + '?v=' + Date.now() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

function certCommonNameFromSubject(subject) {
  const src = String(subject || '');
  const match = src.match(/(?:^|\n)CN\s*=\s*([^\n]+)/) || src.match(/(?:^|,\s*)CN\s*=\s*([^,]+)/);
  return match ? match[1].replace(/\\([,=+<>#;"\\])/g, '$1').trim() : '';
}

function firstCertificateBlock(text) {
  const match = String(text || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  return match ? match[0] : '';
}

function certificateCommonName(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const text = buf.toString('utf8');
    const pem = firstCertificateBlock(text);
    const cert = new crypto.X509Certificate(pem || buf);
    return certCommonNameFromSubject(cert.subject);
  } catch {
    return '';
  }
}

app.get('/api/certificates', (req, res) => {
  try {
    const dir = path.join(__dirname, 'data', 'certs');
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir)
      .filter(f => /\.(crt|pem|cer|pfx|p12)$/i.test(f))
      .map(f => {
        const filePath = path.join(dir, f);
        const extractedPem = path.join(dir, f.replace(/\.(pfx|p12)$/i, '.pem'));
        const cnPath = /\.(pfx|p12)$/i.test(f) && fs.existsSync(extractedPem) ? extractedPem : filePath;
        return {
          name: f,
          size: fs.statSync(filePath).size,
          trusted: /\.(crt|pem|cer)$/i.test(f),
          commonName: certificateCommonName(cnPath),
        };
      });
    res.json({ files });
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
    const { key, enabled, topic } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    if (enabled === false) notifyDisabled.add(key); else notifyDisabled.delete(key);
    if (topic !== undefined) {
      const cleanTopic = normalizeNotifyTopic(topic);
      if (cleanTopic) notifyTopics.set(String(key), cleanTopic);
      else notifyTopics.delete(String(key));
    }
    saveNotify();
    res.json({ ok: true, disabled: Array.from(notifyDisabled), topics: Object.fromEntries(notifyTopics) });
  } catch (err) { sendServerError(res, err); }
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
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  try { res.json(await getDockerData()); }
  catch (err) { sendServerError(res, err); }
});

app.get('/api/debug/kubernetes', async (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  try { res.json(await getAllKubernetesData(config.kubernetes)); }
  catch (err) { sendServerError(res, err); }
});

app.get('/api/debug/snmp', async (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  try { res.json(await getAllSynologyData(config.snmp)); }
  catch (err) { sendServerError(res, err); }
});

app.get('/api/debug/uptimekuma', async (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
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
  catch (err) { sendServerError(res, err); }
});

app.get('/api/debug/snmp-probe', async (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
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
      if (!dev.community) return res.status(400).json({ error: 'SNMP community is required for SNMP v1/v2c devices' });
      session = snmp.createSession(dev.host, dev.community, { version: snmp.Version2c, timeout: 5000, retries: 0 });
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
  if (REQUIRE_AGENT_TLS && !isSecureRequest(req) && !isLoopbackRequest(req)) {
    res.status(403).json({ error: 'HTTPS is required for agent endpoints' });
    return false;
  }
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

app.get('/agent/install-windows.ps1', (req, res) => {
  res.type('text/plain; charset=utf-8').sendFile(path.join(__dirname, 'agent', 'install-windows.ps1'));
});

app.get('/agent/omnisight-agent.ps1', (req, res) => {
  res.type('text/plain; charset=utf-8').sendFile(path.join(__dirname, 'agent', 'omnisight-agent.ps1'));
});

app.post('/api/agent/ping', (req, res) => {
  if (!agentAuth(req, res)) return;
  res.json({ ok: true, id: String(req.body?.id || '').replace(/[^\w.-]/g, '').slice(0, 128), serverTime: new Date().toISOString() });
});

const AGENT_CACHE_UPDATE_DELAY_MS = Math.max(250, Number(process.env.OMNISIGHT_AGENT_CACHE_UPDATE_DELAY_MS || 1500));
const AGENT_CACHE_UPDATE_SLOW_MS = Math.max(250, Number(process.env.OMNISIGHT_AGENT_CACHE_UPDATE_SLOW_MS || 750));
let agentCacheUpdateTimer = null;
function refreshAgentDerivedCache() {
  if (!cache.data) return;
  const en = c => c && c.enabled !== false;
  cache.data.linux = en(config.linux) ? getLinuxData(cache.data.proxmox) : [];
  cache.data.windows = en(config.windows) ? getWindowsData() : [];
  if (en(config.proxmox) && !hasProxmoxApi()) {
    cache.data.proxmox = preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
  } else if (!en(config.proxmox)) {
    cache.data.proxmox = { clusterSummary: null, nodes: [] };
  }
  cache.data.linux = en(config.linux) ? getLinuxData(cache.data.proxmox) : [];
  cache.data.windows = en(config.windows) ? getWindowsData() : [];
  cache.data.docker = en(config.docker) ? mergeDockerHistory(mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData())) : [];
  assignStatic(cache.data);
  cache.data.timestamp = new Date().toISOString();
}
function scheduleAgentCacheUpdate() {
  if (agentCacheUpdateTimer) return;
  agentCacheUpdateTimer = setTimeout(() => {
    agentCacheUpdateTimer = null;
    try {
      const start = Date.now();
      refreshAgentDerivedCache();
      const ms = Date.now() - start;
      if (ms >= AGENT_CACHE_UPDATE_SLOW_MS) console.warn(`[agents] derived cache refresh ${ms}ms ${diagnosticSnapshot()}`);
    }
    catch (err) { console.warn('agent cache update failed:', err.message); }
  }, AGENT_CACHE_UPDATE_DELAY_MS);
  agentCacheUpdateTimer.unref?.();
}

app.post('/api/agent/report', (req, res) => {
  if (!agentAuth(req, res)) return;
  try {
    const a = agents.handleReport(req.body || {});
    const cmds = agents.takeCommands(a.id);
    res.type('text/plain').send(agents.commandLines(cmds));
    scheduleAgentCacheUpdate();
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

let agentLatestVersionCache = { file: '', mtimeMs: 0, version: null };
function agentLatestVersion() {
  const file = path.join(__dirname, 'agent', 'omnisight-agent.sh');
  try {
    const stat = fs.statSync(file);
    if (agentLatestVersionCache.file === file && agentLatestVersionCache.version && agentLatestVersionCache.mtimeMs === stat.mtimeMs) {
      return agentLatestVersionCache.version;
    }
    const txt = fs.readFileSync(file, 'utf8');
    const version = (txt.match(/^VERSION="([^"]+)"/m) || [])[1] || appVersion();
    agentLatestVersionCache = { file, mtimeMs: stat.mtimeMs, version };
    return version;
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

let updateCheckCache = { expires: 0, value: null, pending: null };
const UPDATE_CHECK_SUCCESS_TTL_MS = Math.max(60 * 1000, Number(process.env.OMNISIGHT_UPDATE_CHECK_TTL_MS || 6 * 60 * 60 * 1000));
const UPDATE_CHECK_ERROR_TTL_MS = Math.max(60 * 1000, Number(process.env.OMNISIGHT_UPDATE_CHECK_ERROR_TTL_MS || 30 * 60 * 1000));

function semverParts(v) {
  return String(v || '0.0.0')
    .trim()
    .replace(/^v/i, '')
    .split(/[+-]/)[0]
    .split('.')
    .slice(0, 3)
    .map(n => Number.parseInt(n, 10) || 0);
}

function semverCompare(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function githubJson(pathname, timeoutMs = 2200) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get({
      hostname: 'api.github.com',
      path: pathname,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `OmniSight/${appVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: timeoutMs,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`GitHub HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub update check timed out')));
    req.on('error', reject);
  });
}

async function latestGithubVersion() {
  try {
    const rel = await githubJson('/repos/caglaryalcin/OmniSight/releases/latest');
    if (rel?.tag_name) {
      return {
        version: String(rel.tag_name).replace(/^v/i, ''),
        tag: rel.tag_name,
        url: rel.html_url || `https://github.com/caglaryalcin/OmniSight/releases/tag/${encodeURIComponent(rel.tag_name)}`,
        source: 'release',
      };
    }
  } catch (err) {
    if (err.statusCode && err.statusCode !== 404) throw err;
  }
  const tags = await githubJson('/repos/caglaryalcin/OmniSight/tags?per_page=1');
  const tag = Array.isArray(tags) ? tags[0] : null;
  if (!tag?.name) throw new Error('No GitHub release or tag found');
  return {
    version: String(tag.name).replace(/^v/i, ''),
    tag: tag.name,
    url: `https://github.com/caglaryalcin/OmniSight/releases/tag/${encodeURIComponent(tag.name)}`,
    source: 'tag',
  };
}

async function checkForAppUpdate(force = false) {
  const now = Date.now();
  if (!force && updateCheckCache.value && updateCheckCache.expires > now) return updateCheckCache.value;
  if (!force && updateCheckCache.pending) return updateCheckCache.pending;
  const current = appVersion();
  updateCheckCache.pending = (async () => {
    try {
      const latest = await latestGithubVersion();
      const value = {
        currentVersion: current,
        latestVersion: latest.version,
        tag: latest.tag,
        updateAvailable: semverCompare(latest.version, current) > 0,
        url: latest.url,
        source: latest.source,
        checkedAt: new Date().toISOString(),
      };
      updateCheckCache = { expires: now + UPDATE_CHECK_SUCCESS_TTL_MS, value, pending: null };
      return value;
    } catch (err) {
      const value = {
        currentVersion: current,
        latestVersion: null,
        updateAvailable: false,
        url: 'https://github.com/caglaryalcin/OmniSight/releases',
        error: err.message,
        checkedAt: new Date().toISOString(),
      };
      updateCheckCache = { expires: now + UPDATE_CHECK_ERROR_TTL_MS, value, pending: null };
      return value;
    }
  })();
  return updateCheckCache.pending;
}

function manualAgentUpdateCommand() {
  return "sudo sh -c 'set -a; . /etc/omnisight-agent/agent.env; set +a; curl -fsSL ${OMNISIGHT_INSECURE_TLS:+--insecure} \"$OMNISIGHT_URL/agent/install.sh\" -o /tmp/omnisight-install.sh && bash /tmp/omnisight-install.sh && systemctl restart omnisight-agent'";
}

function shQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function agentInstallRole(agent) {
  if (agent?.pveNode || agent?.platform === 'proxmox' || agent?.role === 'proxmox') return 'proxmox';
  if (agent?.platform === 'windows' || agent?.role === 'windows') return 'windows';
  if (agent?.role === 'docker' || agent?.hasDocker) return 'docker';
  return agent?.platform === 'synology' ? 'synology' : 'linux';
}

function agentRepairCommands(req, agent) {
  const base = browserRequestOrigin(req);
  const token = String(config.linux?.agentToken || '');
  const role = agentInstallRole(agent);
  const id = String(agent.id || '');
  if (role === 'windows') {
    const install = token
      ? `$env:OMNISIGHT_URL="${base}"; $env:OMNISIGHT_TOKEN="${token}"; $env:OMNISIGHT_AGENT_ROLE="windows"; iwr -UseBasicParsing "${base}/agent/install-windows.ps1" | iex`
      : 'Generate an agent token in Settings before reinstalling agents.';
    return [
      {
        title: 'Query Windows agent',
        description: 'Run in an elevated PowerShell window on the Windows host.',
        command: 'Get-ScheduledTask -TaskName OmniSightAgent -ErrorAction SilentlyContinue | Format-List *; Get-Content "$env:ProgramData\\OmniSight\\agent.id" -ErrorAction SilentlyContinue',
      },
      {
        title: 'Repair Windows agent',
        description: 'Reinstalls the scheduled task and keeps the same agent identity when ProgramData still exists.',
        command: install,
      },
    ];
  }
  const queryScript = [
    'echo "== omnisight-agent service =="',
    'systemctl status omnisight-agent --no-pager -l || true',
    'echo',
    'echo "== recent logs =="',
    'journalctl -u omnisight-agent -n 120 --no-pager || true',
    'echo',
    'echo "== dashboard reachability =="',
    'set -a',
    '[ -f /etc/omnisight-agent/agent.env ] && . /etc/omnisight-agent/agent.env',
    'set +a',
    `BASE="\${OMNISIGHT_URL:-${base}}"`,
    'TLS="${OMNISIGHT_INSECURE_TLS:+--insecure}"',
    'echo "agent_id=${OMNISIGHT_AGENT_ID:-missing} role=${OMNISIGHT_AGENT_ROLE:-auto} url=${BASE}"',
    'echo',
    'echo "== script download =="',
    'curl -sSL ${TLS} -m 20 -w "http=%{http_code} time=%{time_total}s\\n" "${BASE}/agent/omnisight-agent.sh" -o /tmp/omnisight-agent-check.sh || true',
    'echo',
    'echo "== agent api ping =="',
    'ping_out="$(mktemp)"',
    'ping_body="$(mktemp)"',
    'printf \'{"id":"%s"}\' "${OMNISIGHT_AGENT_ID:-agent-check}" > "$ping_body"',
    'curl -sSL --post301 --post302 --post303 ${TLS} -m 20 -w "http=%{http_code} time=%{time_total}s\\n" -o "$ping_out" -X POST -H "X-Agent-Token: ${OMNISIGHT_TOKEN:-}" -H "Content-Type: application/json" --data-binary @"$ping_body" "${BASE}/api/agent/ping" || true',
    'cat "$ping_out"',
    'rm -f "$ping_out" "$ping_body"',
  ].join('\n');
  const commands = [{
    title: 'Query agent',
    description: 'Run this first to check service state, recent logs and dashboard reachability on the offline host.',
    command: `sudo bash -lc ${shQuote(queryScript)}`,
  }];
  if (token) {
    const repairScript = [
      'set -a',
      '[ -f /etc/omnisight-agent/agent.env ] && . /etc/omnisight-agent/agent.env',
      'set +a',
      'INSECURE="${OMNISIGHT_INSECURE_TLS:-}"',
      'CURL_TLS="${INSECURE:+--insecure}"',
      `if ! curl -fsSL \${CURL_TLS} ${shQuote(base + '/agent/install.sh')} -o /tmp/omnisight-install.sh; then`,
      '  if [ -z "$INSECURE" ]; then',
      '    echo "install download failed; retrying with --insecure for self-signed TLS"',
      '    INSECURE=1',
      `    curl -fsSL --insecure ${shQuote(base + '/agent/install.sh')} -o /tmp/omnisight-install.sh`,
      '  else',
      '    exit 1',
      '  fi',
      'fi',
      `OMNISIGHT_URL=${shQuote(base)} OMNISIGHT_TOKEN=${shQuote(token)} OMNISIGHT_AGENT_ROLE=${shQuote(role)} OMNISIGHT_AGENT_ID=${shQuote(id)} OMNISIGHT_INSECURE_TLS=\${INSECURE:-} bash /tmp/omnisight-install.sh`,
      'systemctl restart omnisight-agent',
      'systemctl status omnisight-agent --no-pager -l',
    ].join('\n');
    commands.push({
      title: 'Repair systemd agent',
      description: 'Run this when logs show 401 invalid agent token or after restoring a backup. It reinstalls the agent with the current dashboard token, keeps the same agent identity and restarts the service.',
      command: `sudo bash -lc ${shQuote(repairScript)}`,
    });
    if (role === 'docker') {
      commands.push({
        title: 'Repair Docker container agent',
        description: 'Use this only if the agent was installed as the Docker container from Settings; it recreates the container with the current dashboard token.',
        command: [
          'docker rm -f omnisight-agent 2>/dev/null || true',
          'docker run -d --name omnisight-agent --restart unless-stopped \\',
          '  --network host --pid host \\',
          `  -e OMNISIGHT_URL=${shQuote(base)} \\`,
          `  -e OMNISIGHT_TOKEN=${shQuote(token)} \\`,
          '  -e OMNISIGHT_AGENT_ROLE=docker \\',
          `  -e OMNISIGHT_AGENT_ID=${shQuote(id)} \\`,
          '  -e OMNISIGHT_HOST_ROOT=/host \\',
          '  -v /:/host:ro \\',
          '  -v /var/run/docker.sock:/var/run/docker.sock:ro \\',
          `  docker:cli sh -c "apk add --no-cache bash curl coreutils >/dev/null && curl -fsSL ${shQuote(base + '/agent/omnisight-agent.sh')} -o /usr/local/bin/omnisight-agent && exec bash /usr/local/bin/omnisight-agent"`,
        ].join('\n'),
      });
    }
  } else {
    commands.push({
      title: 'Repair unavailable',
      description: 'No Linux agent token is configured. Generate a token in Settings before reinstalling agents.',
      command: 'Open Settings -> Linux Server and generate an agent token.',
    });
  }
  return commands;
}

app.get('/api/agents', (req, res) => {
  try {
    const sig = agentsViewSignature();
    const view = cachedView('agents:list', sig, () => ({ latestVersion: agentLatestVersion(), agents: agents.listAgents() }));
    const role = sessionRole(req);
    sendCachedJson(req, res, `agents:list:${role}`, sig, () => redactForRole(req, view), {
      cacheControl: 'no-store',
    });
  } catch (err) {
    console.warn('agents list failed:', err.message);
    sendServerError(res, err);
  }
});

app.get('/api/agent/repair-commands', (req, res) => {
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Only admins can view repair commands.' });
    const id = String(req.query?.id || '').replace(/[^\w.-]/g, '').slice(0, 128);
    if (!id) return res.status(400).json({ error: 'id required' });
    const agent = agents.findAgent(id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    res.json({ ok: true, id: agent.id, name: agent.hostname || agent.id, commands: agentRepairCommands(req, agent) });
  } catch (err) {
    sendServerError(res, err);
  }
});

app.post('/api/agent/update', async (req, res) => {
  try {
    const id = String(req.body?.id || '').replace(/[^\w.-]/g, '').slice(0, 128);
    if (!id) return res.status(400).json({ error: 'id required' });
    const agent = agents.findAgent(id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    const role = agentInstallRole(agent);
    if (role === 'windows' && versionCompare(agent.agentVersion, '1.2.4') < 0) {
      const base = browserRequestOrigin(req);
      const token = String(config.linux?.agentToken || '');
      return res.status(409).json({
        error: 'This Windows agent needs a one-time reinstall before remote updates are available.',
        manualCommand: token
          ? `$env:OMNISIGHT_URL="${base}"; $env:OMNISIGHT_TOKEN="${token}"; $env:OMNISIGHT_AGENT_ROLE="windows"; $env:OMNISIGHT_AGENT_ID="${id}"; iwr -UseBasicParsing "${base}/agent/install-windows.ps1" | iex`
          : 'Generate an agent token in Settings before reinstalling the Windows agent.',
      });
    }
    if (versionCompare(agent.agentVersion, '1.2.1') < 0) {
      return res.status(409).json({
        error: 'This agent needs a one-time manual update before remote updates are available.',
        manualCommand: manualAgentUpdateCommand(),
      });
    }
    const output = await agents.queueCommand(id, 'agent_update', 'self');
    auditEvent('agent.update.queued', { id, version: agent.agentVersion }, req);
    res.json({ ok: true, output });
  } catch (err) {
    sendServerError(res, err);
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
    applyDiskWritePolicy();
    markConfigChanged();
    auditEvent('agent.token.regenerate', {}, req);
    res.json({ ok: true, token });
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/agent/token', (req, res) => {
  try {
    if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const token = String(config.linux?.agentToken || '');
    if (!token) return res.status(404).json({ error: 'agent token is not configured' });
    res.json({ ok: true, token });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/agent/pending', (req, res) => {
  try {
    const kind = ['linux', 'windows', 'proxmox', 'docker'].includes(req.body?.kind) ? req.body.kind : 'linux';
    const pending = agents.addPendingInstall(kind);
    if (cache.data) {
      if (kind === 'linux') {
        cache.data.linux = getLinuxData(cache.data.proxmox);
      }
      if (kind === 'windows') {
        cache.data.windows = getWindowsData();
      }
      if (kind === 'proxmox') {
        cache.data.proxmox = preserveProxmoxOnTransient(agents.getProxmoxData({ excludedServices: config.excludedServices }));
      }
      if (kind === 'docker') {
        cache.data.docker = mergeDockerHistory(mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData()));
      }
      assignStatic(cache.data);
    }
    auditEvent('agent.pending.add', { kind, id: pending.id }, req);
    res.json({ ok: true, pending, data: cache.data });
  } catch (err) { sendServerError(res, err); }
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
      cache.data.windows = getWindowsData();
      cache.data.docker = mergeDockerHistory(mergeDockerConfiguredRows(cache.data.docker, agents.getDockerData()));
      assignStatic(cache.data);
    }
    auditEvent('agent.remove', { id, ok }, req);
    res.json({ ok, data: cache.data });
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.max(0, Math.min(1000, Number(req.query.limit) || 0));
  let rows = LOG_BUFFER.filter(l => l.t > since);
  if (limit) rows = rows.slice(-limit);
  res.json(redactForRole(req, rows.map(compactLogEvent)));
});

function compactEventText(value, limit = 1400) {
  if (value == null) return value;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function compactEventValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return compactEventText(value, depth > 1 ? 500 : 1200);
  if (typeof value !== 'object') return value;
  if (depth >= 3) return compactEventText(safeStr(value), 700);
  if (Array.isArray(value)) return value.slice(0, 12).map(v => compactEventValue(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 24)) out[k] = compactEventValue(v, depth + 1);
  return out;
}

function compactLogEvent(l = {}) {
  return { ...l, msg: compactEventText(l.msg, 1800) };
}

function compactAuditEvent(a = {}) {
  return { ...a, detail: compactEventValue(a.detail) };
}

function compactAlertEvent(a = {}) {
  return {
    ...a,
    message: compactEventText(a.message, 1600),
    detail: compactEventText(a.detail, 1600),
  };
}

app.get('/api/events/initial', (req, res) => {
  const limit = Math.max(30, Math.min(180, Number(req.query.limit) || 90));
  const sig = eventsViewSignature(limit);
  const view = cachedView(`events:initial:${limit}`, sig, () => ({
    logs: LOG_BUFFER.slice(-limit).map(compactLogEvent),
    audit: auditLog.slice(-limit).map(compactAuditEvent),
    alerts: alertHistory.slice(-limit).map(compactAlertEvent),
  }));
  const role = sessionRole(req);
  sendCachedJson(req, res, `events:initial:${role}:${limit}`, sig, () => redactForRole(req, view));
});

app.get('/api/events/delta', (req, res) => {
  const logsSince = Number(req.query.logsSince) || Number(req.query.since) || 0;
  const auditSince = Number(req.query.auditSince) || Number(req.query.since) || 0;
  const alertsSince = Number(req.query.alertsSince) || Number(req.query.since) || 0;
  const sig = `${eventsViewSignature(0)}|${logsSince}|${auditSince}|${alertsSince}`;
  const role = sessionRole(req);
  sendCachedJson(req, res, `events:delta:${role}:${logsSince}:${auditSince}:${alertsSince}`, sig, () => redactForRole(req, {
    logs: LOG_BUFFER.filter(l => Number(l.t || 0) > logsSince).map(compactLogEvent),
    audit: auditLog.filter(a => Number(a.t || 0) > auditSince).map(compactAuditEvent),
    alerts: alertHistory.filter(a => Number(a.t || 0) > alertsSince).map(compactAlertEvent),
  }));
});

app.get('/api/alerts/history', (req, res) => {
  const since = Number(req.query.since) || 0;
  const sig = `${alertHistory.length}|${alertHistory.at(-1)?.t || 0}|${since}`;
  const role = sessionRole(req);
  sendCachedJson(req, res, `alerts:history:${role}:${since}`, sig, () => redactForRole(req, alertHistory.filter(a => Number(a.t || 0) > since)));
});

app.get('/api/alerts/timeline', (req, res) => {
  const key = String(req.query.key || '').slice(0, 300);
  if (!key) return res.status(400).json({ error: 'Missing key' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(redactForRole(req, alertHistory.filter(a => a.key === key).slice(-200)));
});

app.post('/api/alerts/ack', (req, res) => {
  const id = String(req.body?.id || '');
  const key = String(req.body?.key || '');
  let changed = false;
  alertHistory = alertHistory.map(a => {
    if ((id && a.id === id) || (key && a.key === key && a.type === 'problem' && !a.acknowledgedAt)) {
      changed = true;
      return { ...a, acknowledgedAt: Date.now(), acknowledgedBy: reqActor(req) };
    }
    return a;
  });
  if (changed) saveAlertHistory();
  auditEvent('alert.acknowledge', { id, key, changed }, req);
  res.json({ ok: true, changed });
});

app.post('/api/alerts/mute', (req, res) => {
  const key = String(req.body?.key || '').slice(0, 300);
  const minutes = Math.max(1, Math.min(10080, Number(req.body?.minutes || 60)));
  if (!key) return res.status(400).json({ error: 'Missing key' });
  const rec = { until: Date.now() + minutes * 60 * 1000, by: reqActor(req), minutes };
  alertMutes.set(key, rec);
  saveAlertMutes();
  auditEvent('alert.mute', { key, minutes }, req);
  res.json({ ok: true, key, ...rec });
});

app.post('/api/alerts/unmute', (req, res) => {
  const key = String(req.body?.key || '').slice(0, 300);
  if (!key) return res.status(400).json({ error: 'Missing key' });
  const changed = alertMutes.delete(key);
  if (changed) saveAlertMutes();
  auditEvent('alert.unmute', { key, changed }, req);
  res.json({ ok: true, changed });
});

app.post('/api/alerts/history/clear', (req, res) => {
  alertHistory = [];
  alertSentAtBySignature.clear();
  saveAlertHistory();
  auditEvent('alert.history.clear', {}, req);
  res.json({ ok: true });
});

app.post('/api/webhook/event', (req, res) => {
  const cfg = webhookConfig();
  if (cfg.enabled === false) return res.status(404).json({ error: 'webhook endpoint is disabled' });
  const expected = String(cfg.token || process.env.OMNISIGHT_WEBHOOK_TOKEN || '').trim();
  if (!expected) return res.status(403).json({ error: 'webhook token is not configured' });
  if (!tokenMatches(webhookTokenFromReq(req), expected)) return res.status(401).json({ error: 'invalid webhook token' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const severity = normalizeWebhookSeverity(body.severity || body.status || body.state || body.level);
  const type = normalizeWebhookType(body.type || body.event || body.status || body.state, severity);
  const source = clipText(body.source || body.system || body.host || 'external', 160);
  const title = clipText(body.title || body.name || body.event || 'External event', 180);
  const message = clipText(body.message || body.description || body.detail || body.error || '', 3000);
  const key = clipText(body.key || body.id || `${source}:${title}`, 300);
  const entry = pushAlertHistory({
    type,
    severity,
    title,
    message,
    label: clipText(body.label || source, 180),
    detail: clipText(body.detail || body.error || body.status || body.state || '', 1000),
    key,
    source: 'webhook',
    externalSource: source,
    externalPayload: body.includePayload === true ? sanitizeWebhookPayload(body) : undefined,
    status: 'received',
    channels: [{ channel: 'webhook', ok: true }],
  });
  res.json({ ok: true, id: entry.id });
});

app.get('/api/audit', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.setHeader('Cache-Control', 'no-store');
  res.json(redactForRole(req, auditLog.filter(a => Number(a.t || 0) > since)));
});

app.get('/api/audit/integrity', (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(auditIntegrityReport());
});

function auditExportItems(req) {
  const since = Number(req.query.since) || 0;
  const limit = Math.max(1, Math.min(AUDIT_MAX, Number(req.query.limit) || AUDIT_MAX));
  return auditLog
    .filter(a => Number(a.t || 0) > since)
    .slice(-limit);
}
function csvCell(value) {
  const s = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return `"${String(s).replace(/"/g, '""')}"`;
}
function auditCsv(items) {
  const headers = ['id', 'time', 'actor', 'ip', 'publicIp', 'action', 'detail', 'prevHash', 'hash'];
  const rows = items.map(a => [
    a.id || '',
    new Date(Number(a.t || 0)).toISOString(),
    a.actor || '',
    a.ip || '',
    a.publicIp || '',
    a.action || '',
    a.detail || {},
    a.prevHash || '',
    a.hash || '',
  ].map(csvCell).join(','));
  return [headers.join(','), ...rows].join('\n') + '\n';
}
function syslogValue(value) {
  return String(value == null ? '' : value).replace(/["\\\]\r\n]/g, ' ').slice(0, 2048);
}
function auditSyslog(items) {
  return items.map(a => {
    const ts = new Date(Number(a.t || 0)).toISOString();
    const id = syslogValue(a.id || '-');
    const detail = syslogValue(JSON.stringify(a.detail || {}));
    return `<134>1 ${ts} omnisight audit - ${id} - action="${syslogValue(a.action)}" actor="${syslogValue(a.actor)}" ip="${syslogValue(a.ip)}" publicIp="${syslogValue(a.publicIp)}" hash="${syslogValue(a.hash)}" detail="${detail}"`;
  }).join('\n') + '\n';
}
app.get('/api/audit/export', (req, res) => {
  if (sessionRole(req) !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const format = String(req.query.format || 'json').toLowerCase();
  const items = auditExportItems(req);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="omnisight-audit-${date}.csv"`);
    return res.send(auditCsv(items));
  }
  if (format === 'syslog') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="omnisight-audit-${date}.log"`);
    return res.send(auditSyslog(items));
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="omnisight-audit-${date}.json"`);
  return res.send(JSON.stringify({ exportedAt: new Date().toISOString(), integrity: auditIntegrityReport(), events: items }, null, 2));
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
    const metaParts = activeNodes.length ? [`${online}/${activeNodes.length} nodes up`] : ['connecting...'];
    
    if (!activeNodes.length && connecting) status = 'connecting';
    else if (online === 0) status = 'down';
    else if (online < activeNodes.length || connecting || failedSvcs > 0 || (ceph && ceph.health !== 'HEALTH_OK')) status = 'warn';
    if (ceph && ceph.health === 'HEALTH_ERR') status = 'down';
    
    if (failedSvcs > 0) metaParts.push(`${failedSvcs} failed services`);
    if (ceph && ceph.health !== 'HEALTH_OK') metaParts.push(`Ceph ${ceph.health.replace('HEALTH_', '')}`);
    
    out.push({ id: 'proxmox', title: 'Proxmox', status, meta: metaParts.join(' · ') });
  }
  if ((data.linux || []).length) {
    const linuxRows = data.linux.filter(l => !l._connecting);
    const connecting = data.linux.length - linuxRows.length;
    const up = linuxRows.filter(l => l.online).length;
    const svcTotal = linuxRows.reduce((a, l) => a + (l.services || []).filter(s => !s.excluded).length, 0);
    const svcUp = linuxRows.reduce((a, l) => a + (l.services || []).filter(x => x.active && !x.excluded).length, 0);
    const failedSvcs = svcTotal - svcUp;
    const status = !linuxRows.length && connecting ? 'connecting' : up === 0 ? 'down' : (up < linuxRows.length || connecting || failedSvcs > 0 ? 'warn' : 'ok');
    out.push({ id: 'linux', title: 'Linux Server', status, meta: linuxRows.length ? `${up}/${linuxRows.length} servers\n${svcUp}/${svcTotal} services` : 'connecting...' });
  }
  if ((data.windows || []).length) {
    const rows = data.windows.filter(w => !w._connecting);
    const connecting = data.windows.length - rows.length;
    const up = rows.filter(w => w.online).length;
    const svcTotal = rows.reduce((a, w) => a + (w.services || []).filter(s => !s.excluded).length, 0);
    const svcUp = rows.reduce((a, w) => a + (w.services || []).filter(x => x.active && !x.excluded).length, 0);
    const failedSvcs = rows.reduce((a, w) => a + (w.services || []).filter(x => !x.active && !x.excluded && x.state !== 'unknown').length, 0);
    const status = !rows.length && connecting ? 'connecting' : up === 0 ? 'down' : (up < rows.length || connecting || failedSvcs > 0 ? 'warn' : 'ok');
    out.push({ id: 'windows', title: 'Windows Server', status, meta: rows.length ? `${up}/${rows.length} servers\n${svcUp}/${svcTotal} services` : 'connecting...' });
  }
  const k = data.kubernetes;
  if (k && k.online !== undefined && (k.online || k.summary)) {
    const sm = k.summary || {};
    const resources = Number(sm.resources ?? ((k.pods || []).length + (k.services || []).length + (k.deployments || []).length));
    const issue = !!k._empty || !!k.error || resources === 0;
    out.push({
      id: 'kubernetes',
      title: 'Kubernetes',
      status: k._connecting && !k.online ? 'connecting' : !k.online ? 'down' : (issue || sm.failed > 0 ? 'warn' : 'ok'),
      meta: k._connecting && !k.online ? 'connecting...' : !k.online ? 'unreachable' : issue ? 'no resources found' : `${sm.running || 0}/${sm.total || 0} pods`,
    });
  }
  if ((data.snmp || []).length) {
    const profileId = d => {
      const p = String(d?.profile || d?.preset || '').trim().toLowerCase();
      return ['synology', 'mikrotik', 'unifi'].includes(p) ? p : 'snmp';
    };
    const titles = { synology: 'Synology', mikrotik: 'MikroTik', unifi: 'UniFi', snmp: 'SNMP' };
    for (const id of ['synology', 'mikrotik', 'unifi', 'snmp']) {
      const devices = data.snmp.filter(d => profileId(d) === id);
      if (!devices.length) continue;
      const connecting = devices.filter(d => d._connecting && !d.online).length;
      const rows = devices.filter(d => !d._connecting || d.online);
      const up = rows.filter(d => d.online).length;
      out.push({ id, title: titles[id], status: !rows.length && connecting ? 'connecting' : up === rows.length && !connecting ? 'ok' : up > 0 ? 'warn' : 'down', meta: !rows.length && connecting ? 'connecting...' : `${up}/${rows.length} up${connecting ? ` · ${connecting} connecting` : ''}` });
    }
  }
  const hc = data.healthchecks;
  if (hc && hc.online !== undefined) {
    const sm = hc.summary || {};
    const up = Number(sm.up || 0);
    const down = Number(sm.down || 0);
    const grace = Number(sm.grace || 0);
    const total = Number(sm.total || 0);
    const status = hc._connecting && !hc.online ? 'connecting' : !hc.online ? 'down' : (total > 0 && down > total / 2 ? 'down' : (down > 0 || grace > 0) ? 'warn' : 'ok');
    out.push({ id: 'healthchecks', title: 'Healthchecks', status, meta: hc._connecting && !hc.online ? 'connecting...' : hc.online ? `${up}/${sm.total || 0} up` : 'unreachable' });
  }
  const uk = data.uptimekuma;
  if (uk && uk.online !== undefined) {
    const sm = uk.summary || {};
    const up = sm.up || 0;
    const down = sm.down || 0;
    const warn = (sm.pending || 0) + (sm.unknown || 0);
    const status = uk._connecting && !uk.online ? 'connecting' : !uk.online ? 'down' : (down > 0 ? (up > 0 ? 'warn' : 'down') : (warn > 0 ? 'warn' : 'ok'));
    out.push({ id: 'uptimekuma', title: 'Uptime Kuma', status, meta: uk._connecting && !uk.online ? 'connecting...' : uk.online ? `${up}/${sm.total || 0} up` : 'unreachable' });
  }
  const checks = data.checks;
  if (checks && checks.online !== undefined) {
    const sm = checks.summary || {};
    const total = sm.total || (checks.checks || []).length || 0;
    const up = sm.up || 0;
    const down = sm.down || 0;
    const connecting = (checks.checks || []).filter(c => c._connecting || c.status === 'connecting').length;
    const status = connecting && !up && !down ? 'connecting' : down > 0 ? (up > 0 ? 'warn' : 'down') : 'ok';
    out.push({ id: 'checks', title: 'Service checks', status, meta: connecting && !up && !down ? 'connecting...' : `${up}/${total} up` });
  }
  const prom = data.prometheus;
  if (prom && prom.online !== undefined) {
    const sm = prom.summary || {};
    const up = sm.up || 0;
    const down = sm.down || 0;
    const unknown = sm.unknown || 0;
    const instanceDown = sm.instanceDown || 0;
    const connecting = prom._connecting || (prom.instances || []).some(i => i._connecting && !i.online);
    const status = connecting && !prom.online ? 'connecting' : !prom.online ? 'down' : (down > 0 ? (up > 0 ? 'warn' : 'down') : ((unknown > 0 || instanceDown > 0 || connecting) ? 'warn' : 'ok'));
    const instanceMeta = sm.instances ? ` · ${sm.instanceUp || 0}/${sm.instances} servers` : '';
    out.push({ id: 'prometheus', title: 'Prometheus', status, meta: connecting && !prom.online ? 'connecting...' : prom.online ? `${up}/${sm.total || 0} targets up${instanceMeta}${connecting ? ' · connecting' : ''}` : 'unreachable' });
  }
  if ((data.docker || []).length) {
    const dockerRows = data.docker.filter(h => !h._connecting);
    const connecting = data.docker.length - dockerRows.length;
    const up = dockerRows.filter(h => h.online).length;
    const running = dockerRows.reduce((a, h) => a + (h.summary?.running || 0), 0);
    const total = dockerRows.reduce((a, h) => a + (h.summary?.total || 0), 0);
    const stopped = dockerRows.reduce((a, h) => a + (h.summary?.stopped || 0), 0);
    const status = !dockerRows.length && connecting ? 'connecting' : up < dockerRows.length ? (up > 0 ? 'warn' : 'down') : (connecting || stopped > 0 ? 'warn' : 'ok');
    const meta = stopped > 0 ? `${running}/${total} running\n${stopped} stopped` : `${running}/${total} containers`;
    out.push({ id: 'docker', title: 'Docker', status, meta: dockerRows.length ? meta : 'connecting...' });
  }
  const dh = data.dockhand;
  if (dh && dh.online !== undefined) {
    const instances = dh.instances || [];
    const active = instances.filter(i => !i._connecting);
    const connecting = instances.length - active.length;
    const up = active.filter(i => i.online).length;
    const sm = dh.summary || {};
    const stopped = Number(sm.stopped || 0);
    const noContainers = up > 0 && Number(sm.total || 0) === 0 && !connecting;
    const status = !active.length && connecting ? 'connecting' : up === 0 ? 'down' : (noContainers || up < active.length || connecting || stopped > 0 ? 'warn' : 'ok');
    const meta = active.length ? (noContainers ? `no containers · ${up}/${active.length} servers` : `${sm.running || 0}/${sm.total || 0} running · ${up}/${active.length} servers`) : 'connecting...';
    out.push({ id: 'dockhand', title: 'Dockhand', status, meta });
  }
  if ((data.database || []).length) {
    const connecting = data.database.filter(d => d._connecting && !d.online).length;
    const rows = data.database.filter(d => !d._connecting || d.online);
    const up = rows.filter(d => d.online).length;
    out.push({ id: 'database', title: 'Databases', status: !rows.length && connecting ? 'connecting' : up === rows.length && !connecting ? 'ok' : up > 0 ? 'warn' : 'down', meta: !rows.length && connecting ? 'connecting...' : `${up}/${rows.length} up${connecting ? ` · ${connecting} connecting` : ''}` });
  }
  const fw = data.firewall;
  if (fw && fw.online !== undefined) {
    const sm = fw.summary || {};
    const up = Number(sm.up || 0);
    const down = Number(sm.down || 0);
    const updates = Number(sm.updates || 0);
    const reboot = Number(sm.rebootRequired || 0);
    const status = fw._connecting && !fw.online ? 'connecting' : !fw.online || up === 0 ? 'down' : (down > 0 || updates > 0 || reboot > 0 ? 'warn' : 'ok');
    const meta = fw._connecting && !fw.online ? 'connecting...' : fw.online ? `${up}/${sm.instances || 0} gateways · ${sm.interfacesUp || 0}/${sm.interfaces || 0} links` : 'unreachable';
    out.push({ id: 'firewall', title: 'Firewalls', status, meta });
  }
  const tn = data.truenas;
  if (tn && tn.online !== undefined) {
    const sm = tn.summary || {};
    const up = Number(sm.up || 0);
    const down = Number(sm.down || 0);
    const warn = Number(sm.poolsWarn || 0) + Number(sm.disksWarn || 0) + Number(sm.alertsCritical || 0) + Number(sm.alertsWarning || 0);
    const status = tn._connecting && !tn.online ? 'connecting' : !tn.online || up === 0 ? 'down' : (down > 0 || warn > 0 ? 'warn' : 'ok');
    const meta = tn._connecting && !tn.online ? 'connecting...' : tn.online ? `${up}/${sm.instances || 0} systems · ${sm.poolsHealthy || 0}/${sm.pools || 0} pools` : 'unreachable';
    out.push({ id: 'truenas', title: 'TrueNAS', status, meta });
  }
  const qnap = data.qnap;
  if (qnap && qnap.online !== undefined) {
    const sm = qnap.summary || {};
    const up = Number(sm.up || 0);
    const total = Number(sm.instances || (qnap.instances || []).length || 0);
    const status = qnap._connecting && !qnap.online ? 'connecting' : !qnap.online || up === 0 ? 'down' : (up < total ? 'warn' : 'ok');
    const meta = qnap._connecting && !qnap.online ? 'connecting...' : qnap.online ? `${up}/${total} systems` : 'unreachable';
    out.push({ id: 'qnap', title: 'QNAP', status, meta });
  }
  const ugreen = data.ugreen;
  if (ugreen && ugreen.online !== undefined) {
    const sm = ugreen.summary || {};
    const up = Number(sm.up || 0);
    const total = Number(sm.instances || (ugreen.instances || []).length || 0);
    const status = ugreen._connecting && !ugreen.online ? 'connecting' : !ugreen.online || up === 0 ? 'down' : (up < total ? 'warn' : 'ok');
    const meta = ugreen._connecting && !ugreen.online ? 'connecting...' : ugreen.online ? `${up}/${total} systems` : 'unreachable';
    out.push({ id: 'ugreen', title: 'Ugreen', status, meta });
  }
  const pbs = data.pbs;
  if (pbs && pbs.online !== undefined) {
    const sm = pbs.summary || {};
    const up = Number(sm.up || 0);
    const down = Number(sm.down || 0);
    const warn = Number(sm.datastoresWarn || 0) + Number(sm.failedTasks || 0);
    const status = pbs._connecting && !pbs.online ? 'connecting' : !pbs.online || up === 0 ? 'down' : (down > 0 || warn > 0 ? 'warn' : 'ok');
    const meta = pbs._connecting && !pbs.online ? 'connecting...' : pbs.online ? `${up}/${sm.instances || 0} servers · ${sm.datastores || 0} DST` : 'unreachable';
    out.push({ id: 'pbs', title: 'Proxmox Backup', status, meta });
  }
  const cfPublic = data.cloudflare;
  if (cfPublic && cfPublic.online !== undefined) {
    const sm = cfPublic.summary || {};
    const zones = Number(sm.zones || 0);
    const active = Number(sm.zonesActive || 0);
    const zoneWarn = Number(sm.zonesWarn || 0);
    const tunnelsDown = Number(sm.tunnelsDown || 0);
    const domainWarn = Number(sm.domainsExpired || 0) + Number(sm.domainsExpiring || 0);
    const partial = !!cfPublic.partial || Number(sm.errors || 0) > 0;
    const status = cfPublic._connecting && !cfPublic.online ? 'connecting' : !cfPublic.online ? 'down' : (zoneWarn > 0 || tunnelsDown > 0 || domainWarn > 0 || partial ? 'warn' : 'ok');
    const tunnelMeta = Number(sm.tunnels || 0) ? ` - ${sm.tunnelsHealthy || 0}/${sm.tunnels} tunnels` : '';
    const meta = cfPublic._connecting && !cfPublic.online ? 'connecting...' : cfPublic.online ? `${active}/${zones} zones${tunnelMeta}` : 'unreachable';
    out.push({ id: 'cloudflare', title: 'Cloudflare', status, meta });
  }
  const ciPublic = data.cicd;
  if (ciPublic && ciPublic.online !== undefined) {
    const sm = ciPublic.summary || {};
    const up = Number(sm.up || 0);
    const total = Number(sm.projects || (ciPublic.projects || []).length || 0);
    const failed = Number(sm.failed || 0) + Number(sm.jobsFailed || 0);
    const running = Number(sm.running || 0) + Number(sm.jobsRunning || 0);
    const partial = Number(sm.partial || 0) > 0 || (ciPublic.projects || []).some(p => p.partial);
    const status = ciPublic._connecting && !ciPublic.online ? 'connecting' : !ciPublic.online || up === 0 ? 'down' : (failed > 0 || partial ? 'warn' : 'ok');
    const runMeta = running ? ` - ${running} running` : '';
    const meta = ciPublic._connecting && !ciPublic.online ? 'connecting...' : ciPublic.online ? `${up}/${total} projects - ${sm.success || 0}/${sm.pipelines || 0} green${runMeta}` : 'unreachable';
    out.push({ id: 'cicd', title: 'GitHub/GitLab CI', status, meta });
  }
  const veeam = data.veeam;
  if (veeam && veeam.online !== undefined) {
    const sm = veeam.summary || {};
    const up = Number(sm.up || 0);
    const down = Number(sm.down || 0);
    const warn = Number(sm.failedSessions || 0) + Number(sm.warningSessions || 0) + Number(sm.repositoriesWarn || 0) + Number(sm.partial || 0);
    const running = Number(sm.runningSessions || 0);
    const status = veeam._connecting && !veeam.online ? 'connecting' : !veeam.online || up === 0 ? 'down' : (down > 0 || warn > 0 ? 'warn' : 'ok');
    const runMeta = running ? ` - ${running} running` : '';
    const meta = veeam._connecting && !veeam.online ? 'connecting...' : veeam.online ? `${up}/${sm.instances || 0} servers ${sm.failedSessions || 0}/${sm.sessions || 0} failed${runMeta}` : 'unreachable';
    out.push({ id: 'veeam', title: 'Veeam', status, meta });
  }
  const portainer = data.portainer;
  if (portainer && portainer.online !== undefined) {
    const sm = portainer.summary || {};
    const up = Number(sm.up || 0);
    const down = Number(sm.down || 0);
    const warn = Number(sm.environmentsDown || 0) + Number(sm.stacksWarn || 0);
    const status = portainer._connecting && !portainer.online ? 'connecting' : !portainer.online || up === 0 ? 'down' : (down > 0 || warn > 0 ? 'warn' : 'ok');
    const meta = portainer._connecting && !portainer.online ? 'connecting...' : portainer.online ? `${up}/${sm.instances || 0} servers · ${sm.environmentsUp || 0}/${sm.environments || 0} env` : 'unreachable';
    out.push({ id: 'portainer', title: 'Portainer', status, meta });
  }
  return out;
}

app.get('/api/public/status', (req, res) => {
  if (!config.publicStatus) return res.status(404).json({ error: 'public status not enabled' });
  const data = cache.data || EMPTY;
  const showDetails = configFlag(config.publicStatusShowDetails, false);
  const showHistory = configFlag(config.publicStatusShowHistory, false);
  const maintenanceWindow = currentMaintenanceWindow();
  const visible = Array.isArray(config.publicPlatforms) && config.publicPlatforms.length
    ? new Set(config.publicPlatforms.map(String))
    : null;
  const services = buildPublicSummary(data).filter(s => !visible || visible.has(s.id));
  const present = new Set(services.map(s => s.id));
  const titles = { proxmox: 'Proxmox', linux: 'Linux Server', windows: 'Windows Server', kubernetes: 'Kubernetes', synology: 'Synology', mikrotik: 'MikroTik', unifi: 'UniFi', snmp: 'SNMP', healthchecks: 'Healthchecks', uptimekuma: 'Uptime Kuma', checks: 'Service checks', prometheus: 'Prometheus', docker: 'Docker', dockhand: 'Dockhand', database: 'Databases', firewall: 'Firewalls', truenas: 'TrueNAS', qnap: 'QNAP', ugreen: 'Ugreen', pbs: 'Proxmox Backup', cloudflare: 'Cloudflare', cicd: 'GitHub/GitLab CI', veeam: 'Veeam', portainer: 'Portainer' };
  configuredList().forEach(id => {
    if (visible && !visible.has(id)) return;
    if (!present.has(id)) services.push({ id, title: titles[id] || id, status: 'connecting', meta: 'connecting…' });
  });
  services.forEach(s => {
    s.history = showHistory && PLATFORM_HISTORY[s.id] && PLATFORM_HISTORY[s.id].length
      ? PLATFORM_HISTORY[s.id]
      : [];
    if (!showDetails) s.meta = '';
  });
  res.json({
    title: config.publicTitle || 'OmniSight Status',
    description: config.publicDescription || '',
    preferredLanguage: config.preferredLanguage || 'en',
    timestamp: data.timestamp || new Date().toISOString(),
    refreshing: refreshBusy(),
    version: appVersion(),
    historyEnabled: showHistory,
    maintenance: maintenanceWindow ? {
      active: true,
      start: maintenanceWindow.start || maintenanceWindow.from || '',
      end: maintenanceWindow.end || maintenanceWindow.to || '',
      days: maintenanceWindow.days || maintenanceWindow.day || maintenanceWindow.weekdays || '',
    } : { active: false },
    services,
  });
});

app.get('/api/about', (req, res) => {
  res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
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

app.get('/api/update-check', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const updateTtlSeconds = Math.max(60, Math.floor(UPDATE_CHECK_SUCCESS_TTL_MS / 1000));
    res.setHeader('Cache-Control', force ? 'no-store' : `private, max-age=${updateTtlSeconds}, stale-while-revalidate=86400`);
    if (!force) {
      if (updateCheckCache.value) {
        checkForAppUpdate(false).catch(() => {});
        return res.json(updateCheckCache.value);
      }
      checkForAppUpdate(false).catch(() => {});
      return res.json({
        currentVersion: appVersion(),
        latestVersion: null,
        updateAvailable: false,
        checking: true,
        url: 'https://github.com/caglaryalcin/OmniSight/releases',
      });
    }
    res.json(await checkForAppUpdate(true));
  } catch (err) {
    sendServerError(res, err, { currentVersion: appVersion(), updateAvailable: false });
  }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/windows/service', async (req, res) => {
  try {
    const { host, service, action } = req.query;
    if (!['status', 'start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (!SVC_NAME.test(String(host || '')) || !SVC_NAME.test(String(service || ''))) return res.status(400).json({ error: 'invalid host or service' });
    if (!agents.findAgent(host)) return res.status(404).json({ error: 'agent not found' });
    const output = await agents.queueCommand(host, action, service);
    if (action !== 'status') {
      if (cache.data?.windows) {
        const s = cache.data.windows.find(x => x.host === host || x.name === host);
        if (s && s.services) {
          const svc = s.services.find(x => x.name === service);
          if (svc) svc.active = action !== 'stop';
        }
      }
      refreshPromise = null;
      backgroundRefresh();
    }
    res.json({ ok: true, output });
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/dockhand/logs', async (req, res) => {
  try {
    const { instance, id, env } = req.query;
    if (!instance || !id) return res.status(400).json({ error: 'instance and id required' });
    const logs = await dockhandLogs(config.dockhand, instance, id, env);
    res.type('text/plain; charset=utf-8').send(logs || '');
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Kubernetes logs unavailable' });
  }
});

app.get(['/api/portainer/logs', '/api/portainer/container/logs'], async (req, res) => {
  try {
    const { instance, endpoint, id } = req.query;
    if (!instance || !endpoint || !id) return res.status(400).json({ error: 'instance, endpoint and id required' });
    const logs = await portainerLogs(config.portainer, instance, endpoint, id);
    res.type('text/plain; charset=utf-8').send(logs || '');
  } catch (err) { sendServerError(res, err); }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

let shutdownFlushed = false;
function flushPendingDiskWrites() {
  if (shutdownFlushed) return;
  shutdownFlushed = true;
  try { flushRuntimeSnapshotSave(); } catch (e) { console.warn('runtime snapshot flush failed:', e.message); }
  try { flushHistorySaves(); } catch (e) { console.warn('history flush failed:', e.message); }
  try { agents.flushSaves?.(); } catch (e) { console.warn('agents flush failed:', e.message); }
  try { flushAuditLogSave(); } catch (e) { console.warn('audit flush failed:', e.message); }
  try { flushSessionsSave(); } catch (e) { console.warn('sessions flush failed:', e.message); }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    console.warn(`[runtime] received ${sig}; ${diagnosticSnapshot()}`);
    flushPendingDiskWrites();
    process.exit(0);
  });
}
process.once('beforeExit', flushPendingDiskWrites);
process.once('exit', flushPendingDiskWrites);
process.on('unhandledRejection', err => {
  console.error(`Unhandled promise rejection: ${err?.stack || err?.message || err}\n[runtime] ${diagnosticSnapshot()}`);
});
process.on('uncaughtException', err => {
  console.error(`Uncaught exception: ${err?.stack || err?.message || err}\n[runtime] ${diagnosticSnapshot()}`);
});
process.on('warning', warn => {
  console.warn(`Process warning: ${warn?.stack || warn?.message || warn}\n[runtime] ${diagnosticSnapshot()}`);
});

function startRuntimeDiagnostics() {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 1000;
    last = now;
    if (lag >= DIAG_EVENT_LOOP_LAG_MS) {
      warnDiagnostic('runtime:event-loop-lag', `[runtime] event-loop-lag lag=${Math.round(lag)}ms ${diagnosticSnapshot()}`);
    }
  }, 1000);
  timer.unref?.();
}

startRuntimeDiagnostics();

function startDemoAlongsideMain() {
  if (!envFlag('OMNISIGHT_START_DEMO')) return;
  const demoPort = Number(process.env.DEMO_PORT || process.env.OMNISIGHT_DEMO_PORT || 4000);
  if (!Number.isFinite(demoPort) || demoPort <= 0 || String(demoPort) === String(PORT)) return;
  try {
    const demo = require('./demo-server');
    const demoApp = demo.app || demo;
    const demoServer = demoApp.listen(demoPort, () => {
      console.log(`OmniSight demo running at http://localhost:${demoPort}`);
    });
    demoServer.on('error', err => {
      if (err && err.code === 'EADDRINUSE') {
        console.warn(`OmniSight demo port ${demoPort} is already in use; main app continues on ${PORT}.`);
        return;
      }
      console.warn(`OmniSight demo server failed: ${err?.message || err}`);
    });
  } catch (err) {
    console.warn(`OmniSight demo server failed to start: ${err?.message || err}`);
  }
}

const mainServer = app.listen(PORT, () => {
  console.log(`OmniSight running at http://localhost:${PORT}`);
  startDemoAlongsideMain();
});
mainServer.on('error', err => {
  console.error(`[runtime] server error on port ${PORT}: ${err?.stack || err?.message || err}\n[runtime] ${diagnosticSnapshot()}`);
});
mainServer.on('close', () => {
  console.warn(`[runtime] server closed on port ${PORT}; ${diagnosticSnapshot()}`);
});
