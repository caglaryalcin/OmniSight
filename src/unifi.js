const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');
const { loadHistoryMap, scheduleSaveHistoryMap } = require('./historyStore');

// UniFi Network collector — official Integration API first, legacy API only for
// WAN quality (stat/health), per the design doc.
//
//   basePathDetect (cached)          legacy auth (optional, WAN quality only)
//   ┌───────────────────────────┐    ┌──────────────────────────────────────┐
//   │ /proxy/network/integration│    │ ok ──► stat/health (latency/loss)    │
//   │   /v1  (UniFi OS console) │    │ 401 ──► re-login once ──► retry      │
//   │ /v1    (self-hosted)      │    │ 3 consecutive fails ──► degraded:    │
//   │ both fail ──► error state │    │   wanQuality='unavailable' until a   │
//   └───────────────────────────┘    │   later login succeeds               │
//                                    └──────────────────────────────────────┘
//   HTTP 429 anywhere ──► keep last-good result, skip this instance for
//   COOLDOWN_CYCLES refreshes (per-instance; other instances unaffected).
//   Per-device stats fetched every STATS_EVERY_N refreshes; device list +
//   WAN state every refresh.

const UNIFI_HISTORY_MAX = 5760;
const uniHistory = loadHistoryMap('unifi-history', UNIFI_HISTORY_MAX);

const STATS_EVERY_N = 4;      // stats cadence: every 4th refresh (~60s at 15s)
const COOLDOWN_CYCLES = 4;    // refreshes to skip after a 429
const LEGACY_MAX_FAILS = 3;   // consecutive legacy failures before degrading
const MAX_PAGES = 40;         // pagination walk safety cap
const PAGE_LIMIT = 200;       // requested page size (server may clamp lower)

// Device states that page. Everything transitional renders as a warn pill
// without alerting (fleet firmware upgrades must not storm).
const ALERTABLE_STATES = new Set(['OFFLINE']);
const WARN_STATES = new Set(['UPDATING', 'ADOPTING', 'GETTING_READY', 'PENDING_ADOPTION', 'PROVISIONING']);

// Per-instance runtime state, keyed by instance url. Survives across refreshes
// within the process; deliberately not persisted.
const runtime = new Map();

// Runtime state is keyed by url+site so two instances can watch different
// sites on the same controller without sharing siteId/stats/cooldown state.
function rtKeyOf(inst) {
  return inst._rtKey || `${cleanBaseUrl(inst.url)}|${String(inst.site || '').trim().toLowerCase()}`;
}

function rt(inst) {
  const key = rtKeyOf(inst);
  if (!runtime.has(key)) {
    runtime.set(key, {
      basePath: null,          // '/proxy/network/integration/v1' | '/v1'
      unifiOs: null,           // true when the /proxy prefix answered
      siteId: null,
      legacySiteName: null,
      tick: 0,
      statsCache: new Map(),   // device id -> normalized stats
      cooldown: 0,             // refreshes left to skip after 429
      lastGood: null,
      legacy: { cookie: '', csrf: '', fails: 0 },
      agent: null,
    });
  }
  return runtime.get(key);
}

function agentFor(inst) {
  const state = rt(inst);
  if (!state.agent) {
    const lib = cleanBaseUrl(inst.url).startsWith('https:') ? https : http;
    state.agent = new lib.Agent({ keepAlive: true, maxSockets: 4 });
  }
  return state.agent;
}

function cleanBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `UniFi ${idx + 1}`).trim();
}

function configuredInstances(config = {}) {
  config = config || {};
  const rows = Array.isArray(config.instances) && config.instances.length
    ? config.instances
    : (config.url ? [config] : []);
  return rows
    .filter(row => row && row.url)
    .map((row, idx) => ({ ...row, name: instanceName(row, idx) }));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timeoutMs(inst = {}) {
  const n = Number(inst.timeoutMs || inst.timeout || 10000);
  return Math.max(2000, Math.min(60000, Number.isFinite(n) ? n : 10000));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function httpJson(url, inst = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const req = lib.request(parsed, {
      method: opts.method || 'GET',
      headers,
      agent: opts.agent,
      rejectUnauthorized: inst.insecureTLS ? false : undefined,
      timeout: timeoutMs(inst),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > Number(opts.maxBytes || 4 * 1024 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new HttpError(res.statusCode, `HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        }
        let body = {};
        if (data.trim()) {
          try { body = JSON.parse(data); }
          catch { return reject(new Error('Invalid JSON from UniFi API')); }
        }
        resolve({ body, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function apiHeaders(inst) {
  return { 'X-API-KEY': inst.apiKey || inst.apiToken || '' };
}

async function apiGet(inst, path) {
  const state = rt(inst);
  const { body } = await httpJson(`${cleanBaseUrl(inst.url)}${state.basePath}${path}`, inst, {
    headers: apiHeaders(inst),
    agent: agentFor(inst),
  });
  return body;
}

// Walk the offset/limit/totalCount envelope. Returns { rows, complete } —
// `complete` is false when the walk could not corroborate totalCount, in which
// case callers must NOT treat missing devices as removed (design fold-in #2).
async function apiGetAll(inst, path) {
  const rows = [];
  let offset = 0;
  let totalCount = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await apiGet(inst, `${path}${sep}offset=${offset}&limit=${PAGE_LIMIT}`);
    const data = Array.isArray(body) ? body : (Array.isArray(body.data) ? body.data : []);
    rows.push(...data);
    totalCount = num(body.totalCount) != null ? num(body.totalCount) : totalCount;
    if (totalCount == null) {
      // No envelope (plain array response): single page, treat as complete.
      return { rows, complete: true };
    }
    if (rows.length >= totalCount || data.length === 0) break;
    offset = rows.length;
  }
  return { rows, complete: totalCount == null || rows.length >= totalCount };
}

// Probe the UniFi OS proxy prefix first, then the self-hosted bare path.
async function detectBasePath(inst) {
  const state = rt(inst);
  if (state.basePath) return;
  const probes = inst.basePath
    ? [{ base: String(inst.basePath).replace(/\/+$/, ''), unifiOs: String(inst.basePath).includes('/proxy/') }]
    : [
      { base: '/proxy/network/integration/v1', unifiOs: true },
      { base: '/v1', unifiOs: false },
    ];
  const errors = [];
  for (const probe of probes) {
    try {
      const { body } = await httpJson(`${cleanBaseUrl(inst.url)}${probe.base}/sites?offset=0&limit=1`, inst, {
        headers: apiHeaders(inst),
        agent: agentFor(inst),
      });
      state.basePath = probe.base;
      state.unifiOs = probe.unifiOs;
      return body;
    } catch (err) {
      if (err instanceof HttpError && [401, 403].includes(err.status)) {
        // Auth failure means the path exists — surface the real problem.
        state.basePath = probe.base;
        state.unifiOs = probe.unifiOs;
        throw err;
      }
      errors.push(`${probe.base}: ${err.message}`);
    }
  }
  throw new Error(`Integration API not reachable (${errors.join('; ')})`);
}

async function resolveSite(inst) {
  const state = rt(inst);
  if (state.siteId) return state.siteId;
  const { rows } = await apiGetAll(inst, '/sites');
  if (!rows.length) throw new Error('Controller reports no sites');
  const want = String(inst.site || '').trim().toLowerCase();
  const site = want
    ? rows.find(s => [s.id, s.name, s.internalReference].some(v => String(v || '').toLowerCase() === want)) || rows[0]
    : rows[0];
  state.siteId = site.id;
  // Legacy API uses the short site name ('default'), not the Integration id.
  state.legacySiteName = String(inst.legacy?.site || site.internalReference || 'default');
  return state.siteId;
}

function normalizeState(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'ONLINE') return { state: 'online', alertable: false, warn: false };
  if (ALERTABLE_STATES.has(s)) return { state: 'offline', alertable: true, warn: false };
  if (WARN_STATES.has(s)) return { state: s.toLowerCase().replace(/_/g, ' '), alertable: false, warn: true };
  return { state: s ? s.toLowerCase() : 'unknown', alertable: false, warn: s !== '' };
}

function isGatewayDevice(dev = {}) {
  const feats = [].concat(dev.features || [], dev.capabilities || []).map(f => String(f).toLowerCase());
  if (feats.some(f => f.includes('gateway'))) return true;
  return /gateway|udm|uxg|usg/i.test(String(dev.model || dev.type || ''));
}

function normalizeDevice(row = {}) {
  const st = normalizeState(row.state);
  return {
    id: row.id || row.macAddress || row.name,
    name: row.name || row.model || row.macAddress || 'device',
    model: row.model || '',
    mac: String(row.macAddress || '').toLowerCase(),
    ip: row.ipAddress || '',
    state: st.state,
    stateRaw: String(row.state || ''),
    alertable: st.alertable,
    warn: st.warn,
    online: st.state === 'online',
    firmware: row.firmwareVersion || '',
    firmwareUpdatable: row.firmwareUpdatable === true,
    isGateway: isGatewayDevice(row),
    cpu: null,
    ram: null,
    uptimeSeconds: null,
  };
}

function applyStats(dev, stats = {}) {
  dev.cpu = num(stats.cpuUtilizationPct);
  dev.ram = num(stats.memoryUtilizationPct) != null ? { percent: num(stats.memoryUtilizationPct) } : null;
  dev.uptimeSeconds = num(stats.uptimeSec);
  const uplink = stats.uplink || {};
  dev.uplink = {
    rxBps: num(uplink.rxRateBps),
    txBps: num(uplink.txRateBps),
  };
  return dev;
}

// ---------------------------------------------------------------------------
// Legacy API (WAN quality only). Dual login path per design fold-in #5.
// ---------------------------------------------------------------------------

function legacyConfigured(inst) {
  return !!(inst.legacy && inst.legacy.username && inst.legacy.password);
}

async function legacyLogin(inst) {
  const state = rt(inst);
  const loginPath = state.unifiOs ? '/api/auth/login' : '/api/login';
  const { headers } = await httpJson(`${cleanBaseUrl(inst.url)}${loginPath}`, inst, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    agent: agentFor(inst),
    body: { username: inst.legacy.username, password: inst.legacy.password },
  });
  const cookies = [].concat(headers['set-cookie'] || []).map(c => c.split(';')[0]);
  state.legacy.cookie = cookies.join('; ');
  state.legacy.csrf = headers['x-csrf-token'] || '';
  if (!state.legacy.cookie) throw new Error('Legacy login returned no session cookie');
}

async function legacyGet(inst, path) {
  const state = rt(inst);
  const prefix = state.unifiOs ? '/proxy/network' : '';
  const headers = { Cookie: state.legacy.cookie };
  if (state.legacy.csrf) headers['X-Csrf-Token'] = state.legacy.csrf;
  const { body } = await httpJson(`${cleanBaseUrl(inst.url)}${prefix}${path}`, inst, {
    headers,
    agent: agentFor(inst),
  });
  return body;
}

function normalizeHealth(body = {}) {
  const rows = Array.isArray(body.data) ? body.data : [];
  const www = rows.find(r => r.subsystem === 'www') || {};
  const wan = rows.find(r => r.subsystem === 'wan') || {};
  return {
    latencyMs: num(www.latency),
    lossPct: num(www.drops) != null ? num(www.drops) : num(www.packet_loss),
    wanStatus: String(wan.status || www.status || '').toLowerCase() || null,
  };
}

// Returns { quality: 'ok'|'unavailable'|'unconfigured', data|error }.
// Single re-login on 401; LEGACY_MAX_FAILS consecutive failures => degraded
// until a later cycle logs in successfully again.
async function fetchWanQuality(inst) {
  const state = rt(inst);
  if (!legacyConfigured(inst)) return { quality: 'unconfigured' };
  try {
    if (!state.legacy.cookie) await legacyLogin(inst);
    let body;
    try {
      body = await legacyGet(inst, `/api/s/${state.legacySiteName}/stat/health`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        await legacyLogin(inst);
        body = await legacyGet(inst, `/api/s/${state.legacySiteName}/stat/health`);
      } else {
        throw err;
      }
    }
    state.legacy.fails = 0;
    return { quality: 'ok', ...normalizeHealth(body) };
  } catch (err) {
    state.legacy.cookie = '';
    state.legacy.fails += 1;
    return {
      quality: 'unavailable',
      error: state.legacy.fails >= LEGACY_MAX_FAILS
        ? `legacy auth failing (${state.legacy.fails} attempts): ${err.message}`
        : err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// History — same pattern as the SNMP collector: the module owns its rolling
// series ('unifi-history'), attaches them to rows, and schedules persistence.
// Device points at stats cadence; WAN point (incl. up 0/1) every refresh so
// "ISP events" can be derived from falling edges.
// ---------------------------------------------------------------------------

function pushHistory(key, point, max = UNIFI_HISTORY_MAX) {
  const rows = uniHistory.get(key) || [];
  rows.push(point);
  if (rows.length > max) rows.splice(0, rows.length - max);
  uniHistory.set(key, rows);
  return rows;
}

function recordHistory(inst, devices, wan, statsUpdated) {
  const now = Date.now();
  let changed = false;
  if (statsUpdated) {
    for (const dev of devices) {
      if (!dev.online || (dev.cpu == null && !dev.ram)) continue;
      dev.history = pushHistory(`dev:${dev.mac || dev.id}`, {
        time: now, cpu: dev.cpu, ram: dev.ram?.percent ?? null,
      });
      changed = true;
    }
  } else {
    for (const dev of devices) {
      dev.history = uniHistory.get(`dev:${dev.mac || dev.id}`) || [];
    }
  }
  if (wan) {
    // Migrate series recorded under the pre-multi-site key (url only).
    const wanKey = `wan:${rtKeyOf(inst)}`;
    const legacyKey = `wan:${cleanBaseUrl(inst.url)}`;
    if (!uniHistory.has(wanKey) && uniHistory.has(legacyKey)) {
      uniHistory.set(wanKey, uniHistory.get(legacyKey));
      uniHistory.delete(legacyKey);
    }
    wan.history = pushHistory(wanKey, {
      time: now,
      up: wan.state === 'down' ? 0 : 1,
      latency: wan.latencyMs,
      loss: wan.lossPct,
      rxBps: wan.rxBps,
      txBps: wan.txBps,
    });
    changed = true;
    // Falling edges over the retention window = "ISP events" (design fold-in #8).
    const edges = [];
    const rows = wan.history;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].up === 1 && rows[i].up === 0) edges.push(rows[i].time);
    }
    wan.downEvents = { count: edges.length, recent: edges.slice(-5) };
  }
  if (changed) scheduleSaveHistoryMap('unifi-history', uniHistory, UNIFI_HISTORY_MAX);
}

function summarize(instances) {
  const devices = instances.flatMap(i => i.devices || []);
  return {
    instances: instances.length,
    up: instances.filter(i => i.online).length,
    down: instances.filter(i => !i.online).length,
    devices: devices.length,
    devicesOnline: devices.filter(d => d.online).length,
    devicesOffline: devices.filter(d => d.alertable).length,
    devicesWarn: devices.filter(d => d.warn).length,
    wanDown: instances.filter(i => i.wan && i.wan.state === 'down').length,
  };
}

function offlineInstance(inst, error, extra = {}) {
  return {
    online: false,
    name: inst.name,
    url: inst.url || '',
    error,
    devices: [],
    devicesComplete: false,
    wan: null,
    wanQuality: legacyConfigured(inst) ? 'unavailable' : 'unconfigured',
    ...extra,
  };
}

async function getUnifiInstance(inst, idx) {
  const state = rt(inst);
  state.tick += 1;

  // 429 cooldown: serve last-good, skip the controller entirely (fold-in #7).
  if (state.cooldown > 0) {
    state.cooldown -= 1;
    if (state.lastGood) {
      return { ...state.lastGood, stale: true, staleReason: `rate limited — retrying in ${state.cooldown + 1} cycle(s)` };
    }
    return offlineInstance(inst, 'rate limited (HTTP 429), backing off');
  }

  try {
    await detectBasePath(inst);
    await resolveSite(inst);

    const { rows, complete } = await apiGetAll(inst, `/sites/${state.siteId}/devices`);
    const devices = rows.map(normalizeDevice);

    // Split cadence: stats every STATS_EVERY_N refreshes; cached in between.
    const wantStats = state.tick % STATS_EVERY_N === 1 || state.statsCache.size === 0;
    if (wantStats) {
      await mapLimit(devices.filter(d => d.online), Number(inst.statsConcurrency || 4), async dev => {
        try {
          const body = await apiGet(inst, `/sites/${state.siteId}/devices/${dev.id}/statistics/latest`);
          state.statsCache.set(dev.id, body || {});
        } catch (err) {
          if (err instanceof HttpError && err.status === 429) throw err;
          state.statsCache.delete(dev.id);
        }
      });
    }
    for (const dev of devices) {
      if (state.statsCache.has(dev.id)) applyStats(dev, state.statsCache.get(dev.id));
    }

    const gateway = devices.find(d => d.isGateway) || null;
    if (gateway) {
      // The controller URL host is one of the gateway's own IPs (often a
      // different interface than the one the controller reports, which can be
      // the WAN address). Expose it as a match alias so SNMP/API dedupe works
      // for the gateway too.
      try {
        const urlHost = new URL(cleanBaseUrl(inst.url)).hostname;
        if (urlHost && urlHost !== gateway.ip) gateway.aliases = [urlHost];
      } catch {}
    }
    const quality = await fetchWanQuality(inst);
    let wan = null;
    if (gateway) {
      wan = {
        // Transitional gateway states (updating/adopting/provisioning — e.g.
        // during a UniFi reprovision) are NOT WAN outages: map to 'unknown'
        // so no down-edge is recorded and no alert fires. Only a genuinely
        // OFFLINE gateway (or legacy-reported error) marks the WAN down.
        state: gateway.alertable ? 'down' : gateway.online ? 'up' : 'unknown',
        rxBps: gateway.uplink?.rxBps ?? null,
        txBps: gateway.uplink?.txBps ?? null,
        latencyMs: quality.quality === 'ok' ? quality.latencyMs : null,
        lossPct: quality.quality === 'ok' ? quality.lossPct : null,
      };
      if (quality.quality === 'ok' && ['error', 'critical'].includes(quality.wanStatus)) wan.state = 'down';
      else if (quality.quality === 'ok' && quality.wanStatus === 'warning' && wan.state === 'up') wan.state = 'degraded';
    }

    recordHistory(inst, devices, wan, wantStats);

    const row = {
      online: true,
      name: inst.name,
      url: inst.url,
      site: state.legacySiteName || undefined,
      unifiOs: state.unifiOs,
      devices,
      devicesComplete: complete,
      wan,
      wanQuality: quality.quality,
      wanQualityError: quality.quality === 'unavailable' && rt(inst).legacy.fails >= LEGACY_MAX_FAILS ? quality.error : undefined,
      stale: false,
    };
    state.lastGood = row;
    return row;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      state.cooldown = COOLDOWN_CYCLES;
      if (state.lastGood) {
        return { ...state.lastGood, stale: true, staleReason: 'rate limited — backing off' };
      }
      return offlineInstance(inst, 'rate limited (HTTP 429), backing off');
    }
    // Base path / site resolution may be stale after controller changes.
    if (err instanceof HttpError && [404].includes(err.status)) {
      state.basePath = null;
      state.siteId = null;
    }
    return offlineInstance(inst, err.message);
  }
}

async function getAllUnifiData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) {
    return { online: false, error: 'No UniFi controllers configured', summary: summarize([]), instances: [] };
  }
  const rows = await mapLimit(instances, Number(config.concurrency || 2), (inst, idx) => getUnifiInstance(inst, idx));
  const summary = summarize(rows);
  const firstError = rows.find(r => !r.online)?.error || '';
  return { online: summary.up > 0, error: firstError, summary, instances: rows };
}

// Settings "Test connection": probes both auth paths independently so the UI
// can show "API ok / WAN quality failing" (design spec 5). Runs against an
// isolated runtime key so a failing test never pushes the production instance
// toward the 3-strike degraded state.
async function testUnifiConnection(input = {}) {
  const inst = { ...input, name: input.name || 'test', _rtKey: `test:${cleanBaseUrl(input.url)}:${Date.now()}` };
  const out = { api: { ok: false }, wanQuality: { configured: legacyConfigured(inst), ok: false } };
  try {
    try {
      await detectBasePath(inst);
      await resolveSite(inst);
      out.api = { ok: true, unifiOs: rt(inst).unifiOs, site: rt(inst).legacySiteName };
    } catch (err) {
      out.api = { ok: false, error: err.message };
      return out;
    }
    if (out.wanQuality.configured) {
      const q = await fetchWanQuality(inst);
      out.wanQuality = { configured: true, ok: q.quality === 'ok', error: q.quality === 'ok' ? undefined : q.error };
    }
    return out;
  } finally {
    const state = runtime.get(inst._rtKey);
    try { state?.agent?.destroy(); } catch {}
    runtime.delete(inst._rtKey);
  }
}

// Test hook: reset module-level runtime state between fixture scenarios.
// Also discards in-memory history and any pending debounced save so fixture
// data can never flush into data/unifi-history.yaml. Never called by server.js.
function _resetRuntime() {
  for (const state of runtime.values()) {
    try { state.agent?.destroy(); } catch {}
  }
  runtime.clear();
  uniHistory.clear();
  try { require('./historyStore').cancelHistorySaves('unifi-history'); } catch {}
}

module.exports = { getAllUnifiData, configuredInstances, testUnifiConnection, _resetRuntime };
