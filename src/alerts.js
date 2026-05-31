const http = require('http');
const https = require('https');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

function httpRequest(urlStr, { method = 'POST', headers = {}, body = null, timeout = 9000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, rejectUnauthorized: false }, res => {
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
  if (!cfg || !cfg.topic) throw new Error('ntfy: topic missing');
  const base = (cfg.url || 'https://ntfy.sh').replace(/\/$/, '');
  const safeTitle = String(alert.title || 'OmniSight').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim() || 'OmniSight';
  const headers = {
    'Title': safeTitle,
    'Priority': String(alert.priority || cfg.priority || 'default'),
  };
  if (alert.tags) headers['Tags'] = alert.tags;
  if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
  else if (cfg.username) headers['Authorization'] = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
  return httpRequest(`${base}/${cfg.topic}`, { headers, body: alert.message || '' });
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

const CHANNELS = { ntfy: sendNtfy, telegram: sendTelegram, smtp: sendSmtp };

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

module.exports = { dispatchAlert };
