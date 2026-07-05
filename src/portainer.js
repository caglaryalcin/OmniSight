const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

function cleanBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `Portainer ${idx + 1}`).trim();
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

function apiPath(path) {
  return String(path || '').startsWith('/api/') ? path : `/api/${String(path || '').replace(/^\/+/, '')}`;
}

function tokenValue(inst = {}) {
  return inst.apiKey || inst.accessToken || inst.token || inst.bearerToken || inst.jwt || '';
}

function authHeaders(inst = {}, session = {}) {
  const headers = { Accept: 'application/json' };
  if (session.jwt) headers.Authorization = `Bearer ${session.jwt}`;
  else if (inst.jwt || inst.bearerToken) headers.Authorization = `Bearer ${inst.jwt || inst.bearerToken}`;
  else if (tokenValue(inst)) headers['X-API-Key'] = tokenValue(inst);
  return headers;
}

function httpJson(url, inst = {}, opts = {}, session = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;
    const headers = { ...authHeaders(inst, session), ...(opts.headers || {}) };
    if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (body && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
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
        catch { reject(new Error('Invalid JSON from Portainer API')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function loginSession(inst = {}) {
  if (tokenValue(inst)) return {};
  if (!inst.username || !inst.password) return {};
  const res = await httpJson(cleanBaseUrl(inst.url) + apiPath('auth'), inst, {
    method: 'POST',
    body: { username: inst.username, password: inst.password },
  });
  return { jwt: res.jwt || '' };
}

async function call(inst, path, session) {
  return httpJson(cleanBaseUrl(inst.url) + apiPath(path), inst, {}, session);
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

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function endpointId(row = {}) {
  return row.Id ?? row.ID ?? row.id;
}

function endpointType(row = {}) {
  const t = row.Type ?? row.type;
  const map = { 1: 'docker', 2: 'agent', 3: 'azure', 4: 'edge-agent', 5: 'kubernetes' };
  return map[t] || String(t || row.Platform || row.platform || 'environment').toLowerCase();
}

function endpointOnline(row = {}) {
  const st = row.Status ?? row.status;
  if (st === 1 || st === '1' || st === true) return true;
  if (st === 2 || st === '2' || st === false) return false;
  const text = String(row.StatusText || row.statusText || row.State || row.state || '').toLowerCase();
  if (['up', 'online', 'healthy', 'running'].includes(text)) return true;
  if (['down', 'offline', 'unhealthy'].includes(text)) return false;
  return row.LastCheckInDate || row.LastCheckInDate === 0 ? true : null;
}

function normalizeEndpoint(row = {}) {
  const online = endpointOnline(row);
  return {
    id: endpointId(row),
    name: row.Name || row.name || row.URL || row.url || 'environment',
    url: row.URL || row.url || '',
    type: endpointType(row),
    groupId: row.GroupId ?? row.groupId ?? null,
    online,
    status: online === true ? 'online' : online === false ? 'offline' : 'unknown',
  };
}

function normalizeStack(row = {}) {
  const status = String(row.Status ?? row.status ?? '').toLowerCase();
  return {
    id: row.Id ?? row.ID ?? row.id,
    name: row.Name || row.name || 'stack',
    endpointId: row.EndpointId ?? row.endpointId,
    type: row.Type ?? row.type,
    namespace: row.Namespace || row.namespace || '',
    status,
    healthy: !status || ['1', 'active', 'running'].includes(status),
  };
}

function normalizeContainer(row = {}, endpoint = {}) {
  const names = Array.isArray(row.Names) ? row.Names : [];
  const state = String(row.State || row.state || '').toLowerCase();
  const image = row.Image || '';
  return {
    id: row.Id || row.ID || row.id || '',
    name: row.Name || names[0]?.replace(/^\//, '') || row.Image || 'container',
    image,
    imageShort: String(image).split('/').pop().slice(0, 40),
    state,
    status: row.Status || '',
    endpointId: endpoint.id,
    endpointName: endpoint.name,
    sourceName: endpoint.name,
    sourceUrl: endpoint.url,
    running: state === 'running',
    color: state === 'running' ? 'green' : (state === 'exited' || state === 'dead') ? 'red' : 'yellow',
  };
}

function summarize(instances = []) {
  const environments = instances.flatMap(i => i.environments || []);
  const stacks = instances.flatMap(i => i.stacks || []);
  const containers = instances.flatMap(i => i.containers || []);
  return {
    instances: instances.length,
    up: instances.filter(i => i.online).length,
    down: instances.filter(i => !i.online).length,
    environments: environments.length,
    environmentsUp: environments.filter(e => e.online === true).length,
    environmentsDown: environments.filter(e => e.online === false).length,
    stacks: stacks.length,
    stacksWarn: stacks.filter(s => s.healthy === false).length,
    containers: containers.length,
    running: containers.filter(c => c.running).length,
    stopped: containers.filter(c => c.state && c.state !== 'running').length,
  };
}

async function dockerContainersForEndpoint(inst, endpoint, session) {
  if (!endpoint?.id) return [];
  if (!['docker', 'agent', 'edge-agent'].includes(endpoint.type)) return [];
  const res = await optionalCall(inst, [`endpoints/${encodeURIComponent(endpoint.id)}/docker/containers/json?all=1`], session);
  if (!res.ok) throw new Error(res.error);
  return arr(res.data).map(row => normalizeContainer(row, endpoint));
}

async function getPortainerInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  if (!inst.url) throw new Error('Portainer URL is required');
  const session = await loginSession(inst);
  const [status, endpoints, stacks] = await Promise.all([
    optionalCall(inst, ['system/status', 'status'], session),
    optionalCall(inst, ['endpoints'], session),
    optionalCall(inst, ['stacks'], session),
  ]);
  if (!status.ok && !endpoints.ok) throw new Error(status.error || endpoints.error || 'Portainer API unavailable');
  const environments = arr(endpoints.data).map(normalizeEndpoint);
  const endpointLimit = Number(inst.containerEndpointLimit || inst.endpointLimit || 0);
  const selected = endpointLimit > 0 ? environments.slice(0, endpointLimit) : environments;
  const containerResults = await mapLimit(selected, Number(inst.containerConcurrency || 2), async endpoint => {
    try { return await dockerContainersForEndpoint(inst, endpoint, session); }
    catch (err) { endpoint.error = err.message; return []; }
  });
  const errors = [status, endpoints, stacks]
    .filter(r => !r.ok)
    .map(r => r.error)
    .filter(Boolean);
  const row = {
    online: true,
    name: inst.name,
    url: inst.url,
    version: status.ok ? (status.data.Version || status.data.version || '') : '',
    edition: status.ok ? (status.data.Edition || status.data.edition || '') : '',
    environments,
    stacks: stacks.ok ? arr(stacks.data).map(normalizeStack) : [],
    containers: containerResults.flat(),
    partial: errors.length > 0 || environments.some(e => e.error),
    errors: [...errors, ...environments.map(e => e.error).filter(Boolean)].slice(0, 5),
  };
  row.summary = summarize([row]);
  return row;
}

async function getAllPortainerData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) return { online: false, error: 'No Portainer instances configured', summary: summarize([]), instances: [] };
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 3), async (inst, idx) => {
    try {
      return await getPortainerInstance(inst, idx);
    } catch (err) {
      return {
        online: false,
        name: inst.name,
        url: inst.url || '',
        error: err.message,
        version: '',
        environments: [],
        stacks: [],
        containers: [],
        summary: summarize([]),
      };
    }
  });
  const summary = summarize(rows);
  const firstError = rows.find(r => !r.online)?.error || '';
  return { online: summary.up > 0, error: firstError, summary, instances: rows, containers: rows.flatMap(r => r.containers || []) };
}

async function portainerLogs(cfg = {}, instanceName, endpointId, id) {
  const inst = configuredInstances(cfg).find(i => i.name === instanceName || i.url === instanceName);
  if (!inst) throw new Error('Portainer instance not found');
  if (!endpointId) throw new Error('Portainer environment is required');
  if (!id) throw new Error('Container id is required');
  const session = await loginSession(inst);
  return new Promise((resolve, reject) => {
    const url = cleanBaseUrl(inst.url) + apiPath(`endpoints/${encodeURIComponent(endpointId)}/docker/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=300`);
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = authHeaders(inst, session);
    headers.Accept = 'text/plain,application/json,*/*';
    const req = lib.request(parsed, {
      method: 'GET',
      headers,
      rejectUnauthorized: inst.insecureTLS ? false : undefined,
      timeout: timeoutMs(inst),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        try {
          const body = JSON.parse(data);
          return resolve(String(body?.logs || body?.log || body?.output || body?.data || data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { getAllPortainerData, configuredInstances, portainerLogs };
