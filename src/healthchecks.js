const https = require('https');
const http = require('http');

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Healthchecks')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const STATUS_ORDER = { down: 0, grace: 1, new: 2, up: 3, paused: 4 };

async function getAllHealthchecks(config) {
  try {
    const url = config.url.replace(/\/$/, '') + '/api/v3/checks/';
    const data = await httpGet(url, { 'X-Api-Key': config.apiKey });
    const checks = (data.checks || []).map(c => ({
      name: c.name,
      status: c.status,
      healthy: c.status === 'up',
      down: c.status === 'down',
      grace: c.status === 'grace',
      paused: c.status === 'paused',
      lastPing: c.last_ping || null,
      periodSec: c.timeout ?? null,
      graceSec: c.grace ?? null,
      tags: c.tags || '',
      slug: c.slug || null,
    }));

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
