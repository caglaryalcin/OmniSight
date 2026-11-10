// Vendor-neutral UGREEN SNMP coverage. Real packets stay on loopback; no NAS,
// config changes, persisted history or external services are required.
const assert = require('assert');
const dgram = require('dgram');
const snmp = require('net-snmp');
const { getGenericNasData } = require('../src/snmp');
const { getAllUgreenData, configuredInstances, _resetRuntime } = require('../src/ugreen');

const COMMUNITY = 'ugreen-fixture-readonly';
const USER = {
  name: 'ugreen-fixture',
  level: snmp.SecurityLevel.authPriv,
  authProtocol: snmp.AuthProtocols.sha,
  authKey: 'FixtureAuthPassword',
  privProtocol: snmp.PrivProtocols.aes,
  privKey: 'FixturePrivPassword',
};
const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  storage: '1.3.6.1.2.1.25.2.3.1',
  storageRam: '1.3.6.1.2.1.25.2.1.2',
  storageDisk: '1.3.6.1.2.1.25.2.1.4',
};

async function unusedPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function fixtureAgent() {
  const port = await unusedPort();
  const errors = [];
  const agent = snmp.createAgent({ port, address: '127.0.0.1' }, error => {
    if (error) errors.push(error);
  });
  const socket = Object.values(agent.listener.sockets)[0];
  await new Promise((resolve, reject) => {
    socket.once('listening', resolve);
    socket.once('error', reject);
  });
  agent.getAuthorizer().addCommunity(COMMUNITY);
  agent.getAuthorizer().addUser(USER);
  const mib = agent.getMib();
  function scalar(name, oid, type, value) {
    mib.registerProvider({ name, oid, type: snmp.MibProviderType.Scalar,
      scalarType: type, maxAccess: snmp.MaxAccess['read-only'] });
    mib.setScalarValue(name, value);
  }
  function table(name, oid, columns, rows) {
    mib.registerProvider({ name, oid, type: snmp.MibProviderType.Table,
      maxAccess: snmp.MaxAccess['not-accessible'],
      tableColumns: columns.map(([number, columnName, type]) => ({
        number, name: columnName, type, maxAccess: snmp.MaxAccess['read-only'],
      })),
      tableIndex: [{ columnName: columns[0][1] }],
    });
    rows.forEach(row => mib.addTableRow(name, row));
  }
  scalar('sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString, 'UGREEN fixture running Net-SNMP');
  scalar('sysUpTime', '1.3.6.1.2.1.1.3', snmp.ObjectType.TimeTicks, 1234500);
  table('hrProcessorEntry', '1.3.6.1.2.1.25.3.3.1', [
    [1, 'hrProcessorIndex', snmp.ObjectType.Integer],
    [2, 'hrProcessorLoad', snmp.ObjectType.Integer],
  ], [[1, 30], [2, 50]]);
  table('hrStorageEntry', OID.storage, [
    [1, 'hrStorageIndex', snmp.ObjectType.Integer],
    [2, 'hrStorageType', snmp.ObjectType.OID],
    [3, 'hrStorageDescr', snmp.ObjectType.OctetString],
    [4, 'hrStorageAllocationUnits', snmp.ObjectType.Integer],
    [5, 'hrStorageSize', snmp.ObjectType.Integer],
    [6, 'hrStorageUsed', snmp.ObjectType.Integer],
  ], [
    [1, OID.storageRam, 'Physical memory', 4096, 2097152, 524288],
    [2, OID.storageDisk, '/volume1', 4096, 1000000, 250000],
    [3, '1.3.6.1.2.1.25.2.1.3', 'Swap space', 4096, 100000, 10000],
    [4, '1.3.6.1.2.1.25.2.1.5', 'USB removable storage', 4096, 100000, 10000],
    [5, OID.storageDisk, '/invalid-allocation-units', 0, 1000000, 250000],
  ]);
  table('lmTempSensorsEntry', '1.3.6.1.4.1.2021.13.16.2.1', [
    [1, 'lmTempSensorsIndex', snmp.ObjectType.Integer],
    [2, 'lmTempSensorsDevice', snmp.ObjectType.OctetString],
    [3, 'lmTempSensorsValue', snmp.ObjectType.Gauge32],
  ], [[1, 'CPU package', 47000]]);
  table('ifEntry', '1.3.6.1.2.1.2.2.1', [
    [1, 'ifIndex', snmp.ObjectType.Integer],
    [2, 'ifDescr', snmp.ObjectType.OctetString],
    [5, 'ifSpeed', snmp.ObjectType.Gauge32],
    [8, 'ifOperStatus', snmp.ObjectType.Integer],
    [10, 'ifInOctets', snmp.ObjectType.Counter32],
    [16, 'ifOutOctets', snmp.ObjectType.Counter32],
  ], [[1, 'eth0', 1000000000, 1, 100000, 200000]]);
  return { port, errors, close: () => new Promise(resolve => agent.close(resolve)) };
}

function observeSessionFactories() {
  const originals = { createSession: snmp.createSession, createV3Session: snmp.createV3Session };
  const sessions = [];
  for (const factory of Object.keys(originals)) {
    snmp[factory] = function (...args) {
      const session = originals[factory].apply(this, args);
      const entry = { factory, host: args[0], credentials: args[1], options: args[2], oids: [], closes: 0 };
      sessions.push(entry);
      const get = session.get;
      const subtree = session.subtree;
      const close = session.close;
      session.get = function (oids, ...rest) {
        entry.oids.push(...oids);
        return get.call(this, oids, ...rest);
      };
      session.subtree = function (oid, ...rest) {
        entry.oids.push(oid);
        return subtree.call(this, oid, ...rest);
      };
      session.close = function (...rest) {
        entry.closes += 1;
        return close.apply(this, rest);
      };
      return session;
    };
  }
  return { sessions, restore: () => Object.assign(snmp, originals) };
}

async function withControlledSession(options, callback) {
  const original = snmp.createSession;
  let closes = 0;
  snmp.createSession = () => ({
    get(oids, done) {
      if (options.unreachable) return done(new Error('fixture unreachable'));
      if (options.ucdMemoryUnavailable && oids.some(oid => oid.startsWith('1.3.6.1.4.1.2021.4.'))) {
        return done(new Error('fixture UCD memory unavailable'));
      }
      done(null, oids.map(oid => oid === OID.sysDescr
        ? { oid, type: snmp.ObjectType.OctetString, value: Buffer.from('Minimal NAS agent') }
        : { oid, type: snmp.ObjectType.NoSuchObject, value: null }));
    },
    subtree(oid, repetitions, feed, done) {
      if (oid === OID.storage && options.memoryType != null) {
        const values = { 2: options.memoryType, 3: Buffer.from('Memory'), 4: 4096, 5: 1000, 6: options.used == null ? 250 : options.used };
        feed(Object.entries(values).map(([column, value]) => ({
          oid: `${OID.storage}.${column}.1`,
          type: column === '2' && typeof value === 'string' ? snmp.ObjectType.OID : Buffer.isBuffer(value) ? snmp.ObjectType.OctetString : snmp.ObjectType.Integer,
          value,
        })));
      }
      done();
    },
    close() { closes += 1; },
  });
  try { await callback(() => closes); }
  finally { snmp.createSession = original; }
}

async function run() {
  const fixture = await fixtureAgent();
  const observed = observeSessionFactories();
  try {
    const device = { host: '127.0.0.1', port: fixture.port, community: COMMUNITY, snmpVersion: 2, timeoutMs: 1750, retries: 0 };
    const data = await getGenericNasData(device);
    assert.strictEqual(data.online, true);
    assert.strictEqual(data.system.cpu, 40, 'CPU must come from HOST-RESOURCES processor loads');
    assert.strictEqual(data.system.ram.totalBytes, 8589934592);
    assert.strictEqual(data.system.ram.usedBytes, 2147483648);
    assert.strictEqual(data.system.ram.percent, 25);
    assert.strictEqual(data.system.uptimeSeconds, 12345);
    assert.strictEqual(data.system.cpuTemp, 47, 'LM-SENSORS milli-degrees must be normalized');
    assert.strictEqual(data.network.length, 1);
    assert.strictEqual(data.network[0].name, 'eth0');
    assert.strictEqual(data.network[0].rxBps, null, 'first counter sample must not invent a throughput');
    assert.deepStrictEqual(data.volumes, [{ name: '/volume1', mountpoint: '/volume1', totalBytes: 4096000000, usedBytes: 1024000000, usedPercent: 25 }]);
    assert.deepStrictEqual(data.available, { system: true, storage: true, disks: false, services: false });
    assert.deepStrictEqual(data.errors, []);
    const v2 = observed.sessions.at(-1);
    assert.strictEqual(v2.host, '127.0.0.1');
    assert.strictEqual(v2.options.port, fixture.port);
    assert.strictEqual(v2.options.timeout, 1750);
    assert.strictEqual(v2.options.retries, 0);
    assert.strictEqual(v2.options.version, snmp.Version2c);

    const v3 = await getGenericNasData({ host: '127.0.0.1', port: fixture.port, snmpVersion: 3,
      username: USER.name, securityLevel: 'authPriv', authProtocol: 'sha', authPassword: USER.authKey,
      privProtocol: 'aes', privPassword: USER.privKey, timeoutMs: 2250, retries: 0 });
    assert.strictEqual(v3.system.cpu, 40, 'SNMPv3 SHA/AES must read actual loopback-agent values');
    assert.strictEqual(v3.system.ram.percent, 25);
    const v3Session = observed.sessions.at(-1);
    assert.strictEqual(v3Session.factory, 'createV3Session');
    assert.strictEqual(v3Session.options.port, fixture.port);
    assert.strictEqual(v3Session.options.timeout, 2250);
    assert.strictEqual(v3Session.options.retries, 0);
    assert.deepStrictEqual(v3Session.credentials, USER);

    const inherited = configuredInstances({ method: 'snmp', community: COMMUNITY, port: fixture.port, instances: [{ host: '127.0.0.1' }] });
    assert.strictEqual(inherited.length, 1, 'a host-only SNMP instance must be retained');
    assert.strictEqual(inherited[0].method, 'snmp');
    assert.strictEqual(inherited[0].port, fixture.port);
    assert.strictEqual(inherited[0].community, COMMUNITY);
    assert.strictEqual(inherited[0].name, '127.0.0.1');
    const platform = await getAllUgreenData({ method: 'snmp', community: COMMUNITY, port: fixture.port,
      timeoutMs: 1000, instances: [{ host: '127.0.0.1', name: 'NAS fixture' }] });
    assert.strictEqual(platform.online, true);
    const nas = platform.instances[0];
    assert.strictEqual(nas.host, '127.0.0.1');
    assert.strictEqual(nas.method, 'snmp');
    assert.strictEqual(nas.partial, false, nas.error);
    assert.strictEqual(nas.system.cpuPercent, 40);
    assert.strictEqual(nas.system.memoryPercent, 25);
    assert.strictEqual(nas.system.memoryTotalBytes, 8589934592);
    assert.strictEqual(nas.volumes[0].totalBytes, 4096000000);
    assert.strictEqual(nas.available.disks, false);
    for (const session of observed.sessions) {
      assert.strictEqual(session.closes, 1, 'each UDP client session must close after collection');
      assert.ok(!session.oids.some(oid => /^1\.3\.6\.1\.4\.1\.(?:6574|14988)(?:\.|$)/.test(oid)), 'generic collection must not query Synology or MikroTik vendor OIDs');
    }
    assert.deepStrictEqual(fixture.errors, []);
  } finally {
    observed.restore();
    await fixture.close();
    _resetRuntime();
  }

  await withControlledSession({}, async closes => {
    const data = await getGenericNasData({ host: 'minimal', community: COMMUNITY });
    assert.strictEqual(data.online, true, 'reachability and detailed metric availability must remain separate');
    assert.strictEqual(data.system.cpu, null);
    assert.strictEqual(data.system.ram, null);
    assert.strictEqual(data.system.uptimeSeconds, null);
    assert.deepStrictEqual(data.volumes, []);
    assert.strictEqual(data.available.system, false);
    assert.strictEqual(data.available.storage, false);
    assert.ok(data.errors.some(error => /did not expose/.test(error)));
    assert.strictEqual(closes(), 1);
  });
  for (const memoryType of [OID.storageRam, 2]) {
    await withControlledSession({ memoryType }, async closes => {
      const data = await getGenericNasData({ host: 'memory-' + memoryType, community: COMMUNITY });
      assert.ok(data.system.ram, 'physical RAM must be recognized from an OID or numeric enum varbind');
      assert.strictEqual(data.system.ram.totalBytes, 4096000);
      assert.strictEqual(data.system.ram.usedBytes, 1024000);
      assert.strictEqual(data.system.ram.percent, 25);
      assert.deepStrictEqual(data.volumes, [], 'RAM must never be counted as a fixed-disk volume');
      assert.strictEqual(closes(), 1);
    });
  }
  await withControlledSession({ memoryType: 2, used: 950, ucdMemoryUnavailable: true }, async closes => {
    const data = await getGenericNasData({ host: 'hr-memory-high-usage', community: COMMUNITY });
    assert.ok(data.system.ram, 'valid HOST-RESOURCES RAM must remain available when optional UCD memory queries fail');
    assert.strictEqual(data.system.ram.percent, 95, 'a genuine 95% RAM reading must not be discarded by vendor-specific spike mitigation');
    assert.strictEqual(data.system.ram.usedBytes, 3891200);
    assert.strictEqual(data.system.ram.totalBytes, 4096000);
    assert.strictEqual(data.system.ram.stale, undefined);
    assert.strictEqual(closes(), 1);
  });
  await withControlledSession({ unreachable: true }, async closes => {
    await assert.rejects(getGenericNasData({ host: 'offline', community: COMMUNITY }), /fixture unreachable/);
    assert.strictEqual(closes(), 1, 'failed initial reachability must still close the session');
    const platform = await getAllUgreenData({ method: 'snmp', host: 'offline', community: COMMUNITY });
    assert.strictEqual(platform.online, false);
    assert.match(platform.instances[0].error, /fixture unreachable/);
    assert.strictEqual(closes(), 2);
  });
  for (const port of [0, -1, 65536, 1.5, 'bad']) {
    await assert.rejects(getGenericNasData({ host: '127.0.0.1', port, community: COMMUNITY }), /SNMP port/);
  }
  console.log('smoke ok — UGREEN SNMP: loopback UDP v2/v3 SHA-AES, standard MIB metrics, host-only routing, unavailable data and session cleanup');
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
