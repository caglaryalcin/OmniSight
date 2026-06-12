const https = require('https');
const http = require('http');
const { io: socketIo } = require('socket.io-client');

function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}

function parseStatusPage(inputUrl, slug) {
  const out = { baseUrl: String(inputUrl || '').trim(), slug: String(slug || '').trim() };
  if (!out.baseUrl) return out;
  try {
    const u = new URL(out.baseUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const statusIdx = parts.findIndex(p => ['status', 'status-page'].includes(p));
    if (!out.slug && statusIdx >= 0 && parts[statusIdx + 1]) out.slug = parts[statusIdx + 1];
    if (statusIdx >= 0) {
      u.pathname = parts.slice(0, statusIdx).join('/');
      if (!u.pathname.startsWith('/')) u.pathname = '/' + u.pathname;
      if (u.pathname === '/') u.pathname = '';
      u.search = '';
      u.hash = '';
      out.baseUrl = u.toString().replace(/\/$/, '');
    }
  } catch {}
  return out;
}

function compactHttpBody(data) {
  return String(data || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function httpGetJson(url, headers = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers, rejectUnauthorized: opts.insecureTLS ? false : undefined }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${compactHttpBody(data) || res.statusMessage}`));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Uptime Kuma')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const STATUS = {
  0: { status: 'down', healthy: false },
  1: { status: 'up', healthy: true },
  2: { status: 'pending', healthy: true },
  3: { status: 'maintenance', healthy: true },
};
const STATUS_ORDER = { down: 0, pending: 1, maintenance: 2, up: 3, unknown: 4 };
const HISTORY_MAX_POINTS = 6000;
const SOCKET_TIMEOUT_MS = 12000;
const SOCKET_EVENT_TIMEOUT_MS = 8000;
const SOCKET_CONCURRENCY = 4;
const SOCKET_TOKEN_CACHE = new Map();

function allowInsecureTLS(config = {}) {
  return config.insecureTLS === true || String(config.insecureTLS || '').toLowerCase() === 'true';
}

function latestHeartbeat(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return [...list].sort((a, b) => heartbeatTimeMs(b) - heartbeatTimeMs(a))[0];
}

function statusFromCode(code, monitor = {}) {
  return STATUS[Number(code)] || { status: monitor.active === false ? 'maintenance' : 'unknown', healthy: monitor.active !== false };
}

function monitorIds(m = {}) {
  return [m.id, m.monitorID, m.monitor_id, m.monitorId]
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
    .map(v => String(v));
}

function heartbeatMaps(payload = {}) {
  return [
    payload.heartbeatList,
    payload.heartbeats,
    payload.heartbeat_list,
    payload.data?.heartbeatList,
    payload.data?.heartbeats,
  ].filter(Boolean);
}

function heartbeatListFor(payload = {}, monitor = {}) {
  const ids = monitorIds(monitor);
  for (const root of [payload.heartbeatList, payload.heartbeats, payload.heartbeat_list]) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
    for (const id of ids) {
      const direct = root[id];
      if (Array.isArray(direct)) return direct;
    }
  }
  for (const map of heartbeatMaps(payload)) {
    if (Array.isArray(map)) {
      const flat = map.flatMap(item => Array.isArray(item) ? item : [item]);
      const matched = flat.filter(h => ids.includes(String(h?.monitorID ?? h?.monitor_id ?? h?.monitorId ?? '')));
      if (matched.length) return matched;
      if (ids.length <= 1 && flat.length && !flat.some(h => h?.monitorID || h?.monitor_id || h?.monitorId)) return flat;
      continue;
    }
    if (typeof map === 'object') {
      for (const id of ids) {
        if (Array.isArray(map[id])) return map[id];
      }
      const flat = Object.values(map).flatMap(item => Array.isArray(item) ? item : []);
      const matched = flat.filter(h => ids.includes(String(h?.monitorID ?? h?.monitor_id ?? h?.monitorId ?? '')));
      if (matched.length) return matched;
    }
  }
  return [];
}

function heartbeatTimeRaw(h = {}) {
  return h?.time || h?.createdDate || h?.created_date || null;
}

function normalizeHeartbeatTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(s);
  const isoish = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(hasZone ? isoish : `${isoish}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function heartbeatTimeMs(h = {}) {
  const t = normalizeHeartbeatTime(heartbeatTimeRaw(h));
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function socketErrorMessage(err) {
  if (!err) return 'socket error';
  const parts = [err.message || String(err)];
  if (err.description) parts.push(`description=${err.description}`);
  const status = err.context?.statusCode || err.context?.status;
  if (status) parts.push(`status=${status}`);
  const body = err.context?.responseText || err.context?.body;
  if (body) parts.push(`body=${String(body).slice(0, 160)}`);
  return parts.filter(Boolean).join(' ');
}

function historyHours(value) {
  const hours = Number(value || 1);
  if (!Number.isFinite(hours) || hours <= 0) return 1;
  return Math.min(Math.max(hours, 0.25), 24);
}

function heartbeatHistory(list, monitor = {}, hours = 1) {
  if (!Array.isArray(list) || !list.length) return [];
  const sorted = [...list]
    .sort((a, b) => heartbeatTimeMs(a) - heartbeatTimeMs(b));
  const cutoff = Date.now() - (historyHours(hours) * 60 * 60 * 1000);
  const recent = sorted.filter(h => {
    const t = heartbeatTimeMs(h);
    return Number.isFinite(t) && t >= cutoff;
  });
  return (recent.length ? recent : sorted.slice(-36))
    .slice(-HISTORY_MAX_POINTS)
    .map(h => ({
      status: statusFromCode(h?.status, monitor).status,
      time: normalizeHeartbeatTime(heartbeatTimeRaw(h)),
      ping: h?.ping ?? null,
      message: h?.msg || h?.message || '',
    }));
}

function emitAck(socket, event, args = [], timeout = SOCKET_EVENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, ...args, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

function waitSocketConnect(socket, timeout = SOCKET_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timed out')), timeout);
    const done = (err) => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      err ? reject(err) : resolve();
    };
    const onConnect = () => done();
    const onError = (err) => done(new Error(socketErrorMessage(err || 'socket connect failed')));
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      out[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return out;
}

function socketHistoryHours(config = {}) {
  return historyHours(config.historyHours || 1);
}

function socketCredentials(config = {}) {
  if (config.authToken) return { mode: 'token', token: String(config.authToken) };
  if (config.username && config.password) return { mode: 'password', username: String(config.username), password: String(config.password) };
  return null;
}

function defaultSocketPath(parsed = {}) {
  try {
    const pathname = new URL(parsed.baseUrl).pathname.replace(/\/+$/, '');
    return `${pathname && pathname !== '/' ? pathname : ''}/socket.io`;
  } catch {
    return '/socket.io';
  }
}

function socketTransports(config = {}) {
  const raw = String(config.socketTransport || '').toLowerCase();
  if (raw === 'websocket') return ['websocket'];
  if (raw === 'both') return ['polling', 'websocket'];
  return ['polling'];
}

function replyData(reply) {
  if (Array.isArray(reply)) return reply;
  if (Array.isArray(reply?.data)) return reply.data;
  if (Array.isArray(reply?.beats)) return reply.beats;
  if (Array.isArray(reply?.heartbeats)) return reply.heartbeats;
  if (Array.isArray(reply?.heartbeatList)) return reply.heartbeatList;
  if (Array.isArray(reply?.data?.beats)) return reply.data.beats;
  if (Array.isArray(reply?.data?.heartbeats)) return reply.data.heartbeats;
  if (Array.isArray(reply?.data?.heartbeatList)) return reply.data.heartbeatList;
  return [];
}

function chartDataToHeartbeats(list = [], monitor = {}) {
  return replyData(list).map(item => {
    const rawTs = Number(item?.timestamp ?? item?.time ?? item?.date);
    if (!Number.isFinite(rawTs)) return null;
    const ms = rawTs > 1000000000000 ? rawTs : rawTs * 1000;
    const up = Number(item?.up || 0);
    const down = Number(item?.down || 0);
    const pending = Number(item?.pending || 0);
    const maintenance = Number(item?.maintenance || 0);
    let status = null;
    if (down > 0) status = 0;
    else if (pending > 0) status = 2;
    else if (maintenance > 0) status = 3;
    else if (up > 0) status = 1;
    if (status === null) return null;
    return {
      monitorID: monitor.id ?? monitor.monitorID ?? monitor.monitor_id,
      status,
      time: new Date(ms).toISOString(),
      ping: item?.avgPing ?? item?.ping ?? null,
      msg: 'Aggregated minute',
    };
  }).filter(Boolean);
}

async function fetchMonitorSocketHistory(socket, id, hours, monitor = {}) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return { id, list: [], source: null, error: 'Invalid monitor id' };
  const errors = [];

  try {
    const beatsReply = await emitAck(socket, 'getMonitorBeats', [numericId, hours]);
    const beats = replyData(beatsReply);
    if (beats.length) return { id, list: beats, source: 'socket-beats', error: null };
    if (beatsReply?.ok === false) errors.push(`getMonitorBeats: ${beatsReply.msg || 'failed'}`);
  } catch (err) {
    errors.push(`getMonitorBeats: ${err.message}`);
  }

  try {
    const chartReply = await emitAck(socket, 'getMonitorChartData', [numericId, hours]);
    const chart = chartDataToHeartbeats(replyData(chartReply), monitor);
    if (chart.length) return { id, list: chart, source: 'socket-chart', error: null };
    if (chartReply?.ok === false) errors.push(`getMonitorChartData: ${chartReply.msg || 'failed'}`);
  } catch (err) {
    errors.push(`getMonitorChartData: ${err.message}`);
  }

  return { id, list: [], source: null, error: errors.filter(Boolean).join('; ') || 'No socket history returned' };
}

async function fetchSocketHistory(config = {}, monitors = [], parsed = parseStatusPage(config.url, config.slug)) {
  const credentials = socketCredentials(config);
  const ids = [...new Set(monitors.flatMap(monitorIds))];
  const transports = socketTransports(config);
  if (!credentials || !ids.length) return { used: false, historyById: new Map(), sourceById: new Map(), errorsById: new Map(), error: null, transports };

  const historyById = new Map();
  const sourceById = new Map();
  const errorsById = new Map();
  const monitorById = new Map();
  monitors.forEach(m => monitorIds(m).forEach(id => monitorById.set(id, m)));
  const socket = socketIo(parsed.baseUrl, {
    path: config.socketPath || defaultSocketPath(parsed),
    transports,
    upgrade: transports.length > 1,
    reconnection: false,
    forceNew: true,
    timeout: SOCKET_TIMEOUT_MS,
    rejectUnauthorized: allowInsecureTLS(config) ? false : undefined,
    transportOptions: allowInsecureTLS(config) ? {
      polling: { rejectUnauthorized: false },
      websocket: { rejectUnauthorized: false },
    } : undefined,
  });

  try {
    await waitSocketConnect(socket);
    let login = null;
    if (credentials.mode === 'token') {
      login = await emitAck(socket, 'loginByToken', [credentials.token]);
    } else {
      const cacheKey = `${parsed.baseUrl}|${credentials.username}`;
      const cachedToken = SOCKET_TOKEN_CACHE.get(cacheKey);
      if (cachedToken) {
        login = await emitAck(socket, 'loginByToken', [cachedToken]);
        if (!login?.ok) SOCKET_TOKEN_CACHE.delete(cacheKey);
      }
      if (!login?.ok) {
        login = await emitAck(socket, 'login', [{ username: credentials.username, password: credentials.password }]);
        if (login?.ok && login.token) SOCKET_TOKEN_CACHE.set(cacheKey, login.token);
      }
    }
    if (login?.tokenRequired) throw new Error('Uptime Kuma 2FA is not supported for history sync');
    if (!login?.ok) throw new Error(login?.msg || 'Uptime Kuma socket login failed');

    const hours = socketHistoryHours(config);
    const results = await mapLimit(ids, SOCKET_CONCURRENCY, id => fetchMonitorSocketHistory(socket, id, hours, monitorById.get(id)));
    results.forEach(result => {
      if (result?.list?.length) {
        historyById.set(String(result.id), result.list);
        sourceById.set(String(result.id), result.source);
      }
      if (result?.error) errorsById.set(String(result.id), result.error);
    });
    return {
      used: historyById.size > 0,
      historyById,
      sourceById,
      errorsById,
      error: historyById.size > 0 ? null : [...errorsById.values()][0] || 'No socket history returned',
      transports,
    };
  } catch (err) {
    return { used: false, historyById, sourceById, errorsById, error: err.message, transports };
  } finally {
    try { socket.disconnect(); } catch {}
  }
}

async function getAllUptimeKuma(config = {}) {
  try {
    const parsed = parseStatusPage(config.url, config.slug);
    if (!parsed.baseUrl || !parsed.slug) throw new Error('Uptime Kuma URL and status page slug are required');
    const headers = {};
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
      headers['X-Api-Key'] = config.apiKey;
    }

    const pageUrl = joinUrl(parsed.baseUrl, `/api/status-page/${encodeURIComponent(parsed.slug)}`);
    const hbUrl = joinUrl(parsed.baseUrl, `/api/status-page/heartbeat/${encodeURIComponent(parsed.slug)}`);
    const [page, heartbeat] = await Promise.all([
      httpGetJson(pageUrl, headers, { insecureTLS: allowInsecureTLS(config) }),
      httpGetJson(hbUrl, headers, { insecureTLS: allowInsecureTLS(config) }).catch(() => ({})),
    ]);

    const monitors = [];
    const groups = page.publicGroupList || page.publicGroupListData || page.groups || [];
    const sourceMonitors = groups.flatMap(group => (group.monitorList || group.monitor_list || group.monitors || []));
    const socketHistory = await fetchSocketHistory(config, sourceMonitors, parsed);
    const hours = socketHistoryHours(config);
    groups.forEach(group => {
      (group.monitorList || group.monitor_list || group.monitors || []).forEach(m => {
        const id = m.id ?? m.monitorID ?? m.monitor_id;
        const socketId = monitorIds(m).find(mid => Array.isArray(socketHistory.historyById.get(mid)) && socketHistory.historyById.get(mid).length);
        const socketList = socketId ? socketHistory.historyById.get(socketId) : null;
        const hbList = socketList || heartbeatListFor(heartbeat, m);
        const hb = latestHeartbeat(hbList);
        const code = Number(hb?.status ?? m.status);
        const st = statusFromCode(code, m);
        const lastPing = normalizeHeartbeatTime(heartbeatTimeRaw(hb));
        monitors.push({
          id,
          name: m.name || m.displayName || `Monitor ${id}`,
          type: m.type || '',
          url: m.url || m.hostname || '',
          group: group.name || '',
          status: st.status,
          healthy: st.healthy,
          lastPing,
          ping: hb?.ping ?? null,
          message: hb?.msg || hb?.message || '',
          history: heartbeatHistory(hbList, m, hours),
          historySource: socketId ? (socketHistory.sourceById.get(socketId) || 'socket') : 'public',
        });
      });
    });

    monitors.sort((a, b) => (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5) || String(a.name).localeCompare(String(b.name)));

    const summary = {
      total: monitors.length,
      up: monitors.filter(m => m.status === 'up').length,
      down: monitors.filter(m => m.status === 'down').length,
      pending: monitors.filter(m => m.status === 'pending').length,
      maintenance: monitors.filter(m => m.status === 'maintenance').length,
      unknown: monitors.filter(m => m.status === 'unknown').length,
    };

    return { online: true, title: page.title || page.statusPage?.title || 'Uptime Kuma', slug: parsed.slug, summary, monitors, historyHours: hours, historySource: socketHistory.used ? 'socket' : 'public', historyError: socketHistory.error || null };
  } catch (err) {
    console.warn('Uptime Kuma refresh failed:', err.message);
    return { online: false, error: err.message, summary: { total: 0, up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0 }, monitors: [] };
  }
}

async function debugUptimeKuma(config = {}) {
  const parsed = parseStatusPage(config.url, config.slug);
  if (!parsed.baseUrl || !parsed.slug) throw new Error('Uptime Kuma URL and status page slug are required');
  const headers = {};
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    headers['X-Api-Key'] = config.apiKey;
  }
  const pageUrl = joinUrl(parsed.baseUrl, `/api/status-page/${encodeURIComponent(parsed.slug)}`);
  const hbUrl = joinUrl(parsed.baseUrl, `/api/status-page/heartbeat/${encodeURIComponent(parsed.slug)}`);
  const [page, heartbeat] = await Promise.all([
    httpGetJson(pageUrl, headers, { insecureTLS: allowInsecureTLS(config) }),
    httpGetJson(hbUrl, headers, { insecureTLS: allowInsecureTLS(config) }).catch(err => ({ _error: err.message })),
  ]);
  const groups = page.publicGroupList || page.publicGroupListData || page.groups || [];
  const roots = heartbeatMaps(heartbeat);
  const sourceMonitors = groups.flatMap(group => (group.monitorList || group.monitor_list || group.monitors || []));
  const socketHistory = await fetchSocketHistory(config, sourceMonitors, parsed);
  return {
    parsed,
    heartbeatError: heartbeat._error || null,
    heartbeatTopKeys: Object.keys(heartbeat || {}).slice(0, 20),
    heartbeatRootShapes: roots.map(root => Array.isArray(root)
      ? { type: 'array', length: root.length }
      : { type: typeof root, keys: Object.keys(root || {}).slice(0, 20) }),
    monitors: groups.flatMap(group => (group.monitorList || group.monitor_list || group.monitors || []).map(m => ({
      name: m.name || m.displayName || '',
      ids: monitorIds(m),
      historyCount: heartbeatListFor(heartbeat, m).length,
      first: normalizeHeartbeatTime(heartbeatTimeRaw(heartbeatListFor(heartbeat, m)[0])),
      last: normalizeHeartbeatTime(heartbeatTimeRaw(latestHeartbeat(heartbeatListFor(heartbeat, m)))),
    }))),
    socketHistory: {
      configured: !!socketCredentials(config),
      used: socketHistory.used,
      error: socketHistory.error,
      transports: socketHistory.transports,
      hours: socketHistoryHours(config),
      errors: Object.fromEntries(socketHistory.errorsById || new Map()),
      monitors: sourceMonitors.map(m => {
        const socketId = monitorIds(m).find(id => Array.isArray(socketHistory.historyById.get(id)));
        const history = socketId ? socketHistory.historyById.get(socketId) : [];
        return {
          name: m.name || m.displayName || '',
          ids: monitorIds(m),
          count: history.length,
          source: socketId ? socketHistory.sourceById.get(socketId) : null,
          error: socketId ? socketHistory.errorsById.get(socketId) : monitorIds(m).map(id => socketHistory.errorsById.get(id)).find(Boolean) || null,
          first: normalizeHeartbeatTime(heartbeatTimeRaw(history[0])),
          last: normalizeHeartbeatTime(heartbeatTimeRaw(latestHeartbeat(history))),
        };
      }),
    },
  };
}

module.exports = { getAllUptimeKuma, debugUptimeKuma };
