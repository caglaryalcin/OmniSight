const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `QNAP ${idx + 1}`).trim();
}

function configuredInstances(config = {}) {
  config = config || {};
  const rows = Array.isArray(config.instances) && config.instances.length
    ? config.instances
    : (config.url ? [config] : []);
  return rows
    .filter(row => row && (row.url || row.name))
    .map((row, idx) => ({ ...row, name: instanceName(row, idx) }));
}

function timeoutMs(inst = {}) {
  const n = Number(inst.timeoutMs || inst.timeout || 10000);
  return Math.max(2000, Math.min(60000, Number.isFinite(n) ? n : 10000));
}

function httpText(url, inst = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, {
      method: opts.method || 'GET',
      headers: { Accept: opts.accept || 'application/json, text/xml, */*' },
      rejectUnauthorized: inst.insecureTLS ? false : undefined,
      timeout: timeoutMs(inst),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > Number(opts.maxBytes || 512 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end();
  });
}

function xmlValue(text, tag) {
  const m = String(text || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return String(m[1] || '')
    .replace(/^<!\[CDATA\[/i, '')
    .replace(/\]\]>$/i, '')
    .trim();
}

function jsonOrXmlValue(text, key) {
  try {
    const data = JSON.parse(text);
    return data?.[key] ?? data?.data?.[key] ?? '';
  } catch {}
  return xmlValue(text, key);
}

async function login(inst = {}) {
  const sid = inst.sid || inst.qsid || inst.token || '';
  if (sid) return String(sid);
  if (!inst.username && !inst.user) throw new Error('QNAP username is required');
  if (!inst.password) throw new Error('QNAP password is required');
  const params = new URLSearchParams({
    user: inst.username || inst.user || '',
    pwd: inst.password || '',
    service: inst.service || '1',
  });
  const body = await httpText(`${cleanBaseUrl(inst.url)}/cgi-bin/authLogin.cgi?${params}`, inst, { accept: 'text/xml, application/json, */*' });
  const authPassed = jsonOrXmlValue(body, 'authPassed');
  const sidValue = jsonOrXmlValue(body, 'authSid') || jsonOrXmlValue(body, 'sid');
  if (String(authPassed) === '1' && sidValue) return String(sidValue);
  if (sidValue) return String(sidValue);
  throw new Error(jsonOrXmlValue(body, 'errorValue') ? `QNAP login failed (${jsonOrXmlValue(body, 'errorValue')})` : 'QNAP login failed');
}

async function checkSid(inst = {}, sid = '') {
  const params = new URLSearchParams({ func: 'check_sid', sid });
  const body = await httpText(`${cleanBaseUrl(inst.url)}/cgi-bin/filemanager/utilRequest.cgi?${params}`, inst);
  let data = {};
  try { data = JSON.parse(body); } catch {}
  const ok = data.status === 1 || data.status === '1' || data.success === true || data.success === 'true';
  return {
    ok: ok || /success|server_name|hostname/i.test(body),
    serverName: data.server_name || data.hostname || jsonOrXmlValue(body, 'server_name') || '',
    rawStatus: data.status ?? '',
  };
}

function summarize(instances = []) {
  return {
    instances: instances.length,
    up: instances.filter(i => i.online).length,
    down: instances.filter(i => !i.online).length,
  };
}

async function getQnapInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  if (!inst.url) throw new Error('QNAP URL is required');
  const sid = await login(inst);
  const checked = await checkSid(inst, sid);
  if (!checked.ok) throw new Error('QNAP session check failed');
  return {
    online: true,
    name: inst.name,
    url: inst.url,
    system: { hostname: checked.serverName || inst.name },
    summary: summarize([{ online: true }]),
    partial: false,
  };
}

async function getAllQnapData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) return { online: false, error: 'No QNAP instances configured', summary: summarize([]), instances: [] };
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 3), async (inst, idx) => {
    try { return await getQnapInstance(inst, idx); }
    catch (err) {
      return { online: false, name: inst.name, url: inst.url || '', error: err.message, system: {}, summary: summarize([]) };
    }
  });
  const summary = summarize(rows);
  return { online: summary.up > 0, error: rows.find(r => !r.online)?.error || '', summary, instances: rows };
}

module.exports = { getAllQnapData, configuredInstances };
