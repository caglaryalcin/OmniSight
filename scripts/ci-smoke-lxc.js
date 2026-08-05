#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const repoRoot = path.join(__dirname, '..');

function bashPath(file) {
  return file.replaceAll('\\', '/');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runScript(script, env, mocks) {
  const scriptSource = shellQuote(bashPath(script));
  const mockSource = mocks ? shellQuote(bashPath(path.relative(repoRoot, mocks))) : '';
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('; ');
  const command = mocks
    ? `${exports}; source ${mockSource}; source ${scriptSource}`
    : `${exports}; source ${scriptSource}`;
  return spawnSync('bash', ['-c', command], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function run() {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.error?.code === 'ENOENT') {
    console.log('smoke skipped — native LXC installer (bash unavailable)');
    return;
  }
  assert.strictEqual(bash.status, 0, bash.stderr);

  const root = fs.mkdtempSync(path.join(repoRoot, '.omnisight-lxc-smoke-'));
  const mocks = path.join(root, 'proxmox-mocks.sh');
  const log = path.join(root, 'pct.log');
  fs.writeFileSync(mocks, `
id() {
  if [ "$1" = "-u" ]; then echo 0; return 0; fi
  return 1
}
pvesh() { echo 150; }
pveam() {
  case "$1" in
    update|download) echo "mock pveam details"; return 0 ;;
    available)
      echo "system debian-13-standard_13.6-1_amd64.tar.zst"
      echo "system ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
      ;;
    list) return 0 ;;
    *) return 1 ;;
  esac
}
curl() {
  local output=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o) output="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$output" ] || return 1
  cp "$MOCK_INSTALLER_SOURCE" "$output"
}
pct() {
  printf '%s\n' "$*" >> "$MOCK_PCT_LOG"
  case "$1" in
    status) return 1 ;;
    create) echo "mock pct create details"; return 0 ;;
    push|stop|destroy) return 0 ;;
    exec)
      case "$*" in
        *"/root/install-lxc.sh"*) echo "mock installer details"; [ "$MOCK_INSTALL_FAIL" = "1" ] && return 1 ;;
        *"hostname -I"*) echo "192.0.2.10" ;;
      esac
      return 0
      ;;
    *) return 1 ;;
  esac
}
`);

  const env = {
    CTID: '150',
    CT_HOSTNAME: 'omnisight',
    CONFIRM: '1',
    MOCK_PCT_LOG: bashPath(path.relative(repoRoot, log)),
    MOCK_INSTALL_FAIL: '0',
    MOCK_INSTALLER_SOURCE: bashPath(path.join('scripts', 'install-lxc.sh')),
  };
  const wrapper = path.join('scripts', 'proxmox-lxc.sh');
  const installer = path.join('scripts', 'install-lxc.sh');

  let result = runScript(wrapper, env, mocks);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verbose mode: disabled/);
  assert.ok(!result.stdout.includes('mock pveam details'), 'quiet mode must hide command output');
  let calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /create 150 .*debian-13-standard_/);
  assert.ok(!calls.includes('nesting=1'), 'nesting must be disabled by default');

  fs.writeFileSync(log, '');
  result = runScript(wrapper, { ...env, VERBOSE: '1' }, mocks);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verbose mode: enabled/);
  assert.match(result.stdout, /mock pveam details/, 'verbose mode must show command output');

  const remoteWrapper = path.join(root, 'proxmox-lxc-remote.sh');
  fs.copyFileSync(wrapper, remoteWrapper);
  fs.writeFileSync(log, '');
  result = runScript(path.relative(repoRoot, remoteWrapper), env, mocks);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /downloading companion OmniSight installer/);
  calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /create 150 .*debian-13-standard_/);

  fs.writeFileSync(log, '');
  result = runScript(wrapper, { ...env, DISTRO: 'ubuntu', DISTRO_VERSION: '24.04' }, mocks);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /create 150 .*ubuntu-24\.04-standard_/);

  fs.writeFileSync(log, '');
  result = runScript(wrapper, { ...env, MOCK_INSTALL_FAIL: '1' }, mocks);
  assert.notStrictEqual(result.status, 0, 'failed install must fail the wrapper');
  assert.match(result.stderr, /mock installer details/, 'quiet failures must reveal the last command output');
  calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /destroy 150 --purge 1/, 'failed new LXC must be removed');

  fs.writeFileSync(log, '');
  result = runScript(wrapper, { ...env, OMNISIGHT_REPO: 'https://user:token@example.test/repo.git' }, mocks);
  assert.notStrictEqual(result.status, 0, 'embedded repository credentials must be rejected');
  assert.ok(!fs.readFileSync(log, 'utf8').includes('create '), 'invalid input must fail before LXC creation');

  result = runScript(installer, { OMNISIGHT_PORT: '70000' });
  assert.notStrictEqual(result.status, 0, 'invalid installer port must be rejected');

  const installerSource = fs.readFileSync(path.join(__dirname, 'install-lxc.sh'), 'utf8');
  const wrapperSource = fs.readFileSync(path.join(__dirname, 'proxmox-lxc.sh'), 'utf8');
  assert.ok(installerSource.includes('GIT_ASKPASS'), 'private token must use GIT_ASKPASS');
  assert.ok(!installerSource.includes('reset --hard'), 'update must not silently discard local edits');
  assert.ok(!wrapperSource.includes('${TOKEN_USER}:${TOKEN}@'), 'wrapper must not embed tokens in URLs');
  assert.ok(wrapperSource.includes('Enable verbose mode? [y/N]'), 'interactive runs must ask for verbose mode with No as the default');
  assert.ok(wrapperSource.includes('Create this LXC and install OmniSight? [Y/n]'), 'final confirmation must default to Yes');
  assert.match(wrapperSource, /""\|\[Yy\]\) break/, 'empty final confirmation must continue');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('smoke ok — native LXC installer: Debian/Ubuntu, validation, cleanup');
}

if (require.main === module) run();
module.exports = { run };
