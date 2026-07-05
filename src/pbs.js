const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `PBS ${idx + 1}`).trim();
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

function apiPath(path) {
  const p = String(path || '').replace(/^\/+/, '');
  return p.startsWith('api2/json/') ? `/${p}` : `/api2/json/${p}`;
}

function tokenParts(inst = {}) {
  const full = inst.token || inst.apiToken || '';
  if (full && String(full).includes(':')) {
    const [id, ...rest] = String(full).split(':');
    return { id, secret: rest.join(':') };
  }
  return {
    id: inst.tokenId || inst.apiTokenId || inst.apiKey || '',
    secret: inst.tokenSecret || inst.apiSecret || inst.secret || '',
  };
}

function headersFor(inst = {}, session = {}, extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  const token = tokenParts(inst);
  if (token.id && token.secret) headers.Authorization = `PBSAPIToken=${token.id}:${token.secret}`;
  else if (session.ticket) headers.Cookie = `PBSAuthCookie=${encodeURIComponent(session.ticket)}`;
  return headers;
}

function httpJson(url, inst = {}, opts = {}, session = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = headersFor(inst, session, opts.headers || {});
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
        catch { reject(new Error('Invalid JSON from PBS API')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

async function loginSession(inst = {}) {
  const token = tokenParts(inst);
  if (token.id && token.secret) return {};
  if (!inst.username || !inst.password) return {};
  const body = new URLSearchParams({ username: inst.username, password: inst.password }).toString();
  const res = await httpJson(cleanBaseUrl(inst.url) + apiPath('access/ticket'), inst, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  const data = res.data || res;
  return { ticket: data.ticket || '', csrf: data.CSRFPreventionToken || '' };
}

async function call(inst, path, session) {
  const res = await httpJson(cleanBaseUrl(inst.url) + apiPath(path), inst, {}, session);
  return res && Object.prototype.hasOwnProperty.call(res, 'data') ? res.data : res;
}

async function optionalCall(inst, paths, session) {
  const errors = [];
  for (const path of paths) {
    try { return { ok: true, path, data: await call(inst, path, session) }; }
    catch (err) { errors.push(`${path}: ${err.message}`); }
  }
  return { ok: false, error: errors[0] || 'not available' };
}

function arr(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function normalizeVersion(row = {}) {
  return {
    version: row.version || '',
    release: row.release || '',
    repoid: row.repoid || '',
  };
}

function normalizeNode(row = {}, name = '') {
  const memoryTotal = pick(row, ['memory.total', 'memory']);
  const memoryUsed = pick(row, ['memory.used']);
  const rootTotal = pick(row, ['root.total']);
  const rootUsed = pick(row, ['root.used']);
  return {
    name: row.node || row.name || name || 'localhost',
    cpuPercent: num(row.cpu) != null ? Math.round(Number(row.cpu) * 1000) / 10 : num(row.cpuPercent),
    uptime: num(row.uptime),
    memoryTotalBytes: num(memoryTotal),
    memoryUsedBytes: num(memoryUsed),
    memoryPercent: percentFromPair(memoryUsed, memoryTotal),
    rootTotalBytes: num(rootTotal),
    rootUsedBytes: num(rootUsed),
    rootPercent: percentFromPair(rootUsed, rootTotal),
    loadavg: Array.isArray(row.loadavg) ? row.loadavg.slice(0, 3).map(num).filter(v => v != null) : [],
  };
}

function datastoreName(row = {}) {
  return row.store || row.name || row.datastore || row.id || '';
}

function normalizeDatastore(configRow = {}, status = {}) {
  const data = status?.data || status || {};
  const total = pick(data, ['total', 'total-bytes', 'disk.total']);
  const used = pick(data, ['used', 'used-bytes', 'disk.used']);
  const avail = pick(data, ['avail', 'available', 'free', 'disk.avail']);
  const totalBytes = num(total) || (num(used) != null && num(avail) != null ? num(used) + num(avail) : null);
  const usedBytes = num(used) != null ? num(used) : (totalBytes != null && num(avail) != null ? totalBytes - num(avail) : null);
  const counts = data.counts || data['backup-count'] || {};
  const gcStatus = pick(data, ['gc-status', 'gcStatus', 'garbage-collection-status']) || '';
  const verifyStatus = pick(data, ['verify-state', 'verifyStatus']) || '';
  const error = data.error || data['last-error'] || '';
  const warn = !!error || /fail|error|warn/i.test(String(gcStatus || verifyStatus));
  return {
    name: datastoreName(configRow) || datastoreName(data) || 'datastore',
    path: configRow.path || data.path || '',
    comment: configRow.comment || data.comment || '',
    totalBytes,
    usedBytes,
    availableBytes: num(avail),
    usedPercent: percentFromPair(usedBytes, totalBytes),
    groups: num(counts.groups ?? data.groups),
    snapshots: num(counts.snapshots ?? data.snapshots),
    gcStatus,
    verifyStatus,
    error,
    health: warn ? 'warn' : 'online',
  };
}

function normalizeTasks(rows = []) {
  return arr(rows).slice(0, 30).map(t => ({
    id: t.upid || t.id || '',
    type: t.worker_type || t.type || '',
    user: t.user || '',
    starttime: t.starttime || null,
    endtime: t.endtime || null,
    status: t.status || '',
  }));
}

function summarize(instances = []) {
  const datastores = instances.flatMap(i => i.datastores || []);
  const tasks = instances.flatMap(i => i.tasks || []);
  const totalBytes = datastores.reduce((a, d) => a + Number(d.totalBytes || 0), 0);
  const usedBytes = datastores.reduce((a, d) => a + Number(d.usedBytes || 0), 0);
  return {
    instances: instances.length,
    up: instances.filter(i => i.online).length,
    down: instances.filter(i => !i.online).length,
    datastores: datastores.length,
    datastoresWarn: datastores.filter(d => d.health !== 'online').length,
    snapshots: datastores.reduce((a, d) => a + Number(d.snapshots || 0), 0),
    groups: datastores.reduce((a, d) => a + Number(d.groups || 0), 0),
    failedTasks: tasks.filter(t => /fail|error/i.test(String(t.status || ''))).length,
    totalBytes,
    usedBytes,
    usedPercent: percentFromPair(usedBytes, totalBytes),
  };
}

async function getPbsInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  if (!inst.url) throw new Error('PBS URL is required');
  const session = await loginSession(inst);
  const version = await optionalCall(inst, ['version'], session);
  const nodes = await optionalCall(inst, ['nodes'], session);
  const nodeNames = arr(nodes.data).map(n => n.node || n.name).filter(Boolean);
  const selectedNodes = nodeNames.length ? nodeNames : ['localhost'];
  const nodeStatuses = await mapLimit(selectedNodes.slice(0, 4), 2, async node => {
    const res = await optionalCall(inst, [`nodes/${encodeURIComponent(node)}/status`], session);
    return res.ok ? normalizeNode(res.data, node) : { name: node, error: res.error };
  });
  const storesRes = await optionalCall(inst, ['admin/datastore', 'config/datastore'], session);
  const storeRows = arr(storesRes.data);
  const statuses = await mapLimit(storeRows, Number(inst.datastoreConcurrency || 3), async row => {
    const name = datastoreName(row);
    if (!name) return normalizeDatastore(row, {});
    const res = await optionalCall(inst, [`admin/datastore/${encodeURIComponent(name)}/status`], session);
    return normalizeDatastore(row, res.ok ? res.data : { error: res.error });
  });
  const tasks = await optionalCall(inst, [`nodes/${encodeURIComponent(selectedNodes[0])}/tasks?limit=20`], session);
  if (!version.ok && !storesRes.ok && !nodes.ok) throw new Error(version.error || storesRes.error || nodes.error || 'PBS API unavailable');
  const errors = [version, nodes, storesRes, tasks]
    .filter(r => !r.ok)
    .map(r => r.error)
    .filter(Boolean);
  const row = {
    online: true,
    name: inst.name,
    url: inst.url,
    version: version.ok ? normalizeVersion(version.data) : {},
    nodes: nodeStatuses,
    datastores: statuses.filter(Boolean),
    tasks: tasks.ok ? normalizeTasks(tasks.data) : [],
    partial: errors.length > 0 || statuses.some(d => d.error),
    errors: [...errors, ...statuses.map(d => d.error).filter(Boolean)].slice(0, 5),
  };
  row.summary = summarize([row]);
  return row;
}

async function getAllPbsData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) return { online: false, error: 'No PBS instances configured', summary: summarize([]), instances: [] };
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 3), async (inst, idx) => {
    try {
      return await getPbsInstance(inst, idx);
    } catch (err) {
      return {
        online: false,
        name: inst.name,
        url: inst.url || '',
        error: err.message,
        version: {},
        nodes: [],
        datastores: [],
        tasks: [],
        summary: summarize([]),
      };
    }
  });
  const summary = summarize(rows);
  const firstError = rows.find(r => !r.online)?.error || '';
  return { online: summary.up > 0, error: firstError, summary, instances: rows };
}

module.exports = { getAllPbsData, configuredInstances };
