const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function instanceName(config = {}, idx = 0) {
  return String(config.name || config.label || config.url || `Ugreen ${idx + 1}`).trim();
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
  const n = Number(inst.timeoutMs || inst.timeout || 8000);
  return Math.max(2000, Math.min(60000, Number.isFinite(n) ? n : 8000));
}

function httpProbe(url, inst = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP(S) URLs are supported'));
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, {
      method: 'GET',
      headers: { Accept: 'text/html, application/json, */*' },
      rejectUnauthorized: inst.insecureTLS ? false : undefined,
      timeout: timeoutMs(inst),
    }, res => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, statusMessage: res.statusMessage || '' }));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end();
  });
}

function summarize(instances = []) {
  return {
    instances: instances.length,
    up: instances.filter(i => i.online).length,
    down: instances.filter(i => !i.online).length,
  };
}

async function getUgreenInstance(config = {}, idx = 0) {
  const inst = { ...config, name: instanceName(config, idx) };
  if (!inst.url) throw new Error('Ugreen URL is required');
  const probe = await httpProbe(cleanBaseUrl(inst.url), inst);
  const online = probe.statusCode >= 200 && probe.statusCode < 500;
  if (!online) throw new Error(`HTTP ${probe.statusCode || 0}: ${probe.statusMessage || 'unreachable'}`);
  return {
    online: true,
    name: inst.name,
    url: inst.url,
    statusCode: probe.statusCode,
    system: { hostname: inst.name },
    summary: summarize([{ online: true }]),
  };
}

async function getAllUgreenData(config = {}) {
  config = config || {};
  const instances = configuredInstances(config);
  if (!instances.length) return { online: false, error: 'No Ugreen instances configured', summary: summarize([]), instances: [] };
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 3), async (inst, idx) => {
    try { return await getUgreenInstance(inst, idx); }
    catch (err) {
      return { online: false, name: inst.name, url: inst.url || '', error: err.message, system: {}, summary: summarize([]) };
    }
  });
  const summary = summarize(rows);
  return { online: summary.up > 0, error: rows.find(r => !r.online)?.error || '', summary, instances: rows };
}

module.exports = { getAllUgreenData, configuredInstances };
