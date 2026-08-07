const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `QNAP ${idx + 1}`).trim();
}

function configuredInstances(config = {}) {
  config = config || {};
  const rows = Array.isArray(config.instances) && config.instances.length
    ? config.instances
    : (config.url ? [config] : []);
  return rows
    .filter(row => row && (row.url || row.name))
    .map((row, idx) => ({ ...row, name: instanceName(row, idx) }));
}

function timeoutMs(inst = {}) {
  const value = Number(inst.timeoutMs || inst.timeout || 10000);
  return Math.max(2000, Math.min(60000, Number.isFinite(value) ? value : 10000));
}

function cookieHeader(setCookie) {
  const rows = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return rows.map(value => String(value).split(';', 1)[0]).filter(Boolean).join('; ');
}

function httpRequest(url, inst = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { Accept: opts.accept || 'application/json, text/xml, */*', ...(opts.headers || {}) };
    const req = lib.request(parsed, {
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: inst.insecureTLS ? false : undefined,
      timeout: timeoutMs(inst),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > Number(opts.maxBytes || 2 * 1024 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        }
        resolve({ body: data, headers: res.headers, statusCode: res.statusCode || 0 });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end(opts.body);
  });
}

function decodeXml(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[/i, '')
    .replace(/\]\]>$/i, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function xmlBlocks(text, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = String(text || '').matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'gi'));
  return [...matches].map(match => String(match[1] || '').trim());
}

function xmlValues(text, tag) {
  return xmlBlocks(text, tag).map(value => decodeXml(value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]+>/g, '')));
}

function parseJson(text) {
  try { return JSON.parse(String(text || '').trim()); } catch { return null; }
}

function normalizedKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scalar(value) {
  return value == null || typeof value === 'object' ? null : value;
}

function directRaw(object, aliases) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const wanted = new Set(aliases.map(normalizedKey));
  const entry = Object.entries(object).find(([key]) => wanted.has(normalizedKey(key)));
  return entry?.[1];
}

function deepValue(object, aliases) {
  if (!object || typeof object !== 'object') return '';
  const wanted = new Set(aliases.map(normalizedKey));
  const queue = [object];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(normalizedKey(key)) && scalar(value) != null && String(value).trim() !== '') return value;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return '';
}

function deepRawValue(object, aliases) {
  if (!object || typeof object !== 'object') return { found: false, value: undefined };
  const wanted = new Set(aliases.map(normalizedKey));
  const queue = [object];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      for (const [key, value] of Object.entries(current)) {
        if (wanted.has(normalizedKey(key))) return { found: true, value };
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return { found: false, value: undefined };
}

function rowsForKeys(object, aliases) {
  if (!object || typeof object !== 'object') return [];
  const wanted = new Set(aliases.map(normalizedKey));
  const rows = [];
  const queue = [object];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach(value => { if (value && typeof value === 'object') queue.push(value); });
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(normalizedKey(key))) {
        const values = Array.isArray(value) ? value : [value];
        values.forEach(row => { if (row && typeof row === 'object') rows.push(row); });
      }
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return rows;
}

function responseValue(body, aliases) {
  const json = parseJson(body);
  if (json) return deepValue(json, aliases);
  for (const alias of aliases) {
    const value = xmlValues(body, alias).find(item => String(item).trim() !== '');
    if (value !== undefined) return value;
  }
  return '';
}

function responseHasKey(body, aliases) {
  const json = parseJson(body);
  if (json) return deepRawValue(json, aliases).found;
  return aliases.some(alias => {
    const escaped = String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<${escaped}(?:\\s|>|\/)`, 'i').test(String(body || ''));
  });
}

function rowValue(row, aliases) {
  if (row && typeof row === 'object') return deepValue(row, aliases);
  return responseValue(row, aliases);
}

function numberValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value) {
  const parsed = numberValue(value);
  if (parsed == null) return null;
  return Math.max(0, Math.min(100, Math.round(parsed * 10) / 10));
}

function percentFromPair(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return percent((used / total) * 100);
}

function bytesValue(value, defaultUnit = 'B') {
  if (value == null || value === '') return null;
  const text = String(value).trim().replace(/,/g, '');
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*([kmgtpe]?i?b)?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = String(match[2] || defaultUnit || 'B').toUpperCase().replace('IB', 'B');
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5, EB: 6 };
  return amount * (1024 ** (powers[unit] ?? 0));
}

function qnapLoginInfo(body = '') {
  const value = (...keys) => responseValue(body, keys);
  return {
    hostname: value('hostname', 'hostName', 'serverName', 'server_name'),
    model: value('displayModelName', 'modelName', 'internalModelName'),
    firmware: value('firmwareVersion', 'version'),
    firmwareBuild: value('firmwareBuild', 'build'),
  };
}

async function login(inst = {}) {
  const configuredSid = inst.sid || inst.qsid || inst.token || '';
  if (configuredSid) return { sid: String(configuredSid), info: {}, cookie: '', owned: false };
  if (!inst.username && !inst.user) throw new Error('QNAP username is required');
  if (!inst.password) throw new Error('QNAP password is required');
  const params = new URLSearchParams({
    user: inst.username || inst.user || '',
    pwd: Buffer.from(String(inst.password), 'utf8').toString('base64'),
    serviceKey: String(inst.serviceKey || inst.service || '1'),
  });
  const response = await httpRequest(`${cleanBaseUrl(inst.url)}/cgi-bin/authLogin.cgi?${params}`, inst, { accept: 'text/xml, application/json, */*' });
  const authPassed = responseValue(response.body, ['authPassed']);
  const sidValue = responseValue(response.body, ['authSid', 'sid']);
  if ((String(authPassed) === '1' || sidValue) && sidValue) {
    return { sid: String(sidValue), info: qnapLoginInfo(response.body), cookie: cookieHeader(response.headers['set-cookie']), owned: true };
  }
  const errorValue = responseValue(response.body, ['errorValue', 'error']);
  throw new Error(errorValue ? `QNAP login failed (${errorValue})` : 'QNAP login failed');
}

function qtsUrl(inst, path, sid) {
  const url = new URL(`${cleanBaseUrl(inst.url)}/cgi-bin/${String(path).replace(/^\/+/, '')}`);
  url.searchParams.set('sid', sid);
  return url.toString();
}

async function qtsRequest(inst, auth, path, label) {
  const headers = auth.cookie ? { Cookie: auth.cookie } : {};
  const response = await httpRequest(qtsUrl(inst, path, auth.sid), inst, { headers, accept: 'text/xml, application/json, */*' });
  const body = response.body;
  if (!String(body || '').trim()) throw new Error(`${label} returned an empty response`);
  if (/^\s*<!doctype\s+html|^\s*<html\b/i.test(body)) throw new Error(`${label} returned the QTS login page`);
  const authPassed = responseValue(body, ['authPassed']);
  if (String(authPassed) === '0') throw new Error(`${label} permission denied; the QNAP user must belong to the administrators group`);
  const success = responseValue(body, ['success']);
  const errorValue = responseValue(body, ['errorValue', 'error_code', 'errorCode']);
  if (success === false || success === 'false') throw new Error(`${label} failed${errorValue ? ` (${errorValue})` : ''}`);
  if (errorValue && String(errorValue) !== '0') throw new Error(`${label} failed (${errorValue})`);
  return body;
}

async function optionalQtsRequest(inst, auth, path, label) {
  try { return { ok: true, body: await qtsRequest(inst, auth, path, label) }; }
  catch (err) { return { ok: false, error: err.message }; }
}

async function checkSid(inst = {}, auth = {}) {
  const body = await qtsRequest(inst, auth, 'filemanager/utilRequest.cgi?func=check_sid', 'QNAP session check');
  const json = parseJson(body) || {};
  const status = deepValue(json, ['status']);
  const success = deepValue(json, ['success']);
  const serverName = deepValue(json, ['server_name', 'hostname']) || responseValue(body, ['server_name', 'hostname']);
  const ok = status === 1 || status === '1' || success === true || success === 'true' || Boolean(String(serverName || '').trim());
  return {
    ok,
    serverName,
  };
}

async function logout(inst = {}, auth = {}) {
  if (!auth.owned || !auth.sid) return;
  const headers = auth.cookie ? { Cookie: auth.cookie } : {};
  await httpRequest(qtsUrl(inst, 'authLogout.cgi', auth.sid), inst, { headers, maxBytes: 256 * 1024 });
}

function parseSystemStats(body, fallback = {}) {
  const cpuPercent = percent(responseValue(body, ['cpu_usage', 'cpuUsage', 'cpu_percent', 'cpuPercent']));
  const memoryPercentDirect = percent(responseValue(body, ['memory_usage_percent', 'memoryPercent', 'mem_usage_percent']));
  const totalMemoryMb = numberValue(responseValue(body, ['total_memory', 'totalMemory']));
  const freeMemoryMb = numberValue(responseValue(body, ['free_memory', 'freeMemory', 'available_memory']));
  const usedMemoryMb = totalMemoryMb != null && freeMemoryMb != null ? Math.max(0, totalMemoryMb - freeMemoryMb) : null;
  const memoryPercent = memoryPercentDirect ?? percentFromPair(usedMemoryMb, totalMemoryMb);
  const uptimeDays = numberValue(responseValue(body, ['uptime_day'])) || 0;
  const uptimeHours = numberValue(responseValue(body, ['uptime_hour'])) || 0;
  const uptimeMinutes = numberValue(responseValue(body, ['uptime_min'])) || 0;
  const uptimeSecondsPart = numberValue(responseValue(body, ['uptime_sec'])) || 0;
  const firmware = responseValue(body, ['firmwareVersion', 'version']) || fallback.firmware || '';
  const firmwareBuild = responseValue(body, ['firmwareBuild', 'build']) || fallback.firmwareBuild || '';
  const cpuTempValue = numberValue(responseValue(body, ['cpu_tempc', 'cpuTempC', 'cpu_temperature']));
  const systemTempValue = numberValue(responseValue(body, ['sys_tempc', 'systemTempC', 'system_temperature']));
  return {
    hostname: responseValue(body, ['server_name', 'hostname', 'hostName']) || fallback.hostname || '',
    model: responseValue(body, ['displayModelName', 'modelName', 'internalModelName']) || fallback.model || '',
    firmware: [firmware, firmwareBuild].filter(Boolean).join(' build '),
    version: firmware,
    cpuModel: responseValue(body, ['cpu_model', 'cpuModel']),
    cpuPercent,
    memoryPercent,
    memoryTotalBytes: totalMemoryMb != null ? totalMemoryMb * 1024 * 1024 : null,
    memoryUsedBytes: usedMemoryMb != null ? usedMemoryMb * 1024 * 1024 : null,
    memoryFreeBytes: freeMemoryMb != null ? freeMemoryMb * 1024 * 1024 : null,
    cpuTemp: cpuTempValue != null && cpuTempValue >= 0 && cpuTempValue <= 150 ? cpuTempValue : null,
    systemTemp: systemTempValue != null && systemTempValue >= 0 && systemTempValue <= 150 ? systemTempValue : null,
    uptimeSeconds: uptimeDays * 86400 + uptimeHours * 3600 + uptimeMinutes * 60 + uptimeSecondsPart,
  };
}

function storageHealth(status, code) {
  const value = String(status || '').toLowerCase();
  if (/(fail|error|offline|unmount|degrad|warn)/.test(value)) return 'warn';
  if (code != null && Number(code) !== 0) return 'warn';
  return 'online';
}

function parseChartVolumes(body) {
  const json = parseJson(body);
  const volumeRows = json ? rowsForKeys(json, ['volume']) : xmlBlocks(body, 'volume');
  const usageRows = json ? rowsForKeys(json, ['volumeUse']) : xmlBlocks(body, 'volumeUse');
  const usageById = new Map(usageRows.map(row => [String(rowValue(row, ['volumeValue', 'volume_id', 'id'])), row]));
  return volumeRows.map((row, idx) => {
    const id = String(rowValue(row, ['volumeValue', 'volume_id', 'id']) || idx + 1);
    const usage = usageById.get(id);
    const totalBytes = bytesValue(rowValue(usage, ['total_size', 'totalSize', 'capacity']), 'B')
      ?? bytesValue(rowValue(row, ['total_size', 'totalSize', 'capacity']), 'B');
    const freeBytes = bytesValue(rowValue(usage, ['free_size', 'freeSize', 'available']), 'B')
      ?? bytesValue(rowValue(row, ['free_size', 'freeSize', 'available']), 'B');
    const explicitUsed = bytesValue(rowValue(usage, ['used_size', 'usedSize']), 'B')
      ?? bytesValue(rowValue(row, ['used_size', 'usedSize']), 'B');
    const usedBytes = explicitUsed ?? (totalBytes != null && freeBytes != null ? Math.max(0, totalBytes - freeBytes) : null);
    const status = rowValue(row, ['volumeStat', 'status', 'state']);
    const statusCode = numberValue(rowValue(row, ['volumeStatus', 'statusCode']));
    return {
      id,
      name: rowValue(row, ['volumeLabel', 'volume_name', 'name']) || `Volume ${id}`,
      status: status || (statusCode === 0 ? 'ready' : statusCode != null ? `status ${statusCode}` : ''),
      health: storageHealth(status, statusCode),
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: percentFromPair(usedBytes, totalBytes),
    };
  }).filter(row => row.name || row.totalBytes != null);
}

function parseFileStationVolumes(body) {
  const json = parseJson(body);
  if (!json) return [];
  const rows = Array.isArray(json) ? json
    : Array.isArray(json.data) ? json.data
      : Array.isArray(json.datas) ? json.datas
        : Array.isArray(json.items) ? json.items : [];
  return rows.filter(row => row && typeof row === 'object' && (row.volume_name || row.volume_id != null || row.capacity != null)).map((row, idx) => {
    const id = String(row.volume_id ?? row.id ?? idx + 1);
    const totalBytes = bytesValue(row.capacity ?? row.total_size, row.capacity_unit || row.volume_unit || row.unit || 'B');
    const freeBytes = bytesValue(row.free_size ?? row.available, row.free_size_unit || row.volume_free_unit || row.unit || 'B');
    const explicitUsed = bytesValue(row.used_size, row.used_size_unit || row.volume_used_unit || row.volume_unit || row.unit || 'B');
    const usedBytes = explicitUsed ?? (totalBytes != null && freeBytes != null ? Math.max(0, totalBytes - freeBytes) : null);
    const statusCode = numberValue(row.volume_status ?? row.status);
    const status = row.status_text || row.state || (statusCode === 0 ? 'ready' : statusCode != null ? `status ${statusCode}` : '');
    return {
      id,
      name: row.volume_name || row.name || `Volume ${id}`,
      status,
      health: storageHealth(status, statusCode),
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: percentFromPair(usedBytes, totalBytes),
    };
  });
}

function mergeVolumes(primary = [], fallback = []) {
  const merged = new Map();
  for (const row of [...primary, ...fallback]) {
    const key = String(row.id || row.name).toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, { ...row });
      continue;
    }
    const current = merged.get(key);
    for (const [field, value] of Object.entries(row)) {
      if ((current[field] == null || current[field] === '') && value != null && value !== '') current[field] = value;
    }
    current.usedPercent = current.usedPercent ?? percentFromPair(current.usedBytes, current.totalBytes);
  }
  return [...merged.values()];
}

function diskTemperature(row) {
  if (row && typeof row === 'object') {
    const container = directRaw(row, ['Temperature', 'temperature']);
    const raw = container && typeof container === 'object' ? deepValue(container, ['oC', 'celsius', 'value']) : container;
    const parsed = numberValue(raw ?? deepValue(row, ['temp_c', 'temperature_celsius']));
    return parsed != null && parsed >= 0 && parsed <= 150 ? parsed : null;
  }
  const container = xmlBlocks(row, 'Temperature')[0] || '';
  const parsed = numberValue(responseValue(container, ['oC', 'celsius']) || responseValue(row, ['temp_c', 'temperature_celsius']));
  return parsed != null && parsed >= 0 && parsed <= 150 ? parsed : null;
}

function diskHealth(value, statusCode) {
  const health = String(value || '').toLowerCase();
  if (/(^|\b)(ok|good|normal|ready|healthy|online)(\b|$)/.test(health)) return 'online';
  if (/(warn|abnormal|degrad)/.test(health)) return 'warn';
  if (/(fail|error|bad|offline|critical)/.test(health)) return 'down';
  if (statusCode === 0) return 'online';
  return statusCode == null ? 'unknown' : 'warn';
}

function parseDisks(body) {
  const json = parseJson(body);
  const rows = json ? rowsForKeys(json, ['entry', 'disks']) : xmlBlocks(body, 'entry');
  return rows.map((row, idx) => {
    const model = rowValue(row, ['Model', 'model', 'model_name']);
    const serial = rowValue(row, ['Serial', 'serial', 'serial_number']);
    const vendor = rowValue(row, ['Vendor', 'vendor', 'manufacturer']);
    const capacity = rowValue(row, ['Capacity', 'capacity', 'size']);
    const sizeBytes = bytesValue(capacity, 'B');
    if (!model && !serial && !vendor && sizeBytes == null) return null;
    const statusCode = numberValue(rowValue(row, ['Disk_Status', 'status_code']));
    const rawHealth = rowValue(row, ['Health', 'health', 'smart_status']);
    const diskNumber = rowValue(row, ['HDNo', 'disk_number', 'id']) || idx + 1;
    const isSsd = String(rowValue(row, ['hd_is_ssd', 'is_ssd', 'ssd'])).toLowerCase();
    return {
      name: rowValue(row, ['Disk_Alias', 'alias', 'name']) || `Disk ${diskNumber}`,
      device: String(diskNumber),
      model: model || vendor || '',
      serial: serial || '',
      type: ['1', 'true', 'yes', 'ssd', 'nvme'].includes(isSsd) || /ssd|nvme/i.test(String(model || vendor)) ? 'ssd' : 'hdd',
      sizeBytes,
      temperature: diskTemperature(row),
      status: rawHealth || (statusCode === 0 ? 'OK' : statusCode != null ? `status ${statusCode}` : ''),
      health: diskHealth(rawHealth, statusCode),
    };
  }).filter(Boolean);
}

function diskPayloadRecognized(body, disks) {
  if (disks.length) return true;
  const json = parseJson(body);
  if (json) {
    const info = deepRawValue(json, ['Disk_Info', 'diskInfo']);
    const directDisks = deepRawValue(json, ['disks']);
    const payload = info.found ? info.value : directDisks.value;
    if (!info.found && !directDisks.found) return false;
    if (payload == null) return true;
    if (Array.isArray(payload)) return payload.length === 0;
    if (typeof payload !== 'object') return String(payload).trim() === '';
    const entries = deepRawValue(payload, ['entry', 'disks']);
    if (entries.found && Array.isArray(entries.value)) return entries.value.length === 0;
    return Object.keys(payload).length === 0;
  }
  const info = xmlBlocks(body, 'Disk_Info');
  return (info.length > 0 && info.every(value => !String(value).replace(/<!\[CDATA\[|\]\]>/g, '').trim()))
    || /<Disk_Info(?:\s[^>]*)?\s*\/>/i.test(String(body || ''));
}

function chartPayloadRecognized(body) {
  return responseHasKey(body, ['volumeList', 'volumeUseList']);
}

function fileStationPayloadRecognized(body) {
  const json = parseJson(body);
  return Array.isArray(json) || Array.isArray(json?.data) || Array.isArray(json?.datas) || Array.isArray(json?.items);
}

function summarize(instances = []) {
  const volumes = instances.flatMap(instance => instance.volumes || []);
  const disks = instances.flatMap(instance => instance.disks || []);
  const totalBytes = volumes.reduce((sum, row) => sum + (Number(row.totalBytes) || 0), 0);
  const usedBytes = volumes.reduce((sum, row) => sum + (Number(row.usedBytes) || 0), 0);
  return {
    instances: instances.length,
    up: instances.filter(instance => instance.online).length,
    down: instances.filter(instance => !instance.online).length,
    volumes: volumes.length,
    disks: disks.length,
    disksWarn: disks.filter(disk => !['online', 'unknown'].includes(disk.health)).length,
    totalBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? percentFromPair(usedBytes, totalBytes) : null,
  };
}

async function getQnapInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  if (!inst.url) throw new Error('QNAP URL is required');
  let auth;
  try {
    auth = await login(inst);
    const checked = await checkSid(inst, auth);
    if (!checked.ok) throw new Error('QNAP session check failed');
    const [systemResult, disksResult, chartResult, fileStationResult] = await Promise.all([
      optionalQtsRequest(inst, auth, 'management/manaRequest.cgi?subfunc=sysinfo&hd=no&multicpu=1', 'QNAP system metrics'),
      optionalQtsRequest(inst, auth, 'disk/qsmart.cgi?func=all_hd_data', 'QNAP disk metrics'),
      optionalQtsRequest(inst, auth, 'management/chartReq.cgi?chart_func=disk_usage&disk_select=all&include=all', 'QNAP storage metrics'),
      optionalQtsRequest(inst, auth, 'filemanager/utilRequest.cgi?func=get_tree&hidden_file=0&is_iso=0&node=vol_root&recycle=0&check_acl=0', 'QNAP storage fallback'),
    ]);
    const system = systemResult.ok
      ? parseSystemStats(systemResult.body, auth.info)
      : { hostname: checked.serverName || auth.info.hostname || inst.name, model: auth.info.model || '', firmware: [auth.info.firmware, auth.info.firmwareBuild].filter(Boolean).join(' build ') };
    if (!system.hostname) system.hostname = checked.serverName || auth.info.hostname || inst.name;
    const disks = disksResult.ok ? parseDisks(disksResult.body) : [];
    const chartVolumes = chartResult.ok ? parseChartVolumes(chartResult.body) : [];
    const fileStationVolumes = fileStationResult.ok ? parseFileStationVolumes(fileStationResult.body) : [];
    const volumes = mergeVolumes(chartVolumes, fileStationVolumes);
    const systemAvailable = systemResult.ok && (system.cpuPercent != null || system.memoryPercent != null);
    const disksAvailable = disksResult.ok && diskPayloadRecognized(disksResult.body, disks);
    const chartAvailable = chartResult.ok && chartPayloadRecognized(chartResult.body);
    const fileStationAvailable = fileStationResult.ok && fileStationPayloadRecognized(fileStationResult.body);
    const storageAvailable = chartAvailable || fileStationAvailable;
    const errors = [];
    if (!systemResult.ok) errors.push(systemResult.error);
    else {
      if (system.cpuPercent == null) errors.push('QNAP system metrics did not include CPU usage');
      if (system.memoryPercent == null) errors.push('QNAP system metrics did not include RAM usage');
    }
    if (!disksAvailable) errors.push(disksResult.error || 'QNAP disk metrics did not include a disk inventory');
    if (!storageAvailable) errors.push([chartResult.error, fileStationResult.error].filter(Boolean).join(' / ') || 'QNAP storage metrics did not include a volume inventory');
    const summary = summarize([{ online: true, volumes, disks }]);
    return {
      online: true,
      name: inst.name,
      url: inst.url,
      method: 'QTS API',
      system,
      volumes,
      disks,
      available: { system: systemAvailable, storage: storageAvailable, disks: disksAvailable },
      summary,
      partial: errors.length > 0,
      errors: errors.filter(Boolean).slice(0, 5),
    };
  } finally {
    if (auth) await logout(inst, auth).catch(() => {});
  }
}

async function getAllQnapData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) return { online: false, error: 'No QNAP instances configured', summary: summarize([]), instances: [] };
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 3), async (inst, idx) => {
    try { return await getQnapInstance(inst, idx); }
    catch (err) {
      return { online: false, name: inst.name, url: inst.url || '', error: err.message, system: {}, volumes: [], disks: [], summary: summarize([]) };
    }
  });
  const summary = summarize(rows);
  return { online: summary.up > 0, error: rows.find(row => !row.online)?.error || '', summary, instances: rows };
}

module.exports = { getAllQnapData, configuredInstances, qnapLoginInfo };
