const snmp = require('net-snmp');
const { loadHistoryMap, scheduleSaveHistoryMap } = require('./historyStore');
const { allSettledLimit } = require('./concurrency');

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
      timeout: 5000,
      retries: 0,
    });
  }
  if (!device.community) throw new Error('SNMP community is required for SNMP v1/v2c devices');
  return snmp.createSession(device.host, device.community, {
    version: snmp.Version2c,
    timeout: 5000,
    retries: 0,
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

function cleanSnmpText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8').replace(/\0/g, '') : String(value || '');
}

function clampPercent(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampMemoryFree(totalKB, freeKB) {
  if (totalKB == null || freeKB == null) return freeKB;
  return Math.max(0, Math.min(Number(totalKB), Number(freeKB)));
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
const memPrev = new Map();
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
  let memSource = memTotalKB != null ? 'synology' : null;
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

  let ucdMem = null;
  let ucdMemError = null;
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
      ucdMem = { totalKB: uTotal, freeKB: clampMemoryFree(uTotal, uFree + uBuf + uCached) };
    }
  } catch (e) { ucdMemError = e; console.error(`[SNMP ${deviceKey} ucd-mem]`, e.message); }

  if (ucdMem) {
    const synTotal = toNum(memTotalKB);
    const closeEnough = !synTotal || Math.abs(synTotal - ucdMem.totalKB) / Math.max(synTotal, ucdMem.totalKB) < 0.25;
    if (closeEnough) {
      memTotalKB = ucdMem.totalKB;
      memFreeKB = ucdMem.freeKB;
      memSource = 'ucd';
    }
  }

  if (memTotalKB == null) {
    try {
      const hr = await getHrMemory(session);
      if (hr) { memTotalKB = hr.totalKB; memFreeKB = hr.freeKB; memSource = 'hrStorage'; }
    } catch (e) { console.error('[SNMP hrStorage mem]', e.message); }
  }

  const memTotal = memTotalKB != null ? memTotalKB * 1024 : null;
  const memFree  = memFreeKB  != null ? memFreeKB  * 1024 : null;
  const memUsed  = memTotal != null && memFree != null ? Math.max(0, Math.min(memTotal, memTotal - memFree)) : null;
  let ram = memTotal ? {
    percent: clampPercent((memUsed / memTotal) * 100),
    usedBytes: memUsed,
    totalBytes: memTotal,
    usedGB: (memUsed / 1024 ** 3).toFixed(1),
    totalGB: (memTotal / 1024 ** 3).toFixed(1),
    source: memSource,
  } : null;

  const prevMem = memPrev.get(deviceKey);
  if (ram && memSource !== 'ucd' && ucdMemError && prevMem?.ram) {
    const jump = Math.abs((ram.percent ?? 0) - (prevMem.ram.percent ?? 0));
    const suspiciousFull = ram.percent >= 95 && prevMem.ram.percent <= 90;
    if (suspiciousFull || jump >= 35) {
      ram = { ...prevMem.ram, stale: true };
    }
  } else if (ram && memSource !== 'ucd' && ucdMemError && !prevMem && ram.percent >= 95) {
    ram = null;
  } else if (!ram && ucdMemError && prevMem?.ram && Date.now() - prevMem.time < 10 * 60 * 1000) {
    ram = { ...prevMem.ram, stale: true };
  }
  if (ram && !ram.stale && (memSource === 'ucd' || ram.percent < 95 || !ucdMemError)) {
    memPrev.set(deviceKey, { ram, time: Date.now() });
  }

  return {
    cpu: cpuUser != null ? cpuUser + (cpuSystem || 0) : null,
    systemTemp: systemTemp != null ? systemTemp : null,
    systemTempLabel: systemTemp != null ? 'CPU temperature' : null,
    ram,
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
const diskIoPrev = new Map();
const SNMP_HISTORY_MAX = 5760;
const synHistory = loadHistoryMap('snmp-history', SNMP_HISTORY_MAX);

function rateFromCounters(cache, key, read, write) {
  const now = Date.now();
  const r = read != null ? Number(read) : null;
  const w = write != null ? Number(write) : null;
  if (!Number.isFinite(r) || !Number.isFinite(w)) return null;
  const prev = cache.get(key);
  cache.set(key, { time: now, read: r, write: w });
  if (!prev || !Number.isFinite(prev.read) || !Number.isFinite(prev.write)) return null;
  const elapsed = (now - prev.time) / 1000;
  if (elapsed <= 0) return null;
  const dRead = r - prev.read;
  const dWrite = w - prev.write;
  if (dRead < 0 || dWrite < 0) return null;
  return {
    readBps: dRead / elapsed,
    writeBps: dWrite / elapsed,
  };
}

function parseTableRows(rows, base) {
  const prefix = base + '.';
  const prefixLen = base.split('.').length;
  const cols = {};
  rows.forEach(({ oid, value }) => {
    if (!oid.startsWith(prefix)) return;
    const parts = oid.split('.');
    if (parts.length < prefixLen + 2) return;
    const col = parts[prefixLen];
    const idx = parts[prefixLen + 1];
    if (!cols[col]) cols[col] = {};
    cols[col][idx] = value;
  });
  return cols;
}

function firstCounter(cols, idx, keys) {
  for (const key of keys) {
    const n = toNum(cols[key]?.[idx]);
    if (n != null && Number.isFinite(n)) return n;
  }
  return null;
}

async function getDiskIoFromTable(session, deviceKey, base, source, readKeys, writeKeys) {
  const rows = await snmpWalk(session, base);
  const cols = parseTableRows(rows, base);
  const names = cols['2'] || {};
  const devices = [];
  let readBps = 0;
  let writeBps = 0;
  let any = false;
  for (const idx of Object.keys(names)) {
    const rawName = names[idx];
    const name = Buffer.isBuffer(rawName) ? rawName.toString('utf8').replace(/\0/g, '') : String(rawName || `disk${idx}`);
    if (!name || /^(loop|ram|zram|dm-|md)$/i.test(name)) continue;
    const read = firstCounter(cols, idx, readKeys);
    const write = firstCounter(cols, idx, writeKeys);
    const rate = rateFromCounters(diskIoPrev, `${source}:${deviceKey}:${idx}`, read, write);
    if (!rate) continue;
    any = true;
    readBps += rate.readBps;
    writeBps += rate.writeBps;
    devices.push({ name, readBps: rate.readBps, writeBps: rate.writeBps });
  }
  return any ? { readBps, writeBps, devices, source } : null;
}

async function getDiskIO(session, deviceKey, preferSynology = false) {
  const sources = preferSynology
    ? [
        ['1.3.6.1.4.1.6574.101.1.1', 'synology-storageio', ['8', '12', '3'], ['9', '13', '4']],
        ['1.3.6.1.4.1.2021.13.15.1.1', 'ucd-diskio', ['12', '3'], ['13', '4']],
      ]
    : [
        ['1.3.6.1.4.1.2021.13.15.1.1', 'ucd-diskio', ['12', '3'], ['13', '4']],
        ['1.3.6.1.4.1.6574.101.1.1', 'synology-storageio', ['8', '12', '3'], ['9', '13', '4']],
      ];
  for (const [base, source, readKeys, writeKeys] of sources) {
    try {
      const data = await getDiskIoFromTable(session, deviceKey, base, source, readKeys, writeKeys);
      if (data) return data;
    } catch {
      // Some devices simply do not expose this table.
    }
  }
  return null;
}

function sumNetworkBandwidth(network) {
  if (!Array.isArray(network)) return null;
  let rxBps = 0;
  let txBps = 0;
  let any = false;
  for (const item of network) {
    const rx = Number(item.rxMBps);
    const tx = Number(item.txMBps);
    if (Number.isFinite(rx) && rx >= 0) { rxBps += rx * 1024 * 1024; any = true; }
    if (Number.isFinite(tx) && tx >= 0) { txBps += tx * 1024 * 1024; any = true; }
  }
  return any ? { rxBps, txBps } : null;
}

async function getNetwork(session, deviceKey) {
  const [
    names,
    descrs,
    rxHcOctets,
    txHcOctets,
    rxOctets,
    txOctets,
    operStatus,
  ] = await Promise.all([
    snmpWalk(session, '1.3.6.1.2.1.31.1.1.1.1').catch(() => []),
    snmpWalk(session, '1.3.6.1.2.1.2.2.1.2').catch(() => []),
    snmpWalk(session, '1.3.6.1.2.1.31.1.1.1.6').catch(() => []),
    snmpWalk(session, '1.3.6.1.2.1.31.1.1.1.10').catch(() => []),
    snmpWalk(session, '1.3.6.1.2.1.2.2.1.10').catch(() => []),
    snmpWalk(session, '1.3.6.1.2.1.2.2.1.16').catch(() => []),
    snmpWalk(session, '1.3.6.1.2.1.2.2.1.8').catch(() => []),
  ]);

  const nameMap  = buildMap(names);
  const descrMap = buildMap(descrs);
  const rxMap    = { ...buildMap(rxOctets), ...buildMap(rxHcOctets) };
  const txMap    = { ...buildMap(txOctets), ...buildMap(txHcOctets) };
  const upMap    = buildMap(operStatus);
  const indexes = [...new Set([...Object.keys(nameMap), ...Object.keys(descrMap), ...Object.keys(rxMap), ...Object.keys(txMap)])];

  const interfaces = indexes
    .map(idx => {
      const ifName = cleanSnmpText(nameMap[idx]);
      const descr = cleanSnmpText(descrMap[idx]);
      const name = ifName || descr || `if${idx}`;
      const rx = toNum(rxMap[idx]);
      const tx = toNum(txMap[idx]);
      const oper = toNum(upMap[idx]);
      const rate = rateFromCounters(netPrev, `${deviceKey}:${idx}`, rx, tx);
      const rxMBps = rate ? (rate.readBps / 1024 / 1024).toFixed(2) : null;
      const txMBps = rate ? (rate.writeBps / 1024 / 1024).toFixed(2) : null;
      return { name, ifName, descr, operStatus: oper, rxMBps, txMBps };
    })
    .filter(iface => {
      const name = iface.ifName || iface.name || '';
      if (!name || /^(lo|dummy|sit|tunl|ip6tnl|veth)/i.test(name)) return false;
      if (/docker|br-|virbr|vnet|tailscale|wg|zt/i.test(name)) return false;
      if (iface.operStatus != null && iface.operStatus !== 1) return false;
      const wanted = /^(eth|ovs_|bond)/i.test(name);
      if (wanted) return true;
      return iface.rxMBps != null || iface.txMBps != null;
    })
    .map(({ name, rxMBps, txMBps }) => ({ name, rxMBps, txMBps }));

  return interfaces;
}

async function getDeviceData(device) {
  const session = createSession(device);
  try {
    const sysInfo = await getSystemInfo(session, device.host).catch(e => {
      console.error(`[SNMP ${device.name}] sysInfo:`, e.message);
      return {};
    });
    const [disks, volumes, network] = await Promise.all([
      getDisks(session).catch(e => { console.error(`[SNMP ${device.name}] disks:`, e.message); return []; }),
      getVolumes(session).catch(e => { console.error(`[SNMP ${device.name}] volumes:`, e.message); return []; }),
      getNetwork(session, device.host).catch(e => { console.error(`[SNMP ${device.name}] network:`, e.message); return []; }),
    ]);
    const diskIO = await getDiskIO(session, device.host, !!(disks.length || volumes.length))
      .catch(e => { console.error(`[SNMP ${device.name}] disk I/O:`, e.message); return null; });
    const bandwidth = sumNetworkBandwidth(network);
    const hist = synHistory.get(device.host) || [];
    if (sysInfo.cpu != null || sysInfo.ram || sysInfo.systemTemp != null || diskIO || bandwidth) {
      hist.push({
        time: Date.now(),
        cpu: sysInfo.cpu ?? null,
        ram: sysInfo.ram?.percent ?? null,
        temp: sysInfo.systemTemp ?? null,
        diskIO: diskIO ? (Number(diskIO.readBps) || 0) + (Number(diskIO.writeBps) || 0) : null,
        bandwidth: bandwidth ? (Number(bandwidth.rxBps) || 0) + (Number(bandwidth.txBps) || 0) : null,
      });
      if (hist.length > SNMP_HISTORY_MAX) hist.splice(0, hist.length - SNMP_HISTORY_MAX);
      synHistory.set(device.host, hist);
      scheduleSaveHistoryMap('snmp-history', synHistory, SNMP_HISTORY_MAX);
    }

    return {
      name: device.name,
      host: device.host,
      profile: device.profile || device.preset || 'generic',
      snmpVersion: device.snmpVersion,
      online: true,
      cpu:     sysInfo.cpu     ?? null,
      systemTemp: sysInfo.systemTemp ?? null,
      systemTempLabel: sysInfo.systemTempLabel ?? null,
      ram:     sysInfo.ram     ?? null,
      disks,
      volumes,
      network,
      metrics: { diskIO, bandwidth },
      history: [...hist],
    };
  } catch (err) {
    return {
      name: device.name,
      host: device.host,
      profile: device.profile || device.preset || 'generic',
      snmpVersion: device.snmpVersion,
      online: false,
      error: err.message
    };
  } finally {
    session.close();
  }
}

async function getAllSynologyData(config) {
  const devices = config.devices || [];
  const results = await allSettledLimit(devices, Number(config.concurrency || config.collectorConcurrency || 3), getDeviceData);
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: devices[i].name, host: devices[i].host, online: false, error: r.reason?.message }
  );
}

module.exports = { getAllSynologyData };
