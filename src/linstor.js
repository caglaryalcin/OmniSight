const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');
const { loadHistoryMap, scheduleSaveHistoryMap, cancelHistorySaves } = require('./historyStore');

// LINSTOR collector — polls one (or more) LINSTOR controller REST APIs and
// derives replication health for the dashboard + pager. Controller-only: no
// per-node agents (premise 1). Structure mirrors src/unifi.js (per-instance
// runtime Map, lastGood serving, isolated test-connection runtime) per the
// eng review's copy-now decision (D7); the shared collectorRuntime.js
// extraction is a TODOS.md item gated on a third consumer.
//
//   every cycle (15s, per-instance override)
//   ┌─────────────┐  GET /v1/nodes ──────────────┐
//   │ controller  │  GET /v1/view/resources ─────┤ all-or-nothing (D9):
//   │ :3370/:3371 │  GET /v1/view/storage-pools ─┘ any fail → lastGood + ctr++
//   └─────────────┘  GET /v1/error-reports?since=…   (every 4th, warn-only)
//                          │
//                          ▼  strip secrets at ingest, derive compact view
//   out.linstor = { summary, instances:[ { nodes[], degraded[], syncing[] } ] }
//   The full ~490KB resource view NEVER leaves this module (eng amendment #2).
//
// Auth (2026-07-15 amendment): the controller REST API is unauthenticated as
// this cluster ships, but can be secured with mTLS (client cert) or bearer
// token (LINSTOR 1.34+). This collector speaks both so it survives the
// cluster-side auth rollout without a code change — mirroring linstor-proxmox.

const LINSTOR_HISTORY_MAX = 10080;     // 7 days at the ~60s pool cadence (D3)
const linHistory = loadHistoryMap('linstor-history', LINSTOR_HISTORY_MAX);

const POOL_EVERY_N = 4;                // record a pool-history point every 4th cycle (~60s)
const ERRORS_EVERY_N = 4;             // fetch error reports every 4th cycle (warn-only, D14a)
const UNREACHABLE_STREAK = 3;         // consecutive failed polls before controller pages (rule e)
const DEGRADED_CAP = 50;             // worst-first row cap in the compact payload (D10)
const INT64_MAX = 9223372036854775807; // DISKLESS pool capacity sentinel
const KIB_PER_TIB = 1024 * 1024 * 1024; // 2^30 KiB in a TiB

// Disk states that are unhealthy when there is no active sync (rule (c) field
// spec, live-probed 2026-07-14). Diskless / UpToDate / Consistent are healthy;
// Diskless is the expected tiebreaker state and must never page.
const UNHEALTHY_DISK_STATES = new Set(['Inconsistent', 'Outdated', 'Failed', 'DUnknown']);
const SYNC_STATES = new Set(['SyncTarget', 'SyncSource']);

// Per-instance runtime, keyed by cleaned base URL. Not persisted.
const runtime = new Map();

function rtKeyOf(inst) {
  return inst._rtKey || cleanBaseUrl(inst.url);
}

function rt(inst) {
  const key = rtKeyOf(inst);
  if (!runtime.has(key)) {
    runtime.set(key, {
      tick: 0,
      failures: 0,            // consecutive failed poll cycles (drives rule e)
      lastGood: null,
      errorWindow: [],        // [{ time }] rolling error-report timestamps
      errorsSince: 0,         // epoch-ms high-water mark for the since= fetch
      agent: null,
    });
  }
  return runtime.get(key);
}

// --- URL / auth --------------------------------------------------------------

function cleanBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

function hasAuthMaterial(inst = {}) {
  const tls = inst.tls || {};
  return !!(inst.bearerToken || tls.privateKey || tls.cert || tls.caCert);
}

// Mirror linstor-proxmox: presenting any TLS/token material auto-switches the
// controller from plain http://…:3370 to https://…:3371 (setting apica/apicrt
// there does the same). Honour an explicit https:// URL as-is.
function effectiveUrl(inst = {}) {
  let base = cleanBaseUrl(inst.url);
  if (!base) return '';
  if (base.startsWith('https:')) return base;
  if (hasAuthMaterial(inst)) {
    try {
      const u = new URL(base);
      // Mirror linstor-proxmox: upgrade the DEFAULT controller endpoint (bare
      // host or :3370) to https://…:3371. An explicit non-default http port is
      // respected as-is — the token still rides along in the Authorization
      // header — so operators can point at a proxy without a forced rewrite.
      if (u.port === '' || u.port === '3370') {
        u.protocol = 'https:';
        u.port = '3371';
        return u.toString().replace(/\/+$/, '');
      }
    } catch { /* fall through */ }
  }
  return base;
}

function agentFor(inst) {
  const state = rt(inst);
  if (!state.agent) {
    const url = effectiveUrl(inst);
    if (url.startsWith('https:')) {
      const tls = inst.tls || {};
      state.agent = new https.Agent({
        keepAlive: true,
        maxSockets: 4,
        cert: tls.cert || undefined,
        key: tls.privateKey || undefined,
        passphrase: tls.password || undefined,
        ca: tls.caCert || undefined,
        // The `auth init` cert is self-signed; strict CA verify would fail.
        // Skip verify when told to, or when a bearer token is the auth (the
        // token is the credential, not the cert) and no CA was supplied.
        rejectUnauthorized: !(inst.tls?.skipVerify || inst.insecureTLS || (inst.bearerToken && !tls.caCert)),
      });
    } else {
      state.agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    }
  }
  return state.agent;
}

function authHeaders(inst = {}) {
  const h = {};
  if (inst.bearerToken) h.Authorization = `Bearer ${inst.bearerToken}`;
  return h;
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `LINSTOR ${idx + 1}`).trim();
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

function shortHost(name) {
  return String(name || '').trim().toLowerCase().split('.')[0];
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
    const headers = { Accept: 'application/json', ...authHeaders(inst), ...(opts.headers || {}) };
    const req = lib.request(parsed, {
      method: opts.method || 'GET',
      headers,
      agent: opts.agent,
      timeout: timeoutMs(inst),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        // The /v1/view/resources body is ~490KB on this cluster; allow headroom.
        if (data.length > Number(opts.maxBytes || 16 * 1024 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new HttpError(res.statusCode, `HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        }
        let body = {};
        if (data.trim()) {
          try { body = JSON.parse(data); }
          catch { return reject(new Error('Invalid JSON from LINSTOR API')); }
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

async function apiGet(inst, path) {
  const { body } = await httpJson(`${effectiveUrl(inst)}${path}`, inst, { agent: agentFor(inst) });
  return body;
}

// --- secret redaction (ingest-side, non-negotiable) --------------------------

// Deep-strip any key literally named `secret` before the payload is allowed
// into the runtime cache. The /v1/view/resources body carries one cleartext
// DRBD shared secret per resource-definition; these must never reach a status
// payload or the history file. Asserted by the redaction-status fixture.
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'secret') continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

// --- derivation helpers ------------------------------------------------------

function nodeProps(node = {}) {
  return node.props || {};
}

function isMaintenance(node = {}) {
  return String(nodeProps(node)['Aux/maintenance'] || '').trim().toLowerCase() === 'true';
}

function normalizeNode(node = {}) {
  const conn = String(node.connection_status || '').toUpperCase();
  const maintenance = isMaintenance(node);
  const online = conn === 'ONLINE';
  return {
    name: node.name || 'node',
    type: String(node.type || '').toUpperCase() || 'SATELLITE',
    connectionStatus: conn || 'UNKNOWN',
    online,
    maintenance,
    // Placement excluded but NOT maintenance (context for the replica-count warn).
    autoplaceTarget: String(nodeProps(node)['AutoplaceTarget'] || '').toLowerCase() !== 'false',
    // Unexpected offline: any non-ONLINE state on a non-maintenance node (rule a).
    alertableOffline: !maintenance && !online,
    // Forgot-to-clear: maintenance flag set but the satellite is ONLINE (D13, warn only).
    maintenanceOnline: maintenance && online,
    pools: [],
    resourceCount: 0,
  };
}

// storage-pools → per-node pool stats. Excludes DISKLESS and the int64 sentinel;
// tolerates null capacity (offline node) and allocated -1. Pool severity is
// max(data%, tmeta%) (D12/design-amendment 11) so the card can never show green
// while metadata exhaustion pages.
function normalizePool(sp = {}) {
  const kind = String(sp.provider_kind || '').toUpperCase();
  const total = num(sp.total_capacity);
  const free = num(sp.free_capacity);
  const props = sp.props || {};
  const tmetaPct = num(props['StorDriver/internal/lvmthin/thinPoolMetadataPercent']);
  const usable = kind !== 'DISKLESS' && total != null && total > 0 && total !== INT64_MAX && free != null;
  const dataPct = usable ? ((total - free) / total) * 100 : null;
  const worstPct = Math.max(dataPct ?? 0, tmetaPct ?? 0);
  return {
    node: sp.node_name || '',
    name: sp.storage_pool_name || sp.name || '',
    kind,
    usable,
    dataPct,
    tmetaPct,
    worstPct: usable || tmetaPct != null ? worstPct : null,
    metaDrives: tmetaPct != null && dataPct != null && tmetaPct > dataPct,
    usedTiB: usable ? (total - free) / KIB_PER_TIB : null,
    totalTiB: usable ? total / KIB_PER_TIB : null,
    freeTiB: usable ? free / KIB_PER_TIB : null,
  };
}

// A placement is one (resource, node) entry from /v1/view/resources.
function volumeStates(res = {}) {
  const vols = Array.isArray(res.volumes) ? res.volumes : [];
  return vols.map(v => ({
    diskless: String(v.provider_kind || '').toUpperCase() === 'DISKLESS',
    diskState: (v.state && v.state.disk_state) || '',
    replication: (v.state && v.state.replication_states) || {},
    allocatedKib: num(v.allocated_size_kib), // may be -1; tolerated
  }));
}

// Worst disk_state across a placement's volumes; whether any volume is actively
// syncing; and the sync percent (from the SyncTarget/SyncSource peer `done`).
function placementHealth(vols) {
  let worst = '';
  let syncing = false;
  let syncPct = null;
  let anyDiskful = false;
  let allHealthy = true;
  for (const v of vols) {
    if (v.diskless) continue;
    anyDiskful = true;
    for (const peer of Object.values(v.replication || {})) {
      const rs = String(peer && peer.replication_state || '');
      if (SYNC_STATES.has(rs)) {
        syncing = true;
        const done = num(peer.done);
        if (done != null) syncPct = done <= 1 ? Math.round(done * 100) : Math.round(done);
      }
    }
    if (UNHEALTHY_DISK_STATES.has(v.diskState)) { worst = worst || v.diskState; allHealthy = false; }
    else if (v.diskState && v.diskState !== 'UpToDate') { allHealthy = false; }
  }
  return { worst, syncing, syncPct, anyDiskful, allHealthy };
}

// --- per-instance poll -------------------------------------------------------

function offlineInstance(inst, error, extra = {}) {
  return {
    online: false,
    name: inst.name,
    url: inst.url || '',
    error,
    version: null,
    resourceGroup: null,
    groupCount: 0,
    nodes: [],
    degraded: [],
    syncing: [],
    degradedTotal: 0,
    syncingTotal: 0,
    warns: [],
    errors24h: 0,
    errors1h: 0,
    unreachableStreak: rt(inst).failures,
    ctrlPaging: rt(inst).failures >= UNREACHABLE_STREAK,
    stale: false,
    summary: emptyInstanceSummary(),
    ...extra,
  };
}

function emptyInstanceSummary() {
  return {
    nodes: 0, nodesOnline: 0, nodesOffline: 0, nodesMaintenance: 0,
    resources: 0, degraded: 0, syncing: 0, atOneCopy: 0,
    worstPoolPct: null, freeTiB: 0,
  };
}

// Rolling error window: fetch reports since the last high-water mark, append,
// prune to 24h, and expose 24h/1h counts. Immune to the endpoint's 1000-entry
// lifetime cap because we only ever ask for new reports (D14a).
async function refreshErrorWindow(inst, now) {
  const state = rt(inst);
  const since = state.errorsSince || (now - 24 * 3600 * 1000);
  try {
    const body = await apiGet(inst, `/v1/error-reports?since=${since}`);
    const rows = Array.isArray(body) ? body : (Array.isArray(body.data) ? body.data : []);
    for (const r of rows) {
      const t = num(r.error_time) ?? num(r.errorTime) ?? now;
      state.errorWindow.push({ time: t });
    }
    state.errorsSince = now;
  } catch { /* warn-only path — never fails the cycle */ }
  const dayAgo = now - 24 * 3600 * 1000;
  const hourAgo = now - 3600 * 1000;
  state.errorWindow = state.errorWindow.filter(e => e.time >= dayAgo);
  return {
    errors24h: state.errorWindow.length,
    errors1h: state.errorWindow.filter(e => e.time >= hourAgo).length,
  };
}

function pushPoolHistory(inst, node, pool, now) {
  if (!pool || (pool.dataPct == null && pool.tmetaPct == null)) return;
  const key = `pool:${rtKeyOf(inst)}:${node}`;
  const rows = linHistory.get(key) || [];
  rows.push({ time: now, dataPct: pool.dataPct, tmetaPct: pool.tmetaPct, worstPct: pool.worstPct });
  if (rows.length > LINSTOR_HISTORY_MAX) rows.splice(0, rows.length - LINSTOR_HISTORY_MAX);
  linHistory.set(key, rows);
}

function poolHistoryFor(inst, node) {
  return linHistory.get(`pool:${rtKeyOf(inst)}:${node}`) || [];
}

// Edge "since" tracking: first-seen timestamp for a degraded/down subject,
// persisted so timers survive restarts. Dropped when the subject recovers.
function edgeSince(inst, subject, active, now) {
  const key = `edge:${rtKeyOf(inst)}:${subject}`;
  if (!active) { if (linHistory.has(key)) linHistory.delete(key); return null; }
  const rows = linHistory.get(key);
  if (rows && rows.length) return rows[0].time;
  linHistory.set(key, [{ time: now }]);
  return now;
}

async function getLinstorInstance(inst) {
  const state = rt(inst);
  state.tick += 1;
  const now = Date.now();

  let nodesBody, resBody, poolsBody;
  try {
    // Three core GETs are all-or-nothing (D9): any failure discards the whole
    // cycle, serves lastGood, and advances the unreachable counter by one.
    [nodesBody, resBody, poolsBody] = await Promise.all([
      apiGet(inst, '/v1/nodes'),
      apiGet(inst, '/v1/view/resources'),
      apiGet(inst, '/v1/view/storage-pools'),
    ]);
  } catch (err) {
    state.failures += 1;
    if (state.lastGood) {
      return {
        ...state.lastGood,
        stale: true,
        staleReason: `controller unreachable — ${state.failures} failed poll(s)`,
        unreachableStreak: state.failures,
        ctrlPaging: state.failures >= UNREACHABLE_STREAK,
        error: err.message,
      };
    }
    return offlineInstance(inst, err.message);
  }

  // Strip secrets before anything derives from the resource view.
  const resources = stripSecrets(Array.isArray(resBody) ? resBody : (resBody.data || []));
  const rawNodes = Array.isArray(nodesBody) ? nodesBody : (nodesBody.data || []);
  const rawPools = Array.isArray(poolsBody) ? poolsBody : (poolsBody.data || []);

  state.failures = 0; // a full cycle succeeded

  // --- nodes ---
  const nodes = rawNodes.map(normalizeNode);
  const nodeByName = new Map(nodes.map(n => [n.name, n]));
  const maintenanceNodes = new Set(nodes.filter(n => n.maintenance).map(n => n.name));
  const offlineNodes = new Set(nodes.filter(n => n.alertableOffline).map(n => n.name));

  // --- pools onto nodes ---
  const recordPools = state.tick % POOL_EVERY_N === 1;
  for (const sp of rawPools) {
    const pool = normalizePool(sp);
    const node = nodeByName.get(pool.node);
    if (!node) continue;
    if (pool.kind === 'DISKLESS') continue; // no capacity to show
    node.pools.push(pool);
  }
  for (const node of nodes) {
    // Worst pool per node drives the row bar; keep them worst-first.
    node.pools.sort((a, b) => (b.worstPct ?? -1) - (a.worstPct ?? -1));
    node.pool = node.pools[0] || null;
    if (recordPools && node.pool) pushPoolHistory(inst, node.name, node.pool, now);
    if (node.pool) node.pool.history = poolHistoryFor(inst, node.name);
  }

  // --- resources: group placements by resource name ---
  const byResource = new Map();
  for (const res of resources) {
    const name = res.name || '';
    if (!name) continue;
    const props = res.props || {};
    const g = byResource.get(name) || { name, vmid: null, placements: [], connections: {} };
    const vols = volumeStates(res);
    const health = placementHealth(vols);
    g.vmid = g.vmid || props['Aux/pm/vmid'] || null;
    g.placements.push({
      node: res.node_name || '',
      diskless: vols.length ? vols.every(v => v.diskless) : false,
      anyDiskful: health.anyDiskful,
      worst: health.worst,
      syncing: health.syncing,
      syncPct: health.syncPct,
      healthy: health.allHealthy && health.anyDiskful,
      inUse: !!(res.state && res.state.in_use),
    });
    // peer connections live at the resource layer_object.drbd.connections
    const conns = res.layer_object && res.layer_object.drbd && res.layer_object.drbd.connections;
    if (conns && typeof conns === 'object') {
      for (const [peer, c] of Object.entries(conns)) {
        g.connections[`${res.node_name}->${peer}`] = { from: res.node_name, to: peer, connected: c && c.connected !== false };
      }
    }
    byResource.set(name, g);
  }

  // --- classify each resource: degraded / syncing / copies / cause ---
  const degradedAll = [];
  const syncingAll = [];
  let atOneCopy = 0;
  for (const g of byResource.values()) {
    const diskful = g.placements.filter(p => p.anyDiskful || !p.diskless);
    const wantCopies = diskful.length;
    const healthyCopies = diskful.filter(p => p.healthy && !offlineNodes.has(p.node) && !maintenanceNodes.has(p.node)).length;
    if (wantCopies >= 2 && healthyCopies === 1) atOneCopy += 1;

    const causes = [];
    let syncing = false;
    let syncPct = null;
    let worstState = '';
    let explainedByDownNode = false;
    let maintenanceExplained = false;

    for (const p of g.placements) {
      if (maintenanceNodes.has(p.node)) { maintenanceExplained = true; continue; } // never pages
      if (offlineNodes.has(p.node)) { explainedByDownNode = true; causes.push(`${p.node} OFFLINE`); worstState = worstState || 'Offline'; continue; }
      if (p.syncing) { syncing = true; if (p.syncPct != null) syncPct = Math.max(syncPct ?? 0, p.syncPct); continue; }
      if (p.worst && UNHEALTHY_DISK_STATES.has(p.worst)) { causes.push(`${p.worst} on ${p.node}`); worstState = worstState || p.worst; }
    }
    // peer disconnects between two live, non-maintenance nodes
    for (const c of Object.values(g.connections)) {
      if (c.connected) continue;
      if (maintenanceNodes.has(c.from) || maintenanceNodes.has(c.to)) continue;
      if (offlineNodes.has(c.from) || offlineNodes.has(c.to)) continue; // folded into node page
      causes.push(`peer disconnect ${c.from}↔${c.to}`);
      worstState = worstState || 'Disconnected';
    }

    const pagingCauses = causes.filter(c => !/OFFLINE$/.test(c)); // OFFLINE folds into node page
    const isDegraded = causes.length > 0;
    const cause = causes[0] || '';

    if (isDegraded && !(maintenanceExplained && causes.length === 0)) {
      const row = {
        name: g.name,
        vmid: g.vmid || null,
        group: g.group || null,
        placement: diskful.map(p => p.node).join(' ↔ '),
        nodes: g.placements.map(p => p.node),
        worstState: worstState || 'Degraded',
        cause,
        explainedByDownNode,
        copies: { have: healthyCopies, want: wantCopies },
        since: edgeSince(inst, `res:${g.name}`, true, now),
        // paging = has a live-node cause not explained by an already-paged node
        paging: pagingCauses.length > 0,
      };
      degradedAll.push(row);
    } else {
      edgeSince(inst, `res:${g.name}`, false, now); // recovered → drop edge
    }

    if (syncing) {
      syncingAll.push({
        name: g.name,
        vmid: g.vmid || null,
        placement: diskful.map(p => p.node).join(' → '),
        syncPct,
        copies: { have: healthyCopies, want: wantCopies },
      });
    }
  }

  // resource counts per node (for the row "N resources")
  for (const g of byResource.values()) {
    for (const p of g.placements) {
      const n = nodeByName.get(p.node);
      if (n) n.resourceCount += 1;
    }
  }

  // worst-first ordering + cap (D10); true totals preserved in counters
  degradedAll.sort((a, b) => (a.copies.have - b.copies.have) || (b.paging - a.paging));
  syncingAll.sort((a, b) => (a.syncPct ?? 101) - (b.syncPct ?? 101));
  const degraded = degradedAll.slice(0, DEGRADED_CAP);
  const syncing = syncingAll.slice(0, DEGRADED_CAP);

  // --- card-level warns (never page) ---
  const warns = [];
  for (const n of nodes) {
    if (n.maintenanceOnline) warns.push({ type: 'maintenance-online', node: n.name, msg: `${n.name} in maintenance but ONLINE — forgot to clear?` });
  }

  // --- error reports (warn-only, every 4th cycle) ---
  let errors = { errors24h: rt(inst).errorWindow.length, errors1h: 0 };
  if (state.tick % ERRORS_EVERY_N === 1) {
    errors = await refreshErrorWindow(inst, now);
  } else {
    const hourAgo = now - 3600 * 1000;
    errors = { errors24h: state.errorWindow.length, errors1h: state.errorWindow.filter(e => e.time >= hourAgo).length };
  }

  // --- controller version (best-effort, cheap) ---
  let version = state.lastGood?.version || null;
  try { version = (await apiGet(inst, '/v1/controller/version')).version || version; } catch { /* non-fatal */ }

  // --- resource groups (best-effort) ---
  // The group name lives on /v1/resource-definitions, NOT on the resource view.
  // It rarely changes, so fetch it on a slow cadence and cache across cycles.
  if (state.groups == null || state.tick % 8 === 1) {
    try {
      const rd = await apiGet(inst, '/v1/resource-definitions');
      const rows = Array.isArray(rd) ? rd : (rd.data || []);
      state.groups = [...new Set(rows.map(r => r.resource_group_name).filter(Boolean))];
    } catch { if (state.groups == null) state.groups = []; }
  }
  const groups = state.groups || [];

  const worstPool = nodes.map(n => n.pool).filter(Boolean).sort((a, b) => (b.worstPct ?? -1) - (a.worstPct ?? -1))[0] || null;
  const summary = {
    nodes: nodes.length,
    nodesOnline: nodes.filter(n => n.online && !n.maintenance).length,
    nodesOffline: nodes.filter(n => n.alertableOffline).length,
    nodesMaintenance: nodes.filter(n => n.maintenance).length,
    resources: byResource.size,
    degraded: degradedAll.filter(r => r.paging).length,
    degradedAll: degradedAll.length,
    syncing: syncingAll.length,
    atOneCopy,
    worstPoolPct: worstPool ? worstPool.worstPct : null,
    worstPoolNode: worstPool ? worstPool.node : null,
    worstPoolMeta: worstPool ? !!worstPool.metaDrives : false,
    freeTiB: nodes.reduce((s, n) => s + (n.pool?.freeTiB || 0), 0),
    errors24h: errors.errors24h,
  };

  // nodes sort: unexpected-offline first, then degraded, maintenance last, then name
  nodes.sort((a, b) => {
    const rank = n => n.alertableOffline ? 0 : n.maintenance ? 2 : 1;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  const row = {
    online: true,
    name: inst.name,
    url: inst.url,
    error: '',
    version,
    resourceGroup: groups.length === 1 ? groups[0] : null,
    groupCount: groups.length,
    nodes,
    degraded,
    syncing,
    degradedTotal: degradedAll.length,
    syncingTotal: syncingAll.length,
    // down-node fold-in for the node message: resources degraded per offline node
    offlineNodeImpact: [...offlineNodes].map(nn => ({
      node: nn,
      resources: degradedAll.filter(r => r.nodes.includes(nn)).length,
    })),
    warns,
    errors24h: errors.errors24h,
    errors1h: errors.errors1h,
    unreachableStreak: 0,
    ctrlPaging: false,
    stale: false,
    summary,
  };
  state.lastGood = row;
  return row;
}

function aggregate(instances) {
  const s = {
    instances: instances.length,
    up: instances.filter(i => i.online || i.stale).length,
    down: instances.filter(i => !i.online && !i.stale).length,
    nodes: 0, nodesOnline: 0, nodesOffline: 0, nodesMaintenance: 0,
    resources: 0, degraded: 0, syncing: 0, atOneCopy: 0,
    worstPoolPct: null, worstPoolNode: null, worstPoolMeta: false,
    freeTiB: 0, errors24h: 0,
  };
  for (const i of instances) {
    const sm = i.summary || {};
    s.nodes += sm.nodes || 0;
    s.nodesOnline += sm.nodesOnline || 0;
    s.nodesOffline += sm.nodesOffline || 0;
    s.nodesMaintenance += sm.nodesMaintenance || 0;
    s.resources += sm.resources || 0;
    s.degraded += sm.degraded || 0;
    s.syncing += sm.syncing || 0;
    s.atOneCopy += sm.atOneCopy || 0;
    s.freeTiB += sm.freeTiB || 0;
    s.errors24h += sm.errors24h || 0;
    if (sm.worstPoolPct != null && (s.worstPoolPct == null || sm.worstPoolPct > s.worstPoolPct)) {
      s.worstPoolPct = sm.worstPoolPct;
      s.worstPoolNode = sm.worstPoolNode;
      s.worstPoolMeta = sm.worstPoolMeta;
    }
  }
  return s;
}

async function getAllLinstorData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) {
    return { online: false, error: 'No LINSTOR controllers configured', summary: aggregate([]), instances: [] };
  }
  const rows = await mapLimit(instances, Number(config.concurrency || 2), inst => getLinstorInstance(inst));
  const summary = aggregate(rows);
  const firstError = rows.find(r => !r.online && !r.stale)?.error || '';
  if (rows.some(r => r.online)) flushHistory(); // debounced pool-series + edge persistence
  return { online: rows.some(r => r.online || r.stale), error: firstError, summary, instances: rows };
}

// Settings "Test connection": isolated runtime, destroyed after — never nudges
// the production instance's unreachable counter. Returns version + node count.
async function testLinstorConnection(input = {}) {
  const inst = { ...input, name: input.name || 'test', _rtKey: `test:${cleanBaseUrl(input.url)}:${input._nonce || 'x'}` };
  const out = { ok: false };
  try {
    const version = await apiGet(inst, '/v1/controller/version');
    const nodes = await apiGet(inst, '/v1/nodes');
    const list = Array.isArray(nodes) ? nodes : (nodes.data || []);
    out.ok = true;
    out.version = version.version || null;
    out.restApiVersion = version.rest_api_version || null;
    out.nodes = list.length;
    return out;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    const state = runtime.get(inst._rtKey);
    try { state?.agent?.destroy(); } catch {}
    runtime.delete(inst._rtKey);
  }
}

// Test hook: reset module runtime + discard in-memory history and any pending
// debounced save so fixture data never flushes into data/linstor-history.yaml.
function _resetRuntime() {
  for (const state of runtime.values()) {
    try { state.agent?.destroy(); } catch {}
  }
  runtime.clear();
  linHistory.clear();
  try { cancelHistorySaves('linstor-history'); } catch {}
}

// Persist history on a debounce after each successful aggregate (called by the
// scheduler wrapper in server.js is unnecessary — we save opportunistically).
function flushHistory() {
  scheduleSaveHistoryMap('linstor-history', linHistory, LINSTOR_HISTORY_MAX);
}

module.exports = {
  getAllLinstorData,
  configuredInstances,
  testLinstorConnection,
  flushHistory,
  _resetRuntime,
  // exported for unit-level fixtures
  UNREACHABLE_STREAK,
  DEGRADED_CAP,
};
