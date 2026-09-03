const http = require('http');
const https = require('https');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

function httpRequest(urlStr, { method = 'POST', headers = {}, body = null, timeout = 9000, insecureTLS = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, rejectUnauthorized: insecureTLS ? false : undefined }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 150)}`));
        resolve({ status: res.statusCode, body: d });
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function sendNtfy(cfg, alert) {
  const topic = cfg?.topic || (Array.isArray(cfg?.topics) ? cfg.topics[0] : '');
  if (!cfg || !topic) throw new Error('ntfy: topic missing');
  const base = (cfg.url || 'https://ntfy.sh').replace(/\/$/, '');
  const rawTitle = String(alert.title || 'OmniSight').replace(/^\[from OmniSight\]\s*/i, '').trim();
  const safeTitle = `[from OmniSight] ${rawTitle || 'OmniSight'}`.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim() || '[from OmniSight] OmniSight';
  const rawMessage = String(alert.message || '');
  const message = /^\[from OmniSight\]/i.test(rawMessage) ? rawMessage : `[from OmniSight]\n${rawMessage}`;
  const headers = {
    'Title': safeTitle,
    'Priority': String(alert.priority || cfg.priority || 'default'),
  };
  if (alert.tags) headers['Tags'] = alert.tags;
  if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
  else if (cfg.username) headers['Authorization'] = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
  return httpRequest(`${base}/${topic}`, { headers, body: message, insecureTLS: cfg.insecureTLS === true });
}

async function sendTelegram(cfg, alert) {
  if (!cfg || !cfg.botToken || !cfg.chatId) throw new Error('telegram: botToken/chatId missing');
  const text = (alert.title ? `*${alert.title}*\n` : '') + (alert.message || '');
  const body = JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true });
  return httpRequest(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    headers: { 'Content-Type': 'application/json' }, body,
  });
}

async function sendSmtp(cfg, alert) {
  if (!cfg || !cfg.host || !cfg.to) throw new Error('smtp: host/to missing');
  if (!nodemailer) throw new Error('nodemailer not installed (run: npm install)');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port || 587,
    secure: cfg.secure === true,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    tls: { rejectUnauthorized: cfg.rejectUnauthorized !== false },
  });
  await transport.sendMail({
    from: cfg.from || cfg.user,
    to: Array.isArray(cfg.to) ? cfg.to.join(',') : cfg.to,
    subject: alert.title || 'OmniSight alert',
    text: alert.message || '',
  });
  return { status: 'sent' };
}

async function sendMattermost(cfg, alert) {
  if (!cfg || !cfg.webhookUrl) throw new Error('mattermost: webhookUrl missing');
  const title = String(alert.title || '').trim();
  const message = String(alert.message || '').trim();
  const text = (title ? `**${title}**\n` : '') + message;
  const payload = { text: text || 'OmniSight alert' };
  if (cfg.channel) payload.channel = cfg.channel;
  payload.username = cfg.username || 'OmniSight';
  if (cfg.iconUrl) payload.icon_url = cfg.iconUrl;
  return httpRequest(cfg.webhookUrl, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    insecureTLS: cfg.insecureTLS === true,
  });
}

function serverUpdateNotificationsEnabled(alertConfig = {}) {
  return alertConfig?.detections?.serverUpdates === true;
}

function buildServerUpdateDetections(data = {}) {
  const detections = [];
  const append = (servers, keyPrefix, labelPrefix, options = {}) => {
    if (!Array.isArray(servers)) return;
    servers.forEach(server => {
      const online = typeof options.online === 'function' ? options.online(server) : server?.online;
      if (!server || server._connecting || !online || !server.updates || typeof server.updates !== 'object') return;
      const rawCount = server.updates.count;
      if (rawCount === null || rawCount === undefined || rawCount === '') return;
      const parsedCount = Number(rawCount);
      if (!Number.isFinite(parsedCount) || parsedCount < 0) return;
      const name = String(typeof options.name === 'function'
        ? options.name(server)
        : (server.name || server.host || server.id || '')).trim();
      if (!name) return;
      const count = Math.floor(parsedCount);
      const key = typeof keyPrefix === 'function'
        ? keyPrefix(server, name)
        : `${keyPrefix}:${name}:updates`;
      detections.push({
        key,
        ok: count === 0,
        label: `${labelPrefix} ${name}`,
        detail: `${count} operating system update${count === 1 ? '' : 's'} available`,
        kind: 'updates',
        severity: count > 0 ? 'warning' : 'normal',
        metric: 'updates',
        value: count,
      });
    });
  };
  append(data.linux, 'lx', 'Linux server');
  append(data.windows, 'win', 'Windows server');
  append(data.proxmox?.nodes, (node, name) => {
    const clusterName = String(node.clusterName || '').trim();
    const scope = clusterName ? `${clusterName}:${name}` : name;
    return `px:${scope}:updates`;
  }, 'Proxmox node', {
    online: node => node?.node?.online,
    name: node => node?.node?.name || node?.name || node?.host || node?.id || '',
  });
  return detections;
}

const STICKY_ALERT_KEYS = new Set([
  'cloudflare-domains-expired',
  'cloudflare-domains-expiring',
]);

function isStickyAlertKey(key) {
  return STICKY_ALERT_KEYS.has(String(key || '').trim());
}

function alertDeliverySucceeded(entry = {}) {
  if (entry.status === 'sent') return true;
  return Array.isArray(entry.channels) && entry.channels.some(result => result && result.ok && result.channel !== 'webhook');
}

function rebuildStickyAlertState(history = []) {
  const active = new Map();
  for (const entry of Array.isArray(history) ? history : []) {
    const key = String(entry?.key || '').trim();
    if (!isStickyAlertKey(key)) continue;
    const type = String(entry?.type || '').trim().toLowerCase();
    if (type === 'recovery') {
      active.delete(key);
      continue;
    }
    if (type === 'problem' && alertDeliverySucceeded(entry)) {
      active.set(key, String(entry.severity || 'critical'));
    }
  }
  return active;
}

function resolveStickyAlertState(document, history = []) {
  const stored = document && document.version === 1 && document.active
    && typeof document.active === 'object' && !Array.isArray(document.active);
  if (!stored) return rebuildStickyAlertState(history);
  const active = new Map();
  for (const [key, severity] of Object.entries(document.active)) {
    if (!isStickyAlertKey(key)) continue;
    const normalized = String(severity || '').trim();
    if (normalized) active.set(key, normalized);
  }
  return active;
}

function stickyAlertStateDocument(state) {
  const active = {};
  if (state instanceof Map) {
    for (const [key, severity] of state) {
      if (!isStickyAlertKey(key)) continue;
      const normalized = String(severity || '').trim();
      if (normalized) active[key] = normalized;
    }
  }
  return { version: 1, active };
}

function stickyAlertDispatchIsCurrent(key, episodeRevision, currentRevision) {
  if (!isStickyAlertKey(key)) return true;
  const dispatched = Number(episodeRevision);
  const current = Number(currentRevision);
  return Number.isFinite(dispatched) && dispatched > 0 && dispatched === current;
}

function alertDeliveryCooldownEnabled(key) {
  return !isStickyAlertKey(key);
}

function notificationKeyCandidates(key) {
  const raw = String(key || '').trim();
  if (!raw) return [];
  const candidates = [];
  const add = value => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  add(raw);
  let current = raw;
  while (current.includes(':')) {
    current = current.slice(0, current.lastIndexOf(':'));
    add(current);
  }
  if (raw.startsWith('cloudflare-')) add('cloudflare');
  return candidates;
}

function buildCloudflareDomainDetections(cloudflare = {}) {
  if (cloudflare.registrarDomainsAuthoritative !== true) return [];
  const summary = cloudflare.summary || {};
  const expired = Math.max(0, Math.floor(Number(summary.domainsExpired) || 0));
  const expiring = Math.max(0, Math.floor(Number(summary.domainsExpiring) || 0));
  return [
    {
      key: 'cloudflare-domains-expired',
      ok: expired === 0,
      label: 'Cloudflare domains',
      detail: expired === 0 ? 'no domains expired' : `${expired} domain(s) expired`,
    },
    {
      key: 'cloudflare-domains-expiring',
      ok: expiring === 0,
      label: 'Cloudflare domains',
      detail: expiring === 0 ? 'no domains expiring soon' : `${expiring} domain(s) expiring soon`,
    },
  ];
}

function shouldDispatchProblem(activeSeverity, nextSeverity) {
  return !activeSeverity || activeSeverity !== nextSeverity;
}

function clearAlertCooldownsForType(cooldowns, type, key) {
  if (!(cooldowns instanceof Map) || !type || !key) return 0;
  const prefix = `${type}|${key}|`;
  let cleared = 0;
  for (const signature of Array.from(cooldowns.keys())) {
    if (!String(signature).startsWith(prefix)) continue;
    cooldowns.delete(signature);
    cleared += 1;
  }
  return cleared;
}

const CHANNELS = { ntfy: sendNtfy, telegram: sendTelegram, smtp: sendSmtp, mattermost: sendMattermost };

async function dispatchAlert(alertConfig, alert, only) {
  if (!alertConfig || alertConfig.enabled === false) return [];
  const jobs = [];
  for (const name of Object.keys(CHANNELS)) {
    if (only && name !== only) continue;
    const cfg = alertConfig[name];
    if (cfg && cfg.enabled !== false) jobs.push([name, CHANNELS[name](cfg, alert)]);
  }
  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  return settled.map((r, i) => ({
    channel: jobs[i][0],
    ok: r.status === 'fulfilled',
    error: r.reason ? r.reason.message : undefined,
  }));
}

module.exports = {
  dispatchAlert,
  serverUpdateNotificationsEnabled,
  buildServerUpdateDetections,
  isStickyAlertKey,
  alertDeliverySucceeded,
  rebuildStickyAlertState,
  resolveStickyAlertState,
  stickyAlertStateDocument,
  stickyAlertDispatchIsCurrent,
  alertDeliveryCooldownEnabled,
  notificationKeyCandidates,
  buildCloudflareDomainDetections,
  shouldDispatchProblem,
  clearAlertCooldownsForType,
};
