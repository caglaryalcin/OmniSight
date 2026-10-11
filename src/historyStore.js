const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Worker } = require('worker_threads');

const DATA_DIR = path.join(__dirname, '..', 'data');
const timers = new Map();
const pending = new Map();
let defaultSaveDelay = 2500;
const SLOW_SAVE_MS = Math.max(250, Number(process.env.OMNISIGHT_HISTORY_SLOW_SAVE_MS || 750));
const USE_HISTORY_WORKER = !['1', 'true', 'yes', 'on'].includes(String(process.env.OMNISIGHT_DISABLE_HISTORY_WORKER || '').toLowerCase());
const HISTORY_POINT_INTERVAL_MS = 15000;
const HISTORY_RAW_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_ARCHIVE_BUCKET_MS = 5 * 60 * 1000;
let historyWorker = null;
let historyWorkerFailed = false;
let configuredRetentionDays = 1;

function normalizeHistoryRetentionDays(value) {
  const days = Number(value || 1);
  if (days <= 1) return 1;
  if (days <= 7) return 7;
  return 30;
}

function setHistoryRetentionDays(value) {
  configuredRetentionDays = normalizeHistoryRetentionDays(value);
  return configuredRetentionDays;
}

function historyStorageMaxPoints(days = configuredRetentionDays) {
  const retentionDays = normalizeHistoryRetentionDays(days);
  const rawPoints = Math.ceil(HISTORY_RAW_WINDOW_MS / HISTORY_POINT_INTERVAL_MS);
  const archivePoints = Math.ceil(Math.max(0, retentionDays - 1) * 24 * 60 * 60 * 1000 / HISTORY_ARCHIVE_BUCKET_MS);
  return rawPoints + archivePoints + 2;
}

function historyPointTime(point) {
  const raw = point?.time;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 1e11 ? numeric : numeric * 1000;
  const parsed = new Date(raw || 0).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function historyPointSeverity(point = {}) {
  if (point.up === false || Number(point.up) === 0 || point.healthy === false) return 0;
  const status = String(point.status ?? point.health ?? '').trim().toLowerCase();
  const statusSeverity = {
    down: 0,
    offline: 0,
    failed: 0,
    error: 0,
    critical: 0,
    warning: 1,
    warn: 1,
    degraded: 1,
    unknown: 2,
    pending: 2,
    maintenance: 2,
    up: 3,
    online: 3,
    ok: 3,
    healthy: 3,
    success: 3,
  }[status];
  if (Number.isFinite(statusSeverity)) return statusSeverity;
  const health = Number(point.health);
  if (Number.isFinite(health)) return 4 + Math.max(0, Math.min(100, health)) / 100;
  if (point.up === true || Number(point.up) === 1 || point.healthy === true) return 3;
  return Number.POSITIVE_INFINITY;
}

function archiveRepresentative(previous, candidate) {
  if (!previous) return candidate;
  const previousSeverity = historyPointSeverity(previous.point);
  const candidateSeverity = historyPointSeverity(candidate.point);
  return candidateSeverity < previousSeverity ? candidate : candidateSeverity > previousSeverity ? previous : candidate;
}

// Keep the most recent day at the native 15-second resolution. Older data is
// represented by one point in each five-minute bucket. The worst explicit
// health/status sample wins so brief outages are not hidden; otherwise the
// last sample wins. A seven-day view adds only ~30% more stored points instead
// of multiplying storage by 7.
function compactHistorySeries(series = [], options = {}) {
  if (!Array.isArray(series) || !series.length) return [];
  const days = normalizeHistoryRetentionDays(options.days ?? configuredRetentionDays);
  const newestPointTime = historyPointTime(series[series.length - 1]);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now)
    : Number.isFinite(newestPointTime) && newestPointTime > Date.now() ? newestPointTime
    : Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const rawCutoff = now - HISTORY_RAW_WINDOW_MS;
  const archived = new Map();
  const recent = [];
  for (const point of series) {
    const time = historyPointTime(point);
    if (!Number.isFinite(time) || time < cutoff || time > now + HISTORY_POINT_INTERVAL_MS * 2) continue;
    if (time >= rawCutoff || days === 1) {
      recent.push({ point, time });
    } else {
      const bucket = Math.floor(time / HISTORY_ARCHIVE_BUCKET_MS);
      archived.set(bucket, archiveRepresentative(archived.get(bucket), { point, time }));
    }
  }
  const rows = [...archived.values(), ...recent]
    .sort((a, b) => a.time - b.time)
    .map(row => row.point);
  return rows.slice(-historyStorageMaxPoints(days));
}

function appendHistoryPoint(series = [], point, options = {}) {
  return compactHistorySeries([...(Array.isArray(series) ? series : []), point], options);
}

function filePath(name) {
  return path.join(DATA_DIR, `${name}.yaml`);
}

function trimSeries(series = [], max = 5760) {
  return Array.isArray(series) ? series.slice(-max) : [];
}

function loadHistoryMap(name, max = 5760) {
  try {
    const raw = yaml.load(fs.readFileSync(filePath(name), 'utf8')) || {};
    const rows = raw.items && typeof raw.items === 'object' ? raw.items : raw;
    const map = new Map();
    for (const [key, series] of Object.entries(rows || {})) {
      map.set(key, trimSeries(series, max));
    }
    return map;
  } catch {
    return new Map();
  }
}

function historyItems(map, max = 5760) {
  const items = {};
  for (const [key, series] of map) {
    if (Array.isArray(series) && series.length) items[key] = compactHistorySeries(trimSeries(series, max));
  }
  return items;
}

function saveHistoryItemsSync(name, items) {
  try {
    const start = Date.now();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(filePath(name), yaml.dump({ items }, { lineWidth: -1 }), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath(name), 0o600); } catch {}
    const ms = Date.now() - start;
    if (ms >= SLOW_SAVE_MS) console.warn(`[history] ${name} save ${ms}ms items=${Object.keys(items).length}`);
  } catch (e) {
    console.warn(`${name} history save failed:`, e.message);
  }
}

function getHistoryWorker() {
  if (!USE_HISTORY_WORKER || historyWorkerFailed) return null;
  if (historyWorker) return historyWorker;
  try {
    historyWorker = new Worker(path.join(__dirname, 'historyWorker.js'));
    historyWorker.on('message', msg => {
      if (!msg?.ok) {
        console.warn(`${msg?.name || 'history'} history save failed:`, msg?.error || 'worker error');
        return;
      }
      if (Number(msg.ms || 0) >= SLOW_SAVE_MS) {
        console.warn(`[history] ${msg.name} save ${msg.ms}ms items=${msg.count} worker=true`);
      }
    });
    historyWorker.on('error', err => {
      historyWorkerFailed = true;
      historyWorker = null;
      console.warn('history worker failed:', err?.message || err);
    });
    historyWorker.on('exit', code => {
      historyWorker = null;
      if (code) {
        historyWorkerFailed = true;
        console.warn(`history worker exited with code ${code}`);
      }
    });
    historyWorker.unref?.();
  } catch (err) {
    historyWorkerFailed = true;
    console.warn('history worker unavailable:', err?.message || err);
  }
  return historyWorker;
}

function saveHistoryMap(name, map, max = 5760, options = {}) {
  const items = historyItems(map, max);
  if (options.sync) return saveHistoryItemsSync(name, items);
  const worker = getHistoryWorker();
  if (!worker) return saveHistoryItemsSync(name, items);
  try {
    worker.postMessage({ name, items });
  } catch (err) {
    console.warn('history worker post failed:', err?.message || err);
    saveHistoryItemsSync(name, items);
  }
}

function scheduleSaveHistoryMap(name, map, max = 5760, delay = defaultSaveDelay) {
  pending.set(name, { map, max });
  if (timers.has(name)) return;
  timers.set(name, setTimeout(() => {
    timers.delete(name);
    const next = pending.get(name) || { map, max };
    pending.delete(name);
    saveHistoryMap(name, next.map, next.max);
  }, delay));
}

function setHistorySaveDelay(delay) {
  const n = Number(delay);
  if (Number.isFinite(n) && n >= 1000) defaultSaveDelay = Math.min(n, 5 * 60 * 1000);
}

function flushHistorySaves() {
  for (const [name, timer] of [...timers.entries()]) {
    clearTimeout(timer);
    timers.delete(name);
    const next = pending.get(name);
    pending.delete(name);
    if (next) saveHistoryMap(name, next.map, next.max, { sync: true });
  }
}

function cancelHistorySaves(names) {
  const wanted = names ? new Set(Array.isArray(names) ? names : [names]) : null;
  const keys = wanted ? [...wanted] : [...new Set([...timers.keys(), ...pending.keys()])];
  for (const name of keys) {
    const timer = timers.get(name);
    if (timer) clearTimeout(timer);
    timers.delete(name);
    pending.delete(name);
  }
}

module.exports = {
  loadHistoryMap,
  saveHistoryMap,
  scheduleSaveHistoryMap,
  setHistorySaveDelay,
  flushHistorySaves,
  cancelHistorySaves,
  trimSeries,
  normalizeHistoryRetentionDays,
  setHistoryRetentionDays,
  historyStorageMaxPoints,
  compactHistorySeries,
  appendHistoryPoint,
};
