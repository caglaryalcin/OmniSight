#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function testQnap() {
  let loginQuery = null;
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/cgi-bin/authLogin.cgi') {
      loginQuery = url.searchParams;
      res.setHeader('Content-Type', 'text/xml');
      return res.end('<QDocRoot><authPassed>1</authPassed><authSid>sid123</authSid><displayModelName>TS-464</displayModelName><firmwareVersion>5.2.9</firmwareVersion><firmwareBuild>20250623</firmwareBuild></QDocRoot>');
    }
    if (url.pathname === '/cgi-bin/filemanager/utilRequest.cgi') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ status: 1, server_name: 'qnap01' }));
    }
    res.statusCode = 404;
    res.end('missing');
  });
  try {
    const { getAllQnapData } = require('../src/qnap');
    const url = `http://127.0.0.1:${server.address().port}`;
    const data = await getAllQnapData({ url, username: 'admin', password: 'pässword' });
    assert.strictEqual(loginQuery.get('pwd'), Buffer.from('pässword', 'utf8').toString('base64'));
    assert.strictEqual(loginQuery.get('serviceKey'), '1');
    assert.strictEqual(loginQuery.has('service'), false);
    assert.strictEqual(data.instances[0].system.hostname, 'qnap01');
    assert.strictEqual(data.instances[0].system.model, 'TS-464');
  } finally {
    await close(server);
  }
}

async function testPbs() {
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.match(String(req.headers.authorization || ''), /^PBSAPIToken=/);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api2/json/admin/datastore') return res.end(JSON.stringify({ data: [{ store: 'backup' }] }));
    if (url.pathname === '/api2/json/admin/datastore/backup/status') return res.end(JSON.stringify({ data: { total: 1000, used: 250, counts: { groups: 2, snapshots: 8 } } }));
    res.statusCode = 403;
    res.end(JSON.stringify({ message: 'optional endpoint denied' }));
  });
  try {
    const { getAllPbsData } = require('../src/pbs');
    const url = `http://127.0.0.1:${server.address().port}`;
    const data = await getAllPbsData({ url, tokenId: 'monitor@pbs!omnisight', tokenSecret: 'secret' });
    assert.strictEqual(data.online, true);
    assert.strictEqual(data.instances[0].partial, false, 'optional PBS endpoints must not mark core datastore data partial');
    assert.ok(data.instances[0].warnings.length >= 2);
    assert.strictEqual(data.instances[0].summary.snapshots, 8);
  } finally {
    await close(server);
  }
}

function testDockerAndDockhand() {
  const { cpuPercent, memoryUsage, memoryFromCli, resourceSummary } = require('../src/docker');
  const stats = {
    cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 8 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 600, limit: 1000, stats: { total_inactive_file: 200 } },
  };
  assert.strictEqual(cpuPercent(stats), 20, 'CPU must be host percentage, not one-core percentage');
  assert.deepStrictEqual(memoryUsage(stats), { usage: 400, limit: 1000, percent: 40 });
  assert.deepStrictEqual(memoryFromCli('256MiB / 2GiB'), { usage: 256 * 1024 ** 2, limit: 2 * 1024 ** 3, percent: 12.5 });
  assert.deepStrictEqual(resourceSummary([
    { cpu: 70, memUsageBytes: 200, memLimitBytes: 1000 },
    { cpu: 50, memUsageBytes: 100, memLimitBytes: 1000 },
  ]), { cpu: 100, memPercent: 30 });

  const { enrichDockhandWithDocker } = require('../src/dockhand');
  const enriched = enrichDockhandWithDocker({
    containers: [{ id: 'abcdef123456', name: 'web', image: 'nginx:latest', imageUpdate: { status: 'unknown' } }],
    instances: [{ name: 'dockhand', containers: [{ id: 'abcdef123456', name: 'web', image: 'nginx:latest' }] }],
  }, [{ containers: [{ id: 'abcdef123456', name: 'web', image: 'nginx:latest', cpu: 12, memPercent: 8, imageUpdate: { status: 'update' } }] }]);
  assert.strictEqual(enriched.containers[0].cpu, 12);
  assert.strictEqual(enriched.instances[0].containers[0].memPercent, 8);
  assert.strictEqual(enriched.containers[0].imageUpdate.status, 'update');
}

function testProxmoxInstances() {
  const { configuredInstances } = require('../src/proxmox');
  assert.strictEqual(configuredInstances({ url: 'https://pve-a:8006', tokenId: 'a', tokenSecret: 'x' }).length, 1);
  const rows = configuredInstances({ instances: [
    { name: 'a', url: 'https://pve-a:8006', tokenId: 'a', tokenSecret: 'x' },
    { name: 'b', url: 'https://pve-b:8006', tokenId: 'b', tokenSecret: 'y' },
  ] });
  assert.deepStrictEqual(rows.map(row => row.name), ['a', 'b']);
}

function testLatestStableVersion() {
  const { semverCompare, highestStableVersion } = require('../src/version');
  const releases = [
    { tag_name: 'v2.1.1' },
    { tag_name: 'v2.0.4' },
    { tag_name: 'v2.2.0' },
    { tag_name: 'v2.3.0-beta.1' },
  ];
  assert.strictEqual(highestStableVersion(releases, item => item.tag_name).tag_name, 'v2.2.0');
  assert.ok(semverCompare('2.2.0', '2.1.1') > 0);
}

function testStaticRegressions() {
  const root = path.join(__dirname, '..');
  const windowsAgent = fs.readFileSync(path.join(root, 'agent', 'omnisight-agent.ps1'), 'utf8');
  const linuxAgent = fs.readFileSync(path.join(root, 'agent', 'omnisight-agent.sh'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const snmp = fs.readFileSync(path.join(root, 'src', 'snmp.js'), 'utf8');
  assert.ok(!windowsAgent.includes('Get-Counter'), 'localized Windows counters must not return');
  assert.ok(windowsAgent.includes('Win32_PerfFormattedData_PerfDisk_PhysicalDisk'));
  assert.ok(windowsAgent.includes('Get-UpdateStatus') && linuxAgent.includes('updates_json'));
  assert.ok(server.includes("synology: 'Synology'"), 'public status title must say Synology');
  assert.ok(dashboard.includes('/api/status/history?points='));
  assert.ok(dashboard.includes("const clusterLabel = /^https?:\\/\\//i"), 'Proxmox node subtitle must hide a URL-shaped cluster fallback');
  assert.ok(dashboard.includes('min-width:140px;display:grid;grid-template-columns:minmax(72px,max-content)'), 'Proxmox metric values must keep enough visible width');
  assert.ok(dashboard.includes("pveHeadStat('Bandwidth'"), 'Proxmox bandwidth label must not use an unclear abbreviation');
  assert.ok(dashboard.includes('title="${escAttr(`${label}: ${value}`)}"'), 'header metrics must expose their complete value as a tooltip');
  assert.ok(dashboard.includes("os_app_update_footer_v3") && dashboard.includes("cache:'no-store'"), 'app update check must bypass stale browser responses');
  assert.ok(!dashboard.includes("cachedUpdate || fetch('/api/update-check'"), 'cached app version must not replace the GitHub update request');
  assert.ok(dashboard.includes('@container (max-width:300px)') && dashboard.includes('-webkit-line-clamp:2'), 'overview titles must adapt to narrow cards');
  assert.ok(dashboard.includes('function overviewMetaHtml(meta)'), 'overview metadata must be rendered as separate metrics');
  assert.ok(dashboard.includes('.overview-meta-part+.overview-meta-part::before'), 'wide overview metadata must keep its separator');
  assert.ok(dashboard.includes('.overview-meta{flex-direction:column;align-items:flex-start'), 'narrow overview metadata must wrap each metric onto its own line');
  assert.ok(dashboard.includes('grid-template-columns:repeat(auto-fit,minmax(78px,1fr))'), 'dense overview summaries must adapt their column count');
  assert.ok(dashboard.includes('.overview-card .sb-csum{grid-template-columns:repeat(2,minmax(0,1fr))'), 'narrow overview summaries must use two readable columns');
  assert.ok(server.includes('requestedHistoryPointLimit'));
  assert.match(deploy, /linux\/amd64,linux\/arm64/);
  assert.ok(fs.existsSync(path.join(root, 'src', 'unifi.js')));
  assert.ok(snmp.indexOf('const raw = await ucdRawCpu') < snmp.indexOf('cpuUser == null && synologyCpuUser'), 'UCD CPU must take priority over Synology vendor CPU');
  assert.ok(snmp.indexOf("snmpWalk(session, '1.3.6.1.2.1.25.3.3.1.2')") < snmp.indexOf('cpuUser == null && synologyCpuUser'), 'HOST-RESOURCES CPU must take priority over Synology vendor CPU');
}

async function run() {
  await testQnap();
  await testPbs();
  testDockerAndDockhand();
  testProxmoxInstances();
  testLatestStableVersion();
  testStaticRegressions();
  console.log('smoke ok — issue regressions: #4 #5 #6 #7 #9 #10 #12 #18 #20 #22 #23 #24');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
