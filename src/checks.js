const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const childProcess = require('child_process');
const { loadHistoryMap, scheduleSaveHistoryMap } = require('./historyStore');

const CHECK_HISTORY_MAX = 5760;
const checkHistory = loadHistoryMap('checks-history', CHECK_HISTORY_MAX);

function timeoutMs(check) {
  const n = Number(check.timeoutMs || check.timeout || 5000);
  return Math.max(1000, Math.min(30000, Number.isFinite(n) ? n : 5000));
}

function targetOf(check) {
  return String(check.target || check.url || check.host || check.name || '').trim();
}

function msSince(start) {
  return Math.max(0, Date.now() - start);
}

function okStatus(code, check) {
  if (Array.isArray(check.statusCodes) && check.statusCodes.length) return check.statusCodes.map(Number).includes(Number(code));
  if (check.expectedStatus !== undefined && check.expectedStatus !== '') return Number(code) === Number(check.expectedStatus);
  const min = Number(check.statusMin || 200);
  const max = Number(check.statusMax || 399);
  return Number(code) >= min && Number(code) <= max;
}

function normalizeHttpTargets(check) {
  const raw = targetOf(check);
  if (/^https?:\/\//i.test(raw)) return [raw];
  if (String(check.type || '').toLowerCase() === 'https') return [`https://${raw}`];
  return [`http://${raw}`, `https://${raw}`];
}

function probeHttpUrl(check, url) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('invalid URL')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('only HTTP(S) URLs are supported'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: check.method || 'GET',
      headers: check.headers || {},
      rejectUnauthorized: check.insecureTLS ? false : undefined,
    }, res => {
      res.resume();
      res.on('end', () => {
        const statusCode = Number(res.statusCode || 0);
        if (!okStatus(statusCode, check)) return reject(new Error(`HTTP ${statusCode}`));
        resolve({ responseMs: msSince(start), statusCode });
      });
    });
    req.setTimeout(timeoutMs(check), () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function probeHttp(check) {
  const urls = normalizeHttpTargets(check);
  let lastErr;
  for (const url of urls) {
    try {
      const result = await probeHttpUrl(check, url);
      return { ...result, url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('HTTP check failed');
}

function probeTcp(check) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const { host, port } = tcpTarget(check);
    if (!host || !port) return reject(new Error('host and port are required'));
    const socket = net.createConnection({ host, port, timeout: timeoutMs(check) });
    socket.once('connect', () => {
      socket.destroy();
      resolve({ responseMs: msSince(start), target: host, host, port });
    });
    socket.once('timeout', () => socket.destroy(new Error('timeout')));
    socket.once('error', reject);
  });
}

function tcpTarget(check) {
  const raw = targetOf(check);
  let host = raw;
  let port = Number(check.port) || 0;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const u = new URL(raw);
    host = u.hostname;
    port = Number(u.port) || port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0);
  } else if (!port) {
    const ipv6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
    const hostPort = raw.match(/^([^:]+):(\d+)$/);
    if (ipv6) {
      host = ipv6[1];
      port = Number(ipv6[2]);
    } else if (hostPort) {
      host = hostPort[1];
      port = Number(hostPort[2]);
    }
  }
  host = String(host || '').replace(/^\[|\]$/g, '').split('/')[0].trim();
  return { host, port };
}

async function probeDns(check) {
  const start = Date.now();
  const host = targetOf(check);
  if (!host) throw new Error('host is required');
  const recordType = String(check.recordType || 'A').toUpperCase();
  const records = recordType === 'LOOKUP'
    ? [await dns.lookup(host)]
    : await dns.resolve(host, recordType);
  if (!records || !records.length) throw new Error('no records');
  return { responseMs: msSince(start), records: records.length };
}

function pingErrorMessage(stderr = '', stdout = '', err = null) {
  const text = [stderr, stdout, err?.message].filter(Boolean).join('\n');
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const combined = lines.join('\n');
  if (/permission denied|operation not permitted|are you root/i.test(combined)) {
    return 'ping permission denied (NET_RAW capability/root required)';
  }
  if (/100%\s*packet loss|0\s+(?:packets\s+)?received|request timed out/i.test(combined)) {
    return 'ping timeout/no reply';
  }
  const useful = lines.find(line => !/^PING\b/i.test(line) && !/^---/.test(line) && !/^\d+\s+packets?\s+transmitted/i.test(line));
  return useful || err?.message || 'ping failed';
}

function probePing(check) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const host = targetOf(check);
    if (!host) return reject(new Error('host is required'));
    const timeout = timeoutMs(check);
    const args = process.platform === 'win32'
      ? ['-n', '1', '-w', String(timeout), host]
      : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeout / 1000))), host];
    childProcess.execFile('ping', args, { timeout: timeout + 1000 }, (err, stdout = '', stderr = '') => {
      if (err) return reject(new Error(pingErrorMessage(stderr, stdout, err)));
      const text = stdout.toString();
      const m = text.match(/time[=<]\s*([\d.]+)\s*ms/i);
      resolve({ responseMs: m ? Number(m[1]) : msSince(start) });
    });
  });
}

async function probeCheck(check) {
  const type = String(check.type || 'http').toLowerCase();
  const name = String(check.name || check.target || check.host || 'check').trim();
  const started = Date.now();
  try {
    let extra;
    if (type === 'http' || type === 'https') extra = await probeHttp(check);
    else if (type === 'tcp') extra = await probeTcp(check);
    else if (type === 'dns') extra = await probeDns(check);
    else if (type === 'ping' || type === 'icmp') extra = await probePing(check);
    else throw new Error(`unsupported check type: ${type}`);
    return {
      name,
      type,
      target: targetOf(check),
      port: check.port || null,
      status: 'up',
      healthy: true,
      responseMs: extra.responseMs ?? msSince(started),
      lastCheck: new Date().toISOString(),
      ...extra,
    };
  } catch (err) {
    return {
      name,
      type,
      target: targetOf(check),
      port: check.port || null,
      status: 'down',
      healthy: false,
      responseMs: null,
      lastCheck: new Date().toISOString(),
      error: err.message,
    };
  }
}

function historyKey(check = {}, result = {}) {
  return [
    result.name || check.name || check.target || check.host || 'check',
    result.type || check.type || 'http',
    result.target || targetOf(check),
    result.port || check.port || '',
  ].map(v => String(v || '').toLowerCase().trim()).join('|');
}

function attachHistory(check, result) {
  const key = historyKey(check, result);
  const hist = checkHistory.get(key) || [];
  hist.push({
    time: result.lastCheck || new Date().toISOString(),
    status: result.status || 'unknown',
    ping: result.responseMs ?? null,
    message: result.error || (result.statusCode ? `HTTP ${result.statusCode}` : ''),
  });
  if (hist.length > CHECK_HISTORY_MAX) hist.splice(0, hist.length - CHECK_HISTORY_MAX);
  checkHistory.set(key, hist);
  scheduleSaveHistoryMap('checks-history', checkHistory, CHECK_HISTORY_MAX);
  return { ...result, history: [...hist] };
}

async function getAllChecks(config = {}) {
  const list = Array.isArray(config.services) ? config.services : Array.isArray(config.checks) ? config.checks : [];
  const results = await Promise.allSettled(list.map(probeCheck));
  const checks = results.map((r, i) => {
    const result = r.status === 'fulfilled'
      ? r.value
      : {
        name: list[i]?.name || list[i]?.target || 'check',
        type: list[i]?.type || 'http',
        target: targetOf(list[i] || {}),
        status: 'down',
        healthy: false,
        responseMs: null,
        lastCheck: new Date().toISOString(),
        error: r.reason?.message || 'check failed',
      };
    return attachHistory(list[i] || {}, result);
  });
  const up = checks.filter(c => c.status === 'up').length;
  return {
    online: true,
    summary: { total: checks.length, up, down: checks.length - up },
    checks,
  };
}

module.exports = { getAllChecks };
