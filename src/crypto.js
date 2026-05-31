const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:';
const KEY_DIR = path.join(__dirname, '..', 'credentials');
const KEY_FILE = path.join(KEY_DIR, 'secret.key');

function encryptionEnabled() {
  const f = String(process.env.OMNISIGHT_ENCRYPT || '').toLowerCase();
  return !(f === 'false' || f === '0' || f === 'off' || f === 'no');
}

function resolveSecret() {
  if (process.env.OMNISIGHT_SECRET) return process.env.OMNISIGHT_SECRET;
  try { if (fs.existsSync(KEY_FILE)) { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (k) return k; } } catch {}
  const generated = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(KEY_DIR, { recursive: true }); fs.writeFileSync(KEY_FILE, generated, { mode: 0o600 }); } catch {}
  return generated;
}

function getKey() {
  return crypto.scryptSync(resolveSecret(), 'omnisight-salt-v1', 32);
}

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, enc].map(b => b.toString('base64')).join(':');
}

function decrypt(value) {
  if (!value || !String(value).startsWith(PREFIX)) return value;
  const key = getKey();
  const [ivB64, tagB64, encB64] = String(value).slice(PREFIX.length).split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

const SENSITIVE_KEYS = new Set([
  'password', 'privateKey', 'authPassword', 'privPassword',
  'tokenSecret', 'apiKey', 'token', 'sshPassword', 'sshKey', 'botToken',
]);

function decryptConfig(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(decryptConfig);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && isEncrypted(v)) {
      try { out[k] = decrypt(v); } catch { out[k] = v; }
    } else if (typeof v === 'object' && v !== null) {
      out[k] = decryptConfig(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function encryptConfigValue(key, value) {
  if (!value || typeof value !== 'string') return value;
  if (isEncrypted(value)) return value;
  if (SENSITIVE_KEYS.has(key)) return encrypt(value);
  return value;
}

module.exports = { encrypt, decrypt, isEncrypted, decryptConfig, encryptConfigValue, SENSITIVE_KEYS, encryptionEnabled };
