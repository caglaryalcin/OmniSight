#!/usr/bin/env node
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

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

function testPlatformAvailability() {
  const { availabilityCounts, rowAvailability, platformAvailability } = require('../src/platformAvailability');
  assert.deepStrictEqual(availabilityCounts(1, 2), { offline: 1, online: 1, total: 2 });
  assert.deepStrictEqual(rowAvailability([{ online: true }, { online: false }, { online: false, _connecting: true }]), { offline: 1, online: 1, total: 3 });
  const data = {
    unifi: { instances: [{ online: true, devices: [
      { name: 'gateway', ip: '192.0.2.1', online: true },
      { name: 'office-ap', ip: '192.0.2.2', online: false, alertable: true },
    ] }] },
    snmp: [
      { name: 'office-ap', host: '192.0.2.2', profile: 'unifi', online: false },
      { name: 'yard-ap', host: '192.0.2.3', profile: 'unifi', online: false },
    ],
    uptimekuma: { online: true, summary: { up: 3, down: 1, total: 4 } },
    portainer: { online: true, instances: [{ online: true }], summary: { environments: 3, environmentsDown: 1 } },
  };
  assert.deepStrictEqual(platformAvailability(data, 'unifi'), { offline: 2, online: 1, total: 3 });
  assert.deepStrictEqual(platformAvailability(data, 'uptimekuma'), { offline: 1, online: 3, total: 4 });
  assert.deepStrictEqual(platformAvailability(data, 'portainer'), { offline: 1, online: 2, total: 3 });
}

function testStaticRegressions() {
  const root = path.join(__dirname, '..');
  const windowsAgent = fs.readFileSync(path.join(root, 'agent', 'omnisight-agent.ps1'), 'utf8');
  const windowsInstaller = fs.readFileSync(path.join(root, 'agent', 'install-windows.ps1'), 'utf8');
  const linuxAgent = fs.readFileSync(path.join(root, 'agent', 'omnisight-agent.sh'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const agentsPage = fs.readFileSync(path.join(root, 'public', 'agents.html'), 'utf8');
  const docsPage = fs.readFileSync(path.join(root, 'public', 'docs.html'), 'utf8');
  const docsEnglish = fs.readFileSync(path.join(root, 'public', 'docs', 'en.txt'), 'utf8');
  const docsTurkish = fs.readFileSync(path.join(root, 'public', 'docs', 'tr.txt'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'public', 'settings.html'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8');
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
  assert.ok(linuxAgent.includes('output=$(LC_ALL=C apt list --upgradable'), 'APT must list every available update, including kept-back packages');
  assert.ok(!linuxAgent.includes('apt-get -s -o Debug::NoLocking=1 upgrade'), 'APT update counts must not omit kept-back packages');
  const aptCounter = linuxAgent.match(/count_apt_update_lines\(\) \{[\s\S]*?\r?\n\}/);
  assert.ok(aptCounter, 'APT update counter must be defined');
  if (process.platform !== 'win32') {
    const aptFixture = [
      'Listing...',
      'kubectl/kubernetes-xenial 1.34.0-1.1 amd64 [upgradable from: 1.33.0-1.1]',
      'kubelet/kubernetes-xenial 1.34.0-1.1 amd64 [upgradable from: 1.33.0-1.1]',
      '',
    ].join('\n');
    const count = execFileSync('bash', ['-c', `${aptCounter[0]}\ncount_apt_update_lines`], { input: aptFixture, encoding: 'utf8' }).trim();
    assert.strictEqual(count, '2', 'APT update counter must include kept-back packages');
  }
  const linuxAgentVersion = (linuxAgent.match(/^VERSION="([^"]+)"/m) || [])[1];
  const windowsAgentVersion = (windowsAgent.match(/^\$Version = "([^"]+)"/m) || [])[1];
  assert.strictEqual(linuxAgentVersion, windowsAgentVersion, 'Linux and Windows agent versions must stay synchronized');
  for (const manager of ['dnf', 'yum', 'zypper', 'apk', 'pacman']) {
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
  assert.ok(dashboard.includes('.overview-card .sb-csum{display:flex;flex-wrap:nowrap'), 'overview summary metrics must remain on one row');
  assert.ok(dashboard.includes('flex:1 1 max-content'), 'overview summary widths must adapt to their content');
  assert.ok(dashboard.includes('overviewResponsiveLayoutKey') && dashboard.includes('stableOverviewIds'), 'responsive resizing must preserve the dashboard card order');
  const proxmoxOverviewSource = dashboard.slice(dashboard.indexOf('function buildProxmox'), dashboard.indexOf('function buildLinux'));
  assert.ok(!proxmoxOverviewSource.includes('<div class="sb-csum-lbl">Ceph</div>'), 'Proxmox overview must not repeat the Ceph header badge in its summary metrics');
  assert.ok(proxmoxOverviewSource.includes('cephBad') && proxmoxOverviewSource.includes('Ceph ${ceph.health'), 'Proxmox overview must retain its Ceph header badge');
  const linuxOverviewSource = dashboard.slice(dashboard.indexOf('function buildLinux'), dashboard.indexOf('function buildWindows'));
  assert.ok(!linuxOverviewSource.includes('<div class="sb-csum-lbl">Updates</div>'), 'Linux overview must not repeat the updates header badge in its summary metrics');
  assert.ok(linuxOverviewSource.includes('agentUpdateState: { count: updateCount, visible: updateAttention }'), 'Linux overview must retain its updates header badge');
  assert.ok(!dashboard.includes("prefetchRouteResource(href, 'document')") && !dashboard.includes("cache: 'force-cache'"), 'nonce-protected HTML documents must not be prefetched into the browser cache');
  assert.ok(dashboard.includes('function scheduleEmbedPrefetch(opts = {})'), 'embed prefetch scheduling options must remain defined');
  assert.ok(dashboard.includes("visible:ifr.classList.contains('active')"), 'loaded embeds must receive their current visibility state after their scripts are ready');
  assert.ok(dashboard.includes('localizeSidebarOperationalText(lang);'), 'sidebar status phrases must use the selected language');
  const configuredSidebarSource = dashboard.slice(dashboard.indexOf('function renderConfiguredSidebarShell'), dashboard.indexOf('\nfunction ', dashboard.indexOf('function renderConfiguredSidebarShell') + 10));
  assert.ok(configuredSidebarSource.includes('applyLanguage(currentLang())'), 'embedded pages must preserve the selected language after rebuilding the sidebar');
  const uptimeKumaHealthSource = dashboard.slice(dashboard.indexOf('function uptimeKumaHealth'), dashboard.indexOf('function buildUptimeKuma'));
  assert.ok(uptimeKumaHealthSource.includes('label: offlineRatioLabel(down, total, up)'), 'Uptime Kuma degradation badges must show available and total monitors');
  assert.ok(dashboard.includes("const offlineCount = offlineDevs.length + offlineSnmp.length"), 'UniFi offline badges must count controller and unmatched SNMP devices');
  assert.ok(dashboard.includes('bdg(offlineRatioBadgeClass(offlineCount, totalCount, onlineCount), offlineRatioLabel(offlineCount, totalCount, onlineCount))'), 'UniFi availability badges must use shared counts and severity');
  assert.ok(!dashboard.includes("DEVICE${offlineDevs.length>1?'S':''} OFFLINE"), 'UniFi offline badges must not repeat the platform context');
  const simpleNasPanelSource = dashboard.slice(dashboard.indexOf('function buildSimpleNasPanel'), dashboard.indexOf('\nfunction ', dashboard.indexOf('function buildSimpleNasPanel') + 10));
  assert.ok(simpleNasPanelSource.includes(": 'healthy'"), 'QNAP and Ugreen platform badges must use healthy when all systems are available');
  const ratioFunctions = ['buildProxmox', 'buildLinux', 'buildWindows', 'buildKubernetes', 'buildSynology', 'buildUnifi', 'buildHealthchecks', 'uptimeKumaHealth', 'buildChecks', 'prometheusHealth', 'buildDocker', 'buildDockhand', 'buildFirewall', 'buildTrueNas', 'buildSimpleNasPanel', 'buildPbs', 'buildCloudflare', 'buildCiCd', 'buildVeeam', 'buildPortainer', 'buildDatabase'];
  for (const functionName of ratioFunctions) {
    const start = dashboard.indexOf(`function ${functionName}`);
    const end = dashboard.indexOf('\nfunction ', start + 10);
    assert.ok(start >= 0 && dashboard.slice(start, end > start ? end : undefined).includes('offlineRatioLabel('), `${functionName} must use the shared availability label`);
  }
  const dockerPanelSource = dashboard.slice(dashboard.indexOf('function buildDocker'), dashboard.indexOf('\nfunction ', dashboard.indexOf('function buildDocker') + 10));
  assert.ok(dashboard.includes('function dockerContainerStateCounts(containers)') && dashboard.includes("['created','restarting','paused','removing'].includes(state)"), 'Docker pending states must share one classification');
  assert.ok(dockerPanelSource.includes('containerIssueLabel') && dockerPanelSource.includes('hostIssueLabel') && dashboard.includes("return `${counts.pending} ${trText('pending')}`"), 'Docker pending containers must make platform and host badges degraded instead of healthy');
  assert.ok(dashboard.includes('Number(h.summary?.total||0)>Number(h.summary?.running||0)'), 'global Docker health must include every non-running container state');
  assert.ok(server.includes('const pending = Math.max(0, total - running - stopped)') && server.includes('${pending} pending'), 'compact production health must report pending Docker containers');
  assert.ok(demoServer.includes("state: i === 5 ? 'created' : 'running'") && demoServer.includes("pending: containers.filter(c => c.state === 'created').length"), 'demo Docker data must include a visible pending container example');
  assert.ok(demoServer.includes("if (id === 'docker')") && demoServer.includes("return running < total ? 'degraded' : 'healthy'"), 'demo compact health must mark Docker pending state degraded');
  assert.ok(server.includes('offline: s.offline') && server.includes('online: s.online') && server.includes('...platformAvailability(data, item.id)'), 'production summaries must retain platform availability ratios');
  assert.ok(demoServer.includes('...platformAvailability(data, id)'), 'demo summaries must retain platform offline ratios');
  assert.ok(dashboard.includes("const storageKnown = inst.available?.storage !== false"), 'unavailable QNAP storage metrics must not be displayed as zero');
  assert.ok(dashboard.includes("const disksKnown = inst.available?.disks !== false"), 'unavailable QNAP disk metrics must not be displayed as zero');
  assert.ok(settings.includes('The monitoring account must belong to the QNAP administrators group'), 'QNAP metric permissions must be documented in settings');
  const dockerNavStart = settings.indexOf('data-nav-group="docker"');
  const dockerNavEnd = settings.indexOf('data-nav-group="backup"', dockerNavStart);
  const dockerNav = settings.slice(dockerNavStart, dockerNavEnd);
  assert.ok(dockerNav.indexOf('data-target="kubernetes"') >= 0 && dockerNav.indexOf('data-target="kubernetes"') < dockerNav.indexOf('data-target="docker"'), 'Kubernetes must be the first item in the Docker settings group');
  assert.ok(!settings.includes('data-nav-parent="infra" data-target="kubernetes"'), 'Kubernetes must not remain in the Infrastructure settings group');
  const statusPageStart = settings.indexOf('<div class="card" data-settings-section="statuspage">');
  const statusPageEnd = settings.indexOf('<!-- Proxmox -->', statusPageStart);
  const statusPageSettings = settings.slice(statusPageStart, statusPageEnd);
  const alertsStart = settings.indexOf('<div class="card" data-settings-section="alerts">');
  const alertsEnd = settings.indexOf('</main>', alertsStart);
  const alertsSettings = settings.slice(alertsStart, alertsEnd);
  assert.ok(statusPageSettings.includes('<div class="arr-hdr arr-hdr-static">') && statusPageSettings.includes('id="al-maint-en"'), 'Maintenance Mode settings must live on the Status Page settings screen and remain expanded');
  assert.ok(!statusPageSettings.includes('<div class="settings-section-label">Maintenance Mode</div>') && !statusPageSettings.includes('<label>Maintenance Mode</label>'), 'Maintenance Mode must have only one visible heading');
  assert.ok(!alertsSettings.includes('id="al-maint-en"'), 'Alerts settings must not repeat Maintenance Mode');
  assert.ok(!statusPageSettings.includes('arr-body hidden'), 'Maintenance Mode content must always remain expanded');
  const detectionsSection = alertsSettings.indexOf('<div class="settings-section-label" style="margin-top:0">Detections</div>');
  const notificationsSection = alertsSettings.indexOf('<div class="settings-section-label">Notifications</div>');
  assert.ok(detectionsSection >= 0 && detectionsSection < notificationsSection, 'Alerts settings must be ordered Detections, Notifications');
  assert.ok(settings.includes('id="al-server-updates-en"') && settings.includes('a.detections?.serverUpdates === true'), 'server update notification preference must load in Alerts settings');
  assert.ok(settings.includes("serverUpdates: document.getElementById('al-server-updates-en').checked"), 'server update notification preference must be saved');
  assert.ok(i18n.includes("'Detections':'Algılamalar'") && i18n.includes("'Server updates':'Sunucu güncellemeleri'") && i18n.includes("'Maintenance Mode':'Bakım Modu'"), 'new Alerts and Maintenance Mode settings must be translated');
  assert.ok(server.includes('serverUpdateNotificationsEnabled(config.alerts)') && server.includes('UPDATES AVAILABLE'), 'enabled server update detections must enter the alert engine');
  assert.ok(settings.includes('data-target="users" data-admin-section="1" onclick="showSettingsSection(\'users\')"><span class="settings-nav-dot" style="background:var(--blue)">'), 'Users navigation icon must match the blue System icon');
  assert.ok(settings.includes('data-target="sessions" data-admin-section="1" onclick="showSettingsSection(\'sessions\')"><span class="settings-nav-dot" style="background:var(--blue)">'), 'Sessions navigation icon must match the blue System icon');
  const settingsInit = settings.slice(settings.lastIndexOf('(async () => {'));
  assert.ok(settingsInit.includes('await rolePromise;') && settingsInit.includes('loadSettingsSectionData(activeSettingsSection);'), 'the restored Settings section must load its data during initial startup');
  assert.ok(agentsPage.includes('function commandPanelGuide(commands)') && agentsPage.includes('Run the query command first.') && agentsPage.includes('If the query reports a timeout, DNS, connection or TLS error'), 'agent repair panel must explain diagnosis-first workflow');
  assert.ok(agentsPage.includes("${t('Check / repair')}") && agentsPage.includes("t('Run on affected host')"), 'offline agent action must direct users to check before repairing');
  const i18nContext = { window: {} };
  vm.createContext(i18nContext);
  vm.runInContext(i18n, i18nContext);
  const turkish = i18nContext.window.OmniI18n.dict('tr');
  assert.strictEqual(turkish.healthy, 'sağlıklı');
  assert.strictEqual(turkish.Online, 'Çevrimiçi');
  assert.strictEqual(turkish.Up, 'Aktif');
  assert.strictEqual(turkish.Down, 'Kapalı');
  assert.strictEqual(turkish.down, 'kapalı');
  assert.strictEqual(turkish.pending, 'bekleyen');
  assert.strictEqual(turkish.created, 'oluşturuldu');
  assert.strictEqual(turkish.Documentation, 'Dokümantasyon');
  assert.ok(docsPage.includes('`/docs/${encodeURIComponent(candidate)}.txt`') && docsPage.includes("[requested, base, 'en']"), 'Documentation must load locale packs with English fallback');
  assert.ok(docsPage.includes("event.data?.type === 'omnisight-language'") && docsPage.includes("event.key === 'os_lang'"), 'Open documentation must react to language changes');
  assert.ok(!docsPage.includes("fetch('/docs.md'"), 'Documentation UI must not depend on Markdown files excluded from the image');
  assert.ok(docsPage.includes('function documentationUiLang(lang)') && docsPage.includes('window.OmniI18n?.locales?.[base]'), 'Documentation chrome must support regional language fallback');
  assert.strictEqual((docsEnglish.match(/^## \d+\./gm) || []).length, 15, 'English documentation pack must contain all numbered sections');
  assert.strictEqual((docsTurkish.match(/^## \d+\./gm) || []).length, 15, 'Turkish documentation pack must contain all numbered sections');
  assert.ok(docsTurkish.startsWith('# OmniSight Dokümantasyonu') && docsTurkish.includes('## 14. Sorun Giderme'), 'Turkish documentation pack must contain localized content');
  assert.ok(dashboard.includes("type:'omnisight-language', lang"), 'dashboard must notify cached embedded pages when the language changes');
  assert.strictEqual((dashboard.match(/downCount\+' '\+trText\('down', lang\)/g) || []).length, 2, 'both global health render paths must translate the down count');
  assert.strictEqual((dashboard.match(/degradedCount\+' '\+trText\('degraded', lang\)/g) || []).length, 2, 'both global health render paths must translate the degraded count');
  assert.ok(dashboard.includes("typeof __OMNISIGHT_EMBED_VERSIONS_JSON__ === 'undefined'") && dashboard.includes('EMBED_VERSIONS[route] || APP_VERSION'), 'embedded page URLs must use content-based versions with a safe fallback during server restarts');
  const embedVersionsDeclaration = dashboard.match(/const EMBED_VERSIONS = Object\.freeze\([\s\S]*?\n\);/)?.[0];
  assert.ok(embedVersionsDeclaration, 'embedded page version declaration must remain testable');
  const embedFallbackContext = {};
  vm.runInNewContext(`${embedVersionsDeclaration}\nglobalThis.embedVersions = EMBED_VERSIONS;`, embedFallbackContext);
  assert.deepStrictEqual(Object.keys(embedFallbackContext.embedVersions), [], 'an already-running server must safely fall back when the new embed-version constant is not injected yet');
  const agentTranslationKeys = [...agentsPage.matchAll(/\bt\('((?:\\.|[^'])*)'\)/g)].map(match => match[1].replace(/\\'/g, "'"));
  for (const key of new Set(agentTranslationKeys)) {
    assert.ok(Object.prototype.hasOwnProperty.call(turkish, key), `Agents Turkish translation missing: ${key}`);
  }
  const repairCommandsSource = server.slice(server.indexOf('function agentRepairCommands'), server.indexOf("app.get('/api/agents'"));
  const repairTranslationKeys = [...repairCommandsSource.matchAll(/(?:title|description): '([^']+)'/g)].map(match => match[1]);
  for (const key of new Set(repairTranslationKeys)) {
    assert.ok(Object.prototype.hasOwnProperty.call(turkish, key), `Agent repair Turkish translation missing: ${key}`);
  }
  assert.ok(server.includes("staticAssetVersion('/i18n.js')") && server.includes("raw === staticAssetVersion(req?.path)"), 'production i18n URL must change when translation content changes');
  assert.ok(demoServer.includes("demoAssetVersion('/i18n.js')") && demoServer.includes("raw === demoAssetVersion(req?.path)"), 'demo i18n URL must change when translation content changes');
  assert.ok(server.includes("'/docs': '/docs.html'") && server.includes('__OMNISIGHT_EMBED_VERSIONS_JSON__') && !server.includes("app.get('/docs.md'"), 'production documentation must use an injected content version without a Markdown route');
  assert.ok(demoServer.includes("'/docs': '/docs.html'") && demoServer.includes('__OMNISIGHT_EMBED_VERSIONS_JSON__') && !demoServer.includes("app.get('/docs.md'"), 'demo documentation must use an injected content version without a Markdown route');
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
  testPlatformAvailability();
  testStaticRegressions();
  console.log('smoke ok — issue regressions: #4 #5 #6 #7 #9 #10 #12 #18 #20 #22 #23 #24 #25');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
