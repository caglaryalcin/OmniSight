const http = require('http');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');
const { mapLimit } = require('./concurrency');
const { getGenericNasData } = require('./snmp');

// UGOS protocol and hardware-reply references are listed in DOCUMENTATION.md.
const sessions = new Map();
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const IDLE_SESSION_MS = 120000;
const EMPTY_AVAILABLE = Object.freeze({ system: false, storage: false, disks: false, services: false });

function parseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  if (url.username || url.password) throw new Error('Enter credentials in the username/password fields, not in the URL');
  return url;
}
function cleanBaseUrl(value) {
  const url = parseUrl(value);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/ugreen(?:\/v[12])?$/, '');
  return url.toString().replace(/\/+$/, '');
}
function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || config.host || `Ugreen ${idx + 1}`).trim();
}
function configuredInstances(config = {}) {
  config = config || {};
  const rows = Array.isArray(config.instances) && config.instances.length ? config.instances : (config.url || config.host ? [config] : []);
  const defaults = {};
  for (const key of ['method','connectionMethod','username','user','password','token','insecureTLS','timeoutMs','timeout','port','community','snmpVersion','securityLevel','authProtocol','authPassword','privProtocol','privPassword']) {
    if (config[key] !== undefined) defaults[key] = config[key];
  }
  return rows.filter(row => row && (row.url || row.host || row.name)).map((row, idx) => {
    const merged = { ...defaults, ...row, name: instanceName(row, idx) };
    if (row.method == null && row.connectionMethod != null) merged.method = row.connectionMethod;
    if (row.username == null && row.user != null) merged.username = row.user;
    if (connectionMethod(merged) === 'snmp' && (merged.port == null || merged.port === '')) merged.port = 161;
    return merged;
  });
}
function timeoutMs(inst = {}) {
  const n = Number(inst.timeoutMs || inst.timeout || 8000);
  return Math.max(500, Math.min(60000, Number.isFinite(n) ? n : 8000));
}
function connectionMethod(inst) {
  const value = String(inst.method || inst.connectionMethod || 'web').toLowerCase();
  return value === 'web-check' ? 'web' : value;
}
function number(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function percentage(value) {
  const n = number(value);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}
function array(value) { return Array.isArray(value) ? value : []; }
function first(value) { return Array.isArray(value) ? value[0] || {} : value || {}; }
function sample(value) {
  if (!Array.isArray(value)) return value || {};
  return value.reduce((latest, row) => {
    const time = number(row?.time ?? row?.timestamp);
    const previousTime = number(latest?.time ?? latest?.timestamp);
    return latest == null || (time !== null && (previousTime === null || time >= previousTime)) ? row : latest;
  }, null) || {};
}
function sumKnown(rows, key) {
  const values = rows.map(row => number(row?.[key])).filter(value => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function transport(inst, url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const headers = { Accept: 'application/json', 'Cache-Control': 'no-store', ...options.headers };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = (parsed.protocol === 'https:' ? https : http).request(parsed, {
      method: payload === null ? 'GET' : 'POST', headers, rejectUnauthorized: !inst.insecureTLS,
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) req.destroy(new Error('UGOS response exceeds the size limit'));
        else chunks.push(chunk);
      });
      res.on('aborted', () => reject(new Error('UGOS response was interrupted')));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => req.destroy(new Error('UGOS request timed out')), timeoutMs(inst));
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end(payload);
  });
}
function publicKey(value) {
  const text = String(value || '').replace(/\\n/g, '\n').trim();
  const raw = text.includes('-----BEGIN') ? Buffer.from(text) : Buffer.from(text, 'base64');
  for (const candidate of [
    () => crypto.createPublicKey(raw),
    () => crypto.createPublicKey(raw.toString('utf8').replace(/BEGIN RSA PUBLIC KEY/g, 'BEGIN PUBLIC KEY').replace(/END RSA PUBLIC KEY/g, 'END PUBLIC KEY')),
    () => crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' }),
    () => crypto.createPublicKey({ key: raw, format: 'der', type: 'pkcs1' }),
  ]) {
    try { const key = candidate(); if (key.asymmetricKeyType === 'rsa') return key; } catch {}
  }
  throw new Error('UGOS returned an unsupported RSA public key');
}
function seal(key, value) {
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(value)).toString('base64');
}
function encryptQuery(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64');
}
function decryptResponse(key, encoded) {
  const raw = Buffer.from(String(encoded), 'base64');
  if (raw.length < 28) throw new Error('UGOS encrypted response is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(-16));
  return Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString('utf8');
}
function parseResponse(response, key) {
  if (response.status === 401) {
    const error = new Error('UGOS API session expired');
    error.authExpired = true;
    throw error;
  }
  let body;
  try {
    body = JSON.parse(response.text);
    if (body.encrypt_resp_body && key) body = JSON.parse(decryptResponse(key, body.encrypt_resp_body));
  } catch {
    throw new Error('UGOS did not return valid API JSON. Use the local UGOS API URL (usually port 9999 or 9443)');
  }
  const code = number(body?.code);
  if (code === 1024) {
    const error = new Error('UGOS API session expired');
    error.authExpired = true;
    throw error;
  }
  if (response.status < 200 || response.status >= 300 || code !== 200) {
    const error = new Error(`UGOS API request failed (HTTP ${response.status}, code ${code ?? 'missing'})`);
    error.unsupported = response.status === 404 || code === 404;
    throw error;
  }
  return body.data;
}
function closeTelemetry(session) {
  clearInterval(session.pingTimer);
  session.pingTimer = null;
  if (session.ws) session.ws.terminate();
  session.ws = null;
}
function pruneSessions(activeKeys) {
  for (const [key, session] of sessions) {
    if ((activeKeys && !activeKeys.has(key)) || Date.now() - session.lastUsed > IDLE_SESSION_MS) {
      closeTelemetry(session);
      sessions.delete(key);
    }
  }
}
const cleanupTimer = setInterval(() => pruneSessions(), 30000);
cleanupTimer.unref();
function sessionKey(inst) {
  return crypto.createHash('sha256').update(JSON.stringify([
    cleanBaseUrl(inst.url), inst.username || inst.user || '', inst.password || '', inst.token || '', !!inst.insecureTLS,
  ])).digest('hex');
}
function getSession(inst) {
  const key = sessionKey(inst);
  let session = sessions.get(key);
  if (!session) {
    session = { base: cleanBaseUrl(inst.url), token: String(inst.token || ''), cookies: new Map(), lastUsed: Date.now() };
    sessions.set(key, session);
  }
  session.lastUsed = Date.now();
  return session;
}
async function request(inst, session, path, options = {}) {
  const url = new URL(session.base + path);
  const headers = {};
  if (session.cookies.size) headers.Cookie = [...session.cookies.values()].join('; ');
  let key;
  if (options.encrypted && session.publicKey) {
    key = Buffer.from(crypto.randomBytes(16).toString('hex'), 'ascii');
    const query = [...url.searchParams.entries(), ['token', session.token]].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    url.search = '';
    url.searchParams.set('encrypt_query', encryptQuery(key, query));
    headers['X-Ugreen-Security-Code'] = seal(session.publicKey, key.toString('ascii'));
    // Required UGOS protocol transformation, not a password hash.
    headers['X-Ugreen-Security-Key'] = crypto.createHash('md5').update(session.token).digest('hex');
    headers['X-Ugreen-Token'] = seal(session.publicKey, session.token);
  } else if (options.auth !== false) url.searchParams.set('token', session.token);
  const response = await transport(inst, url, { body: options.body, headers });
  for (const cookie of response.headers['set-cookie'] || []) {
    const value = cookie.split(';', 1)[0];
    session.cookies.set(value.split('=', 1)[0], value);
  }
  return options.raw ? response : parseResponse(response, key);
}
async function login(inst, session) {
  if (session.loginPromise) return session.loginPromise;
  if (Date.now() < (session.loginBackoffUntil || 0)) throw new Error('UGOS login failed recently; waiting before another attempt');
  const username = String(inst.username || inst.user || '').trim();
  if (!username || !inst.password) throw new Error('UGOS API requires a username and password, or a valid session token');
  session.loginPromise = (async () => {
    const challenge = await request(inst, session, '/ugreen/v1/verify/check?token=', { auth: false, raw: true, body: { username } });
    if (challenge.status !== 200 || !challenge.headers['x-rsa-token']) throw new Error('UGOS login challenge is unavailable; check the local API URL and port');
    const key = publicKey(challenge.headers['x-rsa-token']);
    const data = await request(inst, session, '/ugreen/v1/verify/login', {
      auth: false, body: { username, password: seal(key, String(inst.password)), keepalive: true, otp: true, is_simple: true },
    });
    if (!data?.token) {
      if (data?.enable_otp || data?.token_id) throw new Error('UGOS account requires two-factor authentication; provide an existing authenticated session token');
      throw new Error('UGOS login did not return a session token');
    }
    closeTelemetry(session);
    session.token = String(data.token);
    session.publicKey = data.public_key ? publicKey(data.public_key) : null;
    session.loginBackoffUntil = 0;
  })().catch(error => {
    session.loginBackoffUntil = Date.now() + 60000;
    throw error;
  }).finally(() => { session.loginPromise = null; });
  return session.loginPromise;
}
async function ensureTelemetry(inst, session) {
  if (session.ws?.readyState === WebSocket.OPEN) return true;
  if (session.wsPromise) return session.wsPromise;
  const url = new URL(session.base + '/ugreen/v1/desktop/ws');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client_id', `${crypto.randomUUID()}-WEB`);
  url.searchParams.set('lang', 'en-US');
  url.searchParams.set('token', session.token);
  session.wsPromise = new Promise(resolve => {
    let pingTimer;
    let lastPong = Date.now();
    const ws = new WebSocket(url, {
      headers: { Origin: new URL(session.base).origin, 'Cache-Control': 'no-cache', ...(session.cookies.size ? { Cookie: [...session.cookies.values()].join('; ') } : {}) },
      rejectUnauthorized: !inst.insecureTLS, handshakeTimeout: Math.min(4000, timeoutMs(inst)), maxPayload: 256 * 1024,
    });
    session.ws = ws;
    ws.on('message', () => {});
    ws.on('pong', () => { lastPong = Date.now(); });
    ws.once('open', () => {
      ws.send(JSON.stringify({ op: 'subscribe', topics: ['cpu_usage', 'cpu_temp'], ts: Date.now() }));
      ws.ping();
      pingTimer = setInterval(() => {
        if (session.ws !== ws) { clearInterval(pingTimer); return; }
        if (Date.now() - session.lastUsed > IDLE_SESSION_MS || Date.now() - lastPong > 60000 || ws.readyState !== WebSocket.OPEN) closeTelemetry(session);
        else ws.ping();
      }, 25000);
      pingTimer.unref();
      session.pingTimer = pingTimer;
      resolve(true);
    });
    ws.once('error', () => resolve(false));
    ws.once('close', () => {
      clearInterval(pingTimer);
      if (session.ws === ws) {
        clearInterval(session.pingTimer);
        session.pingTimer = null;
        session.ws = null;
      }
      resolve(false);
    });
  }).finally(() => { session.wsPromise = null; });
  return session.wsPromise;
}
function storageRow(row, pool = false) {
  const totalBytes = number(row.total);
  const usedBytes = number(row.used);
  const states = pool
    ? ['normal','syncing','warning','degraded','corrupted','data organizing','creating','deleting','repairing','rebuilding','replacing hard drive','adding hard drive','RAID upgrading','upgrade','waiting for sync']
    : ['normal','warning','danger','faulty'];
  return {
    name: String(row.label || row.name || (pool ? 'Storage pool' : 'Volume')), mountpoint: row.mntpath || '',
    totalBytes, usedBytes, freeBytes: number(row.available),
    // Pool 'used' is allocated capacity, not filesystem fullness.
    usedPercent: !pool && totalBytes > 0 && usedBytes !== null ? Math.min(100, Math.max(0, usedBytes / totalBytes * 100)) : null,
    status: row.status == null ? '' : states[Number(row.status)] || `status ${row.status}`,
    warning: pool ? [2, 3, 4].includes(number(row.status)) : [1, 2, 3].includes(number(row.status)),
  };
}
function apiMetrics(machine, stats, legacy = {}) {
  const common = machine?.common || {};
  const hardware = machine?.hardware || {};
  const overview = stats?.overview || stats || {};
  const cpu = sample(overview.cpu);
  const mem = sample(overview.mem);
  const structure = stats?.mem?.structure || {};
  return {
    hostname: common.nas_name || common.hostname || '', model: common.model || '',
    version: common.system_version || legacy.status?.system_version || '',
    uptimeSeconds: number(common.run_time) ?? number(legacy.status?.total_run_time),
    cpuCores: number(first(hardware.cpu).core),
    cpuPercent: percentage(cpu.used_percent) ?? percentage(legacy.device?.cpu_usage_rate),
    memoryPercent: percentage(mem.used_percent) ?? percentage(legacy.device?.ram_usage_rate),
    memoryTotalBytes: number(structure.total) ?? sumKnown(array(hardware.mem), 'size'), memoryUsedBytes: number(structure.used),
    cpuTemp: number(cpu.temp) ?? number(legacy.temperature?.cpu_temperature) ?? number(first(hardware.cpu).temperature),
    systemTemp: number(overview.device_temp),
  };
}
async function apiData(inst) {
  const session = getSession(inst);
  if (!session.token) await login(inst, session);
  for (let attempt = 0; attempt < 2; attempt++) {
    const telemetry = await ensureTelemetry(inst, session);
    const paths = ['/ugreen/v1/sysinfo/machine/common','/ugreen/v1/taskmgr/stat/get_all','/ugreen/v1/storage/pool/list','/ugreen/v2/storage/disk/list'];
    const results = await Promise.allSettled(paths.map(path => request(inst, session, path, { encrypted: path.includes('/v2/') })));
    if (results.some(result => result.status === 'rejected' && result.reason.authExpired)) {
      if (attempt || !(inst.username || inst.user) || !inst.password) throw new Error('UGOS API session expired; refresh the token or configure username/password');
      await login(inst, session);
      continue;
    }
    const errors = [];
    const data = results.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      if (index !== 1) errors.push(`${paths[index]}: ${result.reason.message}`);
      return null;
    });
    let stats = data[1];
    const legacy = {};
    if (!stats) {
      try { stats = await request(inst, session, '/ugreen/v1/taskmgr/stat/overview'); } catch {}
      if (!stats) {
        await Promise.all([['device','DeviceMonitoring'],['temperature','TemperatureMonitoring'],['status','SystemStatus']].map(async ([key, name]) => {
          try { legacy[key] = await request(inst, session, `/ugreen/v1/desktop/components/data?id=desktop.component.${name}`); } catch {}
        }));
        if (!legacy.device) errors.push('UGOS resource monitoring is unavailable for this account or firmware');
      }
    }
    const system = apiMetrics(data[0], stats, legacy);
    if (system.cpuPercent === null || system.memoryPercent === null) errors.push('UGOS did not expose both CPU and RAM usage');
    if (!telemetry) errors.push('UGOS telemetry WebSocket is unavailable; live usage may stop updating');
    const storageKnown = Array.isArray(data[2]?.result);
    const disksKnown = Array.isArray(data[3]?.result);
    if (data[2] !== null && !storageKnown) errors.push('UGOS storage response format is unsupported');
    if (data[3] !== null && !disksKnown) errors.push('UGOS disk response format is unsupported');
    const pools = array(data[2]?.result).map(row => storageRow(row, true));
    const volumes = array(data[2]?.result).flatMap(row => array(row.volumes).map(volume => storageRow(volume)));
    const disks = array(data[3]?.result).map(row => ({
      name: row.label || row.name || row.dev_name || `Disk ${row.slot ?? ''}`, device: row.dev_name || row.name || '',
      model: row.model || row.model_name || '', sizeBytes: number(row.size), temperature: number(row.temperature),
      type: [1, 2, 4].includes(Number(row.type)) || /nvme|ssd|m2/i.test(String(row.interface_type)) ? 'ssd' : [0, 3].includes(number(row.type)) ? 'hdd' : 'unknown',
      status: row.is_standby ? 'standby' : row.status == null ? 'unknown' : ['undetectable', 'normal', 'warning', 'critical', 'failure', 'locked'][Number(row.status)] || `status ${row.status}`,
      warning: !row.is_standby && [0, 2, 3, 4, 5].includes(number(row.status)),
      powerOnHours: number(row.power_on_hours),
    }));
    const net = sample((stats?.overview || stats || {}).net);
    const network = { rxBps: number(net.recv_rate) ?? number(legacy.device?.download_speed?.raw), txBps: number(net.send_rate) ?? number(legacy.device?.upload_speed?.raw) };
    const totalBytes = sumKnown(volumes, 'totalBytes');
    const usedBytes = sumKnown(volumes, 'usedBytes');
    const disksWarn = disks.filter(row => row.warning).length;
    const poolsWarn = pools.filter(row => row.warning).length;
    const volumesWarn = volumes.filter(row => row.warning).length;
    const usageKnown = volumes.length > 0 && volumes.every(row => row.totalBytes > 0 && row.usedBytes !== null);
    return {
      online: true, name: inst.name, url: inst.url, method: 'api', system, pools, volumes, disks, network,
      available: { system: !!data[0] || system.cpuPercent !== null || system.memoryPercent !== null, storage: storageKnown, disks: disksKnown, services: false },
      partial: errors.length > 0, errors, error: errors.join(' / '),
      degraded: disksWarn + poolsWarn + volumesWarn > 0,
      summary: { pools: pools.length, volumes: volumes.length, disks: disks.length, disksWarn, poolsWarn, volumesWarn, usedPercent: usageKnown && totalBytes > 0 && usedBytes !== null ? usedBytes / totalBytes * 100 : null },
    };
  }
}
async function snmpData(inst) {
  let host = String(inst.host || '').trim();
  if (!host && inst.url) host = new URL(inst.url).hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('SNMP host is required');
  const data = await getGenericNasData({ ...inst, host });
  const sys = data.system || {};
  const errors = [...data.errors];
  if (sys.cpu == null && !sys.ram && !data.volumes.length) errors.push('SNMP service exposes no CPU, RAM or storage metrics. Install or enable a compatible SNMP agent on the NAS');
  return {
    online: true, name: inst.name, url: inst.url || host, host, method: 'snmp',
    system: { hostname: inst.name, cpuPercent: sys.cpu ?? null, memoryPercent: sys.ram?.percent ?? null,
      memoryUsedBytes: sys.ram?.usedBytes ?? null, memoryTotalBytes: sys.ram?.totalBytes ?? null,
      cpuTemp: sys.cpuTemp ?? null, systemTemp: sys.systemTemperature ?? sys.systemTemp ?? null, uptimeSeconds: sys.uptimeSeconds ?? null },
    volumes: data.volumes, disks: [], pools: [], network: data.network, available: data.available,
    partial: errors.length > 0, errors, error: errors.join(' / '), summary: { volumes: data.volumes.length, pools: 0, disks: 0 },
  };
}
async function getUgreenInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  const method = connectionMethod(inst);
  if (method === 'snmp') return snmpData(inst);
  if (!['web', 'api'].includes(method)) throw new Error(`Unsupported UGREEN connection method: ${method}`);
  if (!inst.url) throw new Error('Ugreen URL is required');
  if (method === 'api') return apiData(inst);
  const probe = await transport(inst, parseUrl(inst.url));
  if (probe.status < 200 || probe.status >= 500) throw new Error(`HTTP ${probe.status || 0}: unreachable`);
  return { online: true, name: inst.name, url: inst.url, method: 'web', statusCode: probe.status,
    system: { hostname: inst.name }, available: { ...EMPTY_AVAILABLE }, summary: { instances: 1, up: 1, down: 0 } };
}
function summarize(instances = []) {
  return { instances: instances.length, up: instances.filter(i => i.online).length, down: instances.filter(i => !i.online).length,
    partial: instances.filter(i => i.partial).length, degraded: instances.filter(i => i.degraded).length };
}
async function getAllUgreenData(config = {}) {
  const instances = config?.enabled === false ? [] : configuredInstances(config).filter(inst => inst.enabled !== false);
  const activeKeys = new Set();
  instances.filter(inst => connectionMethod(inst) === 'api' && inst.url).forEach(inst => { try { activeKeys.add(sessionKey(inst)); } catch {} });
  pruneSessions(activeKeys);
  if (!instances.length) return { online: false, error: 'No Ugreen instances configured', summary: summarize([]), instances: [] };
  const rows = await mapLimit(instances, Number(config?.concurrency || config?.collectorConcurrency || 3), async (inst, idx) => {
    try { return await getUgreenInstance(inst, idx); }
    catch (error) { return { online: false, name: inst.name, url: inst.url || inst.host || '', method: connectionMethod(inst), error: error.message,
      system: {}, available: { ...EMPTY_AVAILABLE }, summary: summarize([]) }; }
  });
  return { online: rows.some(row => row.online), error: rows.find(row => !row.online)?.error || '', summary: summarize(rows), instances: rows };
}
function _resetRuntime() {
  for (const session of sessions.values()) closeTelemetry(session);
  sessions.clear();
}
module.exports = { getAllUgreenData, configuredInstances, _resetRuntime };
