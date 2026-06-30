const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(name) {
  return path.join(DATA_DIR, `${name}.yaml`);
}

function saveHistoryItems(name, items) {
  const start = Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = filePath(name);
  fs.writeFileSync(file, yaml.dump({ items }, { lineWidth: -1 }), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return Date.now() - start;
}

try {
  const { parentPort } = require('worker_threads');
  parentPort.on('message', msg => {
    const name = String(msg?.name || '').replace(/[^a-z0-9_.-]/gi, '');
    if (!name) return;
    const items = msg?.items && typeof msg.items === 'object' ? msg.items : {};
    try {
      const ms = saveHistoryItems(name, items);
      parentPort.postMessage({ ok: true, name, ms, count: Object.keys(items).length });
    } catch (err) {
      parentPort.postMessage({ ok: false, name, error: err?.message || String(err) });
    }
  });
} catch (err) {
  console.error(`history worker failed: ${err?.message || err}`);
}
