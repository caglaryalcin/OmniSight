const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DATA_DIR = path.join(__dirname, '..', 'data');
const timers = new Map();

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
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const items = {};
    for (const [key, series] of map) {
      if (Array.isArray(series) && series.length) items[key] = trimSeries(series, max);
    }
    fs.writeFileSync(filePath(name), yaml.dump({ items }, { lineWidth: -1 }), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath(name), 0o600); } catch {}
  } catch (e) {
    console.warn(`${name} history save failed:`, e.message);
  }
}

function scheduleSaveHistoryMap(name, map, max = 5760, delay = 2500) {
  if (timers.has(name)) return;
  timers.set(name, setTimeout(() => {
    timers.delete(name);
    saveHistoryMap(name, map, max);
  }, delay));
}

module.exports = { loadHistoryMap, saveHistoryMap, scheduleSaveHistoryMap, trimSeries };
