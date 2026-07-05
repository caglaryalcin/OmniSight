const https = require('https');
const http = require('http');

function httpGet(url, headers, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers, rejectUnauthorized: opts.insecureTLS ? false : undefined }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); }
        catch { return reject(new Error('Invalid JSON from Healthchecks')); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = body?.detail || body?.error || body?.message || res.statusMessage || `HTTP ${res.statusCode}`;
          return reject(new Error(`Healthchecks API ${res.statusCode}: ${detail}`));
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const STATUS_ORDER = { down: 0, grace: 1, new: 2, up: 3, paused: 4 };

function cleanUrlPart(value) {
  return String(value || '').trim().replace(/^\/+|\/+$/g, '');
}

function joinPingUrl(base, ...parts) {
  const cleanBase = String(base || '').trim().replace(/\/+$/g, '');
  const cleanParts = parts.map(cleanUrlPart).filter(Boolean);
  return cleanBase && cleanParts.length ? `${cleanBase}/${cleanParts.join('/')}` : '';
}

function defaultPingBaseUrl(config) {
  const explicit = config.pingBaseUrl || config.pingUrlBase || config.pingEndpoint;
  if (explicit) return String(explicit).trim();
  try {
    const parsed = new URL(config.url);
    if (parsed.hostname === 'healthchecks.io' || parsed.hostname.endsWith('.healthchecks.io')) {
      return 'https://hc-ping.com';
    }
    return `${parsed.origin}/ping`;
  } catch {
    return '';
  }
}

function checkPingUrl(config, check) {
  const direct = check.ping_url || check.pingUrl;
  if (direct) return direct;
  const base = defaultPingBaseUrl(config);
  const uuid = check.uuid || check.id;
  if (uuid) return joinPingUrl(base, uuid);
  if (config.pingKey && check.slug) return joinPingUrl(base, config.pingKey, check.slug);
  return null;
}

async function getAllHealthchecks(config) {
  try {
    const url = config.url.replace(/\/$/, '') + '/api/v3/checks/';
    const data = await httpGet(url, { 'X-Api-Key': config.apiKey }, { insecureTLS: config.insecureTLS === true });
    if (!data || !Array.isArray(data.checks)) {
      const detail = data?.detail || data?.error || data?.message || 'response did not include checks';
      throw new Error(`Invalid Healthchecks response: ${detail}`);
    }
    const checks = data.checks.map(c => {
      const pingUrl = checkPingUrl(config, c);
      return {
        name: c.name,
        status: c.status,
        healthy: c.status === 'up',
        down: c.status === 'down',
        grace: c.status === 'grace',
        paused: c.status === 'paused',
        lastPing: c.last_ping || null,
        periodSec: c.timeout ?? null,
        graceSec: c.grace ?? null,
        project: c.project || c.project_name || c.projectName || c.project_slug || '',
        description: c.desc || c.description || '',
        totalPings: c.n_pings ?? c.total_pings ?? c.totalPings ?? c.pings ?? null,
        tags: c.tags || '',
        slug: c.slug || null,
        uuid: c.uuid || c.id || null,
        uniqueKey: c.unique_key || c.uniqueKey || null,
        pingUrl,
        pingUrlHint: pingUrl ? '' : 'Use a full API key, or set Ping Base URL and Ping Key in Settings.',
      };
    });

    checks.sort((a, b) => (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5));

    const summary = {
      total: checks.length,
      up: checks.filter(c => c.status === 'up').length,
      down: checks.filter(c => c.status === 'down').length,
      grace: checks.filter(c => c.status === 'grace').length,
      paused: checks.filter(c => c.status === 'paused').length,
    };

    return { online: true, summary, checks };
  } catch (err) {
    return { online: false, error: err.message, summary: { total: 0, up: 0, down: 0, grace: 0, paused: 0 }, checks: [] };
  }
}

module.exports = { getAllHealthchecks };
