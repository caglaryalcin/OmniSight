const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

let WsClient = null;
try { WsClient = require('ws'); } catch {}

function cleanBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `TrueNAS ${idx + 1}`).trim();
}

function configuredInstances(config = {}) {
  config = config || {};
  const rows = Array.isArray(config.instances) && config.instances.length
    ? config.instances
    : (config.url ? [config] : []);
  return rows
    .filter(row => row && (row.url || row.name))
    .map((row, idx) => ({
      ...row,
      name: instanceName(row, idx),
      apiMode: String(row.apiMode || row.mode || config.apiMode || config.mode || 'auto').toLowerCase(),
    }));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, keys) {
  for (const key of keys) {
    const parts = String(key).split('.');
    let cur = obj;
    for (const part of parts) cur = cur && cur[part] != null ? cur[part] : undefined;
    if (cur != null && cur !== '') return cur;
  }
  return null;
}

function percentFromPair(used, total) {
  used = num(used);
  total = num(total);
  if (used == null || total == null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10));
}

function bearer(inst = {}) {
  return inst.apiKey || inst.apiToken || inst.token || inst.bearerToken || '';
}

function timeoutMs(inst = {}) {
  const n = Number(inst.timeoutMs || inst.timeout || 10000);
  return Math.max(2000, Math.min(60000, Number.isFinite(n) ? n : 10000));
}

function restUrl(base, path) {
  return `${cleanBaseUrl(base)}/api/v2.0/${String(path || '').replace(/^\/+/, '')}`;
}

function httpJson(url, inst = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const token = bearer(inst);
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.request(parsed, {
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: inst.insecureTLS ? false : undefined,
      timeout: timeoutMs(inst),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > Number(opts.maxBytes || 2 * 1024 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        }
        if (!data.trim()) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from TrueNAS API')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

async function optionalRest(inst, paths) {
  const errors = [];
  for (const path of paths) {
    try { return { ok: true, path, data: await httpJson(restUrl(inst.url, path), inst) }; }
    catch (err) { errors.push(`${path}: ${err.message}`); }
  }
  return { ok: false, error: errors[0] || 'not available' };
}

function websocketUrl(inst = {}) {
  if (inst.websocketUrl || inst.wsUrl) return String(inst.websocketUrl || inst.wsUrl).trim();
  const parsed = new URL(cleanBaseUrl(inst.url));
  parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:';
  parsed.pathname = String(inst.websocketPath || inst.wsPath || '/api/current');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function createWs(url, inst = {}) {
  if (WsClient) {
    return new WsClient(url, {
      rejectUnauthorized: inst.insecureTLS ? false : undefined,
      handshakeTimeout: timeoutMs(inst),
    });
  }
  if (typeof WebSocket === 'function') return new WebSocket(url);
  throw new Error('WebSocket client is not available');
}

function createJsonRpc(inst = {}) {
  const url = websocketUrl(inst);
  const ws = createWs(url, inst);
  const pending = new Map();
  let nextId = 1;
  let opened = false;

  const failAll = err => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(err);
    }
    pending.clear();
  };

  ws.onopen = () => { opened = true; };
  ws.onerror = err => {
    if (!opened) failAll(new Error(err?.message || 'WebSocket connection failed'));
  };
  ws.onclose = event => {
    failAll(new Error(event?.reason || 'WebSocket closed'));
  };
  ws.onmessage = event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const item = pending.get(msg.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(msg.id);
    if (msg.error) item.reject(new Error(msg.error.message || msg.error.reason || 'JSON-RPC error'));
    else item.resolve(msg.result);
  };
  if (typeof ws.on === 'function') {
    ws.on('open', () => { opened = true; });
    ws.on('error', err => { if (!opened) failAll(err); });
    ws.on('close', (_code, reason) => failAll(new Error(reason?.toString?.() || 'WebSocket closed')));
    ws.on('message', data => ws.onmessage({ data: data.toString() }));
  }

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket timeout')), timeoutMs(inst));
    const done = err => {
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    if (typeof ws.once === 'function') {
      ws.once('open', () => done());
      ws.once('error', done);
    } else {
      const prevOpen = ws.onopen;
      const prevErr = ws.onerror;
      ws.onopen = event => { prevOpen?.(event); done(); };
      ws.onerror = event => { prevErr?.(event); done(new Error(event?.message || 'WebSocket connection failed')); };
    }
  });

  return {
    async call(method, params = []) {
      await ready;
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timeout`));
        }, timeoutMs(inst));
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    },
    close() {
      try { ws.close(); } catch {}
      failAll(new Error('closed'));
    },
  };
}

async function authenticateRpc(rpc, inst = {}) {
  const key = bearer(inst);
  const username = inst.username || inst.user || '';
  const password = inst.password || '';
  if (username && key) {
    try {
      await rpc.call('auth.login_ex', [{
        mechanism: 'API_KEY_PLAIN',
        username,
        api_key: key,
        login_options: { user_info: false, reconnect_token: false },
      }]);
      return;
    } catch (err) {
      if (!/not found|method/i.test(err.message)) throw err;
    }
  }
  if (username && password) {
    try {
      await rpc.call('auth.login_ex', [{
        mechanism: 'PASSWORD_PLAIN',
        username,
        password,
        login_options: { user_info: false, reconnect_token: false },
      }]);
      return;
    } catch (err) {
      if (!/not found|method|invalid params|argument/i.test(err.message)) throw err;
    }
    const ok = await rpc.call('auth.login', [username, password]);
    if (ok === false) throw new Error('Username/password rejected');
    return;
  }
  if (key) {
    try {
      const ok = await rpc.call('auth.login_with_api_key', [key]);
      if (ok === false) throw new Error('API key rejected');
      return;
    } catch (err) {
      if (!/not found|method/i.test(err.message)) throw err;
    }
    await rpc.call('auth.login_ex', [{
      mechanism: 'API_KEY',
      api_key: key,
      login_options: { user_info: false, reconnect_token: false },
    }]);
  }
}

async function optionalRpc(rpc, method, params = []) {
  try { return { ok: true, method, data: await rpc.call(method, params) }; }
  catch (err) { return { ok: false, error: `${method}: ${err.message}` }; }
}

function arr(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function normalizeSystem(info = {}) {
  return {
    hostname: pick(info, ['hostname', 'system_product', 'system_serial']) || '',
    version: pick(info, ['version', 'buildtime.version']) || '',
    model: pick(info, ['model', 'system_product']) || '',
    cores: num(pick(info, ['cores', 'physical_cores'])),
    uptimeSeconds: num(pick(info, ['uptime_seconds'])),
    uptime: pick(info, ['uptime']) || null,
    memoryTotalBytes: num(pick(info, ['physmem', 'memory.physmem'])),
    loadavg: Array.isArray(info.loadavg) ? info.loadavg.slice(0, 3).map(num).filter(v => v != null) : [],
  };
}

function poolBytes(row = {}) {
  const total = pick(row, ['size', 'total_size', 'root_dataset.quota.value']);
  const free = pick(row, ['free', 'freeing', 'available', 'root_dataset.available.value']);
  const used = pick(row, ['allocated', 'used', 'root_dataset.used.value']);
  const totalBytes = num(total) || (num(used) != null && num(free) != null ? num(used) + num(free) : null);
  const usedBytes = num(used) != null ? num(used) : (totalBytes != null && num(free) != null ? totalBytes - num(free) : null);
  return { totalBytes, usedBytes, freeBytes: num(free), usedPercent: percentFromPair(usedBytes, totalBytes) };
}

function normalizePool(row = {}) {
  const status = String(pick(row, ['status', 'healthy']) || '').toUpperCase();
  const health = status === 'ONLINE' || status === 'HEALTHY' || row.healthy === true ? 'online'
    : ['DEGRADED', 'REMOVED', 'UNKNOWN'].includes(status) ? 'warn'
    : ['OFFLINE', 'FAULTED', 'UNAVAIL', 'UNAVAILABLE'].includes(status) ? 'down'
    : status ? 'warn' : 'unknown';
  return {
    name: row.name || row.id || 'pool',
    status: status || (row.healthy === true ? 'ONLINE' : ''),
    health,
    encrypted: row.encrypt || row.encrypted || false,
    scan: pick(row, ['scan.state', 'scan.function', 'scrub.status']) || '',
    ...poolBytes(row),
  };
}

function normalizeDisk(row = {}) {
  const status = String(pick(row, ['status', 'state']) || '').toUpperCase();
  const temp = num(pick(row, ['temperature', 'temp', 'hddtemp']));
  const health = ['ONLINE', 'UP', 'ACTIVE', 'HEALTHY'].includes(status) || (!status && row.exported_zpool)
    ? 'online'
    : ['DEGRADED', 'UNKNOWN'].includes(status) ? 'warn'
    : ['OFFLINE', 'FAILED', 'FAULTED', 'UNAVAIL'].includes(status) ? 'down'
    : temp != null && temp >= 55 ? 'warn' : status ? 'warn' : 'unknown';
  return {
    name: row.name || row.devname || row.identifier || row.serial_lunid || 'disk',
    model: row.model || '',
    type: row.type || '',
    sizeBytes: num(row.size),
    temperature: temp,
    status,
    health,
    pool: row.exported_zpool || row.pool || '',
  };
}

function normalizeAlerts(alerts) {
  return arr(alerts).filter(a => !a.dismissed).map(a => ({
    level: String(a.level || a.klass || a.severity || '').toLowerCase(),
    title: a.formatted || a.text || a.title || a.klass || 'Alert',
  })).slice(0, 20);
}

function summarize(instances) {
  const pools = instances.flatMap(i => i.pools || []);
  const disks = instances.flatMap(i => i.disks || []);
  const alerts = instances.flatMap(i => i.alerts || []);
  const totalBytes = pools.reduce((a, p) => a + Number(p.totalBytes || 0), 0);
  const usedBytes = pools.reduce((a, p) => a + Number(p.usedBytes || 0), 0);
  return {
    instances: instances.length,
    up: instances.filter(i => i.online).length,
    down: instances.filter(i => !i.online).length,
    pools: pools.length,
    poolsHealthy: pools.filter(p => p.health === 'online').length,
    poolsWarn: pools.filter(p => p.health !== 'online').length,
    disks: disks.length,
    disksWarn: disks.filter(d => d.health !== 'online' && d.health !== 'unknown').length,
    alertsCritical: alerts.filter(a => ['critical', 'alert', 'emergency'].includes(a.level)).length,
    alertsWarning: alerts.filter(a => ['warning', 'warn'].includes(a.level)).length,
    totalBytes,
    usedBytes,
    usedPercent: percentFromPair(usedBytes, totalBytes),
  };
}

function finishInstance(inst, raw = {}, apiMode = 'websocket') {
  const system = normalizeSystem(raw.system?.data || raw.system || {});
  const pools = arr(raw.pools?.data || raw.pools).map(normalizePool).filter(p => p.name);
  const disks = arr(raw.disks?.data || raw.disks).map(normalizeDisk).filter(d => d.name);
  const alerts = normalizeAlerts(raw.alerts?.data || raw.alerts);
  const errors = [raw.system, raw.pools, raw.disks, raw.alerts, raw.update]
    .filter(r => r && r.ok === false)
    .map(r => r.error)
    .filter(Boolean);
  const sm = summarize([{ online: true, pools, disks, alerts }]);
  return {
    online: true,
    apiMode,
    name: inst.name,
    url: inst.url,
    system,
    pools,
    disks,
    alerts,
    update: raw.update?.ok ? raw.update.data : null,
    summary: sm,
    partial: errors.length > 0,
    errors: errors.slice(0, 5),
  };
}

async function getRpcInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  const rpc = createJsonRpc(inst);
  try {
    await authenticateRpc(rpc, inst);
    const [system, pools, disks, alerts, update] = await Promise.all([
      optionalRpc(rpc, 'system.info'),
      optionalRpc(rpc, 'pool.query', []),
      optionalRpc(rpc, 'disk.query', []),
      optionalRpc(rpc, 'alert.list'),
      optionalRpc(rpc, 'update.status'),
    ]);
    if (!system.ok && !pools.ok) throw new Error(system.error || pools.error || 'TrueNAS API unavailable');
    return finishInstance(inst, { system, pools, disks, alerts, update }, 'websocket');
  } finally {
    rpc.close();
  }
}

async function getRestInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  const [system, pools, disks, alerts, update] = await Promise.all([
    optionalRest(inst, ['system/info']),
    optionalRest(inst, ['pool']),
    optionalRest(inst, ['disk']),
    optionalRest(inst, ['alert/list', 'alert']),
    optionalRest(inst, ['update/status']),
  ]);
  if (!system.ok && !pools.ok) throw new Error(system.error || pools.error || 'TrueNAS REST API unavailable');
  return finishInstance(inst, { system, pools, disks, alerts, update }, 'rest');
}

async function getTrueNasInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx), apiMode: String(config.apiMode || 'auto').toLowerCase() };
  if (!inst.url) throw new Error('TrueNAS URL is required');
  const mode = ['websocket', 'ws', 'jsonrpc'].includes(inst.apiMode) ? 'websocket'
    : ['rest', 'v2'].includes(inst.apiMode) ? 'rest'
    : 'auto';
  try {
    if (mode === 'rest') return await getRestInstance(inst, idx);
    return await getRpcInstance(inst, idx);
  } catch (err) {
    if (mode === 'auto') {
      try {
        const row = await getRestInstance(inst, idx);
        return { ...row, errors: [`websocket: ${err.message}`, ...(row.errors || [])].slice(0, 5), partial: true };
      } catch (restErr) {
        throw new Error(`${err.message}; REST fallback: ${restErr.message}`);
      }
    }
    throw err;
  }
}

async function getAllTrueNasData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) {
    return { online: false, error: 'No TrueNAS instances configured', summary: summarize([]), instances: [] };
  }
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 3), async (inst, idx) => {
    try {
      return await getTrueNasInstance(inst, idx);
    } catch (err) {
      return {
        online: false,
        apiMode: inst.apiMode || 'auto',
        name: inst.name,
        url: inst.url || '',
        error: err.message,
        system: {},
        pools: [],
        disks: [],
        alerts: [],
        summary: summarize([]),
      };
    }
  });
  const summary = summarize(rows);
  const firstError = rows.find(r => !r.online)?.error || '';
  return { online: summary.up > 0, error: firstError, summary, instances: rows };
}

module.exports = { getAllTrueNasData, configuredInstances };
