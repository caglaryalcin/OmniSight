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
      if (env === '2') return res.end(JSON.stringify([{ id: 'lab123456789', name: 'worker', image: 'alpine:latest', state: 'created', updateAvailable: false }]));
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
    assert.strictEqual(data.containers.find(container => container.state === 'created')?.color, 'gray');
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

function testProxmoxClusterStatus() {
  const { normalizeClusterStatus } = require('../src/proxmox');
  const cluster = normalizeClusterStatus([
    { type: 'cluster', name: 'lab-cluster', quorate: 1, nodes: 3, version: 9 },
    { type: 'node', name: 'pve-c', online: 1, nodeid: 3 },
    { type: 'node', name: 'pve-a', online: 1, local: 1, nodeid: 1 },
    { type: 'node', name: 'pve-b', online: 0, nodeid: 2 },
  ], { name: 'Configured Proxmox' });
  assert.strictEqual(cluster.name, 'lab-cluster');
  assert.strictEqual(cluster.configuredName, 'Configured Proxmox');
  assert.strictEqual(cluster.isCluster, true);
  assert.strictEqual(cluster.detected, true);
  assert.strictEqual(cluster.quorate, true);
  assert.strictEqual(cluster.version, 9);
  assert.strictEqual(cluster.totalNodes, 3);
  assert.strictEqual(cluster.nodesOnline, 2);
  assert.strictEqual(cluster.localNode, 'pve-a');
  assert.deepStrictEqual(cluster.members.map(member => member.name), ['pve-a', 'pve-b', 'pve-c']);

  const lost = normalizeClusterStatus([
    { type: 'cluster', name: 'lab-cluster', quorate: 0, nodes: 3 },
    { type: 'node', name: 'pve-a', online: 1, local: 1 },
  ], { name: 'Configured Proxmox' });
  assert.strictEqual(lost.quorate, false, 'a detected quorum loss must remain distinct from an unknown result');

  const standalone = normalizeClusterStatus([
    { type: 'node', name: 'pve-solo', online: 1, local: 1 },
  ], { name: 'Configured Proxmox' });
  assert.strictEqual(standalone.name, 'pve-solo');
  assert.strictEqual(standalone.isCluster, false);
  assert.strictEqual(standalone.quorate, null);

  const inferred = normalizeClusterStatus(null, {
    name: 'restricted-cluster',
    nodesRaw: [
      { node: 'pve-a', status: 'online' },
      { node: 'pve-b', status: 'offline' },
    ],
  });
  assert.strictEqual(inferred.name, 'restricted-cluster');
  assert.strictEqual(inferred.isCluster, true);
  assert.strictEqual(inferred.detected, false);
  assert.strictEqual(inferred.quorate, null);
  assert.strictEqual(inferred.totalNodes, 2);
  assert.strictEqual(inferred.nodesOnline, 1);
}

function testVmwareInventoryNormalization() {
  const { normalizeInventory, parsePropertyResult } = require('../src/vmware');
  const fixture = `<?xml version="1.0"?>
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <soapenv:Body><RetrievePropertiesExResponse xmlns="urn:vim25"><returnval>
      <objects><obj type="ClusterComputeResource">domain-c1</obj>
        <propSet><name>name</name><val xsi:type="xsd:string">Production</val></propSet>
        <propSet><name>overallStatus</name><val xsi:type="xsd:string">green</val></propSet>
        <propSet><name>summary</name><val xsi:type="ClusterComputeResourceSummary"><numHosts>1</numHosts><numEffectiveHosts>1</numEffectiveHosts><numCpuCores>8</numCpuCores><totalCpu>20000</totalCpu><effectiveCpu>16800</effectiveCpu><totalMemory>34359738368</totalMemory><effectiveMemory>24576</effectiveMemory></val></propSet>
        <propSet><name>host</name><val xsi:type="ArrayOfManagedObjectReference"><ManagedObjectReference type="HostSystem">host-1</ManagedObjectReference></val></propSet>
      </objects>
      <objects><obj type="HostSystem">host-1</obj>
        <propSet><name>name</name><val xsi:type="xsd:string">esxi-a</val></propSet>
        <propSet><name>overallStatus</name><val xsi:type="xsd:string">green</val></propSet>
        <propSet><name>runtime.connectionState</name><val xsi:type="xsd:string">connected</val></propSet>
        <propSet><name>runtime.powerState</name><val xsi:type="xsd:string">poweredOn</val></propSet>
        <propSet><name>runtime.inMaintenanceMode</name><val xsi:type="xsd:boolean">false</val></propSet>
        <propSet><name>summary.quickStats</name><val xsi:type="HostListSummaryQuickStats"><overallCpuUsage>3200</overallCpuUsage><overallMemoryUsage>8192</overallMemoryUsage><uptime>86400</uptime></val></propSet>
        <propSet><name>hardware.cpuInfo</name><val xsi:type="HostCpuInfo"><numCpuPackages>1</numCpuPackages><numCpuCores>8</numCpuCores><numCpuThreads>16</numCpuThreads><hz>2500000000</hz></val></propSet>
        <propSet><name>hardware.memorySize</name><val xsi:type="xsd:long">34359738368</val></propSet>
        <propSet><name>summary.config.product</name><val xsi:type="AboutInfo"><fullName>VMware ESXi 8.0.3</fullName><version>8.0.3</version><build>24280767</build></val></propSet>
      </objects>
      <objects><obj type="VirtualMachine">vm-10</obj>
        <propSet><name>name</name><val xsi:type="xsd:string">app-01</val></propSet>
        <propSet><name>overallStatus</name><val xsi:type="xsd:string">green</val></propSet>
        <propSet><name>runtime.powerState</name><val xsi:type="xsd:string">poweredOn</val></propSet>
        <propSet><name>runtime.host</name><val type="HostSystem">host-1</val></propSet>
        <propSet><name>summary.config</name><val xsi:type="VirtualMachineConfigSummary"><numCpu>4</numCpu><memorySizeMB>8192</memorySizeMB><guestFullName>Ubuntu Linux (64-bit)</guestFullName><template>false</template></val></propSet>
        <propSet><name>summary.storage</name><val xsi:type="VirtualMachineStorageSummary"><committed>10737418240</committed><uncommitted>5368709120</uncommitted><unshared>8589934592</unshared></val></propSet>
        <propSet><name>summary.quickStats</name><val xsi:type="VirtualMachineQuickStats"><overallCpuUsage>420</overallCpuUsage><guestMemoryUsage>2048</guestMemoryUsage><hostMemoryUsage>2304</hostMemoryUsage><uptimeSeconds>7200</uptimeSeconds></val></propSet>
        <propSet><name>guest.guestFullName</name><val xsi:type="xsd:string">Ubuntu Linux (64-bit)</val></propSet>
        <propSet><name>guest.ipAddress</name><val xsi:type="xsd:string">10.0.0.50</val></propSet>
        <propSet><name>guest.toolsRunningStatus</name><val xsi:type="xsd:string">guestToolsRunning</val></propSet>
      </objects>
      <objects><obj type="VirtualMachine">vm-11</obj>
        <propSet><name>name</name><val xsi:type="xsd:string">ubuntu-template</val></propSet>
        <propSet><name>runtime.powerState</name><val xsi:type="xsd:string">poweredOff</val></propSet>
        <propSet><name>summary.config</name><val xsi:type="VirtualMachineConfigSummary"><numCpu>2</numCpu><memorySizeMB>2048</memorySizeMB><guestFullName>Ubuntu Linux (64-bit)</guestFullName><template>true</template></val></propSet>
      </objects>
      <objects><obj type="Datastore">datastore-1</obj>
        <propSet><name>name</name><val xsi:type="xsd:string">datastore1</val></propSet>
        <propSet><name>overallStatus</name><val xsi:type="xsd:string">green</val></propSet>
        <propSet><name>summary</name><val xsi:type="DatastoreSummary"><type>VMFS</type><capacity>1000</capacity><freeSpace>250</freeSpace><accessible>true</accessible><multipleHostAccess>false</multipleHostAccess></val></propSet>
        <propSet><name>host</name><val xsi:type="ArrayOfDatastoreHostMount"><DatastoreHostMount><key type="HostSystem">host-1</key></DatastoreHostMount></val></propSet>
      </objects>
      <objects><obj type="Datacenter">datacenter-1</obj>
        <propSet><name>name</name><val xsi:type="xsd:string">Primary DC</val></propSet>
        <propSet><name>overallStatus</name><val xsi:type="xsd:string">green</val></propSet>
      </objects>
    </returnval></RetrievePropertiesExResponse></soapenv:Body>
  </soapenv:Envelope>`;
  const parsed = parsePropertyResult(fixture);
  assert.strictEqual(parsed.objects.length, 6);
  const normalized = normalizeInventory(parsed.objects, {
    apiType: 'HostAgent',
    fullName: 'VMware ESXi 8.0.3',
    version: '8.0.3',
    build: '24280767',
    apiVersion: '8.0.3.0',
  }, 'Lab ESXi');
  assert.strictEqual(normalized.type, 'esxi');
  assert.strictEqual(normalized.clusters[0].name, 'Production');
  assert.strictEqual(normalized.clusters[0].effectiveMemoryBytes, 24576 * 1024 * 1024);
  assert.strictEqual(normalized.datacenters[0].name, 'Primary DC');
  assert.strictEqual(normalized.hosts[0].clusterName, 'Production');
  assert.strictEqual(normalized.hosts[0].online, true);
  assert.strictEqual(normalized.hosts[0].cpuPercent, 16);
  assert.strictEqual(normalized.hosts[0].memoryPercent, 25);
  assert.deepStrictEqual(normalized.hosts[0].vmRefs, ['vm-10']);
  assert.strictEqual(normalized.vms[0].hostName, 'esxi-a');
  assert.strictEqual(normalized.vms[0].running, true);
  assert.strictEqual(normalized.vms[0].cpuCount, 4);
  assert.strictEqual(normalized.vms[0].memoryMb, 8192);
  assert.strictEqual(normalized.vms[0].storageCommittedBytes, 10737418240);
  assert.strictEqual(normalized.vms[0].storageProvisionedBytes, 16106127360);
  assert.strictEqual(normalized.templates[0].name, 'ubuntu-template');
  assert.strictEqual(normalized.datastores[0].usedPercent, 75);
  assert.deepStrictEqual(normalized.datastores[0].hostRefs, ['host-1']);
  assert.strictEqual(normalized.summary.hostsOnline, 1);
  assert.strictEqual(normalized.summary.runningVms, 1);
  assert.strictEqual(normalized.summary.cpuCores, 8);
  assert.strictEqual(normalized.summary.cpuUsedCores, 1.28);
  assert.strictEqual(normalized.summary.vmsWarning, 0);
  assert.strictEqual(normalized.summary.templates, 1);
}

async function testVmwareSoapFlow() {
  const requests = [];
  const soapEnvelope = (method, content = '') => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body><${method}Response xmlns="urn:vim25">${content}</${method}Response></soapenv:Body></soapenv:Envelope>`;
  const server = await listen((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const method = body.match(/<soapenv:Body>\s*<([A-Za-z][A-Za-z0-9]+)/)?.[1] || '';
      requests.push({ method, path: req.url, cookie: req.headers.cookie || '', soapAction: req.headers.soapaction || '', body });
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      if (method === 'RetrieveServiceContent') {
        return res.end(soapEnvelope(method, '<returnval><rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><sessionManager type="SessionManager">SessionManager</sessionManager><viewManager type="ViewManager">ViewManager</viewManager><about><name>VMware vCenter Server</name><fullName>VMware vCenter Server 8.0.3</fullName><apiType>VirtualCenter</apiType><version>8.0.3</version><build>24305161</build><apiVersion>8.0.3.0</apiVersion></about></returnval>'));
      }
      if (method === 'Login') {
        res.setHeader('Set-Cookie', 'vmware_soap_session="stub-session"; Path=/; HttpOnly');
        return res.end(soapEnvelope(method));
      }
      if (method === 'CreateContainerView') return res.end(soapEnvelope(method, '<returnval type="ContainerView">session[stub]52</returnval>'));
      if (method === 'RetrievePropertiesEx') {
        return res.end(soapEnvelope(method, '<returnval><objects><obj type="HostSystem">host-42</obj><propSet><name>name</name><val xsi:type="xsd:string">esxi-stub</val></propSet><propSet><name>runtime.connectionState</name><val xsi:type="xsd:string">connected</val></propSet><propSet><name>runtime.powerState</name><val xsi:type="xsd:string">poweredOn</val></propSet><propSet><name>runtime.inMaintenanceMode</name><val xsi:type="xsd:boolean">false</val></propSet><propSet><name>summary.quickStats</name><val xsi:type="HostListSummaryQuickStats"><overallCpuUsage>1000</overallCpuUsage><overallMemoryUsage>4096</overallMemoryUsage><uptime>3600</uptime></val></propSet><propSet><name>hardware.cpuInfo</name><val xsi:type="HostCpuInfo"><numCpuCores>4</numCpuCores><numCpuThreads>8</numCpuThreads><hz>2500000000</hz></val></propSet><propSet><name>hardware.memorySize</name><val xsi:type="xsd:long">17179869184</val></propSet></objects></returnval>'));
      }
      if (method === 'DestroyView' || method === 'Logout') return res.end(soapEnvelope(method));
      res.statusCode = 500;
      return res.end(soapEnvelope(method || 'Unknown', '<soapenv:Fault><faultcode>Server</faultcode><faultstring>unexpected method</faultstring></soapenv:Fault>'));
    });
  });
  try {
    const { getAllVmwareData } = require('../src/vmware');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const data = await getAllVmwareData({ instances: [{ name: 'Stub vCenter', url: endpoint, username: 'monitoring@vsphere.local', password: 'p<&' }] });
    assert.strictEqual(data.online, true);
    assert.strictEqual(data.instances[0].type, 'vcenter');
    assert.strictEqual(data.instances[0].hosts[0].name, 'esxi-stub');
    assert.strictEqual(data.instances[0].hosts[0].online, true);
    assert.strictEqual(data.summary.hostsOnline, 1);
    assert.deepStrictEqual(requests.map(request => request.method), ['RetrieveServiceContent', 'Login', 'CreateContainerView', 'RetrievePropertiesEx', 'DestroyView', 'Logout']);
    assert.ok(requests.every(request => request.path === '/sdk'), 'VMware collector must normalize endpoint URLs to /sdk');
    assert.ok(requests.every(request => request.soapAction === '"urn:vim25/6.5"'), 'VMware collector must send a vSphere SOAPAction');
    assert.ok(requests.find(request => request.method === 'Login').body.includes('<password>p&lt;&amp;</password>'), 'VMware credentials must be XML escaped');
    assert.ok(requests.filter(request => ['CreateContainerView', 'RetrievePropertiesEx', 'DestroyView', 'Logout'].includes(request.method)).every(request => request.cookie.includes('vmware_soap_session')), 'VMware session cookie must be reused and logged out');
  } finally {
    await close(server);
  }
}

function testCephNormalization() {
  const { normalizeCephStatus } = require('../src/ceph');
  const normalized = normalizeCephStatus({
    health: { status: 'HEALTH_OK', checks: {} },
    osdmap: { osdmap: { num_osds: 3, num_up_osds: 3, num_in_osds: 3 } },
    monmap: {
      num_mons: 3,
      mons: [
        { rank: 0, name: 'pve-a' },
        { rank: 1, name: 'pve-b' },
        { rank: 2, name: 'pve-c' },
      ],
    },
    quorum: [0, 1, 2],
    quorum_names: ['pve-a', 'pve-b', 'pve-c'],
    pgmap: { bytes_total: 1000, bytes_used: 400, bytes_avail: 600 },
  }, null, {
    root: {
      type: 'root',
      children: [{
        type: 'host',
        children: [
          { type: 'osd', name: 'osd.0', status: 'up', apply_latency_ms: 1, commit_latency_ms: 3 },
          { type: 'osd', name: 'osd.1', status: 'up', apply_latency_ms: 2, commit_latency_ms: 4 },
          { type: 'osd', name: 'osd.2', status: 'down', apply_latency_ms: 99, commit_latency_ms: 99 },
        ],
      }],
    },
  });
  assert.deepStrictEqual(normalized.latency, { averageMs: 2.5, applyMs: 1.5, commitMs: 3.5, osds: 2 });
  assert.deepStrictEqual(normalized.mon, { total: 3, inQuorum: 3, names: ['pve-a', 'pve-b', 'pve-c'], quorate: true, status: 'healthy' });
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
    vmware: { online: true, instances: [{ online: true, hosts: [{ online: true }, { online: false }] }] },
  };
  assert.deepStrictEqual(platformAvailability(data, 'unifi'), { offline: 2, online: 1, total: 3 });
  assert.deepStrictEqual(platformAvailability(data, 'uptimekuma'), { offline: 1, online: 3, total: 4 });
  assert.deepStrictEqual(platformAvailability(data, 'portainer'), { offline: 1, online: 2, total: 3 });
  assert.deepStrictEqual(platformAvailability(data, 'vmware'), { offline: 1, online: 1, total: 2 });
  data.vmware._stale = true;
  assert.deepStrictEqual(platformAvailability(data, 'vmware'), { offline: 0, online: 0, total: 2 });
}

function testStaticRegressions() {
  const root = path.join(__dirname, '..');
  const windowsAgent = fs.readFileSync(path.join(root, 'agent', 'omnisight-agent.ps1'), 'utf8');
  const windowsInstaller = fs.readFileSync(path.join(root, 'agent', 'install-windows.ps1'), 'utf8');
  const windowsService = fs.readFileSync(path.join(root, 'agent', 'OmniSight.Agent.cs'), 'utf8');
  const linuxAgent = fs.readFileSync(path.join(root, 'agent', 'omnisight-agent.sh'), 'utf8');
  const agentStore = fs.readFileSync(path.join(root, 'src', 'agents.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const agentsPage = fs.readFileSync(path.join(root, 'public', 'agents.html'), 'utf8');
  const docsPage = fs.readFileSync(path.join(root, 'public', 'docs.html'), 'utf8');
  const docsEnglish = fs.readFileSync(path.join(root, 'public', 'docs', 'en.txt'), 'utf8');
  const docsTurkish = fs.readFileSync(path.join(root, 'public', 'docs', 'tr.txt'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'public', 'settings.html'), 'utf8');
  const topology = fs.readFileSync(path.join(root, 'public', 'topology.html'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const demoServer = fs.readFileSync(path.join(root, 'demo-server.js'), 'utf8');
  const onboarding = fs.readFileSync(path.join(root, 'public', 'onboarding.html'), 'utf8');
  const configExample = fs.readFileSync(path.join(root, 'config.example.yaml'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const vmwareCollector = fs.readFileSync(path.join(root, 'src', 'vmware.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const docker = fs.readFileSync(path.join(root, 'src', 'docker.js'), 'utf8');
  const snmp = fs.readFileSync(path.join(root, 'src', 'snmp.js'), 'utf8');
  assert.ok(!windowsAgent.includes('Get-Counter') && !windowsService.includes('Get-Counter'), 'localized Windows counters must not return');
  assert.ok(windowsAgent.includes('Win32_PerfFormattedData_PerfDisk_PhysicalDisk') && windowsService.includes('Win32_PerfFormattedData_PerfDisk_PhysicalDisk'));
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
  const windowsServiceVersion = (windowsService.match(/internal const string Version = "([^"]+)"/) || [])[1];
  assert.strictEqual(linuxAgentVersion, windowsAgentVersion, 'Linux and Windows agent versions must stay synchronized');
  assert.strictEqual(linuxAgentVersion, windowsServiceVersion, 'Linux and Windows service agent versions must stay synchronized');
  assert.strictEqual(linuxAgentVersion, '1.4.1', 'cluster-aware agents must advertise the 1.4.1 protocol');
  assert.ok(server.includes("const WINDOWS_SERVICE_AGENT_VERSION = '1.4.0'") && server.includes('versionCompare(agent.agentVersion, WINDOWS_SERVICE_AGENT_VERSION) < 0'), 'legacy Windows agents must receive a one-time service migration command instead of a remote update that can stop the scheduled task');
  assert.ok(windowsInstaller.includes('New-Service -Name $script:ServiceName') && windowsInstaller.includes('failureflag') && !windowsInstaller.includes('Register-ScheduledTask'), 'Windows installs must use Service Control Manager rather than a persistent scheduled task');
  assert.ok(windowsInstaller.includes('Repair-AgentDataAccess') && windowsInstaller.includes('Protect-AgentDataAcl') && windowsInstaller.lastIndexOf('    Protect-AgentDataAcl') < windowsInstaller.lastIndexOf('    Start-OmniSightService'), 'Windows agent ACL hardening must be recoverable and complete before the service starts writing logs');
  assert.ok(windowsInstaller.includes('takeown.exe') && windowsInstaller.includes('agent.id.tmp') && windowsInstaller.includes('"/reset", "/T"') && !windowsInstaller.includes('"/inheritance:r", "/T"') && !windowsInstaller.includes('"/setowner"'), 'Windows migration must recover legacy ACL failures, reset children to protected inherited access and replace the agent ID atomically');
  assert.ok(windowsAgent.includes('Invoke-WindowsServiceMigration') && windowsAgent.includes('$ReportedVersion = "1.3.4"') && windowsAgent.includes('legacy agent will continue'), 'legacy Windows agents must migrate automatically and retain a safe fallback');
  assert.ok(windowsService.includes('class OmniSightAgentService : ServiceBase') && windowsService.includes('protected override void OnStart') && windowsService.includes('protected override void OnStop'), 'the Windows agent must implement the Windows service lifecycle');
  assert.ok(windowsInstaller.includes('Stop-ScheduledTask -TaskName $script:TaskName') && windowsService.includes('class LegacyTaskCleanup') && windowsService.includes('/End /TN') && windowsService.includes('/Delete /TN'), 'a successful Windows service migration must stop and remove every running legacy scheduled-task instance');
  assert.ok(windowsService.includes('service start failed:') && windowsService.includes('OmniSightAgent-startup.log') && windowsInstaller.includes('Windows service installation failed:') && windowsInstaller.includes('Agent log:') && windowsInstaller.includes('Startup diagnostic:'), 'Windows service startup failures must include actionable primary and fallback diagnostics');
  assert.ok(windowsService.includes('ScheduleHelper("--update-helper"') && windowsService.includes('ScheduleHelper("--uninstall-helper"') && windowsService.includes('RunUninstall()'), 'the Windows service must update and uninstall through detached native helpers');
  assert.ok(server.includes("app.get('/agent/OmniSight.Agent.cs'") && windowsInstaller.includes('/agent/OmniSight.Agent.cs'), 'the dashboard must distribute the Windows service source used by the installer');
  assert.ok(agentStore.includes("'agent_uninstall'") && server.includes("agents.queueCommand(id, 'agent_uninstall', 'self')"), 'remote uninstall must use one agent command');
  assert.ok(linuxAgent.includes('schedule_agent_uninstall()') && linuxAgent.includes('systemd-run --quiet --collect') && linuxAgent.includes('docker rm -f') && linuxAgent.includes("printf 'uninstall scheduled'"), 'Linux remote uninstall must schedule independent systemd and Docker cleanup');
  assert.ok(linuxAgent.includes('Docker Swarm agents must be removed with the stack or service command') && !linuxAgent.includes("docker service rm '$swarm_service'"), 'single-agent uninstall must never remove an entire Docker Swarm service');
  assert.ok(linuxAgent.includes('if [ "${uninstall_agent:-}" = "1" ]') && linuxAgent.includes('sleep 120'), 'the Linux agent must stop reporting while detached cleanup completes');
  assert.ok(windowsAgent.includes('function Start-AgentUninstall') && windowsAgent.includes('Register-ScheduledTask') && windowsAgent.includes('-NonInteractive'), 'legacy Windows agents must retain connection-independent scheduled cleanup during migration');
  assert.ok(windowsAgent.includes('if ($script:UninstallAfterCommand)') && windowsAgent.includes('Start-Sleep -Seconds 120'), 'the legacy Windows agent must stop reporting while detached cleanup completes');
  const uninstallEndpoint = server.slice(server.indexOf("app.post('/api/agent/uninstall'"), server.indexOf("app.post('/api/agent/token'"));
  assert.ok(uninstallEndpoint.includes("versionCompare(agent.agentVersion, REMOTE_AGENT_UNINSTALL_VERSION) < 0") && uninstallEndpoint.includes('if (!live?.online)'), 'remote uninstall must require a current online agent');
  assert.ok(uninstallEndpoint.indexOf("agents.queueCommand(id, 'agent_uninstall', 'self')") < uninstallEndpoint.indexOf('agents.removeAgent(agent.id)'), 'the dashboard record must be removed only after the agent schedules cleanup');
  assert.ok(agentStore.includes('waiter.delivered = true') && agentStore.includes('error.commandDelivered = waiter.delivered') && agentStore.includes('error.commandDeliveredAt = waiter.deliveredAt') && uninstallEndpoint.includes('agent.uninstall.delivery_unconfirmed'), 'a dropped result connection must still finish a delivered uninstall without leaving a stale dashboard record');
  assert.ok(uninstallEndpoint.includes("current?.lastSeen") && uninstallEndpoint.includes('agent continued reporting after command delivery'), 'an agent that keeps reporting after a failed uninstall must not be removed by the timeout fallback');
  for (const manager of ['dnf', 'yum', 'zypper', 'apk', 'pacman']) {
    assert.ok(linuxAgent.includes(`output=$(${manager}`), `${manager} update output must be captured before it is counted`);
    assert.ok(!linuxAgent.includes(`count=$(${manager}`), `${manager} failures must not be converted to zero updates by a pipeline`);
  }
  assert.ok(server.includes("synology: 'Synology'"), 'public status title must say Synology');
  assert.ok(vmwareCollector.includes("client.call('RetrieveServiceContent'") && vmwareCollector.includes("client.call('CreateContainerView'") && vmwareCollector.includes("client.call('RetrievePropertiesEx'"), 'VMware collector must use the authenticated vSphere inventory flow');
  assert.ok(vmwareCollector.includes("'summary.config'") && vmwareCollector.includes("'summary.storage'") && !vmwareCollector.includes("'config.hardware'"), 'VMware VM inventory must collect compact configuration and storage summaries without downloading every virtual hardware device');
  assert.ok(vmwareCollector.includes('/<!DOCTYPE|<!ENTITY/i') && vmwareCollector.includes('maxResponseBytes'), 'VMware SOAP responses must reject unsafe XML and enforce a size limit');
  assert.ok(server.includes("require('./src/vmware')") && server.includes("['vmware',       enabled(config.vmware)"), 'production refresh must collect configured VMware endpoints');
  assert.ok(settings.includes('data-settings-section="vmware"') && settings.includes('function addVmwareInstance(data = {})') && settings.includes('cfg.vmware = {'), 'Settings must configure and persist ESXi/vCenter endpoints');
  assert.ok(dashboard.includes('function buildVmware(vmware)') && dashboard.includes('function showVmwareGuest(endpointKey, id)') && dashboard.includes('showVmwareGuest(${jsStr(endpointKey)},${jsStr(vm.id)})') && dashboard.includes('vmware:       () => buildVmware(data.vmware)') && dashboard.includes('vmwareHosts.map(host => host.cpuPercent)'), 'dashboard details, clickable VM dialogs and KPI selectors must consume VMware inventory');
  const vmwareOverviewSource = dashboard.slice(dashboard.indexOf('function buildVmware'), dashboard.indexOf('function buildKubernetes'));
  assert.ok(dashboard.includes('.vmware-head-main{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(min-content,1fr)') && vmwareOverviewSource.includes('<div class="pve-head-main vmware-head-main">'), 'wide VMware host summary cells must stay equal unless their content needs more room');
  const vmwareSummarySource = vmwareOverviewSource.slice(vmwareOverviewSource.indexOf('const sidebarSummary ='), vmwareOverviewSource.indexOf('const endpointHtml ='));
  assert.ok(vmwareSummarySource.includes('<div class="sb-csum pve-sb-csum">') && vmwareSummarySource.indexOf('Hosts</div>') < vmwareSummarySource.indexOf('Cores</div>') && vmwareSummarySource.indexOf('Cores</div>') < vmwareSummarySource.indexOf('RAM</div>') && vmwareSummarySource.indexOf('RAM</div>') < vmwareSummarySource.indexOf('VMs</div>'), 'VMware detail must use the Proxmox-style Hosts, Cores, RAM and VMs summary order');
  assert.ok(vmwareOverviewSource.includes("miniSparkline(hostHistory, 'cpu'") && vmwareOverviewSource.includes("miniSparkline(hostHistory, 'mem'") && vmwareOverviewSource.includes("histChart(hostHistory, 'cpu'") && vmwareOverviewSource.includes("histChart(hostHistory, 'mem'"), 'VMware hosts must show CPU and RAM history in summary and expanded charts');
  const vmwareHostHeader = vmwareOverviewSource.slice(vmwareOverviewSource.indexOf('<div class="node-hdr pve-node-hdr" onclick="toggleVmwareHost'), vmwareOverviewSource.indexOf('<div class="node-body', vmwareOverviewSource.indexOf('<div class="node-hdr pve-node-hdr" onclick="toggleVmwareHost')));
  assert.ok(vmwareHostHeader.includes('${bdg(hostBadgeClass, hostStateText)}') && vmwareOverviewSource.includes("const hostBadgeClass = instanceStale ? 'yellow' : !host.online") && vmwareOverviewSource.includes('detailSummary: sidebarSummary') && !vmwareOverviewSource.includes("detailBadge: ''") && vmwareOverviewSource.includes("detailMeta: ''"), 'VMware host and top summaries must restore their far-right health badges');
  assert.ok(vmwareOverviewSource.includes('const stale = !!vmware._stale;') && vmwareOverviewSource.includes("? 'stale data'") && vmwareOverviewSource.includes("const instanceStale = stale || !!instance._stale"), 'stale VMware inventory must be visibly degraded instead of remaining healthy');
  assert.ok(server.includes("if (key === 'vmware') return value?._stale === true") && server.includes('const vmwareStale = !!data.vmware?._stale;') && server.includes("const status = stale ? 'warn'"), 'stale VMware inventory must affect refresh backoff, alerts and public health');
  assert.ok(i18n.includes("'stale data':'güncel değil'"), 'stale VMware status must follow the selected language');
  assert.ok(vmwareOverviewSource.includes('class="vmware-datastore-grid"') && vmwareOverviewSource.includes('const datastoreCards = instanceDatastores.length') && vmwareOverviewSource.includes("datastore.name || 'Datastore'") && vmwareOverviewSource.includes('hideTitle: instanceDatastores.length === 1') && dashboard.includes('.vmware-datastore-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))') && dashboard.includes('function capacityGaugeCard(title, percent, usedBytes, totalBytes, options = {})'), 'VMware datastores must reuse responsive side-by-side Ceph capacity gauges and suppress a redundant single-datastore card title');
  assert.ok(dashboard.includes('function toggleVmwareDatastores(instanceIndex, key)') && dashboard.includes('setOverride(`vmware:datastores:${key}`, open)') && vmwareOverviewSource.includes('panelOpenState(`vmware:datastores:${endpointKey}`, false)') && vmwareOverviewSource.includes('class="k8s-grp ceph-health-group vmware-datastore-group"') && vmwareOverviewSource.includes('onclick="toggleVmwareDatastores(${instanceIndex},${jsStr(endpointKey)})"'), 'VMware datastores must use a persistent Ceph-style expand and collapse group');
  const vmwareInstanceLayout = vmwareOverviewSource.slice(vmwareOverviewSource.indexOf('const instanceBody ='), vmwareOverviewSource.indexOf("if (instance.type === 'esxi')"));
  assert.ok(vmwareInstanceLayout.indexOf('<span>Datastores</span>') < vmwareInstanceLayout.indexOf('<span>Clusters</span>') && vmwareInstanceLayout.indexOf('<span>Clusters</span>') < vmwareInstanceLayout.indexOf('${hostRows') && !vmwareInstanceLayout.includes('<span>ESXi hosts</span>'), 'VMware detail must show datastores first, optional clusters second and host rows last without a redundant ESXi host count heading');
  assert.ok(vmwareOverviewSource.includes("if (instance.type === 'esxi') return `<section class=\"prom-instance vmware-standalone-instance\">") && vmwareOverviewSource.includes('<div class="prom-instance-body open" id="vmware-body-${instanceIndex}">${instanceBody}</div>'), 'standalone ESXi details must omit the duplicate endpoint row while retaining datastore and host controls');
  assert.ok(vmwareOverviewSource.includes("badgeHtml: datastoreWarn ? bdg(datastoreBadgeClass, datastore.accessible === false ? 'inaccessible' : 'attention') : ''") && !vmwareOverviewSource.includes("datastore.accessible === false ? 'inaccessible' : 'online'"), 'healthy VMware datastore gauges must not repeat an online badge');
  assert.ok(server.includes("const vmwareHistory = loadHistoryMap('vmware-history'") && server.includes("key === 'vmware' ? preservePlatformOnTransient(key, mergeVmwareHistory(next))"), 'VMware host history must persist across refreshes and restarts');
  assert.ok(!dashboard.includes('transform ${INTERVAL}ms linear') && dashboard.includes("if(msg.type === 'refreshing')") && dashboard.includes('manualPbarStart();') && dashboard.includes("if(msg.type === 'updated') manualPbarDone();"), 'the top progress bar must represent actual refresh activity instead of a fixed 15-second countdown');
  assert.ok(server.indexOf("broadcastStatusEvent('refreshing')") > server.indexOf('if (!taskFns.length)'), 'refresh activity must only be broadcast when collector tasks actually run');
  assert.ok(topology.includes('vmware-endpoint:') && topology.includes('vmware-cluster:') && topology.includes('vmware-host:') && topology.includes('vmware-guest:'), 'topology must map vCenter endpoints, clusters, ESXi hosts and VMs');
  assert.ok(demoServer.includes('const vmwareHosts = [') && demoServer.includes('history: history(96, 20, 35)') && demoServer.includes('data.vmware = {') && demoServer.includes("['vmware', 'vmware']"), 'demo mode must expose realistic VMware inventory and host history');
  assert.ok(onboarding.includes('<option value="vmware">VMware ESXi / vCenter</option>') && server.includes("type === 'vmware' && url && input.username && input.password"), 'first-run onboarding must accept a VMware endpoint');
  assert.ok(configExample.includes('vmware:') && readme.includes('**VMware ESXi / vCenter**') && docsEnglish.includes('### VMware ESXi / vCenter') && docsTurkish.includes('### VMware ESXi / vCenter'), 'VMware configuration and operation must be documented in both languages');
  assert.ok(i18n.includes("'VMware endpoints':'VMware endpoint’leri'") && packageJson.description.includes('VMware ESXi/vCenter'), 'VMware UI strings and package metadata must identify the platform');
  assert.ok(dashboard.includes('/api/status/history?points='));
  assert.ok(!dashboard.includes("const clusterLabel = /^https?:\\/\\//i"), 'Proxmox node subtitle must not include cluster metadata');
  assert.ok(dashboard.includes("replace(/:8006\\/?$/i, '')"), 'Proxmox host summaries must hide the default 8006 port');
  assert.ok(dashboard.includes('min-width:140px;display:grid;grid-template-columns:max-content minmax(32px,1fr)'), 'header history charts must begin immediately after their metric text');
  assert.ok(dashboard.includes("pveHeadStat('Bandwidth'"), 'Proxmox bandwidth label must not use an unclear abbreviation');
  assert.ok(dashboard.includes('title="${escAttr(`${label}: ${value}`)}"'), 'header metrics must expose their complete value as a tooltip');
  assert.ok(dashboard.includes("os_app_update_footer_v3") && dashboard.includes("cache:'no-store'"), 'app update check must bypass stale browser responses');
  assert.ok(!dashboard.includes("cachedUpdate || fetch('/api/update-check'"), 'cached app version must not replace the GitHub update request');
  assert.ok(dashboard.includes('@container (max-width:300px)') && dashboard.includes('-webkit-line-clamp:2'), 'overview titles must adapt to narrow cards');
  assert.ok(dashboard.includes('@container (min-width:301px)') && dashboard.includes('.overview-title{display:block;white-space:nowrap'), 'normal-width overview titles must stay on one line so alert badges cannot make one card taller');
  assert.ok(dashboard.includes('.overview-card[data-id="windows"] .overview-card-h>.badge{width:64px') && dashboard.includes('white-space:normal;line-height:1.08;text-align:center') && dashboard.includes('.overview-card[data-id="windows"] .overview-title{overflow:visible;text-overflow:clip}'), 'Windows overview must preserve its full title and wrap reboot-required into the badge');
  assert.ok(dashboard.includes('.shell .sb-card.sb-badge-priority .sb-badge-wrap>.badge{width:var(--sb-badge-width)') && dashboard.includes('overflow-wrap:normal;word-break:normal;line-height:1.08;text-align:center;font-size:11px'), 'all sidebar platform badges must support readable word wrapping');
  assert.ok(dashboard.includes('function syncSidebarBadgeWrapping()') && dashboard.includes('title.scrollWidth - title.clientWidth') && dashboard.includes('const minimumWidth = sidebarBadgeMinimumWidth(badge)') && dashboard.includes('naturalWidth - titleOverflow - 2'), 'sidebar badges must give space to the complete platform title before allowing the title to truncate');
  assert.ok(!dashboard.includes('.shell.rail-narrow .sb-card[data-id="windows"] .sb-badge-wrap>.badge'), 'sidebar badge wrapping must not be limited to Windows or Linux');
  assert.ok(dashboard.includes('function overviewMetaHtml(meta)'), 'overview metadata must be rendered as separate metrics');
  assert.ok(dashboard.includes('.overview-meta-part+.overview-meta-part::before'), 'wide overview metadata must keep its separator');
  assert.ok(dashboard.includes('.overview-meta{flex-direction:column;align-items:flex-start'), 'narrow overview metadata must wrap each metric onto its own line');
  assert.ok(dashboard.includes('.overview-card .sb-csum{display:flex;flex-wrap:nowrap'), 'overview summary metrics must remain on one row');
  assert.ok(dashboard.includes('flex:1 1 max-content'), 'overview summary widths must adapt to their content');
  assert.ok(dashboard.includes('function overviewGaugeSegments(raw)') && dashboard.includes('const count = 30') && dashboard.includes('const innerRadius = 70') && dashboard.includes('const outerRadius = 80') && dashboard.includes('M8.12 104.55 A87 87 0 1 1 181.88 104.55'), 'overview gauge outer arc must extend slightly below the tick endpoints while retaining a constant radial gap');
  assert.ok(dashboard.includes('.ov-gauge-center{position:absolute;left:50%;top:calc(61% + 5px)'), 'overview gauge values must sit five pixels lower inside the ring');
  assert.ok(dashboard.includes('.ov-gauge{position:relative;width:100%;height:118px') && dashboard.includes('overflow:hidden;transform:translateY(-3px)'), 'the complete overview gauge must sit slightly higher without changing its internal alignment');
  assert.ok(dashboard.includes('transform:translateY(8px) scale(1.15);transform-origin:center bottom'), 'overview CPU and RAM gauge rings must retain the original width and height');
  assert.ok(dashboard.includes('function overviewPercentHistory') && dashboard.includes('class="ov-gauge-trend"'), 'overview CPU and RAM gauges must use real metric history for their trend line');
  assert.ok(dashboard.includes("function overviewKpiHostOptions(platform, data, metric = '')") && dashboard.includes('window.setOverviewKpiTarget = function(metric, platform, host = \'all\')'), 'CPU, RAM, Disk I/O and Bandwidth KPIs must expose an atomic platform-and-host selector');
  assert.ok(dashboard.includes('function drawOverviewKpiCascadeSelect(metric, current, currentHost, options, data)') && dashboard.includes('overviewKpiHostOptions(option.id, data, metric)') && dashboard.includes('class="os-sel-submenu"') && dashboard.includes('openOverviewKpiSubmenu(this,event)'), 'all KPI host choices must open as a right-side cascading submenu');
  assert.ok(dashboard.includes('function captureOverviewKpiMenuState(detail)') && dashboard.includes('restoreOverviewKpiMenuState(detail, openKpiMenus)') && dashboard.includes('data-platform="${escAttr(option.id)}"'), 'open KPI cascading menus must survive dashboard data refreshes');
  assert.ok(!dashboard.includes('drawOverviewKpiHostSelect') && !dashboard.includes('overview-kpi-host-select'), 'KPIs must not render a second standalone host dropdown');
  assert.ok(dashboard.includes("label:trText('All hosts')") && dashboard.includes("overviewPercentHistory(data, platform, metric, selectedHost?.id || 'all')"), 'CPU and RAM host selection must filter both the current KPI value and its history');
  assert.ok(dashboard.includes('disk: sources.disk?.[platform]?.[index]') && dashboard.includes('bandwidth: sources.bandwidth?.[platform]?.[index]') && dashboard.includes('const metricHosts = metric ? hosts.filter(host => hasNum(host?.[metric])) : hosts'), 'rate KPI host menus must include only devices reporting the selected metric');
  assert.ok(dashboard.includes("const supportsHostSelection = ['cpu','mem','disk','bandwidth'].includes(metric)") && dashboard.includes("const hostOptions = ['cpu','mem','disk','bandwidth'].includes(metric) ? overviewKpiHostOptions(current, data, metric) : []"), 'all four overview KPIs must retain device selection during initial and incremental renders');
  assert.ok(dashboard.includes("function overviewRateHistory(data, platform, metric, host = 'all')") && dashboard.includes('const rateRows = selectedHost ? { [platform]: [selectedHost.row] } : sources.rateRows') && dashboard.includes('const metricValues = selectedHost ? [selectedHost.disk]') && dashboard.includes('const metricValues = selectedHost ? [selectedHost.bandwidth]'), 'Disk I/O and Bandwidth device selection must filter both current values and history');
  assert.ok(dashboard.includes('overviewKpiHosts: overviewKpiHosts || {}') && server.includes('ui.overviewKpiHosts = cleanStringMap(') && server.includes("'cpu','mem','memory','disk','bandwidth'"), 'KPI host filters and the RAM metric key must survive preference persistence');
  assert.ok(dashboard.includes('overviewResponsiveLayoutKey') && dashboard.includes('stableOverviewIds'), 'responsive resizing must preserve the dashboard card order');
  assert.ok(dashboard.includes('function bindDetailSystemDragging(detail)') && dashboard.includes("header.classList.toggle('detail-system-draggable', canDrag)") && dashboard.includes('moveDraggedDetailSystem(detailSystemDrag.detail'), 'collapsed detail systems must support pointer-based drag-and-drop ordering');
  assert.ok(!dashboard.includes('detail-order-btn') && !dashboard.includes('detail-order-controls'), 'platform detail ordering must not render separate up/down buttons');
  assert.ok(dashboard.includes("localStorage.setItem('os_detail_system_order'") && server.includes('ui.detailSystemOrder = cleanStringArrayMap('), 'detail system order must persist locally and on the server');
  assert.ok(dashboard.includes('sidebarPanelOrder = mergeUiOrder(sidebarPanelOrder, order)') && dashboard.includes('dashboardPanelOrder = mergeUiOrder(dashboardPanelOrder, order)'), 'sidebar and dashboard ordering must retain systems that are temporarily absent');
  assert.ok(dashboard.split("panel.sbMeta !== undefined ? panel.sbMeta : (panel.meta || '')").length - 1 === 2 && dashboard.includes("if(item?.id === 'linux' || item?.id === 'windows')") && dashboard.includes('if(total > 0) return `${online}/${total} online`;'), 'Linux and Windows sidebar metadata must remain online across full and embedded pages');
  assert.ok(dashboard.includes('function readLocalRailWidthPref()') && dashboard.includes('const localRailWidth = readLocalRailWidthPref()') && dashboard.includes('if(localRailWidth) railWidthPref = localRailWidth') && dashboard.includes("localStorage.setItem('os_rail_width', String(railWidthPref))"), 'a locally saved sidebar width must remain authoritative across navigation and monitored-system changes');
  assert.ok(dashboard.includes('if(!window._railResizing)') && dashboard.includes('window._railResizing = true') && dashboard.includes('window._railResizing = false'), 'status refreshes must not resize the sidebar during an active drag');
  assert.ok(dashboard.includes("window.addEventListener('pointermove', move, { capture:true, passive:false })") && dashboard.includes("window.removeEventListener('pointermove', move, true)"), 'sidebar resizing must keep tracking the pointer when it leaves the narrow resize handle');
  const embeddedPollSource = dashboard.slice(dashboard.indexOf('async function pollOnce()'), dashboard.indexOf('let statusStream = null'));
  assert.ok(!embeddedPollSource.includes('embedOpen') && dashboard.includes('SHELL_SUMMARY_INTERVAL') && dashboard.includes('scheduleShellSummarySync(80)'), 'embedded pages must keep the sidebar health summary refreshed');
  assert.ok(server.includes("badge: failedSvcs > 0 ? `${failedSvcs} services failed`") && server.includes('badge: s.badge ||') && dashboard.includes('if(item?.badge)') && dashboard.includes('txt:String(item.badge)'), 'embedded pages must preserve detailed Linux and Windows failure, reboot and update badges');
  assert.ok(dashboard.includes("e.data?.type === 'omnisight-status-changed'") && settings.includes("type: 'omnisight-status-changed'"), 'settings status and agent changes must immediately notify the parent sidebar');
  assert.ok(dashboard.includes('const activeIds = new Set([...present, ...configuredIds])') && dashboard.includes('if(ALL_IDS.includes(id) && !activeIds.has(id)) delete panels[id]'), 'summary refreshes must remove platforms that no longer have configured systems');
  const orderHelperStart = dashboard.indexOf('function validUiPlatform');
  const orderHelperEnd = dashboard.indexOf('function compactUiPreferences', orderHelperStart);
  const orderContext = {};
  vm.runInNewContext(`const ALL_IDS = ${JSON.stringify(['proxmox','vmware','kubernetes','linux','windows','synology','mikrotik','unifi','snmp','healthchecks','uptimekuma','checks','prometheus','docker','dockhand','firewall','truenas','qnap','ugreen','pbs','cloudflare','cicd','veeam','portainer','database'])};\n${dashboard.slice(orderHelperStart, orderHelperEnd)}\nglobalThis.mergeUiOrder = mergeUiOrder;`, orderContext);
  assert.strictEqual(JSON.stringify(orderContext.mergeUiOrder(['proxmox','kubernetes','linux','docker'], ['docker','proxmox','linux'])), JSON.stringify(['docker','kubernetes','proxmox','linux']), 'temporarily absent sidebar platforms must keep their saved slot during a visible reorder');
  assert.ok(i18n.includes("'All hosts':'Tüm hostlar'") && !i18n.includes("'Move up':'Yukarı taşı'") && !i18n.includes("'Move down':'Aşağı taşı'"), 'host filters must stay translated and removed ordering buttons must not leave dead labels');
  const proxmoxOverviewSource = dashboard.slice(dashboard.indexOf('function buildProxmox'), dashboard.indexOf('function buildLinux'));
  assert.ok(!proxmoxOverviewSource.includes('<div class="sb-csum-lbl">Ceph</div>'), 'Proxmox overview must not repeat the Ceph header badge in its summary metrics');
  assert.ok(proxmoxOverviewSource.includes('cephBad') && proxmoxOverviewSource.includes('Ceph ${ceph.health'), 'Proxmox overview must retain its Ceph header badge');
  assert.ok(proxmoxOverviewSource.includes('<div class="pve-head-main proxmox-head-main">') && dashboard.includes('.proxmox-head-main{flex-wrap:nowrap}') && dashboard.includes('.proxmox-head-main .pve-head-stat.has-spark{min-width:0}'), 'wide Proxmox node summaries must keep all metrics on one row');
  assert.ok(proxmoxOverviewSource.includes("<div class=\"pve-head-sub\">${node.online ? 'online' : 'offline'}</div>"), 'Proxmox node subtitle must show only its online state');
  assert.ok(proxmoxOverviewSource.includes('sbMeta: `${online}/${total} hosts · ${vmRunning}/${allVms.length} VMs`'), 'Proxmox sidebar metadata must show host and VM availability like VMware');
  const proxmoxHostHeader = proxmoxOverviewSource.slice(proxmoxOverviewSource.indexOf('<div class="node-hdr pve-node-hdr" onclick="toggleNode'), proxmoxOverviewSource.indexOf('<div class="node-body', proxmoxOverviewSource.indexOf('<div class="node-hdr pve-node-hdr" onclick="toggleNode')));
  assert.ok(proxmoxHostHeader.includes("${bdg(node.online ? (svcFailed ? 'red' : 'green') : 'red'") && proxmoxHostHeader.includes('`${svcFailed} services failed`') && proxmoxOverviewSource.includes("detailSummary: relabelDetailSummary(sbSummaryHtml, 'Nodes', 'Hosts')") && !proxmoxOverviewSource.includes("detailBadge: ''") && proxmoxOverviewSource.includes("detailMeta: ''"), 'Proxmox host and top summaries must restore their far-right health badges');
  assert.ok(proxmoxOverviewSource.includes('pve-cluster-status') && proxmoxOverviewSource.includes('clusterQuorumLost') && proxmoxOverviewSource.includes('Cluster quorum lost'), 'Proxmox details must show detected cluster membership and surface quorum loss');
  assert.ok(proxmoxOverviewSource.includes('body: cephHtml + clusterHtml + nodesHtml'), 'Proxmox details must be ordered Ceph health, cluster, then hosts');
  assert.ok(topology.includes('proxmox-cluster:') && topology.includes('clusterNodeIds.set(clusterName, clusterId)') && topology.includes("clusterNodeIds.get(n.clusterName || '')"), 'Proxmox topology must group hosts under their detected cluster');
  assert.ok(server.includes('px:cluster:${name}:quorum') && server.includes('quorumLost.length > 0'), 'cluster quorum loss must enter alerts and public health');
  assert.ok(linuxAgent.includes('pvesh get /cluster/status --output-format json') && linuxAgent.includes('\"clusterStatus\"'), 'Proxmox agents must report cluster identity, membership and quorum');
  assert.ok(demoServer.includes("name: 'demo-cluster'") && docsEnglish.includes('real Proxmox cluster name, member nodes and quorum state'), 'demo data and documentation must cover automatic Proxmox cluster detection');
  assert.ok(proxmoxOverviewSource.includes('ceph-osd-metrics') && proxmoxOverviewSource.includes('OSDs Up') && proxmoxOverviewSource.includes('Total OSDs'), 'Ceph health must show separate Proxmox-style OSD counters');
  assert.ok(proxmoxOverviewSource.includes('latency.averageMs') && proxmoxOverviewSource.includes('AVG Latency') && proxmoxOverviewSource.includes('MON Quorum Status'), 'Ceph health must show average OSD latency and MON quorum status');
  assert.ok(proxmoxOverviewSource.includes("value < 1 ? '&lt;1 ms'"), 'sub-millisecond Ceph latency must be displayed as less than one millisecond');
  assert.ok(proxmoxOverviewSource.includes("capacityGaugeCard('Cluster Capacity Used'") && dashboard.includes('ceph-gauge-fill'), 'Ceph capacity must use the shared Proxmox-style gauge');
  assert.ok(dashboard.includes('.ceph-gauge-fill.is-ok{stroke:#3cb78a}') && dashboard.includes('M17 128 A113 113') && dashboard.includes("usagePct >= 90 ? 'is-critical'"), 'capacity gauge colors and arc spacing must preserve Proxmox-style threshold severity');
  assert.ok(dashboard.includes('.ceph-health-grid{display:grid') && dashboard.includes('.ceph-health-grid{grid-template-columns:1fr}'), 'Ceph health cards must stack on narrow screens');
  assert.ok(i18n.includes("'Ceph Storage Health':'Ceph Depolama Sağlığı'") && i18n.includes("'Cluster Capacity Used':'Kullanılan Küme Kapasitesi'") && i18n.includes("'No active warnings or errors':'Aktif uyarı veya hata yok'"), 'Ceph health labels must follow the selected language');
  assert.ok(linuxAgent.includes('pvesh get "/nodes/$HOSTNAME_S/ceph/osd"'), 'Proxmox agents must report per-OSD latency data');
  const linuxOverviewSource = dashboard.slice(dashboard.indexOf('function buildLinux'), dashboard.indexOf('function buildWindows'));
  assert.ok(!linuxOverviewSource.includes('<div class="sb-csum-lbl">Updates</div>'), 'Linux overview must not repeat the updates header badge in its summary metrics');
  assert.ok(linuxOverviewSource.includes('agentUpdateState: { count: updateCount, visible: updateAttention }'), 'Linux overview must retain its updates header badge');
  assert.ok(linuxOverviewSource.includes("allOk && !connecting && !updateAttention ? 'healthy'") && linuxOverviewSource.includes("detailMeta: ''") && !linuxOverviewSource.includes("detailBadge: ''"), 'Linux detail must show its health or update badge at the far right without repeated reachable metadata');
  assert.ok(linuxOverviewSource.includes('sbMeta: `${reachable}/${linux.length} online`'), 'Linux sidebar metadata must use online instead of reachable');
  assert.ok(linuxOverviewSource.includes("svcFailed?`${svcFailed} services failed`:srvReboot?'reboot required':srvUpdates?`${srvUpdates} updates`:'online'"), 'Linux host rows must retain their far-right online, update, reboot or service-failure badge');
  assert.ok(linuxOverviewSource.includes("pveHeadStat('Disk', `${srv.disk.percent}%`, bc(srv.disk.percent), '', 'is-disk-usage')"), 'Linux disk usage must remain visible as a compact percentage');
  assert.ok(linuxOverviewSource.indexOf("pveHeadStat('Disk I/O'") < linuxOverviewSource.indexOf("pveHeadStat('Disk',"), 'Linux disk usage must appear immediately after Disk I/O');
  assert.ok(!linuxOverviewSource.includes("miniSparkline(srv.history, 'disk'") && !linuxOverviewSource.includes("histChart(srv.history,'disk'"), 'Linux disk usage history charts must stay removed');
  assert.ok(dashboard.includes("title:'Linux Servers'") && dashboard.includes("title: 'Linux Servers'") && server.includes("title: 'Linux Servers'") && settings.includes('>Linux Servers</span>') && docsEnglish.includes('### Linux Servers') && docsTurkish.includes('### Linux Servers'), 'Linux platform naming must stay plural across product surfaces');
  const windowsOverviewSource = dashboard.slice(dashboard.indexOf('function buildWindows'), dashboard.indexOf('function vmwareHealthDot'));
  assert.ok(windowsOverviewSource.includes("pveHeadStat('Disk', `${srv.disk.percent}%`, bc(srv.disk.percent), '', 'is-disk-usage')"), 'Windows disk usage must remain visible as a compact percentage');
  assert.ok(windowsOverviewSource.indexOf("pveHeadStat('Disk I/O'") < windowsOverviewSource.indexOf("pveHeadStat('Disk',"), 'Windows disk usage must appear immediately after Disk I/O');
  assert.ok(!windowsOverviewSource.includes("miniSparkline(srv.history, 'disk'") && !windowsOverviewSource.includes("histChart(srv.history,'disk'"), 'Windows disk usage history charts must stay removed');
  const windowsHostHeader = windowsOverviewSource.slice(windowsOverviewSource.indexOf('<div class="node-hdr pve-node-hdr" onclick="toggleWindows'), windowsOverviewSource.indexOf('<div class="node-body', windowsOverviewSource.indexOf('<div class="node-hdr pve-node-hdr" onclick="toggleWindows')));
  assert.ok(!windowsOverviewSource.includes("pveHeadStat('Reboot'") && windowsHostHeader.includes("svcFailed?`${svcFailed} services failed`:srvReboot?'reboot required':srvUpdates?`${srvUpdates} updates`:'online'") && windowsOverviewSource.includes("rebootCount ? `${rebootCount} reboot required`"), 'Windows reboot-required must remain in the platform header and each host row must retain its far-right status badge');
  assert.ok(windowsOverviewSource.includes("detailMeta: ''") && !windowsOverviewSource.includes("detailBadge: ''"), 'Windows detail must remove repeated reachable metadata while retaining its far-right health or update badge');
  assert.ok(windowsOverviewSource.includes('sbMeta: `${reachable}/${windows.length} online`'), 'Windows sidebar metadata must use online instead of reachable');
  assert.ok(dashboard.includes('.pve-head-stat.is-disk-usage{flex:0 0 auto;width:max-content;min-width:76px}'), 'Linux and Windows disk percentage cells must retain their slightly wider layout');
  assert.ok(dashboard.includes("title:'Windows Servers'") && dashboard.includes("title: 'Windows Servers'") && server.includes("title: 'Windows Servers'") && demoServer.includes("windows: 'Windows Servers'") && settings.includes('>Windows Servers</span>') && i18n.includes("'Windows Servers':'Windows Servers'"), 'Windows platform naming must stay plural across product surfaces');
  const synologySource = dashboard.slice(dashboard.indexOf('function buildSynology'), dashboard.indexOf('function buildUnifi'));
  const synologyStatsSource = synologySource.slice(synologySource.indexOf('const snmpStatsArr = ['), synologySource.indexOf('].filter(Boolean)', synologySource.indexOf('const snmpStatsArr = [')));
  assert.ok(synologySource.includes('const uptimeStat = dev.uptimeSeconds != null') && synologyStatsSource.indexOf("pveHeadStat('Bandwidth'") < synologyStatsSource.indexOf('uptimeStat'), 'SNMP uptime must always remain the rightmost visible metric');
  assert.ok(synologySource.includes("const snmpHeadClass = snmpStatsArr.length >= 8 ? ' snmp-head-8' : ''") && synologySource.includes('snmp-head-main${snmpHeadClass}') && dashboard.includes('.snmp-head-main.snmp-head-8{grid-template-columns:'), 'MikroTik rows must accommodate uptime alongside temperature and fan metrics');
  assert.ok(demoServer.includes("profile: 'mikrotik'") && demoServer.includes('uptimeSeconds: uptimeSeconds(26, 8, 17)'), 'demo MikroTik data must include uptime');
  assert.ok(dashboard.includes('.snmp-head-main>.pve-head-stat:last-child{width:auto}'), 'Synology summary rows must fill the complete metric grid width');
  const databaseSource = dashboard.slice(dashboard.indexOf('function buildDatabase'), dashboard.indexOf('function toggleDocker'));
  assert.ok(databaseSource.indexOf("pveHeadStat('Version'") < databaseSource.indexOf("pveHeadStat('Uptime', fmtUptime(d.uptimeSeconds)"), 'database uptime must remain the rightmost metric');
  assert.ok(!dashboard.includes("prefetchRouteResource(href, 'document')") && !dashboard.includes("cache: 'force-cache'"), 'nonce-protected HTML documents must not be prefetched into the browser cache');
  assert.ok(dashboard.includes('function scheduleEmbedPrefetch(opts = {})'), 'embed prefetch scheduling options must remain defined');
  assert.ok(dashboard.includes("visible:ifr.classList.contains('active')"), 'loaded embeds must receive their current visibility state after their scripts are ready');
  assert.ok(dashboard.includes('localizeSidebarOperationalText(lang);'), 'sidebar status phrases must use the selected language');
  assert.ok(dashboard.includes("'#detail .det-meta'") && dashboard.includes("'#detail .pve-head-sub'") && dashboard.includes("'#detail .ov-gauge-sub'") && dashboard.includes("'#detail .prom-instance-meta'") && dashboard.includes("'#detail .chart-hdr .nb-pct'"), 'dynamic detail, metric and overview status text must use operational localization');
  const selectPanelSource = dashboard.slice(dashboard.indexOf('function selectPanel(id, opts = {})'), dashboard.indexOf('function selectPanelGroup'));
  assert.ok(selectPanelSource.includes('applyLanguage(currentLang(data));'), 'platform details must reapply the selected language after navigation');
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
  const dockhandPanelSource = dashboard.slice(dashboard.indexOf('function buildDockhand'), dashboard.indexOf('\nfunction ', dashboard.indexOf('function buildDockhand') + 10));
  const kubernetesPanelSource = dashboard.slice(dashboard.indexOf('function buildKubernetes'), dashboard.indexOf('function nasSummaryMetricHtml'));
  const healthchecksPanelSource = dashboard.slice(dashboard.indexOf('function buildHealthchecks'), dashboard.indexOf('function normalizeUptimeStatus'));
  const uptimeKumaPanelSource = dashboard.slice(dashboard.indexOf('function buildUptimeKuma'), dashboard.indexOf('function buildChecks'));
  const serviceChecksPanelSource = dashboard.slice(dashboard.indexOf('function buildChecks'), dashboard.indexOf('function prometheusHealth'));
  const prometheusPanelSource = dashboard.slice(dashboard.indexOf('function buildPrometheus'), dashboard.indexOf('function dockerHistoryKey'));
  assert.ok(kubernetesPanelSource.includes('const detailSummaryHtml = `<div class="sb-csum">') && kubernetesPanelSource.includes('${s.running??0}/${totalPods}</div><div class="sb-csum-lbl">Pods</div>') && kubernetesPanelSource.includes("detailMeta: ''") && kubernetesPanelSource.includes('detailSummary: detailSummaryHtml'), 'Kubernetes detail must show the running/total pod ratio inside a summary cell instead of loose header metadata');
  assert.ok(synologySource.includes("detailMeta: panelId === 'synology' || panelId === 'mikrotik' ? '' : undefined"), 'Synology and MikroTik detail headers must not repeat device availability beside their boxed device count');
  assert.ok(healthchecksPanelSource.includes("detailMeta: ''") && uptimeKumaPanelSource.includes("detailMeta: ''") && serviceChecksPanelSource.includes("detailMeta: ''"), 'check platform detail headers must not repeat availability beside their boxed up count');
  assert.ok(prometheusPanelSource.includes("detailMeta: ''"), 'Prometheus detail must not repeat target and server availability beside its boxed summary');
  assert.ok(dockerPanelSource.includes("detailMeta: ''") && dockhandPanelSource.includes("detailMeta: ''"), 'Docker and Dockhand details must not repeat container availability beside their boxed summaries');
  assert.ok(databaseSource.includes("detailMeta: ''"), 'database detail must not repeat online availability beside its boxed device count');
  const panelDetailSource = dashboard.slice(dashboard.indexOf('function panelDetailHtml'), dashboard.indexOf('\nfunction ', dashboard.indexOf('function panelDetailHtml') + 10));
  assert.ok(panelDetailSource.includes("const hasBoxedDetailSummary = !!(detailSummary && detailSummary.includes('sb-csum'))") && panelDetailSource.includes("hasBoxedDetailSummary ? '' : panel.meta"), 'all platform detail headers with boxed summaries must suppress repeated loose metadata by default');
  assert.ok(dashboard.includes('function dockerContainerStateCounts(containers)') && dashboard.includes("created: states.filter(state => state === 'created').length") && dashboard.includes("['restarting','paused','removing'].includes(state)"), 'Docker created containers must be classified separately from actionable pending states');
  assert.ok(dockerPanelSource.includes('containerIssueLabel') && dockerPanelSource.includes('hostInfoLabel') && dashboard.includes("return `${counts.created} ${trText('created')}`"), 'Docker created containers must remain visible without degrading platform health');
  assert.ok(dashboard.includes('return counts.failed > 0 || counts.stopped > 0 || counts.pending > 0'), 'global Docker health must ignore created containers and include actionable states');
  assert.ok(server.includes('const containerIssues = stopped + failed + pending') && server.includes('${created} created'), 'compact production health must report created containers without warning');
  assert.ok(demoServer.includes("state: i === 5 ? 'created' : 'running'") && demoServer.includes("created: containers.filter(c => c.state === 'created').length") && demoServer.includes("color: i === 5 ? 'gray' : 'green'"), 'demo Docker data must include a neutral created container example');
  assert.ok(demoServer.includes("const issueStates = new Set(['exited', 'dead', 'restarting', 'paused', 'removing'])") && demoServer.includes("return hasIssue ? 'degraded' : 'healthy'"), 'demo compact health must keep created-only Docker hosts healthy');
  assert.ok(dockerPanelSource.includes('sbMeta: `${totalRunning}/${totalAll} containers · ${onlineHosts}/${docker.length} hosts`'), 'Docker sidebar metadata must show container and host availability counts');
  assert.ok(dockhandPanelSource.includes('sbMeta: `${running}/${total} containers · ${onlineServers}/${totalServers} hosts`'), 'Dockhand sidebar metadata must show container and host availability counts');
  assert.ok(server.includes('sidebarMeta = `${running}/${total} containers · ${up}/${data.docker.length} hosts`') && server.includes('sidebarMeta = `${sm.running || 0}/${sm.total || 0} containers · ${onlineServers}/${totalServers} hosts`') && server.includes('detail: s.sidebarMeta || s.detail || s.meta'), 'embedded production sidebars must retain Docker and Dockhand container and host counts');
  assert.ok(demoServer.includes('containers · ${data.docker.filter(h => h.online).length}/${data.docker.length} hosts') && demoServer.includes('containers · ${data.dockhand.summary.serverUp}/${data.dockhand.summary.servers} hosts'), 'embedded demo sidebars must retain Docker and Dockhand container and host counts');
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
  assert.ok(agentsPage.includes('function commandPanelGuide(commands, opts = {})') && agentsPage.includes('Check result → action') && agentsPage.includes('Service is active (running) and the HTTP result is 200.') && agentsPage.includes('Result contains timeout, DNS, connection or TLS error.'), 'agent repair panel must provide concise result-to-action guidance');
  assert.ok(agentsPage.includes('/^1\\.3(?:\\.|$)/.test(agentVersion)') && agentsPage.includes('This v1.3.x agent uses the old scheduled task.') && agentsPage.includes("agentVersion: d.agentVersion || ''"), 'the v1.3 to v1.4 migration note must be conditional on the selected agent version');
  assert.ok(server.includes('dashboard HTTP check passed.') && server.includes('Dashboard returned HTTP {0}; use Repair Windows agent.') && server.includes('Dashboard connection/TLS check failed;') && server.includes('Legacy scheduled-task agent detected. State={0}; use Repair Windows agent.') && server.includes("Write-Host 'Service History:'") && server.includes('Run only when the RESULT line says to use Repair Windows agent.'), 'Windows query must provide explicit results followed by clearly labelled service history');
  assert.ok(server.includes("agentVersion: agent.agentVersion || ''") && server.includes('role: agentInstallRole(agent)'), 'repair command responses must include the selected agent version and role');
  assert.ok(agentsPage.includes("${t('Check / repair')}") && agentsPage.includes("t('Run on affected host')"), 'offline agent action must direct users to check before repairing');
  assert.ok(agentsPage.includes('showUninstallAgentModal') && agentsPage.includes("closeUninstallAgentModal(true)") && agentsPage.includes("fetch('/api/agent/uninstall'"), 'Agents must provide an explicit Yes-confirmed uninstall action');
  assert.ok(settings.includes("const endpoint = pendingInstall ? '/api/agent/remove' : '/api/agent/uninstall'") && settings.includes("confirmLabel: 'Yes'"), 'Settings agent removal must remotely uninstall installed agents while retaining pending-install cancellation');
  assert.ok(docsEnglish.includes('### Remote Uninstall') && docsTurkish.includes('### Uzaktan Kaldırma') && docsEnglish.includes('independent local helper'), 'both documentation languages must explain connection-independent remote uninstall');
  assert.ok(demoServer.includes("app.post('/api/agent/uninstall'") && demoServer.includes("latestVersion: '1.4.1'"), 'the demo must mirror remote uninstall and current agent protocol behavior');
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
  assert.strictEqual(turkish.Uptime, 'Çalışma süresi');
  assert.strictEqual(turkish['Services up'], 'Aktif servisler');
  assert.strictEqual(turkish['reporting sources'], 'raporlama kaynağı');
  assert.strictEqual(turkish['Sys temp'], 'Sistem sıcaklığı');
  assert.strictEqual(turkish.VMs, 'VM’ler');
  assert.strictEqual(turkish.Documentation, 'Dokümantasyon');
  assert.ok(docsPage.includes('`/docs/${encodeURIComponent(candidate)}.txt`') && docsPage.includes("[requested, base, 'en']"), 'Documentation must load locale packs with English fallback');
  assert.ok(docsPage.includes("event.data?.type === 'omnisight-language'") && docsPage.includes("event.key === 'os_lang'"), 'Open documentation must react to language changes');
  assert.ok(!docsPage.includes("fetch('/docs.md'"), 'Documentation UI must not depend on Markdown files excluded from the image');
  assert.ok(docsPage.includes('function documentationUiLang(lang)') && docsPage.includes('window.OmniI18n?.locales?.[base]'), 'Documentation chrome must support regional language fallback');
  assert.ok(topology.includes('function localizeTopologyText(text, selectedLang = lang())') && topology.includes("document.querySelectorAll('.node-meta')"), 'topology node metadata must localize composite operational text');
  assert.ok(topology.includes("event.data?.type === 'omnisight-language'") && topology.includes('applyTopologyLanguage();'), 'open topology views must react to language changes');
  assert.strictEqual(turkish.Platforms, 'Platformlar');
  assert.strictEqual(turkish.Workloads, 'İş yükleri');
  assert.strictEqual(turkish.Links, 'Bağlantılar');
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
  assert.ok(server.includes('ensureAgentDerivedCacheCurrent();') && server.includes("broadcastStatusEvent('updated')") && server.includes('function refreshAgentCacheAfterRemoval() {\n  refreshAgentDerivedCache();'), 'agent additions, reports and removals must invalidate and broadcast the derived sidebar state');
  assert.ok((settings.match(/class="btn-sm platform-add"/g) || []).length >= 5, 'non-standard platform add buttons must participate in the lock');
}

async function run() {
  await testQnap();
  await testPbs();
  testDockerAndDockhand();
  await testDockhandEnvironments();
  testSynologyCpuCounters();
  testProxmoxInstances();
  testProxmoxClusterStatus();
  testVmwareInventoryNormalization();
  await testVmwareSoapFlow();
  testCephNormalization();
  testLatestStableVersion();
  testFullBackupEmptyFileCompatibility();
  testPlatformAvailability();
  testStaticRegressions();
  console.log('smoke ok — issue regressions: #4 #5 #6 #7 #9 #10 #12 #18 #20 #22 #23 #24 #25');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
