#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');

function run() {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.error?.code === 'ENOENT') {
    console.log('smoke skipped — Community Scripts LXC integration (bash unavailable)');
    return;
  }
  assert.strictEqual(bash.status, 0, bash.stderr);

  const installer = path.join(repoRoot, 'scripts', 'install-lxc.sh');
  const invalidPort = spawnSync('bash', [installer], {
    cwd: repoRoot,
    env: { ...process.env, OMNISIGHT_PORT: '70000' },
    encoding: 'utf8',
  });
  assert.notStrictEqual(invalidPort.status, 0, 'invalid standalone installer port must be rejected');

  const installerSource = fs.readFileSync(installer, 'utf8');
  const wrapperSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'proxmox-lxc.sh'), 'utf8');
  const readmeSource = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const documentationSource = fs.readFileSync(path.join(repoRoot, 'DOCUMENTATION.md'), 'utf8');
  const communityRoot = path.join(repoRoot, 'deploy', 'community-scripts');
  const communityCt = fs.readFileSync(path.join(communityRoot, 'ct', 'omnisight.sh'), 'utf8');
  const communityInstall = fs.readFileSync(path.join(communityRoot, 'install', 'omnisight-install.sh'), 'utf8');
  const communityMetadata = JSON.parse(fs.readFileSync(path.join(communityRoot, 'json', 'omnisight.json'), 'utf8'));

  assert.ok(installerSource.includes('GIT_ASKPASS'), 'private token must use GIT_ASKPASS');
  assert.ok(!installerSource.includes('reset --hard'), 'update must not silently discard local edits');
  assert.ok(wrapperSource.includes('COMMUNITY_SCRIPTS_URL'), 'wrapper must identify the OmniSight scripts root');
  assert.ok(wrapperSource.includes('deploy/community-scripts'), 'wrapper must use the repository Community Scripts tree');
  assert.ok(wrapperSource.includes('/ct/omnisight.sh'), 'wrapper must delegate to the canonical CT script');
  assert.ok(!wrapperSource.includes('COMMUNITY_BUILD_FUNC'), 'wrapper must not patch the Community Scripts framework source');
  assert.ok(!wrapperSource.includes('ProxmoxVE/main/misc/build.func'), 'wrapper must not use the retired monolithic framework path');
  assert.ok(!wrapperSource.includes('pct create'), 'wrapper must not maintain a separate LXC implementation');
  assert.ok(!wrapperSource.includes('read -r -p "Container ID'), 'wrapper must not use the legacy plain-text prompt flow');
  assert.match(readmeSource, /bash -c "\$\(curl -fsSL https:\/\/raw\.githubusercontent\.com\/caglaryalcin\/OmniSight\/main\/scripts\/proxmox-lxc\.sh\)"/);
  assert.ok(readmeSource.includes('Default Install') && readmeSource.includes('Advanced Install'));
  assert.ok(documentationSource.includes('Community Scripts storage-pool dialog'));
  assert.strictEqual(communityMetadata.install_methods[0].config_path, '/opt/omnisight/data/config.yaml');
  assert.strictEqual(communityMetadata.install_methods[0].script, 'ct/omnisight.sh');
  assert.strictEqual(communityMetadata.repository, 'https://github.com/caglaryalcin/OmniSight');
  assert.deepStrictEqual(communityMetadata.platforms, ['pve']);
  assert.ok(!Object.hasOwn(communityMetadata, 'has_arm'), 'legacy has_arm metadata must not be used');
  assert.ok(!Object.hasOwn(communityMetadata, 'architectures'), 'untested ARM64 support must remain undeclared');
  assert.ok(communityInstall.includes('/opt/omnisight/data/config.yaml'));
  assert.ok(!communityInstall.includes('/usr/bin/update'), 'the Community Scripts core must create the update command');
  assert.ok(communityCt.includes('community-scripts/core/main'), 'CT script must load the current Community Scripts core');
  assert.ok(communityCt.includes('COMMUNITY_SCRIPTS_CORE_DIR'), 'CT script must support a local core checkout');
  assert.ok(communityCt.includes('build_container') && communityCt.includes('update_script'));
  assert.ok(fs.existsSync(path.join(communityRoot, 'ct', 'headers', 'omnisight')));

  console.log('smoke ok — Community Scripts LXC interface and installer integration');
}

if (require.main === module) run();
module.exports = { run };
