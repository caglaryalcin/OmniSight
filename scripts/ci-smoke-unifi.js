// CI smoke tests for src/unifi.js — fixture mock server, no network, no config.
// Called from ci-smoke.js; also runnable standalone: node scripts/ci-smoke-unifi.js
const http = require('http');
const assert = require('assert');

const { getAllUnifiData, _resetRuntime } = require('../src/unifi');
const { cancelHistorySaves } = require('../src/historyStore');

// The collector schedules debounced history persistence; in a smoke run that
// would flush fixture data into data/unifi-history.yaml. Cancel after each use.
function discardFixtureHistory() {
  cancelHistorySaves('unifi-history');
}

const SITES = { offset: 0, limit: 1, count: 1, totalCount: 1, data: [{ id: 'site-1', internalReference: 'default', name: 'Default' }] };
const DEVICES = [
  { id: 'd-gw', name: 'gw-office', model: 'UDM-Pro', macAddress: 'AA:BB:CC:00:00:01', ipAddress: '192.168.30.1', state: 'ONLINE', firmwareVersion: '4.3.6', features: ['switching', 'gateway'] },
  { id: 'd-sw', name: 'sw-rack-1', model: 'USW-Pro-24', macAddress: 'AA:BB:CC:00:00:02', ipAddress: '192.168.30.2', state: 'ONLINE', firmwareVersion: '7.1.20' },
  { id: 'd-ap1', name: 'ap-warehouse', model: 'U6-Pro', macAddress: 'AA:BB:CC:00:00:03', ipAddress: '192.168.30.3', state: 'OFFLINE', firmwareVersion: '6.6.65' },
  { id: 'd-ap2', name: 'ap-frontdesk', model: 'U6-Lite', macAddress: 'AA:BB:CC:00:00:04', ipAddress: '192.168.30.4', state: 'UPDATING', firmwareVersion: '6.6.65' },
];
const STATS = {
  'd-gw': { cpuUtilizationPct: 22, memoryUtilizationPct: 61, uptimeSec: 3542400, uplink: { rxRateBps: 842e6, txRateBps: 96e6 } },
  'd-sw': { cpuUtilizationPct: 14, memoryUtilizationPct: 38, uptimeSec: 3542400, uplink: {} },
  'd-ap2': { cpuUtilizationPct: 48, memoryUtilizationPct: 52, uptimeSec: 120, uplink: {} },
};
const HEALTH = { data: [{ subsystem: 'www', status: 'ok', latency: 11, drops: 0 }, { subsystem: 'wan', status: 'ok' }] };

// Configurable fixture controller. opts:
//   selfHosted   — 404 the /proxy prefix so the /v1 fallback is exercised
//   pageLimit    — clamp device pages to this size (default 2 => multi-page)
//   truncate     — return fewer devices than totalCount claims (partial list)
//   health401Once— first stat/health per login is 401 (relogin path)
//   loginFails   — every legacy login is 500 (3-strike degrade)
//   devices429At — Nth device-list request answers 429 (cooldown path)
function fixtureServer(opts = {}) {
  const counters = { deviceLists: 0, logins: 0, health: 0 };
  let healthCallsThisLogin = 0;
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

    if (opts.selfHosted && path.startsWith('/proxy/')) return json(404, { error: 'not found' });
    const base = opts.selfHosted ? '/v1' : '/proxy/network/integration/v1';
    const legacyPrefix = opts.selfHosted ? '' : '/proxy/network';
    const loginPath = opts.selfHosted ? '/api/login' : '/api/auth/login';

    if (path === `${base}/sites`) return json(200, opts.twoSites
      ? { offset: 0, limit: 2, count: 2, totalCount: 2, data: [SITES.data[0], { id: 'site-2', internalReference: 'branch', name: 'Branch' }] }
      : SITES);

    if (opts.twoSites && path === `${base}/sites/site-2/devices`) {
      const only = [{ id: 'd-b1', name: 'branch-ap', model: 'U6-Lite', macAddress: 'AA:BB:CC:00:00:99', ipAddress: '192.168.40.2', state: 'ONLINE', firmwareVersion: '6.6.65' }];
      return json(200, { offset: 0, limit: 25, count: 1, totalCount: 1, data: only });
    }
    if (opts.twoSites && /\/sites\/site-2\/devices\/[^/]+\/statistics\/latest$/.test(path)) return json(200, {});

    if (path === `${base}/sites/site-1/devices`) {
      counters.deviceLists += 1;
      if (opts.devices429At && counters.deviceLists === opts.devices429At) return json(429, { error: 'rate limited' });
      let all = opts.truncate ? DEVICES.slice(0, 3) : DEVICES;
      if (opts.gatewayUpdating) all = all.map(d => d.id === 'd-gw' ? { ...d, state: 'UPDATING' } : d);
      const limit = Math.min(Number(url.searchParams.get('limit') || 25), opts.pageLimit || 2);
      const offset = Number(url.searchParams.get('offset') || 0);
      const page = all.slice(offset, offset + limit);
      return json(200, { offset, limit, count: page.length, totalCount: DEVICES.length, data: page });
    }

    const stat = path.match(new RegExp(`^${base}/sites/site-1/devices/([^/]+)/statistics/latest$`));
    if (stat) return json(200, STATS[stat[1]] || {});

    if (path === loginPath && req.method === 'POST') {
      counters.logins += 1;
      healthCallsThisLogin = 0;
      if (opts.loginFails) return json(500, { error: 'login rejected' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'TOKEN=fixture; Path=/', 'X-Csrf-Token': 'csrf-fixture' });
      return res.end('{}');
    }

    if (path === `${legacyPrefix}/api/s/default/stat/health`) {
      counters.health += 1;
      healthCallsThisLogin += 1;
      if (opts.health401Once && healthCallsThisLogin === 1 && counters.logins < 2) return json(401, { error: 'expired' });
      return json(200, HEALTH);
    }

    return json(404, { error: `unexpected path ${path}` });
  });
  return new Promise(resolve => srv.listen(0, () => resolve({
    srv,
    counters,
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise(r => srv.close(r)),
  })));
}

function cfg(url, extra = {}) {
  return { enabled: true, instances: [{ name: 'fixture', url, apiKey: 'k', ...extra }] };
}
const LEGACY = { legacy: { username: 'ro', password: 'pw' } };

async function run() {
  // 1) Happy path (UniFi OS prefix, multi-page pagination, legacy WAN quality)
  {
    _resetRuntime();
    const f = await fixtureServer();
    const out = await getAllUnifiData(cfg(f.url, LEGACY));
    const inst = out.instances[0];
    assert.ok(out.online && inst.online, 'happy: instance online');
    assert.strictEqual(inst.devices.length, 4, 'happy: pagination walked all pages');
    assert.ok(inst.devicesComplete, 'happy: totalCount corroborated');
    const byId = Object.fromEntries(inst.devices.map(d => [d.id, d]));
    assert.strictEqual(byId['d-ap1'].state, 'offline', 'happy: OFFLINE mapped');
    assert.ok(byId['d-ap1'].alertable, 'happy: OFFLINE is alertable');
    assert.ok(byId['d-ap2'].warn && !byId['d-ap2'].alertable, 'happy: UPDATING is warn, not alertable');
    assert.strictEqual(byId['d-gw'].cpu, 22, 'happy: gateway stats applied');
    assert.ok(byId['d-gw'].isGateway, 'happy: gateway detected');
    assert.ok((byId['d-gw'].aliases || []).includes('127.0.0.1'), 'happy: gateway aliased to controller URL host for SNMP dedupe');
    assert.strictEqual(inst.wan.state, 'up', 'happy: WAN up');
    assert.strictEqual(inst.wan.latencyMs, 11, 'happy: legacy latency present');
    assert.strictEqual(inst.wanQuality, 'ok', 'happy: wanQuality ok');
    assert.strictEqual(out.summary.devicesOffline, 1, 'happy: summary counts offline');
    await f.close();
  }

  // 2) Self-hosted base-path fallback; legacy unconfigured degrades gracefully
  {
    _resetRuntime();
    const f = await fixtureServer({ selfHosted: true });
    const out = await getAllUnifiData(cfg(f.url));
    const inst = out.instances[0];
    assert.ok(inst.online, 'selfhosted: online via /v1 fallback');
    assert.strictEqual(inst.unifiOs, false, 'selfhosted: prefix detection');
    assert.strictEqual(inst.wanQuality, 'unconfigured', 'selfhosted: no legacy creds -> unconfigured');
    assert.strictEqual(inst.wan.latencyMs, null, 'selfhosted: no latency without legacy');
    assert.strictEqual(inst.wan.state, 'up', 'selfhosted: WAN up/down still known from gateway');
    await f.close();
  }

  // 3) Legacy 401 -> single re-login -> quality ok
  {
    _resetRuntime();
    const f = await fixtureServer({ health401Once: true });
    const out = await getAllUnifiData(cfg(f.url, LEGACY));
    assert.strictEqual(out.instances[0].wanQuality, 'ok', '401: recovered after re-login');
    assert.strictEqual(f.counters.logins, 2, '401: exactly one re-login');
    await f.close();
  }

  // 4) Legacy 3-strike degrade: platform stays up, WAN quality marked failing
  {
    _resetRuntime();
    const f = await fixtureServer({ loginFails: true });
    const conf = cfg(f.url, LEGACY);
    let out;
    for (let i = 0; i < 3; i++) out = await getAllUnifiData(conf);
    const inst = out.instances[0];
    assert.ok(inst.online, '3strike: instance still online');
    assert.strictEqual(inst.wanQuality, 'unavailable', '3strike: quality unavailable');
    assert.ok(/legacy auth failing \(3 attempts\)/.test(inst.wanQualityError || ''), '3strike: labeled after 3 fails');
    await f.close();
  }

  // 5) 429 cooldown: last-good served stale, controller skipped for the window
  {
    _resetRuntime();
    // First cycle walks 2 pages (requests 1-2); request 3 is cycle two's first page.
    const f = await fixtureServer({ devices429At: 3 });
    const conf = cfg(f.url);
    const first = await getAllUnifiData(conf);
    assert.ok(first.instances[0].online && !first.instances[0].stale, '429: first cycle good');
    const second = await getAllUnifiData(conf);
    assert.ok(second.instances[0].stale, '429: last-good served stale');
    assert.strictEqual(second.instances[0].devices.length, 4, '429: stale payload is the last-good one');
    const listsAfter429 = f.counters.deviceLists;
    await getAllUnifiData(conf);
    await getAllUnifiData(conf);
    assert.strictEqual(f.counters.deviceLists, listsAfter429, '429: cooldown skips the controller');
    await f.close();
  }

  // 6) Partial pagination: totalCount mismatch -> devicesComplete=false (no prune signal)
  {
    _resetRuntime();
    const f = await fixtureServer({ truncate: true });
    const out = await getAllUnifiData(cfg(f.url));
    const inst = out.instances[0];
    assert.ok(inst.online, 'partial: still online');
    assert.strictEqual(inst.devices.length, 3, 'partial: got the rows that exist');
    assert.strictEqual(inst.devicesComplete, false, 'partial: incomplete list flagged — prune must not fire');
    await f.close();
  }

  // 6b) Multi-site: two instances, same controller URL, different sites —
  // runtime state must not be shared (site-2 must not inherit site-1's siteId)
  {
    _resetRuntime();
    const f = await fixtureServer({ twoSites: true });
    const out = await getAllUnifiData({ enabled: true, instances: [
      { name: 'hq', url: f.url, apiKey: 'k', site: 'default' },
      { name: 'branch', url: f.url, apiKey: 'k', site: 'branch' },
    ] });
    const byName = Object.fromEntries(out.instances.map(i => [i.name, i]));
    assert.ok(byName.hq.online && byName.branch.online, 'multisite: both instances online');
    assert.strictEqual(byName.hq.devices.length, 4, 'multisite: hq sees site-1 devices');
    assert.strictEqual(byName.branch.devices.length, 1, 'multisite: branch sees only site-2 devices');
    assert.strictEqual(byName.branch.devices[0].name, 'branch-ap', 'multisite: correct device on branch site');
    await f.close();
  }

  // 6c) Gateway in a transitional state (UniFi reprovision/firmware window):
  // WAN must be 'unknown', never 'down' — no phantom outage, no down-edge
  {
    _resetRuntime();
    const f = await fixtureServer({ gatewayUpdating: true });
    const out = await getAllUnifiData(cfg(f.url));
    const inst = out.instances[0];
    assert.ok(inst.online, 'gw-updating: instance online');
    assert.strictEqual(inst.wan.state, 'unknown', 'gw-updating: WAN unknown, not down');
    const hist = inst.wan.history || [];
    assert.strictEqual(hist[hist.length - 1].up, 1, 'gw-updating: no down-edge recorded');
    assert.strictEqual(out.summary.wanDown, 0, 'gw-updating: summary counts no WAN down');
    await f.close();
  }

  // 7) No config / disabled: clean no-op
  {
    _resetRuntime();
    const out = await getAllUnifiData({});
    assert.strictEqual(out.online, false, 'noconfig: offline');
    assert.deepStrictEqual(out.instances, [], 'noconfig: no instances');
  }

  // 8) Unreachable controller: error state, no throw
  {
    _resetRuntime();
    const out = await getAllUnifiData(cfg('http://127.0.0.1:1'));
    const inst = out.instances[0];
    assert.strictEqual(inst.online, false, 'unreachable: offline');
    assert.ok(inst.error, 'unreachable: error message present');
  }

  _resetRuntime();
  discardFixtureHistory();
  console.log('smoke ok — unifi collector: 10 scenarios passed');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
