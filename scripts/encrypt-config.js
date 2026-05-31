const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { encryptConfigValue, encryptionEnabled } = require('../src/crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'credentials', 'config.yaml');

if (!encryptionEnabled()) {
  console.error('Encryption is disabled (OMNISIGHT_ENCRYPT=false). Nothing to do.');
  process.exit(1);
}
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('config.yaml not found.');
  process.exit(1);
}

function walk(obj) {
  if (Array.isArray(obj)) return obj.map(walk);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = (v && typeof v === 'object') ? walk(v) : encryptConfigValue(k, v);
    }
    return out;
  }
  return obj;
}

const raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
fs.writeFileSync(CONFIG_PATH, yaml.dump(walk(raw), { lineWidth: -1 }), 'utf8');
console.log('Sensitive fields in config.yaml have been encrypted.');
