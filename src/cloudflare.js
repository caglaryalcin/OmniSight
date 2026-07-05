const https = require('https');
const { mapLimit } = require('./concurrency');

const API_BASE = 'https://api.cloudflare.com/client/v4';

function tokenValue(config = {}) {
  return config.apiToken || config.token || config.bearerToken || '';
}

function timeoutMs(config = {}) {
  const n = Number(config.timeoutMs || config.timeout || 10000);
  return Math.max(2000, Math.min(60000, Number.isFinite(n) ? n : 10000));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function arr(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function boolDefault(value, fallback) {
  return value === undefined ? fallback : value !== false;
}

function daysUntil(value) {
  const t = Date.parse(value || '');
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

function configured(config = {}) {
  return !!(config && config.enabled !== false && tokenValue(config));
}

function appendQuery(path, params = {}) {
  const url = new URL(API_BASE + (String(path || '').startsWith('/') ? path : '/' + path));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

function cfJson(path, config = {}, params = {}) {
  return new Promise((resolve, reject) => {
    const token = tokenValue(config);
    if (!token) return reject(new Error('Cloudflare API token is required'));
    const url = appendQuery(path, params);
    const req = https.request(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      timeout: timeoutMs(config),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > Number(config.maxResponseBytes || 2 * 1024 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
        }
        let json;
        try { json = data.trim() ? JSON.parse(data) : {}; }
        catch { return reject(new Error('Invalid JSON from Cloudflare API')); }
        if (json.success === false) {
          const msg = arr(json.errors).map(e => e.message || e.code).filter(Boolean).join('; ');
          return reject(new Error(msg || 'Cloudflare API request failed'));
        }
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function listPaged(path, config = {}, params = {}, opts = {}) {
  const maxPages = Math.max(1, Math.min(Number(opts.maxPages || config.maxPages || 5), 20));
  const perPage = Math.max(1, Math.min(Number(opts.perPage || params.per_page || 50), 100));
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const json = await cfJson(path, config, { ...params, page, per_page: perPage });
    out.push(...arr(json.result));
    const info = json.result_info || {};
    const totalPages = Number(info.total_pages || 0);
    if (!totalPages || page >= totalPages) break;
  }
  return out;
}

async function listCursorPaged(path, config = {}, params = {}, opts = {}) {
  const maxPages = Math.max(1, Math.min(Number(opts.maxPages || config.maxPages || 5), 20));
  const perPage = Math.max(1, Math.min(Number(opts.perPage || params.per_page || 50), 100));
  const out = [];
  let cursor = '';
  for (let page = 1; page <= maxPages; page += 1) {
    const query = { ...params, per_page: perPage };
    if (cursor) query.cursor = cursor;
    const json = await cfJson(path, config, query);
    out.push(...arr(json.result));
    const next = String(json.result_info?.cursor || '').trim();
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

function zoneFilters(config = {}) {
  const values = Array.isArray(config.zones) ? config.zones : (config.zone ? [config.zone] : []);
  return values.map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
}

function zoneAllowed(zone = {}, filters = []) {
  if (!filters.length) return true;
  const vals = [zone.id, zone.name].map(v => String(v || '').toLowerCase()).filter(Boolean);
  return filters.some(f => vals.includes(f));
}

function normalizeZone(row = {}) {
  const status = String(row.status || '').toLowerCase();
  const paused = row.paused === true;
  return {
    id: row.id || '',
    name: row.name || row.original_name || row.id || 'zone',
    status: status || 'unknown',
    paused,
    plan: row.plan?.name || row.plan?.legacy_id || '',
    accountName: row.account?.name || '',
    nameServers: Array.isArray(row.name_servers) ? row.name_servers.slice(0, 4) : [],
    createdOn: row.created_on || '',
    modifiedOn: row.modified_on || '',
    online: status === 'active' && !paused,
    warn: paused || (status && status !== 'active'),
  };
}

function normalizeConnection(row = {}) {
  const active = row.is_pending_reconnect === false || /active|connected/i.test(String(row.status || ''));
  return {
    id: row.id || row.uuid || '',
    coloName: row.colo_name || row.coloName || '',
    originIp: row.origin_ip || row.originIp || '',
    openedAt: row.opened_at || row.openedAt || '',
    isPendingReconnect: row.is_pending_reconnect === true,
    active,
  };
}

function normalizeTunnel(row = {}, connections = []) {
  const status = String(row.status || '').toLowerCase();
  const conns = arr(connections).map(normalizeConnection);
  const activeConnections = conns.filter(c => c.active).length;
  const pendingReconnect = conns.filter(c => c.isPendingReconnect).length;
  const online = ['healthy', 'active', 'open'].includes(status) || activeConnections > 0;
  return {
    id: row.id || row.uuid || '',
    name: row.name || row.id || 'tunnel',
    status: status || (online ? 'active' : 'unknown'),
    createdAt: row.created_at || row.createdAt || '',
    deletedAt: row.deleted_at || row.deletedAt || '',
    connections: conns,
    activeConnections,
    pendingReconnect,
    online,
  };
}

function normalizeRegistrarDomain(row = {}, config = {}) {
  const expiresAt = row.expires_at || row.expiresAt || '';
  const daysToExpire = daysUntil(expiresAt);
  const warnDays = Math.max(1, Number(config.domainExpiryWarningDays || 30));
  const name = row.domain_name || row.domainName || row.name || row.fqdn || row.id || 'domain';
  return {
    id: row.id || name,
    name,
    currentRegistrar: row.current_registrar || row.currentRegistrar || '',
    expiresAt,
    daysToExpire,
    autoRenew: row.auto_renew === true || row.autoRenew === true,
    locked: row.locked === true,
    available: row.available,
    canRegister: row.can_register,
    expired: daysToExpire !== null && daysToExpire < 0,
    expiring: daysToExpire !== null && daysToExpire >= 0 && daysToExpire <= warnDays,
  };
}

function summarize(zones = [], tunnels = [], domains = [], errors = []) {
  return {
    zones: zones.length,
    zonesActive: zones.filter(z => z.online).length,
    zonesPaused: zones.filter(z => z.paused).length,
    zonesPending: zones.filter(z => z.status === 'pending').length,
    zonesWarn: zones.filter(z => z.warn).length,
    tunnels: tunnels.length,
    tunnelsHealthy: tunnels.filter(t => t.online).length,
    tunnelsDown: tunnels.filter(t => !t.online).length,
    domains: domains.length,
    domainsExpiring: domains.filter(d => d.expiring).length,
    domainsExpired: domains.filter(d => d.expired).length,
    domainsAutoRenew: domains.filter(d => d.autoRenew).length,
    errors: errors.length,
  };
}

async function optional(path, config, params, label) {
  try {
    const json = await cfJson(path, config, params);
    return { ok: true, data: json.result };
  } catch (err) {
    return { ok: false, error: `${label || path}: ${err.message}` };
  }
}

async function optionalFirst(paths = [], config, params, label) {
  let lastError = '';
  for (const path of paths) {
    const res = await optional(path, config, params, label);
    if (res.ok) return res;
    lastError = res.error;
  }
  return { ok: false, error: lastError || `${label || paths[0]}: request failed` };
}

async function listTunnels(config = {}) {
  const accountId = encodeURIComponent(config.accountId);
  try {
    return await listPaged(`/accounts/${accountId}/tunnels`, config, {}, {
      maxPages: config.tunnelMaxPages || 3,
      perPage: config.tunnelPerPage || 50,
    });
  } catch (err) {
    if (config.disableLegacyTunnelEndpoint === true) throw err;
    return listPaged(`/accounts/${accountId}/cfd_tunnel`, config, {}, {
      maxPages: config.tunnelMaxPages || 3,
      perPage: config.tunnelPerPage || 50,
    });
  }
}

async function listRegistrarDomains(config = {}) {
  const accountId = encodeURIComponent(config.accountId);
  try {
    const rows = await listCursorPaged(`/accounts/${accountId}/registrar/registrations`, config, {}, {
      maxPages: config.domainMaxPages || 5,
      perPage: config.domainPerPage || 50,
    });
    if (rows.length || config.disableLegacyRegistrarEndpoint === true) return rows;
  } catch (err) {
    if (config.disableLegacyRegistrarEndpoint === true) throw err;
  }
  return listPaged(`/accounts/${accountId}/registrar/domains`, config, {}, {
    maxPages: config.domainMaxPages || 5,
    perPage: config.domainPerPage || 50,
  });
}

async function getCloudflareData(config = {}) {
  config = config || {};
  if (!tokenValue(config)) {
    return { online: false, error: 'No Cloudflare API token configured', summary: summarize(), zones: [], tunnels: [], domains: [] };
  }

  const errors = [];
  const filters = zoneFilters(config);
  const zonesRaw = await listPaged('/zones', config, config.accountId ? { 'account.id': config.accountId } : {}, {
    maxPages: config.zoneMaxPages || 5,
    perPage: config.zonePerPage || 50,
  });
  const zones = zonesRaw.map(normalizeZone).filter(z => zoneAllowed(z, filters));

  let tunnels = [];
  if (config.accountId && boolDefault(config.includeTunnels, true)) {
    try {
      const rows = await listTunnels(config);
      const selected = rows.slice(0, Number(config.tunnelConnectionLimit || 50));
      tunnels = await mapLimit(selected, Number(config.tunnelConcurrency || 3), async row => {
        const tunnelId = encodeURIComponent(row.id || row.uuid);
        const accountId = encodeURIComponent(config.accountId);
        const res = await optionalFirst([
          `/accounts/${accountId}/tunnels/${tunnelId}/connections`,
          `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`,
        ], config, {}, `Tunnel ${row.name || row.id}`);
        if (!res.ok) errors.push(res.error);
        return normalizeTunnel(row, res.ok ? res.data : []);
      });
    } catch (err) {
      errors.push(`Tunnels: ${err.message}`);
    }
  }

  let domains = [];
  if (config.accountId && boolDefault(config.includeRegistrarDomains, true)) {
    try {
      const rows = await listRegistrarDomains(config);
      const zoneNameSet = new Set(zones.map(z => String(z.name || '').toLowerCase()).filter(Boolean));
      domains = rows
        .map(row => normalizeRegistrarDomain(row, config))
        .filter(domain => !filters.length || zoneNameSet.has(String(domain.name || '').toLowerCase()) || zoneAllowed({ id: domain.id, name: domain.name }, filters));
    } catch (err) {
      errors.push(`Registrar domains: ${err.message}`);
    }
  }

  const summary = summarize(zones, tunnels, domains, errors);
  const online = zones.length > 0 || tunnels.length > 0 || domains.length > 0;
  return {
    online,
    error: online ? errors[0] || '' : errors[0] || 'No Cloudflare resources found',
    partial: errors.length > 0,
    errors: errors.slice(0, 8),
    summary,
    zones,
    tunnels,
    domains,
  };
}

module.exports = { getCloudflareData, configured };
