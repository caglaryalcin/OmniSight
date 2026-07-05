const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `Firewall ${idx + 1}`).trim();
}

function configuredInstances(config = {}) {
  config = config || {};
  const rows = Array.isArray(config.instances) && config.instances.length
    ? config.instances
    : (config.url ? [config] : []);
  return rows
    .filter(row => row && (row.url || row.name))
    .map((row, idx) => ({ ...row, name: instanceName(row, idx), type: String(row.type || config.type || 'opnsense').toLowerCase() }));
}

function authHeader(inst = {}) {
  if (inst.apiKey || inst.apiSecret) {
    return 'Basic ' + Buffer.from(`${inst.apiKey || ''}:${inst.apiSecret || ''}`).toString('base64');
  }
  if (inst.username || inst.password) {
    return 'Basic ' + Buffer.from(`${inst.username || ''}:${inst.password || ''}`).toString('base64');
  }
  if (inst.bearerToken || inst.token) return `Bearer ${inst.bearerToken || inst.token}`;
  return '';
}

function apiPath(path) {
  return String(path || '').startsWith('/api/') ? path : `/api/${String(path || '').replace(/^\/+/, '')}`;
}

function httpJson(url, inst = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const auth = authHeader(inst);
    if (auth) headers.Authorization = auth;
    const req = lib.request(parsed, {
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: inst.insecureTLS ? false : undefined,
      timeout: Number(inst.timeoutMs || inst.timeout || 8000),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > Number(opts.maxBytes || 1024 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        }
        if (!data.trim()) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from firewall API')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

async function call(inst, path, opts = {}) {
  return httpJson(cleanBaseUrl(inst.url) + apiPath(path), inst, opts);
}

async function optionalCall(inst, paths, opts = {}) {
  const errors = [];
  for (const path of paths) {
    try { return { ok: true, path, data: await call(inst, path, opts) }; }
    catch (err) { errors.push(`${path}: ${err.message}`); }
  }
  return { ok: false, error: errors[0] || 'not available' };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, keys) {
  for (const key of keys) {
    const parts = String(key).split('.');
    let cur = obj;
    for (const part of parts) cur = cur && cur[part] != null ? cur[part] : undefined;
    if (cur != null && cur !== '') return cur;
  }
  return null;
}

function percentFromPair(used, total) {
  used = num(used);
  total = num(total);
  if (used == null || total == null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10));
}

function normalizeSystem(info = {}, resources = {}, memory = {}, firmware = {}) {
  const memUsed = pick(memory, ['used', 'memory.used', 'memory.active', 'physmem.used']);
  const memTotal = pick(memory, ['total', 'memory.total', 'physmem.total']);
  return {
    hostname: pick(info, ['hostname', 'name', 'system.hostname', 'system.name']) || '',
    version: pick(info, ['version', 'product.version', 'system.version']) || pick(firmware, ['product_version', 'version', 'product.product_version']) || '',
    uptime: pick(info, ['uptime', 'system.uptime', 'uptime_seconds']) || pick(resources, ['uptime', 'uptime_seconds']) || null,
    cpuPercent: num(pick(resources, ['cpu', 'cpu_percent', 'cpu.usage', 'load.cpu'])),
    memoryPercent: num(pick(resources, ['memory', 'memory_percent', 'memory.usage'])) ?? percentFromPair(memUsed, memTotal),
    diskPercent: num(pick(resources, ['disk', 'disk_percent', 'disk.usage'])),
    updateCount: num(pick(firmware, ['updates', 'update_count', 'packages.updates'])),
    rebootRequired: ['1', 'true', true, 1].includes(pick(firmware, ['upgrade_needs_reboot', 'reboot_required'])),
  };
}

function normalizeInterfaces(stats = {}, names = {}, config = {}) {
  const source = Array.isArray(stats) ? stats
    : Array.isArray(stats.rows) ? stats.rows
    : Array.isArray(stats.interfaces) ? stats.interfaces
    : Object.entries(stats || {}).map(([key, value]) => ({ id: key, name: key, ...(value || {}) }));
  const labelMap = names && typeof names === 'object' ? names : {};
  const cfgMap = config && typeof config === 'object' ? config : {};
  return source.map(row => {
    const id = row.id || row.interface || row.if || row.name || row.descr || '';
    const cfg = cfgMap[id] || cfgMap[row.name] || {};
    return {
      id,
      name: row.name || row.descr || labelMap[id] || id,
      description: row.description || cfg.description || cfg.descr || '',
      status: String(row.status || row.link_state || row.link || cfg.status || '').toLowerCase(),
      address: row.address || row.ipaddr || cfg.ipaddr || cfg.address || '',
      inBytes: num(row.inbytes ?? row.bytes_in ?? row.input_bytes ?? row.rx_bytes),
      outBytes: num(row.outbytes ?? row.bytes_out ?? row.output_bytes ?? row.tx_bytes),
      inPackets: num(row.inpkts ?? row.packets_in ?? row.rx_packets),
      outPackets: num(row.outpkts ?? row.packets_out ?? row.tx_packets),
    };
  }).filter(row => row.id || row.name).slice(0, 32);
}

function normalizeFirewallStats(stats = {}, pfStates = {}) {
  return {
    states: num(pick(pfStates, ['current', 'states', 'entries', 'count'])) ?? num(pick(stats, ['states', 'state_count', 'pf.states'])),
    maxStates: num(pick(pfStates, ['max', 'maximum', 'limit'])) ?? num(pick(stats, ['max_states', 'pf.max_states'])),
    packets: num(pick(stats, ['packets', 'pf.packets'])),
    bytes: num(pick(stats, ['bytes', 'pf.bytes'])),
  };
}

async function getOpnsenseInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  if (!inst.url) throw new Error('Firewall URL is required');
  const [firmware, systemInfo, resources, memory, ifStats, ifNames, ifConfig, fwStats, pfStates] = await Promise.all([
    optionalCall(inst, ['/core/firmware/status', '/core/firmware/info']),
    optionalCall(inst, ['/diagnostics/system/system_information']),
    optionalCall(inst, ['/diagnostics/system/system_resources']),
    optionalCall(inst, ['/diagnostics/system/memory']),
    optionalCall(inst, ['/diagnostics/interface/get_interface_statistics']),
    optionalCall(inst, ['/diagnostics/interface/get_interface_names']),
    optionalCall(inst, ['/diagnostics/interface/get_interface_config']),
    optionalCall(inst, ['/diagnostics/firewall/stats', '/diagnostics/firewall/pf_statistics']),
    optionalCall(inst, ['/diagnostics/firewall/pf_states']),
  ]);
  const identityOk = firmware.ok || systemInfo.ok || resources.ok;
  if (!identityOk) throw new Error(firmware.error || systemInfo.error || resources.error || 'Firewall API unavailable');
  const system = normalizeSystem(systemInfo.data, resources.data, memory.data, firmware.data);
  const interfaces = normalizeInterfaces(ifStats.data, ifNames.data, ifConfig.data);
  const fw = normalizeFirewallStats(fwStats.data, pfStates.data);
  const errors = [firmware, systemInfo, resources, memory, ifStats, ifNames, ifConfig, fwStats, pfStates]
    .filter(r => !r.ok)
    .map(r => r.error)
    .filter(Boolean);
  const onlineInterfaces = interfaces.filter(i => ['up', 'active', '1', 'true'].includes(String(i.status).toLowerCase())).length;
  return {
    online: true,
    type: inst.type || 'opnsense',
    name: inst.name,
    url: inst.url,
    system,
    firewall: fw,
    interfaces,
    summary: {
      interfaces: interfaces.length,
      interfacesUp: onlineInterfaces,
      interfacesDown: Math.max(0, interfaces.length - onlineInterfaces),
      states: fw.states,
      updates: system.updateCount,
      rebootRequired: system.rebootRequired,
    },
    partial: errors.length > 0,
    errors: errors.slice(0, 4),
  };
}

async function getFirewallInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx), type: String(config.type || 'opnsense').toLowerCase() };
  try {
    return await getOpnsenseInstance(inst, idx);
  } catch (err) {
    return {
      online: false,
      type: inst.type,
      name: inst.name,
      url: inst.url || '',
      error: err.message,
      system: {},
      firewall: {},
      interfaces: [],
      summary: { interfaces: 0, interfacesUp: 0, interfacesDown: 0, states: null, updates: null, rebootRequired: false },
    };
  }
}

async function getAllFirewallData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) {
    return { online: false, error: 'No firewall instances configured', summary: { instances: 0, up: 0, down: 0, interfaces: 0, interfacesUp: 0, interfacesDown: 0, updates: 0, rebootRequired: 0 }, instances: [] };
  }
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 3), getFirewallInstance);
  const summary = {
    instances: rows.length,
    up: rows.filter(r => r.online).length,
    down: rows.filter(r => !r.online).length,
    interfaces: rows.reduce((a, r) => a + Number(r.summary?.interfaces || 0), 0),
    interfacesUp: rows.reduce((a, r) => a + Number(r.summary?.interfacesUp || 0), 0),
    interfacesDown: rows.reduce((a, r) => a + Number(r.summary?.interfacesDown || 0), 0),
    updates: rows.reduce((a, r) => a + Number(r.summary?.updates || 0), 0),
    rebootRequired: rows.filter(r => r.summary?.rebootRequired).length,
  };
  const firstError = rows.find(r => !r.online)?.error || '';
  return { online: summary.up > 0, error: firstError, summary, instances: rows };
}

module.exports = { getAllFirewallData, configuredInstances };
