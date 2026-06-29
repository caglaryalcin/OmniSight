const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DATA_DIR = path.join(__dirname, '..', 'data');
const timers = new Map();
const pending = new Map();
let defaultSaveDelay = 2500;
const SLOW_SAVE_MS = Math.max(250, Number(process.env.OMNISIGHT_HISTORY_SLOW_SAVE_MS || 750));

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

function saveHistoryMap(name, map, max = 5760) {
  try {
    const start = Date.now();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const items = {};
    for (const [key, series] of map) {
      if (Array.isArray(series) && series.length) items[key] = trimSeries(series, max);
    }
    fs.writeFileSync(filePath(name), yaml.dump({ items }, { lineWidth: -1 }), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath(name), 0o600); } catch {}
    const ms = Date.now() - start;
    if (ms >= SLOW_SAVE_MS) console.warn(`[history] ${name} save ${ms}ms items=${Object.keys(items).length}`);
  } catch (e) {
    console.warn(`${name} history save failed:`, e.message);
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
    if (next) saveHistoryMap(name, next.map, next.max);
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

module.exports = { loadHistoryMap, saveHistoryMap, scheduleSaveHistoryMap, setHistorySaveDelay, flushHistorySaves, cancelHistorySaves, trimSeries };
