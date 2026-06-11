const http = require('http');
const https = require('https');

function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}

function httpGetJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = {};
    if (opts.bearerToken) headers.Authorization = `Bearer ${opts.bearerToken}`;
    const req = lib.get(url, {
      headers,
      rejectUnauthorized: opts.insecureTLS ? false : undefined,
      timeout: opts.timeout || 10000,
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 140)}`));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Prometheus')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

function targetName(t = {}) {
  return t.labels?.instance || t.discoveredLabels?.__address__ || t.scrapeUrl || t.globalUrl || 'target';
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `Prometheus ${idx + 1}`).trim();
}

function configuredInstances(config = {}) {
  if (Array.isArray(config.instances) && config.instances.length) {
    return config.instances
      .filter(i => i && (i.url || i.name))
      .map((i, idx) => ({ ...i, name: instanceName(i, idx) }));
  }
  if (config.url) return [{ ...config, name: instanceName(config, 0) }];
  return [];
}

function normalizeTarget(t = {}, source = {}) {
  const health = String(t.health || 'unknown').toLowerCase();
  const labels = t.labels || {};
  return {
    name: targetName(t),
    sourceName: source.name || '',
    sourceUrl: source.url || '',
    job: labels.job || t.scrapePool || '',
    scrapePool: t.scrapePool || labels.job || '',
    scrapeUrl: t.scrapeUrl || t.globalUrl || '',
    health: ['up', 'down', 'unknown'].includes(health) ? health : 'unknown',
    lastScrape: t.lastScrape || null,
    lastScrapeDuration: Number.isFinite(Number(t.lastScrapeDuration)) ? Number(t.lastScrapeDuration) : null,
    lastError: t.lastError || '',
    labels,
  };
}

async function getPrometheusInstance(config = {}, idx = 0) {
  const source = { ...config, name: instanceName(config, idx) };
  try {
    if (!source.url) throw new Error('Prometheus URL is required');
    const url = joinUrl(source.url, '/api/v1/targets?state=active');
    const body = await httpGetJson(url, source);
    if (body.status && body.status !== 'success') throw new Error(body.error || body.status);
    const targets = (body.data?.activeTargets || []).map(t => normalizeTarget(t, source))
      .sort((a, b) => {
        const order = { down: 0, unknown: 1, up: 2 };
        return (order[a.health] ?? 3) - (order[b.health] ?? 3)
          || String(a.job).localeCompare(String(b.job))
          || String(a.name).localeCompare(String(b.name));
      });
    const summary = {
      total: targets.length,
      up: targets.filter(t => t.health === 'up').length,
      down: targets.filter(t => t.health === 'down').length,
      unknown: targets.filter(t => t.health === 'unknown').length,
    };
    return { online: true, name: source.name, url: source.url, summary, targets };
  } catch (err) {
    console.warn(`Prometheus refresh failed (${source.name || source.url || idx + 1}):`, err.message);
    return { online: false, name: source.name, url: source.url, error: err.message, summary: { total: 0, up: 0, down: 0, unknown: 0 }, targets: [] };
  }
}

async function getPrometheusData(config = {}) {
  const instances = configuredInstances(config);
  if (!instances.length) {
    return { online: false, error: 'Prometheus URL is required', summary: { instances: 0, instanceUp: 0, instanceDown: 0, total: 0, up: 0, down: 0, unknown: 0 }, instances: [], targets: [] };
  }
  const rows = await Promise.all(instances.map(getPrometheusInstance));
  const targets = rows.flatMap(r => r.targets || []).sort((a, b) => {
    const order = { down: 0, unknown: 1, up: 2 };
    return (order[a.health] ?? 3) - (order[b.health] ?? 3)
      || String(a.sourceName).localeCompare(String(b.sourceName))
      || String(a.job).localeCompare(String(b.job))
      || String(a.name).localeCompare(String(b.name));
  });
  const summary = {
    instances: rows.length,
    instanceUp: rows.filter(r => r.online).length,
    instanceDown: rows.filter(r => !r.online).length,
    total: targets.length,
    up: targets.filter(t => t.health === 'up').length,
    down: targets.filter(t => t.health === 'down').length,
    unknown: targets.filter(t => t.health === 'unknown').length,
  };
  const firstError = rows.find(r => !r.online)?.error || '';
  return { online: summary.instanceUp > 0, error: firstError, summary, instances: rows.map(({ targets: _targets, ...r }) => r), targets };
}

module.exports = { getPrometheusData };
