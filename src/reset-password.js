#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DATA_DIR = process.env.OMNISIGHT_DATA_DIR || path.join(__dirname, '..', 'data');
const AUTH_PATH = process.env.OMNISIGHT_AUTH_PATH || path.join(DATA_DIR, 'auth.yaml');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.yaml');

function usage(exitCode = 0) {
  const out = exitCode ? console.error : console.log;
  out(`Usage:
  node src/reset-password.js --password <new-password> [--username <username>] [--disable-2fa]

Options:
  --username <name>       Set username. Defaults to the current username, or admin.
  --password <password>   New password. May also be set with OMNISIGHT_RESET_PASSWORD.
  --disable-2fa           Remove the existing two-factor secret.
  --keep-sessions         Keep sessions.yaml on disk. Old in-memory sessions are still invalidated.
  --data-dir <path>       Override data directory. Default: ${DATA_DIR}
  --help                  Show this help.

Examples:
  OMNISIGHT_RESET_PASSWORD='NewStrongPass1' node src/reset-password.js
  node src/reset-password.js --username admin --password 'NewStrongPass1' --disable-2fa`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--disable-2fa') { args.disable2fa = true; continue; }
    if (arg === '--keep-sessions') { args.keepSessions = true; continue; }
    if (arg === '--username' || arg === '-u') { args.username = argv[++i]; continue; }
    if (arg === '--password' || arg === '-p') { args.password = argv[++i]; continue; }
    if (arg === '--data-dir') { args.dataDir = argv[++i]; continue; }
    console.error(`Unknown option: ${arg}`);
    usage(1);
  }
  return args;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter';
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter';
  return null;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function writePrivateYaml(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(obj, { lineWidth: -1 }), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function loadYaml(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return yaml.load(fs.readFileSync(file, 'utf8')) || null;
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir || DATA_DIR;
  const authPath = process.env.OMNISIGHT_AUTH_PATH || path.join(dataDir, 'auth.yaml');
  const sessionsPath = path.join(dataDir, 'sessions.yaml');
  const auth = loadYaml(authPath) || {};
  const username = String(args.username || auth.username || process.env.OMNISIGHT_RESET_USERNAME || 'admin').trim();
  const password = args.password || process.env.OMNISIGHT_RESET_PASSWORD;

  if (!username) {
    console.error('Username is required.');
    process.exit(1);
  }
  if (!password) {
    console.error('Password is required. Pass --password or set OMNISIGHT_RESET_PASSWORD.');
    process.exit(1);
  }
  const pErr = validatePassword(password);
  if (pErr) {
    console.error(pErr);
    process.exit(1);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const nextAuth = {
    username,
    hash: hashPassword(password, salt),
    salt,
    passwordChangedAt: Date.now(),
  };
  if (!args.disable2fa && auth.totp) nextAuth.totp = auth.totp;
  if (auth.avatar) nextAuth.avatar = auth.avatar;

  writePrivateYaml(authPath, nextAuth);
  if (!args.keepSessions) {
    try { if (fs.existsSync(sessionsPath)) fs.unlinkSync(sessionsPath); } catch {}
  }

  console.log(`OmniSight password reset for user "${username}".`);
  console.log(args.disable2fa ? 'Two-factor authentication was disabled.' : 'Two-factor authentication was preserved.');
  console.log('Old sessions are invalidated by passwordChangedAt.');
}

main();
