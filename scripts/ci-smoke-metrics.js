// Exercise real notification timing with controlled time and local delivery stubs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./ci-smoke-cloudflare');
const { classifyTemperatureMetrics } = require('../src/snmp');
const http = require('http');
const vm = require('vm');
const { getPrometheusData } = require('../src/prometheus');
const { normalizeUnpollerTemperatures, applyUnpollerTemperature } = require('../src/unifiTemperature');

const KEY = 'lx:debk8s03:cpu';
function cpu(value) {
  return {
    key: KEY, label: 'Server debk8s03 CPU usage', detail: `${value}%`,
    kind: 'threshold', metric: 'CPU usage', value,
    thresholds: { warning: 80, critical: 90 }, threshold: value >= 90 ? 90 : 80,
    ok: value < 80, severity: value >= 90 ? 'critical' : value >= 80 ? 'warning' : 'normal',
  };
}
function anomaly(value, ok = false) {
  return {
    ...cpu(value), key: `${KEY}:anomaly`, kind: 'anomaly', metric: 'cpu',
    label: 'Server debk8s03 CPU usage anomaly', severity: 'critical',
    thresholds: undefined, durationSeconds: 120, ok,
  };
}

async function run() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const harness = () => {
    const h = createHarness(source);
    // A deliberately different default proves CPU usage resolves rules.cpu.
    h.context.config.alerts.rules = { default: { durationSeconds: 0 }, cpu: { durationSeconds: 60 } };
    h.mature([cpu(20)]);
    return h;
  };

  {
    const h = harness();
    h.poll([cpu(96), anomaly(96)]);
    h.advance(59000);
    h.poll([cpu(95), anomaly(95)]);
    assert.strictEqual(h.history.length, 0, 'a CPU spike shorter than rules.cpu must not notify');
    h.poll([cpu(20), anomaly(20, true)]);
    h.advance(180000);
    h.poll([cpu(20), anomaly(20, true)]);
    assert.strictEqual(h.history.length, 0, 'an unsent spike must not produce a recovery');
  }

  {
    const h = harness();
    h.poll([cpu(85)]);
    h.advance(60000);
    h.poll([cpu(86)]);
    await h.settleAll();
    assert.strictEqual(h.problems().length, 1, 'sustained CPU warning must notify');
    h.poll([cpu(96), anomaly(96)]);
    h.advance(30000);
    h.poll([cpu(89), anomaly(89)]);
    assert.strictEqual(h.problems().length, 1, 'brief escalation, downgrade and duplicate anomaly must stay quiet');
    h.poll([cpu(95), anomaly(95)]);
    h.advance(60000);
    h.poll([cpu(96), anomaly(96)]);
    await h.settleAll();
    assert.strictEqual(h.problems().length, 2, 'a sustained escalation must still notify');
    assert.ok(h.problems().every(entry => entry.key === KEY), 'threshold and anomaly must share one incident');
    h.poll([cpu(89), anomaly(89)]);
    h.advance(60000);
    h.poll([cpu(79), anomaly(79, true)]);
    h.advance(180000);
    h.poll([cpu(79), anomaly(79, true)]);
    assert.strictEqual(h.history.length, 2, 'near-threshold dips and downgrades must not resolve or notify');
    h.poll([cpu(70)]);
    h.advance(119000);
    h.poll([cpu(70)]);
    assert.strictEqual(h.history.length, 2, 'recovery must wait for two stable minutes');
    h.poll([cpu(85)]);
    h.poll([cpu(70)]);
    h.advance(119000);
    h.poll([cpu(70)]);
    assert.strictEqual(h.history.length, 2, 'another spike must restart the recovery timer');
    h.advance(1000);
    h.poll([cpu(70)]);
    await h.settleAll();
    assert.strictEqual(h.history.length, 3);
    assert.strictEqual(h.history[2].type, 'recovery', 'one sustained recovery must notify once');
    h.poll([cpu(70)]);
    assert.strictEqual(h.history.length, 3);
    h.poll([cpu(95)]);
    h.advance(60000);
    h.poll([cpu(95)]);
    assert.strictEqual(h.problems().length, 3, 'a genuinely new CPU incident must still notify');
    await h.settleAll();
  }

  {
    const h = harness();
    h.poll([cpu(70), anomaly(70)]);
    h.advance(119000);
    h.poll([cpu(70), anomaly(70)]);
    assert.strictEqual(h.history.length, 0, 'below-threshold anomaly must honor its own duration');
    h.advance(1000);
    h.poll([cpu(70), anomaly(70)]);
    await h.settleAll();
    assert.strictEqual(h.problems().length, 1, 'anomalies below the absolute threshold must remain detectable');
    h.poll([cpu(96), anomaly(96)]);
    h.advance(120000);
    h.poll([cpu(96), anomaly(96)]);
    assert.strictEqual(h.problems().length, 1, 'crossing the threshold must not duplicate an active critical anomaly');
  }

  {
    const h = harness();
    h.poll([cpu(95)]);
    h.advance(45000);
    h.poll([]);
    h.advance(180000);
    h.poll([cpu(95)]);
    assert.strictEqual(h.history.length, 0, 'missing telemetry must reset the pending duration');
  }

  for (const label of ['temp-CPU', 'temp_cpu', 'cpu_thermal', 'cpu0', 'CPU-0', 'SoC', 'soc_thermal']) {
    const metrics = classifyTemperatureMetrics([{ label, value: 67 }]);
    assert.strictEqual(metrics.cpu?.value, 67, `${label} must remain a CPU sensor`);
  }
  const other = classifyTemperatureMetrics([
    { label: 'board', value: 45 }, { label: 'NVMe SSD', value: 51 },
    { label: 'Sensor 1', value: 58 }, { label: 'cpu', value: null },
  ]);
  assert.strictEqual(other.cpu, null, 'missing temperatures must not become a zero-degree CPU reading');
  assert.strictEqual(other.system.value, 45);
  assert.strictEqual(other.nvmeTemps[0].value, 51);
  assert.strictEqual(other.rows.length, 3, 'generic sensors must be retained without inventing a CPU label');

  const now = Date.now();
  const metric = { name: 'Grenade', temp_area: 'CPU', temp_type: 'cpu', type: 'udm', source: 'https://10.0.0.1', site_name: 'Default (default)' };
  const vector = rows => ({ status: 'success', data: { resultType: 'vector', result: rows } });
  const samples = normalizeUnpollerTemperatures(vector([
    { metric, value: [now / 1000, '74.3'] },
    { metric, value: [now / 1000, 'NaN'] },
    { metric, value: [now / 1000, '0'] },
    { metric, value: [(now - 121000) / 1000, '70'] },
    { metric: { ...metric, temp_area: 'Board', temp_type: 'board' }, value: [now / 1000, '40'] },
  ]), now);
  assert.strictEqual(samples.length, 1, 'only valid, recent CPU samples may be used');
  const device = { name: 'dream7', profile: 'unifi', host: '10.0.0.1' };
  const native = { cpuTemp: null, cpu: 20, ram: { percent: 40 }, systemTemperature: 45, sensors: { temperatures: [] } };
  const enriched = applyUnpollerTemperature(device, native, samples, now);
  assert.strictEqual(enriched.cpuTemp, 74.3, 'gateway source URL must match despite different Grafana and OmniSight names');
  assert.strictEqual(enriched.temperatureSource, 'unpoller');
  assert.strictEqual(enriched.systemTemperature, 45, 'fresh board temperatures must be preserved');
  assert.strictEqual(enriched.cpu, 20, 'CPU utilization must remain untouched');
  const fresh = { ...native, cpuTemp: 72, temperatureStale: false };
  assert.strictEqual(applyUnpollerTemperature(device, fresh, samples, now), fresh, 'fresh SNMP CPU temperature must take precedence');
  assert.strictEqual(applyUnpollerTemperature(device, native, samples, now + 121000), native, 'expired Prometheus samples must not look live');
  assert.strictEqual(applyUnpollerTemperature({ ...device, host: '10.0.0.2' }, native, samples, now), native, 'another device must not inherit the controller temperature');
  assert.strictEqual(applyUnpollerTemperature(device, native, [{ ...samples[0], type: 'uap' }], now), native, 'an AP must not match its controller URL as a gateway');
  assert.strictEqual(applyUnpollerTemperature({ ...device, profile: 'mikrotik' }, native, samples, now), native);
  assert.strictEqual(applyUnpollerTemperature({ ...device, host: '10.0.0.2', name: 'Grenade' }, native,
    [...samples, { ...samples[0], sourceHost: 'other-controller' }], now), native, 'ambiguous device names across controllers must not match');
  const stale = applyUnpollerTemperature(device, { ...native, cpuTemp: 71, temperatureStale: true }, samples, now);
  assert.strictEqual(stale.cpuTemp, 74.3);
  assert.strictEqual(stale.temperatureStale, false);
  assert.strictEqual(stale.systemTemperature, null, 'old board readings must not be relabeled fresh alongside a new CPU reading');

  let queryCount = 0;
  let rejectQuery = false;
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    assert.strictEqual(req.headers.authorization, 'Bearer fixture-token');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v1/targets') return res.end(JSON.stringify({ status: 'success', data: { activeTargets: [{ health: 'up', labels: { instance: 'unifi-poller:9130' } }] } }));
    assert.strictEqual(url.searchParams.get('query'), 'unpoller_device_temperature_celsius[2m]');
    queryCount += 1;
    if (rejectQuery) { res.statusCode = 500; return res.end('{}'); }
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [
      { metric, values: [[(Date.now() - 60000) / 1000, '73'], [Date.now() / 1000, '74.3']] },
    ] } }));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  try {
    const cfg = { url: `http://127.0.0.1:${fixture.address().port}`, bearerToken: 'fixture-token' };
    await getPrometheusData(cfg);
    assert.strictEqual(queryCount, 0, 'unrelated Prometheus installations must not query UniFi metrics');
    const data = await getPrometheusData(cfg, { collectUnifiTemperatures: true });
    assert.strictEqual(data.summary.up, 1);
    assert.strictEqual(data.unifiTemperatures.length, 1);
    assert.strictEqual(applyUnpollerTemperature(device, native, data.unifiTemperatures).cpuTemp, 74.3);
    const ctx = {};
    const functions = ['prometheusConfigInstances', 'promKeys', 'findPromRow', 'recomputePrometheusSummary', 'mergePrometheusConfigured'];
    vm.runInNewContext(functions.map(name => {
      const start = source.indexOf(`function ${name}(`);
      const end = source.indexOf('\n}', start);
      assert.ok(start >= 0 && end > start);
      return source.slice(start, end + 2);
    }).join('\n'), ctx);
    const shell = ctx.mergePrometheusConfigured(data, cfg);
    assert.strictEqual(shell.unifiTemperatures.length, 1, 'runtime shell reconciliation must retain temperature samples between collector cycles');
    assert.strictEqual(applyUnpollerTemperature(device, native, shell.unifiTemperatures).cpuTemp, 74.3);
    const removed = ctx.mergePrometheusConfigured(data, { url: 'http://replacement.invalid' });
    assert.strictEqual(removed.unifiTemperatures.length, 0, 'removing a Prometheus source must remove its temperature samples');
    rejectQuery = true;
    const failed = await getPrometheusData(cfg, { collectUnifiTemperatures: true });
    assert.ok(failed.online, 'an optional temperature query failure must not mark Prometheus down');
    assert.strictEqual(failed.unifiTemperatures.length, 0);
    assert.strictEqual(failed.summary.up, 1);
  } finally {
    await new Promise(resolve => fixture.close(resolve));
  }
  console.log('smoke ok — CPU incident coalescing, duration, escalation, stable recovery and sensor labels');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
