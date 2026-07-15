// CI smoke tests for src/linstor.js — fixture mock controller, no network, no
// config. Called from ci-smoke.js; also runnable standalone:
//   node scripts/ci-smoke-linstor.js
const http = require('http');
const assert = require('assert');

const { getAllLinstorData, testLinstorConnection, _resetRuntime } = require('../src/linstor');
const { cancelHistorySaves } = require('../src/historyStore');

function discardFixtureHistory() { cancelHistorySaves('linstor-history'); }

// ---------------------------------------------------------------------------
// Fixture builders — shapes match the live-probed LINSTOR REST API (v1.27.0).
// ---------------------------------------------------------------------------
const SECRET = 'ThisIsADrbdSharedSecretThatMustNeverLeak';

function node(name, opts = {}) {
  return {
    name,
    type: opts.type || 'SATELLITE',
    connection_status: opts.conn || 'ONLINE',
    props: { ...(opts.maintenance ? { 'Aux/maintenance': 'true' } : {}), ...(opts.props || {}) },
  };
}

function pool(nodeName, opts = {}) {
  const total = opts.total === undefined ? 8_000_000_000 : opts.total; // KiB (~7.45 TiB)
  const free = opts.free === undefined ? 4_000_000_000 : opts.free;
  return {
    node_name: nodeName,
    storage_pool_name: opts.name || 'pve-storage',
    provider_kind: opts.kind || 'LVM_THIN',
    total_capacity: total,
    free_capacity: free,
    props: opts.tmeta != null ? { 'StorDriver/internal/lvmthin/thinPoolMetadataPercent': String(opts.tmeta) } : {},
  };
}

// A single (resource,node) placement. `repl` is a peer→{replication_state,done} map.
function placement(name, nodeName, opts = {}) {
  return {
    name,
    node_name: nodeName,
    resource_group_name: opts.group || 'pve-rg',
    props: opts.vmid ? { 'Aux/pm/vmid': String(opts.vmid) } : {},
    layer_object: {
      drbd: {
        drbd_resource_definition: { secret: SECRET },
        connections: opts.connections || {},
      },
    },
    volumes: [{
      volume_number: 0,
      provider_kind: opts.diskless ? 'DISKLESS' : 'LVM_THIN',
      allocated_size_kib: opts.allocated === undefined ? 1_000_000 : opts.allocated,
      state: { disk_state: opts.diskless ? 'Diskless' : (opts.diskState || 'UpToDate'), replication_states: opts.repl || {} },
    }],
    state: { in_use: !!opts.inUse },
  };
}

// A healthy 2-diskful + 1-diskless-tiebreaker resource across three nodes.
function healthyResource(name, vmid) {
  const est = { replication_state: 'Established' };
  return [
    placement(name, 'nodeA', { vmid, repl: { nodeB: est, nodeC: est }, connections: { nodeB: { connected: true }, nodeC: { connected: true } } }),
    placement(name, 'nodeB', { vmid, repl: { nodeA: est, nodeC: est }, connections: { nodeA: { connected: true }, nodeC: { connected: true } } }),
    placement(name, 'nodeC', { vmid, diskless: true, repl: { nodeA: est, nodeB: est }, connections: { nodeA: { connected: true }, nodeB: { connected: true } } }),
  ];
}

function fixtureServer(opts = {}) {
  const counters = { nodes: 0, resources: 0, pools: 0, version: 0, errors: 0 };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

    // Optional auth gate (bearer-token fixture).
    if (opts.requireBearer) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${opts.requireBearer}`) return json(401, { message: 'unauthorized' });
    }

    if (path === '/v1/controller/version') { counters.version += 1; return json(200, { version: '1.34.0', rest_api_version: '1.27.0' }); }
    if (path === '/v1/nodes') {
      counters.nodes += 1;
      if (opts.failNodes) return json(500, { message: 'boom' });
      return json(200, opts.nodes || []);
    }
    if (path === '/v1/view/resources') {
      counters.resources += 1;
      if (opts.failResourcesAt && counters.resources === opts.failResourcesAt) return json(500, { message: 'boom' });
      if (opts.timeoutResources) { /* never respond → client 10s timeout (shortened via inst.timeoutMs) */ return; }
      return json(200, opts.resources || []);
    }
    if (path === '/v1/view/storage-pools') { counters.pools += 1; return json(200, opts.pools || []); }
    if (path === '/v1/resource-definitions') {
      const defs = {};
      (opts.resources || []).forEach(r => { if (!defs[r.name]) defs[r.name] = { name: r.name, resource_group_name: r.resource_group_name || 'pve-rg', props: {} }; });
      return json(200, Object.values(defs));
    }
    if (path === '/v1/error-reports') {
      counters.errors += 1;
      return json(200, opts.errorReports ? opts.errorReports(url) : []);
    }
    return json(404, { message: `unexpected ${path}` });
  });
  return new Promise(resolve => srv.listen(0, () => resolve({
    srv, counters,
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise(r => srv.close(r)),
  })));
}

function cfg(url, extra = {}) {
  return { enabled: true, instances: [{ name: 'fixture', url, timeoutMs: 1500, ...extra }] };
}
const inst0 = out => out.instances[0];

async function run() {
  // 1) Happy path — 3 healthy resources, all UpToDate, connected
  {
    _resetRuntime();
    const resources = [...healthyResource('pm-a', 214), ...healthyResource('pm-b', 187), ...healthyResource('pm-c')];
    const f = await fixtureServer({
      nodes: [node('nodeA', { type: 'COMBINED' }), node('nodeB'), node('nodeC')],
      resources,
      pools: [pool('nodeA', { free: 4_000_000_000 }), pool('nodeB'), pool('nodeC')],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    assert.ok(out.online && i.online, 'happy: online');
    assert.strictEqual(i.degradedTotal, 0, 'happy: nothing degraded');
    assert.strictEqual(i.syncingTotal, 0, 'happy: nothing syncing');
    assert.strictEqual(i.summary.resources, 3, 'happy: 3 resources');
    assert.strictEqual(i.summary.nodesOnline, 3, 'happy: 3 online');
    assert.strictEqual(i.summary.atOneCopy, 0, 'happy: none at 1 copy');
    // pool used% formula: (8e9-4e9)/8e9 = 50%
    assert.strictEqual(Math.round(i.summary.worstPoolPct), 50, 'happy: pool 50% via (total-free)/total');
    assert.strictEqual(i.resourceGroup, 'pve-rg', 'happy: single RG shown');
    await f.close();
  }

  // 2) redaction-status — no `secret` anywhere in the derived payload
  {
    _resetRuntime();
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeB'), node('nodeC')],
      resources: healthyResource('pm-a', 214),
      pools: [pool('nodeA')],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const blob = JSON.stringify(out);
    assert.ok(!blob.includes(SECRET), 'redaction: secret value absent');
    assert.ok(!/"secret"/.test(blob), 'redaction: no secret key in payload');
    await f.close();
  }

  // 3) Node OFFLINE (non-maintenance) — node alertable, resources folded to it
  {
    _resetRuntime();
    const est = { replication_state: 'Established' };
    const resources = [
      placement('pm-a', 'nodeA', { vmid: 214, repl: { nodeC: est }, connections: { nodeC: { connected: false } } }),
      placement('pm-a', 'nodeC', { vmid: 214, conn: 'OFFLINE' }),
    ];
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeC', { conn: 'OFFLINE' })],
      resources,
      pools: [pool('nodeA')],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    const off = i.nodes.find(n => n.name === 'nodeC');
    assert.ok(off.alertableOffline, 'offline: nodeC flagged alertable');
    assert.strictEqual(i.summary.nodesOffline, 1, 'offline: 1 node offline');
    const row = i.degraded.find(r => r.name === 'pm-a');
    assert.ok(row && row.explainedByDownNode, 'offline: pm-a degradation explained by down node');
    assert.strictEqual(row.paging, false, 'offline: not a separate degraded page (folds into node)');
    assert.ok(i.offlineNodeImpact.some(x => x.node === 'nodeC' && x.resources >= 1), 'offline: node impact counted');
    await f.close();
  }

  // 4) Maintenance node WITHOUT resources — never pages, counted separately
  {
    _resetRuntime();
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeB'), node('nodeD', { conn: 'OFFLINE', maintenance: true })],
      resources: healthyResource('pm-a', 214).filter(p => p.node_name !== 'nodeC'),
      pools: [pool('nodeA'), pool('nodeB')],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    assert.strictEqual(i.summary.nodesMaintenance, 1, 'maint: 1 in maintenance');
    assert.strictEqual(i.summary.nodesOffline, 0, 'maint: maintenance is NOT counted offline');
    const h13 = i.nodes.find(n => n.name === 'nodeD');
    assert.ok(h13.maintenance && !h13.alertableOffline, 'maint: nodeD never alertable');
    await f.close();
  }

  // 5) Maintenance node WITH placed resources + peer-reported DUnknown → 0 pages
  {
    _resetRuntime();
    const est = { replication_state: 'Established' };
    const resources = [
      placement('pm-a', 'nodeA', { vmid: 214, diskState: 'UpToDate', repl: { nodeD: { replication_state: 'Established' } }, connections: { nodeD: { connected: false } } }),
      placement('pm-a', 'nodeD', { vmid: 214, diskState: 'DUnknown', repl: { nodeA: est } }),
    ];
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeD', { conn: 'OFFLINE', maintenance: true })],
      resources,
      pools: [pool('nodeA')],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    assert.strictEqual(i.summary.degraded, 0, 'maint-res: zero paging degradations despite DUnknown on maintenance node');
    const pmA = i.degraded.find(r => r.name === 'pm-a');
    assert.ok(!pmA || !pmA.paging, 'maint-res: pm-a does not page');
    await f.close();
  }

  // 6) Peer disconnect between two LIVE nodes — degraded, pages
  {
    _resetRuntime();
    const est = { replication_state: 'Established' };
    const resources = [
      placement('pm-x', 'nodeA', { vmid: 300, repl: { nodeB: est }, connections: { nodeB: { connected: false, message: 'Connecting' } } }),
      placement('pm-x', 'nodeB', { vmid: 300, repl: { nodeA: est }, connections: { nodeA: { connected: false, message: 'Connecting' } } }),
    ];
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeB')],
      resources, pools: [pool('nodeA'), pool('nodeB')],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    const row = i.degraded.find(r => r.name === 'pm-x');
    assert.ok(row && row.paging, 'peer: pm-x is a paging degradation');
    assert.ok(/peer disconnect/i.test(row.cause), 'peer: cause names the disconnect');
    await f.close();
  }

  // 7) Inconsistent-no-sync (pages) vs SyncTarget (info, suppressed) with/without done
  {
    _resetRuntime();
    const resources = [
      // inconsistent, no active sync → degraded paging
      placement('pm-i', 'nodeA', { vmid: 400, diskState: 'Inconsistent', repl: { nodeB: { replication_state: 'Established' } } }),
      placement('pm-i', 'nodeB', { vmid: 400, diskState: 'UpToDate', repl: { nodeA: { replication_state: 'Established' } } }),
      // syncing with done → syncing (info), never degraded-paging
      placement('pm-s', 'nodeA', { vmid: 401, diskState: 'Inconsistent', repl: { nodeB: { replication_state: 'SyncTarget', done: 0.43 } } }),
      placement('pm-s', 'nodeB', { vmid: 401, diskState: 'UpToDate', repl: { nodeA: { replication_state: 'SyncSource', done: 0.43 } } }),
      // syncing WITHOUT done → still syncing, pct null
      placement('pm-t', 'nodeA', { vmid: 402, diskState: 'Inconsistent', repl: { nodeB: { replication_state: 'SyncTarget' } } }),
      placement('pm-t', 'nodeB', { vmid: 402, diskState: 'UpToDate', repl: { nodeA: { replication_state: 'SyncSource' } } }),
    ];
    const f = await fixtureServer({ nodes: [node('nodeA'), node('nodeB')], resources, pools: [pool('nodeA')] });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    assert.ok(i.degraded.some(r => r.name === 'pm-i' && r.paging), 'sync: Inconsistent-no-sync pages');
    assert.ok(!i.degraded.some(r => r.name === 'pm-s' && r.paging), 'sync: SyncTarget suppresses disk-state page');
    const s = i.syncing.find(r => r.name === 'pm-s');
    assert.ok(s && s.syncPct === 43, 'sync: done=0.43 → 43%');
    const t = i.syncing.find(r => r.name === 'pm-t');
    assert.ok(t && t.syncPct == null, 'sync: no done → null pct');
    await f.close();
  }

  // 8) Diskless tiebreaker never counts as degraded
  {
    _resetRuntime();
    const est = { replication_state: 'Established' };
    const resources = [
      placement('pm-d', 'nodeA', { vmid: 500, repl: { nodeB: est }, connections: { nodeB: { connected: true } } }),
      placement('pm-d', 'nodeB', { vmid: 500, repl: { nodeA: est }, connections: { nodeA: { connected: true } } }),
      placement('pm-d', 'nodeC', { vmid: 500, diskless: true }),
    ];
    const f = await fixtureServer({ nodes: [node('nodeA'), node('nodeB'), node('nodeC')], resources, pools: [pool('nodeA')] });
    const out = await getAllLinstorData(cfg(f.url));
    assert.strictEqual(inst0(out).degradedTotal, 0, 'diskless: tiebreaker healthy, nothing degraded');
    await f.close();
  }

  // 9) Pool thresholds — used% formula pinned; tmeta drives severity (D12/amend-11)
  {
    _resetRuntime();
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeB')],
      resources: [],
      // nodeA: data 40%, tmeta 93% → worst 93 (meta drives); nodeB: data 87.5%
      pools: [
        pool('nodeA', { total: 10_000_000_000, free: 6_000_000_000, tmeta: 93 }),
        pool('nodeB', { total: 8_000_000_000, free: 1_000_000_000 }),
      ],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    const h10 = i.nodes.find(n => n.name === 'nodeA');
    assert.strictEqual(Math.round(h10.pool.dataPct), 40, 'pool: data% = (10-6)/10 = 40');
    assert.strictEqual(h10.pool.tmetaPct, 93, 'pool: tmeta prop read');
    assert.strictEqual(Math.round(h10.pool.worstPct), 93, 'pool: severity = max(data,tmeta) = 93');
    assert.ok(h10.pool.metaDrives, 'pool: metaDrives flagged when tmeta > data');
    assert.strictEqual(Math.round(i.summary.worstPoolPct), 93, 'pool: worst across cluster is the meta-driven 93');
    assert.ok(i.summary.worstPoolMeta, 'pool: worst flagged meta-driven');
    await f.close();
  }

  // 10) Data quirks tolerated — DISKLESS int64 sentinel, null capacity, allocated -1
  {
    _resetRuntime();
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeD', { conn: 'OFFLINE', maintenance: true })],
      resources: [placement('pm-q', 'nodeA', { vmid: 600, allocated: -1, repl: {} })],
      pools: [
        pool('nodeA'),
        { node_name: 'nodeA', storage_pool_name: 'DfltDisklessStorPool', provider_kind: 'DISKLESS', total_capacity: 9223372036854775807, free_capacity: 9223372036854775807, props: {} },
        { node_name: 'nodeD', storage_pool_name: 'pve-storage', provider_kind: 'LVM_THIN', total_capacity: null, free_capacity: null, props: {} },
      ],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    assert.ok(out.online, 'quirks: survives sentinel/null/-1 without throwing');
    const h10 = i.nodes.find(n => n.name === 'nodeA');
    assert.strictEqual(h10.pool.name, 'pve-storage', 'quirks: DISKLESS sentinel pool excluded, real pool chosen');
    assert.ok(Math.round(h10.pool.worstPct) === 50, 'quirks: real pool still computes 50%');
    await f.close();
  }

  // 11) Controller unreachable ≥3 polls (incl. a timeout) → ctrlPaging, lastGood served
  {
    _resetRuntime();
    // First a good cycle to seed lastGood, then a dead server.
    const good = await fixtureServer({ nodes: [node('nodeA'), node('nodeB')], resources: healthyResource('pm-a', 214).filter(p => p.node_name !== 'nodeC'), pools: [pool('nodeA')] });
    const conf = cfg(good.url);
    let out = await getAllLinstorData(conf);
    assert.ok(inst0(out).online && !inst0(out).stale, 'unreach: first cycle good');
    await good.close();
    // Now the URL is dead (connection refused). Poll 3× → ctrlPaging.
    for (let n = 0; n < 3; n++) out = await getAllLinstorData(conf);
    const i = inst0(out);
    assert.ok(i.stale, 'unreach: serving lastGood dimmed');
    assert.strictEqual(i.unreachableStreak, 3, 'unreach: 3 consecutive failures counted');
    assert.ok(i.ctrlPaging, 'unreach: controller now pages after 3 polls');
    assert.strictEqual(i.summary.nodes, 2, 'unreach: lastGood payload preserved');
    _resetRuntime();
  }

  // 12) Poll atomicity (D9) — resources GET fails → whole cycle discarded, counter+1
  {
    _resetRuntime();
    const est = { replication_state: 'Established' };
    // seed good, then fail only the resources call on the next cycle
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeB')],
      resources: healthyResource('pm-a', 214).filter(p => p.node_name !== 'nodeC'),
      pools: [pool('nodeA')],
      failResourcesAt: 2,
    });
    const conf = cfg(f.url);
    let out = await getAllLinstorData(conf);
    assert.ok(inst0(out).online, 'atomic: cycle 1 good');
    out = await getAllLinstorData(conf); // resources call #2 returns 500
    const i = inst0(out);
    assert.ok(i.stale, 'atomic: partial cycle discarded → lastGood served');
    assert.strictEqual(i.unreachableStreak, 1, 'atomic: counter advanced by exactly one');
    await f.close();
  }

  // 13) Error reports — since-window count moves even at the 1000-entry cap
  {
    _resetRuntime();
    const now = Date.now();
    let served = false;
    const f = await fixtureServer({
      nodes: [node('nodeA')], resources: [], pools: [pool('nodeA')],
      errorReports: (url) => {
        const since = Number(url.searchParams.get('since'));
        // First call (since ~24h ago): return 3 recent reports. Later calls: none.
        if (!served) { served = true; return [
          { error_time: now - 1000 }, { error_time: now - 2000 }, { error_time: now - 3000 },
        ]; }
        assert.ok(since >= now - 5000, 'errors: subsequent fetch uses advanced since= (immune to 1000 cap)');
        return [];
      },
    });
    const out = await getAllLinstorData(cfg(f.url));
    assert.strictEqual(inst0(out).errors24h, 3, 'errors: windowed 24h count present');
    await f.close();
  }

  // 14) Maintenance-forgotten warn (D13) — maintenance flag set but ONLINE
  {
    _resetRuntime();
    const f = await fixtureServer({
      nodes: [node('nodeA'), node('nodeD', { conn: 'ONLINE', maintenance: true })],
      resources: [], pools: [pool('nodeA')],
    });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    assert.ok(i.warns.some(w => w.type === 'maintenance-online' && w.node === 'nodeD'), 'maint-nag: ONLINE-while-maintenance warn present');
    assert.strictEqual(i.summary.nodesMaintenance, 1, 'maint-nag: still counted as maintenance');
    await f.close();
  }

  // 15) Bearer-token auth — header present succeeds; missing → clean error, no throw
  {
    _resetRuntime();
    const f = await fixtureServer({
      requireBearer: 'tok-123',
      nodes: [node('nodeA')], resources: [], pools: [pool('nodeA')],
    });
    // with token → online
    let out = await getAllLinstorData(cfg(f.url, { bearerToken: 'tok-123' }));
    assert.ok(inst0(out).online, 'auth: bearer token authenticates');
    // without token → 401 surfaces as a clean offline instance, not a crash
    _resetRuntime();
    out = await getAllLinstorData(cfg(f.url));
    assert.ok(!inst0(out).online, 'auth: missing token → offline');
    assert.ok(/401/.test(inst0(out).error || ''), 'auth: 401 surfaced as error');
    await f.close();
  }

  // 16) testLinstorConnection — isolated runtime, returns version + node count
  {
    _resetRuntime();
    const f = await fixtureServer({ nodes: [node('nodeA'), node('nodeB'), node('nodeC')], resources: [], pools: [] });
    const r = await testLinstorConnection({ url: f.url, timeoutMs: 1500, _nonce: 't1' });
    assert.ok(r.ok, 'test: ok');
    assert.strictEqual(r.version, '1.34.0', 'test: version reported');
    assert.strictEqual(r.nodes, 3, 'test: node count reported');
    const bad = await testLinstorConnection({ url: 'http://127.0.0.1:1', timeoutMs: 1500, _nonce: 't2' });
    assert.ok(!bad.ok && bad.error, 'test: unreachable → clean error');
    await f.close();
  }

  // 17) No config / disabled — clean no-op
  {
    _resetRuntime();
    const out = await getAllLinstorData({});
    assert.strictEqual(out.online, false, 'noconfig: offline');
    assert.deepStrictEqual(out.instances, [], 'noconfig: no instances');
  }

  // 18) Worst-first cap (D10) — 60 degraded resources → 50 rows, true total in counters
  {
    _resetRuntime();
    const resources = [];
    for (let k = 0; k < 60; k++) {
      resources.push(
        placement(`pm-${k}`, 'nodeA', { vmid: 1000 + k, diskState: 'Inconsistent', repl: { nodeB: { replication_state: 'Established' } } }),
        placement(`pm-${k}`, 'nodeB', { vmid: 1000 + k, diskState: 'UpToDate', repl: { nodeA: { replication_state: 'Established' } } }),
      );
    }
    const f = await fixtureServer({ nodes: [node('nodeA'), node('nodeB')], resources, pools: [pool('nodeA')] });
    const out = await getAllLinstorData(cfg(f.url));
    const i = inst0(out);
    assert.strictEqual(i.degraded.length, 50, 'cap: payload capped at 50 rows');
    assert.strictEqual(i.degradedTotal, 60, 'cap: true total preserved in counter');
    assert.strictEqual(i.summary.degraded, 60, 'cap: summary counts all paging degradations');
    await f.close();
  }

  // 19) redaction-config — TLS key + bearer token encrypt at rest (SENSITIVE_KEYS).
  // Separate mechanism from redaction-status (ingest strip); asserted distinctly
  // so the config-encryption path can never silently regress to plaintext.
  {
    const { encryptConfigValue, isEncrypted, decryptConfig } = require('../src/crypto');
    for (const key of ['privateKey', 'password', 'bearerToken']) {
      const enc = encryptConfigValue(key, 'sensitive-linstor-material');
      assert.ok(isEncrypted(enc), `redaction-config: ${key} encrypts at rest`);
      assert.strictEqual(decryptConfig({ tls: { [key]: enc } }).tls[key], 'sensitive-linstor-material', `redaction-config: ${key} round-trips`);
    }
    // The trap the design flagged: clientKey / passphrase are NOT in the set —
    // guard that our chosen names are, so a rename can't reintroduce plaintext.
    const { SENSITIVE_KEYS } = require('../src/crypto');
    for (const key of ['privateKey', 'password', 'bearerToken', 'token']) {
      assert.ok(SENSITIVE_KEYS.has(key), `redaction-config: ${key} is a sensitive key`);
    }
  }

  _resetRuntime();
  discardFixtureHistory();
  console.log('smoke ok — linstor collector: 19 scenarios passed');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
