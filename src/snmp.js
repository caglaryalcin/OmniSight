const snmp = require('net-snmp');

const DISK_STATUS = { 1: 'normal', 2: 'initialized', 3: 'not initialized', 4: 'sys partition failed', 5: 'crashed' };
const VOLUME_STATUS = { 1: 'normal', 2: 'repairing', 3: 'migrating', 4: 'expanding', 5: 'deleting', 6: 'creating', 11: 'degraded', 12: 'crashed' };

function toNum(val) {
  if (val == null) return null;
  if (Buffer.isBuffer(val)) {
    let n = 0n;
    for (const b of val) n = (n << 8n) | BigInt(b);
    return Number(n);
  }
  if (typeof val === 'object' && val !== null && 'high' in val) {
    return val.high * 0x100000000 + val.low;
  }
  return Number(val);
}

const AUTH_MAP = {
  sha:    () => snmp.AuthProtocols.sha,
  sha256: () => snmp.AuthProtocols.sha256,
  sha512: () => snmp.AuthProtocols.sha512,
  md5:    () => snmp.AuthProtocols.md5,
};
const PRIV_MAP = {
  aes:    () => snmp.PrivProtocols.aes,
  aes256b:() => snmp.PrivProtocols.aes256b,
  des:    () => snmp.PrivProtocols.des,
};
const SEC_MAP = {
  authPriv:    () => snmp.SecurityLevel.authPriv,
  authNoPriv:  () => snmp.SecurityLevel.authNoPriv,
  noAuthNoPriv:() => snmp.SecurityLevel.noAuthNoPriv,
};

function createSession(device) {
  const ver = Number(device.snmpVersion);
  if (ver === 3) {
    const secLevel  = (SEC_MAP[device.securityLevel]  || SEC_MAP.authPriv)();
    const authProto = (AUTH_MAP[device.authProtocol] || AUTH_MAP.sha)();
    const privProto = (PRIV_MAP[device.privProtocol] || PRIV_MAP.aes)();
    const user = {
      name: device.username || '',
      level: secLevel,
      authProtocol: authProto,
      authKey: device.authPassword || '',
      privProtocol: privProto,
      privKey: device.privPassword || '',
    };
    return snmp.createV3Session(device.host, user, {
      context: '',
      transport: 'udp4',
      timeout: 8000,
      retries: 1,
    });
  }
  return snmp.createSession(device.host, device.community || 'public', {
    version: snmp.Version2c,
    timeout: 8000,
    retries: 1,
  });
}

function snmpGet(session, oids) {
  return new Promise((resolve, reject) => {
    try {
      session.get(oids, (err, varbinds) => {
        if (err) return reject(err);
        const result = {};
        varbinds.forEach((vb, i) => {
          result[oids[i]] = snmp.isVarbindError(vb) ? null : vb.value;
        });
        resolve(result);
      });
    } catch (e) { reject(e); }
  });
}

function snmpWalk(session, oid) {
  return new Promise((resolve, reject) => {
    try {
      const items = [];
      session.walk(oid, 20,
        (varbinds) => {
          varbinds.forEach(vb => {
            if (!snmp.isVarbindError(vb)) items.push({ oid: vb.oid, value: vb.value });
          });
        },
        (err) => err ? reject(err) : resolve(items)
      );
    } catch (e) { reject(e); }
  });
}

function lastOidSegment(oid) {
  return oid.split('.').pop();
}

function buildMap(items) {
  const map = {};
  items.forEach(({ oid, value }) => { map[lastOidSegment(oid)] = value; });
  return map;
}

async function getHrMemory(session) {
  const rows = await snmpWalk(session, '1.3.6.1.2.1.25.2.3.1');
  const BASE = '1.3.6.1.2.1.25.2.3.1.';
  const PREFIX_LEN = BASE.split('.').length - 1;
  const cols = {};
  rows.forEach(({ oid, value }) => {
    if (!oid.startsWith(BASE)) return;
    const parts = oid.split('.');
    if (parts.length < PREFIX_LEN + 2) return;
    const col = parts[PREFIX_LEN];
    const idx = parts[PREFIX_LEN + 1];
    if (!cols[col]) cols[col] = {};
    cols[col][idx] = value;
  });
  const typeMap = cols['2'] || {};
  const descrMap = cols['3'] || {};
  const unitMap = cols['4'] || {};
  const sizeMap = cols['5'] || {};
  const usedMap = cols['6'] || {};
  let target = null;
  for (const idx of Object.keys(sizeMap)) {
    const type = String(typeMap[idx] || '');
    const descr = Buffer.isBuffer(descrMap[idx]) ? descrMap[idx].toString('utf8') : String(descrMap[idx] || '');
    if (type.endsWith('25.2.1.2') || /physical memory|real memory|^\s*ram\b/i.test(descr)) { target = idx; break; }
  }
  if (target == null) return null;
  const units = toNum(unitMap[target]) || 1;
  const size = toNum(sizeMap[target]);
  const used = toNum(usedMap[target]);
  if (!size) return null;
  return { totalKB: (size * units) / 1024, freeKB: used != null ? ((size - used) * units) / 1024 : null };
}

const cpuPrev = new Map();
// Vendor-neutral CPU via UCD ssCpuRaw counters (delta over poll interval).
// Works on any net-snmp based device (Linux, UniFi, pfSense, …).
async function ucdRawCpu(session, key) {
  try {
    const base = '1.3.6.1.4.1.2021.11';
    const oids = ['50', '51', '52', '53', '54', '55', '56'].map(s => `${base}.${s}.0`);
    const v = await snmpGet(session, oids);
    const nums = oids.map(o => toNum(v[o]));
    if (nums[0] == null || nums[2] == null || nums[3] == null) return null;
    const idle = (nums[3] || 0) + (nums[4] || 0);
    const total = nums.reduce((a, b) => a + (b || 0), 0);
    const prev = cpuPrev.get(key);
    cpuPrev.set(key, { idle, total });
    if (!prev) return null;
    const dTotal = total - prev.total;
    const dIdle = idle - prev.idle;
    if (dTotal <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal))));
  } catch { return null; }
}

async function getSystemInfo(session, deviceKey) {
  const synVals = await snmpGet(session, [
    '1.3.6.1.4.1.6574.1.4.1.0',
    '1.3.6.1.4.1.6574.1.4.2.0',
    '1.3.6.1.4.1.6574.1.1.1.0',
    '1.3.6.1.4.1.6574.1.1.2.0',
    '1.3.6.1.4.1.6574.1.2.0',
  ]);
  let cpuUser   = synVals['1.3.6.1.4.1.6574.1.4.1.0'];
  let cpuSystem = synVals['1.3.6.1.4.1.6574.1.4.2.0'];
  let memTotalKB = synVals['1.3.6.1.4.1.6574.1.1.1.0'];
  let memFreeKB  = synVals['1.3.6.1.4.1.6574.1.1.2.0'];
  const systemTemp = toNum(synVals['1.3.6.1.4.1.6574.1.2.0']);


  if (cpuUser == null) {
    const raw = await ucdRawCpu(session, deviceKey);
    if (raw != null) { cpuUser = raw; cpuSystem = 0; }
  }

  if (cpuUser == null) {
    try {
      const ss = await snmpGet(session, ['1.3.6.1.4.1.2021.11.11.0']);
      const idle = toNum(ss['1.3.6.1.4.1.2021.11.11.0']);
      if (idle != null && !Number.isNaN(idle)) { cpuUser = Math.max(0, Math.min(100, 100 - idle)); cpuSystem = 0; }
    } catch (e) { console.error('[SNMP ssCpuIdle]', e.message); }
  }

  if (cpuUser == null) {
    try {
      const cpuItems = await snmpWalk(session, '1.3.6.1.2.1.25.3.3.1.2');
      if (cpuItems.length && cpuItems.length <= 64) {
        const nums = cpuItems.map(v => Number(toNum(v.value))).filter(n => !Number.isNaN(n));
        if (nums.length) { cpuUser = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length); cpuSystem = 0; }
      }
    } catch (e) { console.error('[SNMP sysInfo hrCPU]', e.message); }
  }

  if (memTotalKB == null) {
    try {
      const ucd = await snmpGet(session, [
        '1.3.6.1.4.1.2021.4.5.0',
        '1.3.6.1.4.1.2021.4.6.0',
        '1.3.6.1.4.1.2021.4.14.0',
        '1.3.6.1.4.1.2021.4.15.0',
      ]);
      const uTotal  = toNum(ucd['1.3.6.1.4.1.2021.4.5.0']);
      const uFree   = toNum(ucd['1.3.6.1.4.1.2021.4.6.0']);
      const uBuf    = toNum(ucd['1.3.6.1.4.1.2021.4.14.0']) || 0;
      const uCached = toNum(ucd['1.3.6.1.4.1.2021.4.15.0']) || 0;
      if (uTotal && uFree != null) {
        memTotalKB = uTotal;
        memFreeKB  = uFree + uBuf + uCached;
      }
    } catch (e) { console.error('[SNMP ucd-mem]', e.message); }
  }

  if (memTotalKB == null) {
    try {
      const hr = await getHrMemory(session);
      if (hr) { memTotalKB = hr.totalKB; memFreeKB = hr.freeKB; }
    } catch (e) { console.error('[SNMP hrStorage mem]', e.message); }
  }

  const memTotal = memTotalKB != null ? memTotalKB * 1024 : null;
  const memFree  = memFreeKB  != null ? memFreeKB  * 1024 : null;
  const memUsed  = memTotal != null && memFree != null ? memTotal - memFree : null;

  return {
    cpu: cpuUser != null ? cpuUser + (cpuSystem || 0) : null,
    systemTemp: systemTemp != null ? systemTemp : null,
    ram: memTotal ? {
      percent: Math.round((memUsed / memTotal) * 100),
      usedGB: (memUsed / 1024 ** 3).toFixed(1),
      totalGB: (memTotal / 1024 ** 3).toFixed(1),
    } : null,
  };
}

async function getDisks(session) {
  const rows = await snmpWalk(session, '1.3.6.1.4.1.6574.2.1.1');
  const BASE = '1.3.6.1.4.1.6574.2.1.1.';
  const PREFIX_LEN = BASE.split('.').length - 1;
  const cols = {};
  rows.forEach(({ oid, value }) => {
    if (!oid.startsWith(BASE)) return;
    const parts = oid.split('.');
    if (parts.length < PREFIX_LEN + 2) return;
    const col = parts[PREFIX_LEN];
    const idx = parts[PREFIX_LEN + 1];
    if (!cols[col]) cols[col] = {};
    cols[col][idx] = value;
  });

  const nameMap = cols['2'] || {};
  const statMap = cols['5'] || {};
  const tempMap = cols['6'] || {};

  return Object.keys(nameMap).map(idx => {
    const rawName = nameMap[idx];
    const name = Buffer.isBuffer(rawName) ? rawName.toString('utf8').replace(/\0/g, '') : String(rawName || `Disk ${idx}`);
    const statusCode = toNum(statMap[idx]) || 1;
    return {
      name,
      status: DISK_STATUS[statusCode] || 'unknown',
      healthy: statusCode === 1,
      temp: toNum(tempMap[idx]),
    };
  });
}

async function getVolumes(session) {
  const rows = await snmpWalk(session, '1.3.6.1.4.1.6574.3.1.1');
  const BASE = '1.3.6.1.4.1.6574.3.1.1.';
  const PREFIX_LEN = BASE.split('.').length - 1;
  const cols = {};
  rows.forEach(({ oid, value }) => {
    if (!oid.startsWith(BASE)) return;
    const parts = oid.split('.');
    if (parts.length < PREFIX_LEN + 2) return;
    const col = parts[PREFIX_LEN];
    const idx = parts[PREFIX_LEN + 1];
    if (!cols[col]) cols[col] = {};
    cols[col][idx] = value;
  });

  const nameMap  = cols['2'] || {};
  const statMap  = cols['3'] || {};
  const freeMap  = cols['4'] || {};
  const totalMap = cols['5'] || {};

  return Object.keys(nameMap).map(idx => {
    const rawName = nameMap[idx];
    const name = Buffer.isBuffer(rawName) ? rawName.toString('utf8').replace(/\0/g, '') : String(rawName || `Volume ${idx}`);
    const statusCode = toNum(statMap[idx]) || 1;
    const totalBytes = toNum(totalMap[idx]);
    const freeBytes  = toNum(freeMap[idx]);
    const usedBytes  = totalBytes != null && freeBytes != null ? totalBytes - freeBytes : null;
    return {
      name,
      status: VOLUME_STATUS[statusCode] || 'unknown',
      healthy: statusCode === 1,
      usedGB:  usedBytes  != null ? (usedBytes  / 1024 ** 3).toFixed(1) : null,
      totalGB: totalBytes != null ? (totalBytes / 1024 ** 3).toFixed(1) : null,
      percent: totalBytes ? Math.round((usedBytes / totalBytes) * 100) : null,
    };
  }).filter(v => v.totalGB !== null && parseFloat(v.totalGB) > 0 && /volume/i.test(v.name));
}

const netPrev = new Map();
const synHistory = new Map();

async function getNetwork(session, deviceKey) {
  const [descrs, rxOctets, txOctets] = await Promise.all([
    snmpWalk(session, '1.3.6.1.2.1.2.2.1.2'),
    snmpWalk(session, '1.3.6.1.2.1.31.1.1.1.6'),
    snmpWalk(session, '1.3.6.1.2.1.31.1.1.1.10'),
  ]);

  const descrMap = buildMap(descrs);
  const rxMap    = buildMap(rxOctets);
  const txMap    = buildMap(txOctets);
  const now = Date.now();

  const interfaces = Object.keys(descrMap)
    .filter(idx => {
      const name = descrMap[idx]?.toString() || '';
      return name && !name.startsWith('lo') && !name.includes('dummy');
    })
    .map(idx => {
      const name = descrMap[idx]?.toString() || `eth${idx}`;
      const rx = rxMap[idx] != null ? Number(rxMap[idx]) : null;
      const tx = txMap[idx] != null ? Number(txMap[idx]) : null;
      const key = `${deviceKey}-${idx}`;
      const prev = netPrev.get(key);
      netPrev.set(key, { time: now, rx, tx });

      let rxMBps = null, txMBps = null;
      if (prev && rx != null && tx != null) {
        const elapsed = (now - prev.time) / 1000;
        if (elapsed > 0) {
          rxMBps = ((rx - prev.rx) / elapsed / 1024 / 1024).toFixed(2);
          txMBps = ((tx - prev.tx) / elapsed / 1024 / 1024).toFixed(2);
        }
      }
      return { name, rxMBps, txMBps };
    });

  return interfaces;
}

async function getDeviceData(device) {
  const session = createSession(device);
  try {
    const sysInfo = await getSystemInfo(session, device.host).catch(e => { console.error(`[SNMP ${device.name}] sysInfo:`, e.message); return {}; });
    const disks   = await getDisks(session).catch(e => { console.error(`[SNMP ${device.name}] disks:`, e.message); return []; });
    const volumes = await getVolumes(session).catch(e => { console.error(`[SNMP ${device.name}] volumes:`, e.message); return []; });
    const network = await getNetwork(session, device.host).catch(e => { console.error(`[SNMP ${device.name}] network:`, e.message); return []; });
    const hist = synHistory.get(device.host) || [];
    if (sysInfo.cpu != null || sysInfo.ram) {
      hist.push({ time: Date.now(), cpu: sysInfo.cpu ?? 0, ram: sysInfo.ram?.percent ?? 0 });
      if (hist.length > 240) hist.shift();
      synHistory.set(device.host, hist);
    }

    return {
      name: device.name,
      host: device.host,
      online: true,
      cpu:     sysInfo.cpu     ?? null,
      systemTemp: sysInfo.systemTemp ?? null,
      ram:     sysInfo.ram     ?? null,
      disks,
      volumes,
      network,
      history: [...hist],
    };
  } catch (err) {
    return { name: device.name, host: device.host, online: false, error: err.message };
  } finally {
    session.close();
  }
}

async function getAllSynologyData(config) {
  const devices = config.devices || [];
  const results = await Promise.allSettled(devices.map(getDeviceData));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: devices[i].name, host: devices[i].host, online: false, error: r.reason?.message }
  );
}

module.exports = { getAllSynologyData };
