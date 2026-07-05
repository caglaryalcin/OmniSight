const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function timeoutMs(inst = {}) {
  const n = Number(inst.timeoutMs || inst.timeout || 12000);
  return Math.max(3000, Math.min(60000, Number.isFinite(n) ? n : 12000));
}

function configuredInstances(config = {}) {
  const rows = Array.isArray(config.instances) && config.instances.length ? config.instances : (config.url ? [config] : []);
  return rows.filter(r => r && (r.url || r.name)).map((r, idx) => ({
    ...r,
    name: String(r.name || r.label || r.url || `Veeam ${idx + 1}`).trim(),
    apiVersion: r.apiVersion || config.apiVersion || '1.3-rev1',
  }));
}

function arr(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  return [];
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

function apiBase(inst = {}) {
  const base = cleanBaseUrl(inst.url);
  if (!base) throw new Error('Veeam URL is required');
  if (/\/api\/v\d+$/i.test(base)) return base;
  if (/\/api$/i.test(base)) return `${base}/v1`;
  return `${base}/api/v1`;
}

function authBase(inst = {}) {
  const base = cleanBaseUrl(inst.url);
  if (/\/api\/v\d+$/i.test(base)) return base.replace(/\/v\d+$/i, '');
  if (/\/api$/i.test(base)) return base;
  return `${base}/api`;
}

function requestJson(url, inst = {}, opts = {}, token = '') {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;
    const headers = {
      Accept: 'application/json',
      'x-api-version': inst.apiVersion || '1.3-rev1',
      ...(opts.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
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
        if (data.length > Number(opts.maxBytes || inst.maxResponseBytes || 3 * 1024 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        }
        if (!data.trim()) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Veeam API')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(inst = {}) {
  if (inst.accessToken || inst.token || inst.bearerToken) return inst.accessToken || inst.token || inst.bearerToken;
  if (!inst.username || !inst.password) throw new Error('Veeam username/password or accessToken is required');
  const body = new URLSearchParams({ grant_type: 'password', username: inst.username, password: inst.password }).toString();
  const json = await requestJson(`${authBase(inst)}/oauth2/token`, inst, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  const token = json.access_token || json.accessToken || json.token;
  if (!token) throw new Error('Veeam token response did not include access_token');
  return token;
}

async function optionalCall(inst, token, path, label) {
  try {
    const data = await requestJson(`${apiBase(inst)}${path}`, inst, {}, token);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `${label || path}: ${err.message}` };
  }
}

function normalizeJob(row = {}) {
  const status = String(pick(row, ['status', 'state', 'lastResult', 'lastRun.result']) || '').toLowerCase();
  const enabled = pick(row, ['isEnabled', 'enabled']) !== false;
  return {
    id: row.id || row.uid || '',
    name: row.name || row.displayName || 'job',
    type: row.type || row.jobType || '',
    description: row.description || '',
    enabled,
    status: status || (enabled ? 'unknown' : 'disabled'),
    lastResult: String(pick(row, ['lastResult', 'lastRun.result', 'statistics.result']) || '').toLowerCase(),
    lastRun: pick(row, ['lastRun.endTime', 'lastRun.startTime', 'lastRunTime', 'latestRunLocal', 'latestRunUtc', 'lastSession.endTime', 'lastRun']) || '',
  };
}

function normalizeSession(row = {}) {
  const result = String(pick(row, ['result.result', 'result', 'state', 'status']) || '').toLowerCase();
  const state = String(pick(row, ['state', 'status']) || '').toLowerCase();
  return {
    id: row.id || row.uid || '',
    name: row.name || row.jobName || row.type || 'session',
    type: row.sessionType || row.type || '',
    state,
    result,
    creationTime: row.creationTime || row.createdAt || row.startTime || '',
    endTime: row.endTime || row.stopTime || '',
    progressPercent: num(row.progressPercent ?? row.progress?.percent),
    failed: /fail|error/i.test(result),
    warning: /warn/i.test(result),
    running: /running|working|pending|starting|stopping/i.test(state),
  };
}

function normalizeRepo(row = {}, state = {}) {
  const capacity = num(pick(state, ['capacityGB', 'capacity', 'totalSpace', 'totalBytes']) ?? pick(row, ['capacityGB', 'capacity', 'totalSpace', 'totalBytes']));
  const free = num(pick(state, ['freeGB', 'freeSpace', 'freeBytes']) ?? pick(row, ['freeGB', 'freeSpace', 'freeBytes']));
  const used = num(pick(state, ['usedSpace', 'usedBytes']) ?? (capacity != null && free != null ? capacity - free : null));
  const usedPercent = capacity && used != null ? Math.max(0, Math.min(100, Math.round((used / capacity) * 1000) / 10)) : null;
  const status = String(pick(state, ['status', 'state']) || pick(row, ['status', 'state']) || '').toLowerCase();
  return {
    id: row.id || state.id || state.repositoryId || '',
    name: row.name || state.name || 'repository',
    type: row.type || state.type || '',
    status: status || 'unknown',
    path: row.path || row.host || row.repositoryPath || '',
    capacity,
    free,
    used,
    usedPercent,
    warning: /warn|error|unavailable|offline/i.test(status) || (usedPercent != null && usedPercent >= 90),
  };
}

function summarize(instances = []) {
  const jobs = instances.flatMap(i => i.jobs || []);
  const sessions = instances.flatMap(i => i.sessions || []);
  const repos = instances.flatMap(i => i.repositories || []);
  return {
    instances: instances.length,
    up: instances.filter(i => i.online).length,
    down: instances.filter(i => !i.online).length,
    partial: instances.filter(i => i.partial).length,
    jobs: jobs.length,
    jobsDisabled: jobs.filter(j => j.enabled === false).length,
    sessions: sessions.length,
    failedSessions: sessions.filter(s => s.failed).length,
    warningSessions: sessions.filter(s => s.warning).length,
    runningSessions: sessions.filter(s => s.running).length,
    repositories: repos.length,
    repositoriesWarn: repos.filter(r => r.warning).length,
  };
}

async function getVeeamInstance(config = {}, idx = 0) {
  const inst = { ...config, name: config.name || config.url || `Veeam ${idx + 1}` };
  const token = await login(inst);
  const [jobsRes, sessionsRes, reposRes, statesRes] = await Promise.all([
    optionalCall(inst, token, `/jobs?limit=${Number(inst.jobLimit || 100)}`, 'jobs'),
    optionalCall(inst, token, `/sessions?limit=${Number(inst.sessionLimit || 50)}&orderColumn=creationTime&orderAsc=false`, 'sessions'),
    optionalCall(inst, token, `/backupInfrastructure/repositories?limit=${Number(inst.repositoryLimit || 100)}`, 'repositories'),
    optionalCall(inst, token, '/backupInfrastructure/repositories/states', 'repository states'),
  ]);
  if (!jobsRes.ok && !sessionsRes.ok && !reposRes.ok) throw new Error(jobsRes.error || sessionsRes.error || reposRes.error || 'Veeam API unavailable');
  const repoStates = arr(statesRes.data);
  const repositories = arr(reposRes.data).map(r => {
    const state = repoStates.find(s => s.id === r.id || s.repositoryId === r.id || s.name === r.name) || {};
    return normalizeRepo(r, state);
  });
  const errors = [jobsRes, sessionsRes, reposRes, statesRes].filter(r => !r.ok).map(r => r.error).filter(Boolean);
  const row = {
    online: true,
    name: inst.name,
    url: inst.url,
    jobs: jobsRes.ok ? arr(jobsRes.data).map(normalizeJob) : [],
    sessions: sessionsRes.ok ? arr(sessionsRes.data).map(normalizeSession) : [],
    repositories,
    partial: errors.length > 0,
    errors: errors.slice(0, 6),
  };
  row.summary = summarize([row]);
  return row;
}

async function getAllVeeamData(config = {}) {
  const instances = configuredInstances(config || {});
  if (!instances.length) return { online: false, error: 'No Veeam instances configured', summary: summarize([]), instances: [] };
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 2), async (inst, idx) => {
    try {
      return await getVeeamInstance(inst, idx);
    } catch (err) {
      return { online: false, name: inst.name, url: inst.url || '', error: err.message, jobs: [], sessions: [], repositories: [], summary: summarize([]) };
    }
  });
  const summary = summarize(rows);
  return { online: summary.up > 0, error: rows.find(r => !r.online)?.error || '', summary, instances: rows };
}

module.exports = { getAllVeeamData, configuredInstances };
