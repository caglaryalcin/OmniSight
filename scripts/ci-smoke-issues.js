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
  const requests = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url);
    if (url.pathname === '/cgi-bin/authLogin.cgi') {
      loginQuery = url.searchParams;
      res.setHeader('Set-Cookie', 'QTS_SID=sid123; Path=/; HttpOnly');
      res.setHeader('Content-Type', 'text/xml');
      return res.end('<QDocRoot><authPassed><![CDATA[1]]></authPassed><authSid><![CDATA[sid123]]></authSid><hostname><![CDATA[qnap01]]></hostname><displayModelName><![CDATA[TBS-464]]></displayModelName><firmwareVersion><![CDATA[5.2.9]]></firmwareVersion><firmwareBuild><![CDATA[20260701]]></firmwareBuild></QDocRoot>');
    }
    if (url.pathname === '/cgi-bin/filemanager/utilRequest.cgi') {
      res.setHeader('Content-Type', 'application/json');
      if (url.searchParams.get('func') === 'check_sid') return res.end(JSON.stringify({ status: 1, server_name: 'qnap01' }));
      if (url.searchParams.get('func') === 'get_tree') return res.end(JSON.stringify([{ volume_id: 1, volume_name: 'System', volume_status: 0, capacity: 4, volume_unit: 'TB', free_size: 1, volume_free_unit: 'TB', used_size: 3, volume_used_unit: 'TB' }]));
    }
    if (url.pathname === '/cgi-bin/management/manaRequest.cgi') {
      res.setHeader('Content-Type', 'text/xml');
      return res.end('<?xml version="1.0"?><QDocRoot><authPassed><![CDATA[1]]></authPassed><model><displayModelName><![CDATA[TBS-464]]></displayModelName></model><firmware><version><![CDATA[5.2.9]]></version><build><![CDATA[20260701]]></build></firmware><func><ownContent><root><server_name><![CDATA[qnap01]]></server_name><cpu_model><![CDATA[Intel N5105]]></cpu_model><cpu_usage><![CDATA[13.7 %]]></cpu_usage><total_memory><![CDATA[8192]]></total_memory><free_memory><![CDATA[6144]]></free_memory><cpu_tempc>48</cpu_tempc><sys_tempc>42</sys_tempc><uptime_day>2</uptime_day><uptime_hour>3</uptime_hour><uptime_min>4</uptime_min><uptime_sec>5</uptime_sec></root></ownContent></func></QDocRoot>');
    }
    if (url.pathname === '/cgi-bin/disk/qsmart.cgi') {
      res.setHeader('Content-Type', 'text/xml');
      const entries = [1, 2, 3, 4].map(number => `<entry><Disk_Alias><![CDATA[M.2 SSD ${number}]]></Disk_Alias><Disk_Status>0</Disk_Status><HDNo><![CDATA[0:${number}]]></HDNo><Health><![CDATA[OK]]></Health><Capacity><![CDATA[931.51 GB]]></Capacity><Temperature><oC><![CDATA[${39 + number}]]></oC></Temperature><Model><![CDATA[WD Red SN700 NVMe]]></Model><Serial><![CDATA[NVME${number}]]></Serial><hd_is_ssd><![CDATA[1]]></hd_is_ssd></entry>`).join('');
      return res.end(`<QDocRoot><authPassed>1</authPassed><Disk_Info>${entries}</Disk_Info></QDocRoot>`);
    }
    if (url.pathname === '/cgi-bin/management/chartReq.cgi') {
      res.setHeader('Content-Type', 'text/xml');
      return res.end('<QDocRoot><authPassed><![CDATA[1]]></authPassed><volumeList><volume><volumeStat><![CDATA[raid5]]></volumeStat><volumeStatus>0</volumeStatus><volumeValue><![CDATA[1]]></volumeValue><volumeLabel><![CDATA[System]]></volumeLabel></volume></volumeList><volumeUseList><volumeUse><volumeValue><![CDATA[1]]></volumeValue><total_size><![CDATA[4398046511104]]></total_size><free_size><![CDATA[1099511627776]]></free_size></volumeUse></volumeUseList></QDocRoot>');
    }
    if (url.pathname === '/cgi-bin/authLogout.cgi') {
      res.setHeader('Content-Type', 'text/xml');
      return res.end('<QDocRoot><authPassed>1</authPassed></QDocRoot>');
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
    assert.strictEqual(data.instances[0].system.model, 'TBS-464');
    assert.strictEqual(data.instances[0].system.cpuPercent, 13.7);
    assert.strictEqual(data.instances[0].system.memoryPercent, 25);
    assert.strictEqual(data.instances[0].system.cpuTemp, 48);
    assert.strictEqual(data.instances[0].system.uptimeSeconds, 183845);
    assert.strictEqual(data.instances[0].disks.length, 4);
    assert.strictEqual(data.instances[0].disks[0].type, 'ssd');
    assert.strictEqual(data.instances[0].disks[0].temperature, 40);
    assert.strictEqual(data.instances[0].volumes.length, 1);
    assert.strictEqual(data.instances[0].summary.disks, 4);
    assert.strictEqual(data.instances[0].summary.volumes, 1);
    assert.strictEqual(data.instances[0].summary.usedPercent, 75);
    assert.strictEqual(data.instances[0].partial, false);
    assert.deepStrictEqual(data.instances[0].available, { system: true, storage: true, disks: true });
    assert.ok(requests.filter(url => /manaRequest|qsmart|chartReq/.test(url.pathname)).every(url => url.searchParams.get('sid') === 'sid123'));
    assert.ok(requests.some(url => url.pathname === '/cgi-bin/authLogout.cgi'));
  } finally {
    await close(server);
  }

  const jsonServer = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/cgi-bin/filemanager/utilRequest.cgi' && url.searchParams.get('func') === 'check_sid') return res.end(JSON.stringify({ status: 1, server_name: 'json-qnap' }));
    if (url.pathname === '/cgi-bin/filemanager/utilRequest.cgi') return res.end('[]');
    if (url.pathname === '/cgi-bin/management/manaRequest.cgi') return res.end(JSON.stringify({ authPassed: 1, model: { displayModelName: 'TS-464' }, firmware: { version: '5.2.9', build: '20260701' }, func: { ownContent: { root: { server_name: 'json-qnap', cpu_usage: '21 %', total_memory: '4096', free_memory: '1024' } } } }));
    if (url.pathname === '/cgi-bin/disk/qsmart.cgi') return res.end(JSON.stringify({ authPassed: 1, Disk_Info: { entry: { Disk_Alias: 'Disk 1', Disk_Status: 0, HDNo: '0:1', Health: 'GOOD', Capacity: '1.82 TB', Temperature: { oC: 44 }, Model: 'NVMe SSD', Serial: 'JSON1', hd_is_ssd: 1 } } }));
    if (url.pathname === '/cgi-bin/management/chartReq.cgi') return res.end(JSON.stringify({ authPassed: 1, volumeList: { volume: { volumeValue: 1, volumeStatus: 0, volumeLabel: 'Data' } }, volumeUseList: { volumeUse: { volumeValue: 1, total_size: 2000, free_size: 1000 } } }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'missing' }));
  });
  try {
    const { getAllQnapData } = require('../src/qnap');
    const url = `http://127.0.0.1:${jsonServer.address().port}`;
    const data = await getAllQnapData({ url, sid: 'existing-sid' });
    const instance = data.instances[0];
    assert.strictEqual(instance.system.cpuPercent, 21);
    assert.strictEqual(instance.system.memoryPercent, 75);
    assert.strictEqual(instance.disks.length, 1);
    assert.strictEqual(instance.disks[0].temperature, 44);
    assert.strictEqual(instance.volumes.length, 1);
    assert.strictEqual(instance.summary.usedPercent, 50);
    assert.strictEqual(instance.partial, false);
  } finally {
    await close(jsonServer);
  }

  const deniedServer = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', url.pathname.includes('utilRequest') ? 'application/json' : 'text/xml');
    if (url.pathname === '/cgi-bin/authLogin.cgi') return res.end('<QDocRoot><authPassed>1</authPassed><authSid>limited</authSid></QDocRoot>');
    if (url.pathname === '/cgi-bin/filemanager/utilRequest.cgi' && url.searchParams.get('func') === 'check_sid') return res.end(JSON.stringify({ status: 1, server_name: 'limited-qnap' }));
    if (url.pathname === '/cgi-bin/authLogout.cgi') return res.end('<QDocRoot><authPassed>1</authPassed></QDocRoot>');
    if (url.pathname === '/cgi-bin/disk/qsmart.cgi') return res.end('<QDocRoot><authPassed>1</authPassed></QDocRoot>');
    return res.end('<QDocRoot><authPassed>0</authPassed></QDocRoot>');
  });
  try {
    const { getAllQnapData } = require('../src/qnap');
    const url = `http://127.0.0.1:${deniedServer.address().port}`;
    const data = await getAllQnapData({ url, username: 'monitor', password: 'secret' });
    const instance = data.instances[0];
    assert.strictEqual(instance.online, true);
    assert.strictEqual(instance.partial, true);
    assert.deepStrictEqual(instance.available, { system: false, storage: false, disks: false });
    assert.ok(instance.errors.some(error => error.includes('administrators group')));
    assert.ok(instance.errors.some(error => error.includes('did not include a disk inventory')));
  } finally {
    await close(deniedServer);
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

  const deniedServer = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api2/json/version') return res.end(JSON.stringify({ data: { version: '3.4.2' } }));
    res.statusCode = 403;
    return res.end(JSON.stringify({ message: 'permission denied' }));
  });
  try {
    const { getAllPbsData } = require('../src/pbs');
    const url = `http://127.0.0.1:${deniedServer.address().port}`;
    const data = await getAllPbsData({ url, tokenId: 'limited@pbs!omnisight', tokenSecret: 'secret' });
    const instance = data.instances[0];
    assert.strictEqual(instance.online, true);
    assert.strictEqual(instance.partial, true, 'missing datastore access must mark PBS data partial');
    assert.match(instance.error, /Datastore inventory: .*HTTP 403/);
    assert.match(instance.permissionHint, /DatastoreAudit/);
  } finally {
    await close(deniedServer);
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
  assert.deepStrictEqual(resourceSummary([
    { cpu: 10, memUsageBytes: 512 * 1024 ** 2, memLimitBytes: 1024 ** 3 },
    { cpu: 15, memUsageBytes: 512 * 1024 ** 2, memLimitBytes: 1024 ** 3 },
  ], 8 * 1024 ** 3), { cpu: 25, memPercent: 12.5 }, 'Docker host RAM must use MemTotal instead of container limits');

  const { enrichDockhandWithDocker } = require('../src/dockhand');
  const enriched = enrichDockhandWithDocker({
    containers: [{ id: 'abcdef123456', name: 'web', image: 'nginx:latest', imageUpdate: { status: 'unknown' } }],
    instances: [{ name: 'dockhand', containers: [{ id: 'abcdef123456', name: 'web', image: 'nginx:latest' }] }],
  }, [{ containers: [{ id: 'abcdef123456', name: 'web', image: 'nginx:latest', cpu: 12, memPercent: 8, imageUpdate: { status: 'update' } }] }]);
  assert.strictEqual(enriched.containers[0].cpu, 12);
  assert.strictEqual(enriched.instances[0].containers[0].memPercent, 8);
  assert.strictEqual(enriched.containers[0].imageUpdate.status, 'update');
}

async function testDockhandEnvironments() {
  const requests = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(`${url.pathname}${url.search}`);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/environments') {
      return res.end(JSON.stringify([{ id: 1, name: 'production' }, { id: 2, name: 'lab' }]));
    }
    if (url.pathname === '/api/containers') {
      const env = url.searchParams.get('env');
      if (env === '1') return res.end(JSON.stringify([{ id: 'prod12345678', name: 'web', image: 'nginx:latest', state: 'running', updateAvailable: false }]));
      if (env === '2') return res.end(JSON.stringify([{ id: 'lab123456789', name: 'worker', image: 'alpine:latest', state: 'running', updateAvailable: false }]));
      return res.end('[]');
    }
    if (url.pathname === '/api/images') {
      const env = url.searchParams.get('env');
      if (env === '1') return res.end(JSON.stringify([{ id: 'nginx-image', repository: 'nginx', tag: 'latest', containers: 1, updateAvailable: false }]));
      if (env === '2') return res.end(JSON.stringify([{ id: 'alpine-image', repository: 'alpine', tag: 'latest', containers: 1, updateAvailable: false }]));
      return res.end('[]');
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'missing' }));
  });
  try {
    const { getAllDockhand } = require('../src/dockhand');
    const url = `http://127.0.0.1:${server.address().port}`;
    const data = await getAllDockhand({ instances: [{ name: 'dockhand', url }] });
    assert.strictEqual(data.instances[0].environments.length, 2);
    assert.strictEqual(data.containers.length, 2);
    assert.deepStrictEqual(data.containers.map(container => container.environmentId).sort(), ['1', '2']);
    assert.deepStrictEqual(data.containers.map(container => container.environment).sort(), ['lab', 'production']);
    assert.ok(requests.includes('/api/containers?env=1'));
    assert.ok(requests.includes('/api/containers?env=2'));
  } finally {
    await close(server);
  }
}

function testSynologyCpuCounters() {
  const {
    ucdRawCpuSnapshot,
    ucdRawCpuPercent,
    retainLastKnownTemperature,
    SNMP_SENSOR_LAST_KNOWN_MS,
  } = require('../src/snmp');
  const previous = ucdRawCpuSnapshot([100, 0, 100, 700, 100]);
  const current = ucdRawCpuSnapshot([130, 0, 120, 740, 110]);
  assert.deepStrictEqual(previous, { idle: 800, total: 1000 });
  assert.deepStrictEqual(current, { idle: 850, total: 1100 });
  assert.strictEqual(ucdRawCpuPercent(previous, current), 50, 'UCD raw CPU must not count kernel/IRQ counters twice');
  assert.strictEqual(ucdRawCpuPercent(current, previous), null, 'counter resets must wait for a fresh sample');

  const fresh = retainLastKnownTemperature('fixture-temperature', {
    cpuTemp: 70,
    cpuTempLabel: 'CPU temperature',
    systemTemp: 70,
    systemTempLabel: 'CPU temperature',
    sensors: { temperatures: [{ label: 'CPU temperature', value: 70 }], fanSpeeds: [] },
  }, 1_000);
  assert.strictEqual(fresh.temperatureStale, false);
  const retained = retainLastKnownTemperature('fixture-temperature', { sensors: { temperatures: [], fanSpeeds: [] } }, 2_000);
  assert.strictEqual(retained.cpuTemp, 70, 'temporary sensor failure must retain the last real temperature');
  assert.strictEqual(retained.temperatureStale, true, 'retained temperature must be labeled last known');
  assert.strictEqual(retained.temperatureLastKnownAt, 1_000);
  const expired = retainLastKnownTemperature('fixture-temperature', {}, 1_000 + SNMP_SENSOR_LAST_KNOWN_MS + 1);
  assert.strictEqual(expired.cpuTemp, undefined, 'last-known temperature must expire');
  assert.strictEqual(expired.temperatureStale, false);
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

function testFullBackupEmptyFileCompatibility() {
  const yaml = require('js-yaml');
  const { normalizeLegacyEmptyBase64Blocks, fullBackupContentHeader } = require('../src/fullBackupFormat');
  const legacy = [
    'kind: omnisight-full-backup',
    'files:',
    '  ".gitkeep":',
    '    encoding: base64',
    '    mode: "600"',
    '    size: 0',
    '    content: |-',
    '      ',
    '  "config.yaml":',
    '    encoding: base64',
    '    mode: "600"',
    '    size: 3',
    '    content: |-',
    '      e30=',
  ].join('\n');
  const parsed = yaml.load(normalizeLegacyEmptyBase64Blocks(legacy));
  assert.strictEqual(parsed.files['.gitkeep'].content, '');
  assert.strictEqual(parsed.files['config.yaml'].content, 'e30=');
  assert.strictEqual(fullBackupContentHeader(0), '    content: ""\n');
  assert.strictEqual(fullBackupContentHeader(3), '    content: |-\n');
}

function testStaticRegressions() {
  const root = path.join(__dirname, '..');
  const windowsAgent = fs.readFileSync(path.join(root, 'agent', 'omnisight-agent.ps1'), 'utf8');
  const windowsInstaller = fs.readFileSync(path.join(root, 'agent', 'install-windows.ps1'), 'utf8');
  const linuxAgent = fs.readFileSync(path.join(root, 'agent', 'omnisight-agent.sh'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'public', 'settings.html'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const demoServer = fs.readFileSync(path.join(root, 'demo-server.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const docker = fs.readFileSync(path.join(root, 'src', 'docker.js'), 'utf8');
  const snmp = fs.readFileSync(path.join(root, 'src', 'snmp.js'), 'utf8');
  assert.ok(!windowsAgent.includes('Get-Counter'), 'localized Windows counters must not return');
  assert.ok(windowsAgent.includes('Win32_PerfFormattedData_PerfDisk_PhysicalDisk'));
  assert.ok(windowsAgent.includes('SecurityProtocolType]::Tls12') && windowsInstaller.includes('SecurityProtocolType]::Tls12'));
  const windowsDownloadLines = [settings, server, readme].flatMap(source => source.split(/\r?\n/).filter(line => /\biwr\b/.test(line)));
  assert.ok(windowsDownloadLines.length >= 5);
  assert.ok(windowsDownloadLines.every(line => /psTLS12|WINDOWS_TLS12_BOOTSTRAP|SecurityProtocolType\]::Tls12/.test(line)), 'every generated Windows download must enable TLS 1.2 before iwr runs');
  assert.ok(windowsAgent.includes('Get-UpdateStatus') && linuxAgent.includes('updates_json'));
  for (const manager of ['apt-get', 'dnf', 'yum', 'zypper', 'apk', 'pacman']) {
    assert.ok(linuxAgent.includes(`output=$(${manager}`), `${manager} update output must be captured before it is counted`);
    assert.ok(!linuxAgent.includes(`count=$(${manager}`), `${manager} failures must not be converted to zero updates by a pipeline`);
  }
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
  assert.ok(dashboard.includes("const storageKnown = inst.available?.storage !== false"), 'unavailable QNAP storage metrics must not be displayed as zero');
  assert.ok(dashboard.includes("const disksKnown = inst.available?.disks !== false"), 'unavailable QNAP disk metrics must not be displayed as zero');
  assert.ok(settings.includes('The monitoring account must belong to the QNAP administrators group'), 'QNAP metric permissions must be documented in settings');
  assert.ok(server.includes('Number.isFinite(requested) && requested > 0'), 'invalid history point requests must use the safe dashboard default');
  assert.match(deploy, /linux\/amd64,linux\/arm64/);
  assert.ok(docker.includes("reqJson(host, '/info')") && docker.includes("info --format '{{.MemTotal}}'"), 'Docker collectors must read host memory totals');
  assert.ok(fs.existsSync(path.join(root, 'src', 'unifi.js')));
  assert.ok(snmp.includes('session.subtree(oid, 20'), 'SNMP reads must stop at the requested OID subtree');
  assert.ok(!snmp.includes('session.walk(oid, 20'), 'unbounded SNMP walks must not return unrelated OIDs');
  assert.strictEqual((snmp.match(/retries:\s*1/g) || []).length, 2, 'SNMP v2c and v3 sessions must retry once');
  assert.ok(dashboard.includes('last known'), 'stale SNMP temperatures must be visibly marked last known');
  assert.ok(snmp.indexOf('const raw = await ucdRawCpu') < snmp.indexOf('cpuUser == null && synologyCpuUser'), 'UCD CPU must take priority over Synology vendor CPU');
  assert.ok(snmp.includes("const oids = ['50', '51', '52', '53', '54']"), 'UCD CPU must use the canonical non-overlapping counters');
  assert.ok(!snmp.includes("'55', '56'"), 'UCD raw kernel and interrupt counters must not be added to raw system twice');
  assert.ok(snmp.indexOf("snmpWalk(session, '1.3.6.1.2.1.25.3.3.1.2')") < snmp.indexOf('cpuUser == null && synologyCpuUser'), 'HOST-RESOURCES CPU must take priority over Synology vendor CPU');
  assert.ok(server.includes("const ADMIN_VISIBLE_CONFIG_SECRET_KEYS = new Set(['community'])"), 'admins must see the configured SNMP community');
  assert.ok(server.includes("role === 'admin' ? ADMIN_VISIBLE_CONFIG_SECRET_KEYS : null"), 'SNMP community visibility must remain admin-only');
  assert.ok(settings.includes("const PLATFORM_MUTATION_CONTROL_SELECTOR = '.btn-add,.platform-add,.arr-item .btn-rm,.sys-list .btn-rm,.card-body input[type=\"checkbox\"]'"), 'platform add/remove controls and all subordinate checkboxes must share one lock selector');
  assert.ok(settings.includes("card.classList.toggle('platform-mutations-locked', platformOff)"), 'disabled platforms must lock host, instance and subordinate-toggle mutations');
  assert.ok(settings.includes("saveConfig({ platformToggle: id, enabled: on, fast: true });"), 'top-level settings toggles must save their explicit state without waiting for collection');
  assert.ok(settings.includes("const result = settingsSaveQueue.then(run, run);"), 'rapid settings saves must run in order');
  assert.ok(settings.includes("(opts.fast ? '&wait=0' : '')"), 'top-level toggle saves must return before platform collection completes');
  assert.ok(settings.includes("cfgPayload.publicStatus = opts.enabled === true;"), 'status page toggle must persist its disabled state');
  assert.ok(settings.includes("? ['snmp', 'unifi']") && settings.includes("['synology', 'mikrotik'].includes(opts.platformToggle) ? ['snmp']"), 'brand SNMP toggles must persist through the shared collector');
  assert.ok(demoServer.includes("enabled: demoConfigFlag(body[key].enabled, true)"), 'demo settings must remember platform toggle state');
  assert.ok(demoServer.includes(".filter(([, key]) => demoPlatformEnabled(key)).map(([id]) => id)"), 'demo dashboard must hide disabled platforms');
  assert.ok(server.includes("backgroundRefresh({ force: true, only: connectingPlatforms })"), 'settings saves must refresh only platforms whose connection config changed');
  assert.ok(server.includes("if (connectingPlatforms.has('proxmox') || !cache.data.proxmox)"), 'unrelated settings saves must preserve current Proxmox runtime data');
  assert.ok((settings.match(/class="btn-sm platform-add"/g) || []).length >= 5, 'non-standard platform add buttons must participate in the lock');
}

async function run() {
  await testQnap();
  await testPbs();
  testDockerAndDockhand();
  await testDockhandEnvironments();
  testSynologyCpuCounters();
  testProxmoxInstances();
  testLatestStableVersion();
  testFullBackupEmptyFileCompatibility();
  testStaticRegressions();
  console.log('smoke ok — issue regressions: #4 #5 #6 #7 #9 #10 #12 #18 #20 #22 #23 #24 #25');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
