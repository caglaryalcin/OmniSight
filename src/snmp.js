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

function isNum(val) {
  return val !== null && val !== undefined && Number.isFinite(Number(val));
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

function snmpNumber(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8').replace(/\0/g, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  }
  const n = toNum(value);
  return Number.isFinite(n) ? n : null;
}

function diskTempNum(value) {
  const n = snmpNumber(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 200) return null;
  return Math.round(n);
}

function normalizeTemperature(value) {
  let n = snmpNumber(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > 1000) n /= 1000;
  else if (Math.abs(n) > 200) n /= 10;
  if (n <= -50 || n >= 200) return null;
  return Math.round(n);
}

function entitySensorScale(scale) {
  const factors = {
    1: 1e-24, 2: 1e-21, 3: 1e-18, 4: 1e-15, 5: 1e-12, 6: 1e-9,
    7: 1e-6, 8: 1e-3, 9: 1, 10: 1e3, 11: 1e6, 12: 1e9,
    13: 1e12, 14: 1e15, 15: 1e18, 16: 1e21, 17: 1e24,
  };
  return factors[Number(scale)] || 1;
}

function normalizeEntityTemperature(value, scale, precision) {
  const raw = snmpNumber(value);
  if (!Number.isFinite(raw)) return null;
  let n = raw * entitySensorScale(snmpNumber(scale));
  const p = snmpNumber(precision);
  if (Number.isFinite(p) && p > 0 && Math.abs(n) > 200) n /= 10 ** p;
  return normalizeTemperature(n);
}

function tempCandidateScore(label) {
  const s = String(label || '').toLowerCase();
  if (/\bcpu\b|processor/.test(s)) return 100;
  if (/system|board|main|chassis|ambient/.test(s)) return 90;
  if (/temp|thermal|sensor/.test(s)) return 70;
  return 40;
}

function chooseTemperature(candidates) {
  const valid = (candidates || [])
    .filter(c => c && Number.isFinite(Number(c.value)))
    .sort((a, b) => tempCandidateScore(b.label) - tempCandidateScore(a.label) || Number(b.value) - Number(a.value));
  return valid[0] || null;
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

async function getEntitySensorTemperatures(session) {
  const sensorBase = '1.3.6.1.2.1.99.1.1.1';
  const sensorRows = await snmpWalk(session, sensorBase);
  const sensorCols = parseTableRows(sensorRows, sensorBase);
  const typeMap = sensorCols['1'] || {};
  const scaleMap = sensorCols['2'] || {};
  const precisionMap = sensorCols['3'] || {};
  const valueMap = sensorCols['4'] || {};
  const statusMap = sensorCols['5'] || {};
  const unitMap = sensorCols['6'] || {};
  if (!Object.keys(valueMap).length) return [];

  let physicalCols = {};
  try {
    physicalCols = parseTableRows(await snmpWalk(session, '1.3.6.1.2.1.47.1.1.1.1'), '1.3.6.1.2.1.47.1.1.1.1');
  } catch {
    physicalCols = {};
  }
  const descrMap = physicalCols['2'] || {};
  const nameMap = physicalCols['7'] || {};

  const indexes = [...new Set([
    ...Object.keys(typeMap),
    ...Object.keys(valueMap),
    ...Object.keys(statusMap),
  ])];
  return indexes.map(idx => {
    const type = snmpNumber(typeMap[idx]);
    const status = snmpNumber(statusMap[idx]);
    const units = cleanSnmpText(unitMap[idx]).trim();
    const isCelsius = type === 8 || /celsius|centigrade|deg\s*c|°c/i.test(units);
    if (!isCelsius || (status != null && status !== 1)) return null;
    const value = normalizeEntityTemperature(valueMap[idx], scaleMap[idx], precisionMap[idx]);
    if (value == null) return null;
    const label = cleanSnmpText(nameMap[idx]).trim() || cleanSnmpText(descrMap[idx]).trim() || `Sensor ${idx}`;
    return { value, label: /temp|thermal|celsius/i.test(label) ? label : `${label} temperature` };
  }).filter(Boolean);
}

async function getUcdSensorTemperatures(session) {
  const base = '1.3.6.1.4.1.2021.13.16.2.1';
  const rows = await snmpWalk(session, base);
  const cols = parseTableRows(rows, base);
  const nameMap = cols['2'] || {};
  const valueMap = cols['3'] || {};
  const indexes = [...new Set([...Object.keys(nameMap), ...Object.keys(valueMap)])];
  return indexes.map(idx => {
    const value = normalizeTemperature(valueMap[idx]);
    if (value == null) return null;
    const label = cleanSnmpText(nameMap[idx]).trim() || `Sensor ${idx}`;
    return { value, label: /temp|thermal/i.test(label) ? label : `${label} temperature` };
  }).filter(Boolean);
}

async function getScalarTemperatures(session) {
  const scalarOids = [
    ['1.3.6.1.4.1.6574.1.2.0', 'CPU temperature'],
    ['1.3.6.1.4.1.14988.1.1.3.10.0', 'System temperature'],
    ['1.3.6.1.4.1.14988.1.1.3.11.0', 'CPU temperature'],
  ];
  const values = await snmpGet(session, scalarOids.map(([oid]) => oid));
  return scalarOids.map(([oid, label]) => {
    const value = normalizeTemperature(values[oid]);
    return value == null ? null : { value, label };
  }).filter(Boolean);
}

async function getSensorTemperature(session) {
  const candidates = [];
  for (const reader of [getEntitySensorTemperatures, getUcdSensorTemperatures, getScalarTemperatures]) {
    try {
      candidates.push(...await reader(session));
    } catch {
      // Many devices expose only one of these tables.
    }
  }
  return chooseTemperature(candidates);
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
  let tempInfo = chooseTemperature([{ value: normalizeTemperature(synVals['1.3.6.1.4.1.6574.1.2.0']), label: 'CPU temperature' }]);
  if (!tempInfo) {
    try {
      tempInfo = await getSensorTemperature(session);
    } catch (e) { console.error(`[SNMP ${deviceKey} sensors]`, e.message); }
  }


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
    systemTemp: tempInfo?.value ?? null,
    systemTempLabel: tempInfo?.label ?? null,
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
  const modelMap = cols['3'] || {};
  const statMap = cols['5'] || {};
  const tempMap = cols['6'] || {};
  const indexes = [...new Set([
    ...Object.keys(nameMap),
    ...Object.keys(modelMap),
    ...Object.keys(statMap),
    ...Object.keys(tempMap),
  ])].sort((a, b) => Number(a) - Number(b));

  return indexes.map(idx => {
    const rawName = nameMap[idx];
    const rawModel = modelMap[idx];
    const name = cleanSnmpText(rawName).trim() || cleanSnmpText(rawModel).trim() || `Disk ${idx}`;
    const statusCode = snmpNumber(statMap[idx]) || 1;
    return {
      name,
      status: DISK_STATUS[statusCode] || 'unknown',
      healthy: statusCode === 1,
      temp: diskTempNum(tempMap[idx]),
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

async function probeReachable(session) {
  const oid = '1.3.6.1.2.1.1.1.0';
  const values = await snmpGet(session, [oid]);
  const descr = values[oid];
  if (descr == null) throw new Error('SNMP sysDescr is unavailable');
  return cleanSnmpText(descr);
}

const netPrev = new Map();
const diskIoPrev = new Map();
const bandwidthPeak = new Map();
const SNMP_HISTORY_MAX = 5760;
const RATE_CAPACITY_HEADROOM = 1.08;
const BANDWIDTH_PEAK_MAX_AGE_MS = 20000;
const synHistory = loadHistoryMap('snmp-history', SNMP_HISTORY_MAX);

function rateFromCounters(cache, key, read, write, maxCounter = null, maxRateBps = null) {
  const now = Date.now();
  const r = read != null ? Number(read) : null;
  const w = write != null ? Number(write) : null;
  const hasRead = Number.isFinite(r);
  const hasWrite = Number.isFinite(w);
  if (!hasRead && !hasWrite) return null;
  const prev = cache.get(key);
  cache.set(key, {
    time: now,
    read: hasRead ? r : (Number.isFinite(prev?.read) ? prev.read : null),
    write: hasWrite ? w : (Number.isFinite(prev?.write) ? prev.write : null),
  });
  if (!prev) return null;
  if ((hasRead && !Number.isFinite(prev.read)) || (hasWrite && !Number.isFinite(prev.write))) return null;
  const elapsed = (now - prev.time) / 1000;
  if (elapsed <= 0) return null;
  let dRead = hasRead ? r - prev.read : 0;
  let dWrite = hasWrite ? w - prev.write : 0;
  if (Number.isFinite(maxCounter) && maxCounter > 0) {
    if (hasRead && dRead < 0) dRead = (maxCounter - prev.read) + r;
    if (hasWrite && dWrite < 0) dWrite = (maxCounter - prev.write) + w;
  }
  if (dRead < 0 || dWrite < 0) return null;
  const out = {
    readBps: dRead / elapsed,
    writeBps: dWrite / elapsed,
  };
  const total = (Number(out.readBps) || 0) + (Number(out.writeBps) || 0);
  if (Number.isFinite(maxRateBps) && maxRateBps > 0 && total > maxRateBps * RATE_CAPACITY_HEADROOM) return null;
  return out;
}

function counterPair(rxMap, txMap, idx, source, max = null) {
  const rx = toNum(rxMap[idx]);
  const tx = toNum(txMap[idx]);
  const hasCounters = Number.isFinite(rx) || Number.isFinite(tx);
  return { rx: Number.isFinite(rx) ? rx : null, tx: Number.isFinite(tx) ? tx : null, source, max, hasCounters };
}

function rateSum(rate) {
  if (!rate) return null;
  return (Number(rate.readBps) || 0) + (Number(rate.writeBps) || 0);
}

function pickCounterRate(cache, deviceKey, idx, rxHcMap, txHcMap, rx32Map, tx32Map, maxRateBps = null) {
  const hc = counterPair(rxHcMap, txHcMap, idx, 'hc');
  const c32 = counterPair(rx32Map, tx32Map, idx, '32', 0x100000000);
  const hcRate = hc.hasCounters ? rateFromCounters(cache, `${deviceKey}:${idx}:hc`, hc.rx, hc.tx, hc.max, maxRateBps) : null;
  const c32Rate = c32.hasCounters ? rateFromCounters(cache, `${deviceKey}:${idx}:32`, c32.rx, c32.tx, c32.max, maxRateBps) : null;
  const hcSum = rateSum(hcRate);
  const c32Sum = rateSum(c32Rate);

  if (hcRate && c32Rate) {
    if ((hcSum || 0) > 0 || (c32Sum || 0) === 0) return { rate: hcRate, source: 'hc', hasCounters: true };
    return { rate: c32Rate, source: '32', hasCounters: true };
  }
  if (hcRate) return { rate: hcRate, source: 'hc', hasCounters: true };
  if (c32Rate) return { rate: c32Rate, source: '32', hasCounters: true };
  if (hc.hasCounters) return { rate: null, source: 'hc', hasCounters: true };
  if (c32.hasCounters) return { rate: null, source: '32', hasCounters: true };
  return { rate: null, source: 'none', hasCounters: false };
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
        ['1.3.6.1.4.1.6574.101.1.1', 'synology-storageio', ['12', '3'], ['13', '4']],
        ['1.3.6.1.4.1.6574.102.1.1', 'synology-spaceio', ['12', '3'], ['13', '4']],
        ['1.3.6.1.4.1.2021.13.15.1.1', 'ucd-diskio', ['12', '3'], ['13', '4']],
      ]
    : [
        ['1.3.6.1.4.1.2021.13.15.1.1', 'ucd-diskio', ['12', '3'], ['13', '4']],
        ['1.3.6.1.4.1.6574.101.1.1', 'synology-storageio', ['12', '3'], ['13', '4']],
        ['1.3.6.1.4.1.6574.102.1.1', 'synology-spaceio', ['12', '3'], ['13', '4']],
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
  let capacityBps = 0;
  let activeCapacityBps = 0;
  let largestCapacityBps = 0;
  let activeInterfaces = 0;
  let hasCapacity = false;
  let any = false;
  for (const item of network) {
    const rx = isNum(item.rxBps) ? Number(item.rxBps) : (isNum(item.rxMBps) ? Number(item.rxMBps) * 1024 * 1024 : NaN);
    const tx = isNum(item.txBps) ? Number(item.txBps) : (isNum(item.txMBps) ? Number(item.txMBps) * 1024 * 1024 : NaN);
    if (Number.isFinite(rx) && rx >= 0) { rxBps += rx; any = true; }
    if (Number.isFinite(tx) && tx >= 0) { txBps += tx; any = true; }
    if (isNum(item.maxRateBps) && Number(item.maxRateBps) > 0) {
      const cap = Number(item.maxRateBps);
      const traffic = (Number.isFinite(rx) && rx > 0 ? rx : 0) + (Number.isFinite(tx) && tx > 0 ? tx : 0);
      capacityBps += cap;
      largestCapacityBps = Math.max(largestCapacityBps, cap);
      if (traffic > 0) {
        activeCapacityBps += cap;
        activeInterfaces += 1;
      }
      hasCapacity = true;
    }
  }
  return any ? {
    rxBps,
    txBps,
    ...(hasCapacity ? {
      capacityBps,
      activeCapacityBps: activeCapacityBps || null,
      largestCapacityBps: largestCapacityBps || null,
      activeInterfaces,
      historyCapacityBps: activeCapacityBps || largestCapacityBps || capacityBps,
    } : {})
  } : null;
}

function bandwidthTotalBps(bandwidth) {
  if (!bandwidth) return null;
  const total = (Number(bandwidth.rxBps) || 0) + (Number(bandwidth.txBps) || 0);
  return Number.isFinite(total) ? total : null;
}

function recordBandwidthPeak(deviceKey, bandwidth) {
  const total = bandwidthTotalBps(bandwidth);
  if (!Number.isFinite(total) || total < 0) return;
  const now = Date.now();
  const prev = bandwidthPeak.get(deviceKey);
  if (!prev || now - Number(prev.time || 0) > BANDWIDTH_PEAK_MAX_AGE_MS || total >= Number(prev.total || 0)) {
    bandwidthPeak.set(deviceKey, {
      time: now,
      total,
      bandwidth: { ...bandwidth, peakBps: total, peakSampledAt: now },
    });
  }
}

function consumeBandwidthPeak(deviceKey, bandwidth) {
  const now = Date.now();
  const currentTotal = bandwidthTotalBps(bandwidth);
  const peak = bandwidthPeak.get(deviceKey);
  bandwidthPeak.delete(deviceKey);
  if (!peak || now - Number(peak.time || 0) > BANDWIDTH_PEAK_MAX_AGE_MS) return bandwidth;
  if (!Number.isFinite(Number(peak.total))) return bandwidth;
  if (!Number.isFinite(Number(currentTotal)) || Number(peak.total) > Number(currentTotal)) return peak.bandwidth;
  return bandwidth;
}

function interfaceMaxRateBps(ifSpeed, ifHighSpeed) {
  const highMbps = toNum(ifHighSpeed);
  if (Number.isFinite(highMbps) && highMbps > 0) return (highMbps * 1000 * 1000) / 8;
  const speedBits = toNum(ifSpeed);
  if (Number.isFinite(speedBits) && speedBits > 0) return speedBits / 8;
  return null;
}

function sanitizeSnmpHistory(history, bandwidthCapacityBps) {
  const rows = Array.isArray(history) ? history : [];
  const limit = Number.isFinite(Number(bandwidthCapacityBps)) && Number(bandwidthCapacityBps) > 0
    ? Number(bandwidthCapacityBps) * RATE_CAPACITY_HEADROOM
    : null;
  if (!limit) return { history: rows, changed: false };
  let changed = false;
  const cleaned = rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    const bandwidth = Number(row.bandwidth);
    if (Number.isFinite(bandwidth) && (bandwidth < 0 || bandwidth > limit)) {
      changed = true;
      return { ...row, bandwidth: null };
    }
    return row;
  });
  return { history: cleaned, changed };
}

function shouldUseInterface(iface) {
  const name = iface.ifName || iface.name || '';
  const descr = iface.descr || '';
  const combined = `${name} ${descr}`;
  if (!name && !descr) return false;
  if (/^(lo|dummy|sit|tunl|ip6tnl|veth)/i.test(name)) return false;
  if (/\b(docker|virbr|vnet|tailscale|wireguard|wg|zt|zerotier)\b/i.test(combined)) return false;
  if (iface.operStatus != null && iface.operStatus !== 1 && !iface.hasCounters) return false;
  if (iface.hasCounters || iface.rxBps != null || iface.txBps != null) return true;
  return /^(eth|ether|en|lan|wan|ovs_|bond|br|bridge|wlan|wl|wifi|sfp|qsfp|xg|ix|ge|te|port|lte|ppp|vlan)/i.test(name);
}

async function timedWalk(session, oid) {
  const started = Date.now();
  try {
    const rows = await snmpWalk(session, oid);
    return { rows, ms: Date.now() - started, error: null };
  } catch (e) {
    return { rows: [], ms: Date.now() - started, error: e.message };
  }
}

async function getNetwork(session, deviceKey) {
  const ifTable = await timedWalk(session, '1.3.6.1.2.1.2.2.1');
  const ifXTable = await timedWalk(session, '1.3.6.1.2.1.31.1.1.1');

  const ifCols = parseTableRows(ifTable.rows, '1.3.6.1.2.1.2.2.1');
  const ifXCols = parseTableRows(ifXTable.rows, '1.3.6.1.2.1.31.1.1.1');

  const nameMap  = ifXCols['1'] || {};
  const descrMap = ifCols['2'] || {};
  const rxHcMap  = ifXCols['6'] || {};
  const txHcMap  = ifXCols['10'] || {};
  const rx32Map  = ifCols['10'] || {};
  const tx32Map  = ifCols['16'] || {};
  const upMap    = ifCols['8'] || {};
  const speedMap = ifCols['5'] || {};
  const highSpeedMap = ifXCols['15'] || {};
  const indexes = [...new Set([
    ...Object.keys(nameMap),
    ...Object.keys(descrMap),
    ...Object.keys(rxHcMap),
    ...Object.keys(txHcMap),
    ...Object.keys(rx32Map),
    ...Object.keys(tx32Map),
  ])];

  const interfaces = indexes
    .map(idx => {
      const ifName = cleanSnmpText(nameMap[idx]);
      const descr = cleanSnmpText(descrMap[idx]);
      const name = ifName || descr || `if${idx}`;
      const maxRateBps = interfaceMaxRateBps(speedMap[idx], highSpeedMap[idx]);
      const counter = pickCounterRate(netPrev, deviceKey, idx, rxHcMap, txHcMap, rx32Map, tx32Map, maxRateBps);
      const oper = toNum(upMap[idx]);
      const hasCounters = !!counter.hasCounters;
      const rate = counter.rate;
      const rxBps = rate ? rate.readBps : null;
      const txBps = rate ? rate.writeBps : null;
      const rxMBps = rxBps != null ? (rxBps / 1024 / 1024).toFixed(2) : null;
      const txMBps = txBps != null ? (txBps / 1024 / 1024).toFixed(2) : null;
      return { name, ifName, descr, operStatus: oper, hasCounters, counterSource: counter.source, maxRateBps, rxBps, txBps, rxMBps, txMBps };
    })
    .filter(shouldUseInterface)
    .map(({ name, ifName, descr, operStatus, hasCounters, counterSource, maxRateBps, rxBps, txBps, rxMBps, txMBps }) => ({
      name,
      ifName,
      descr,
      operStatus,
      hasCounters,
      counterSource,
      maxRateBps,
      rxBps,
      txBps,
      rxMBps,
      txMBps,
    }));

  Object.defineProperty(interfaces, '_diagnostics', {
    enumerable: false,
    value: {
      ifTable: { count: ifTable.rows.length, ms: ifTable.ms, error: ifTable.error },
      ifXTable: { count: ifXTable.rows.length, ms: ifXTable.ms, error: ifXTable.error },
      selected: interfaces.length,
    },
  });

  return interfaces;
}

async function getDeviceData(device) {
  const session = createSession(device);
  const profile = device.profile || device.preset || 'generic';
  try {
    const sysDescr = await probeReachable(session);
    const isSynology = /synology/i.test(profile) || /synology/i.test(sysDescr);
    const sysInfo = await getSystemInfo(session, device.host).catch(e => {
      console.error(`[SNMP ${device.name}] sysInfo:`, e.message);
      return {};
    });
    const disks = isSynology
      ? await getDisks(session).catch(e => { console.error(`[SNMP ${device.name}] disks:`, e.message); return []; })
      : [];
    const volumes = isSynology
      ? await getVolumes(session).catch(e => { console.error(`[SNMP ${device.name}] volumes:`, e.message); return []; })
      : [];
    const network = await getNetwork(session, device.host).catch(e => { console.error(`[SNMP ${device.name}] network:`, e.message); return []; });
    const networkDiagnostics = network?._diagnostics || null;
    const diskIO = await getDiskIO(session, device.host, isSynology || !!(disks.length || volumes.length))
      .catch(e => { console.error(`[SNMP ${device.name}] disk I/O:`, e.message); return null; });
    const bandwidth = consumeBandwidthPeak(device.host, sumNetworkBandwidth(network));
    const rawHist = synHistory.get(device.host) || [];
    const sanitized = sanitizeSnmpHistory(rawHist, bandwidth?.historyCapacityBps || bandwidth?.activeCapacityBps || bandwidth?.largestCapacityBps || bandwidth?.capacityBps);
    const hist = sanitized.history;
    let shouldSaveHistory = sanitized.changed;
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
      shouldSaveHistory = true;
    }
    if (shouldSaveHistory) {
      synHistory.set(device.host, hist);
      scheduleSaveHistoryMap('snmp-history', synHistory, SNMP_HISTORY_MAX);
    }

    return {
      name: device.name,
      host: device.host,
      profile,
      snmpVersion: device.snmpVersion,
      online: true,
      sysDescr,
      cpu:     sysInfo.cpu     ?? null,
      systemTemp: sysInfo.systemTemp ?? null,
      systemTempLabel: sysInfo.systemTempLabel ?? null,
      ram:     sysInfo.ram     ?? null,
      disks,
      volumes,
      network,
      networkDiagnostics,
      metrics: { diskIO, bandwidth },
      history: [...hist],
    };
  } catch (err) {
    return {
      name: device.name,
      host: device.host,
      profile,
      snmpVersion: device.snmpVersion,
      online: false,
      error: err.message
    };
  } finally {
    session.close();
  }
}

async function sampleDeviceBandwidth(device) {
  const session = createSession(device);
  try {
    const network = await getNetwork(session, device.host);
    const networkDiagnostics = network?._diagnostics || null;
    const bandwidth = sumNetworkBandwidth(network);
    if (bandwidth) recordBandwidthPeak(device.host, bandwidth);
    return {
      name: device.name,
      host: device.host,
      online: !!bandwidth,
      network,
      networkDiagnostics,
      metrics: { bandwidth },
    };
  } catch (err) {
    return {
      name: device.name,
      host: device.host,
      online: false,
      error: err.message,
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

async function sampleSnmpBandwidth(config) {
  const devices = config?.devices || [];
  if (!devices.length) return [];
  const limit = Math.max(1, Math.min(4, Number(config.bandwidthConcurrency || config.concurrency || config.collectorConcurrency || 2) || 2));
  const results = await allSettledLimit(devices, limit, sampleDeviceBandwidth);
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: devices[i].name, host: devices[i].host, online: false, error: r.reason?.message }
  );
}

module.exports = { getAllSynologyData, sampleSnmpBandwidth };
