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
  assert.ok(wrapperSource.includes('community-scripts/ProxmoxVE/main/misc/build.func'), 'wrapper must load the same stable framework as AdGuard');
  assert.ok(wrapperSource.includes('start\nbuild_container\ndescription'), 'wrapper must use the standard Community Scripts lifecycle');
  assert.ok(wrapperSource.includes('COMMUNITY_INSTALL_SOURCE') && wrapperSource.includes('OMNISIGHT_INSTALL_URL'), 'standalone wrapper must redirect only the missing upstream OmniSight installer');
  assert.ok(!wrapperSource.includes('pct create'), 'wrapper must not maintain a separate LXC implementation');
  assert.ok(!wrapperSource.includes('read -r -p "Container ID'), 'wrapper must not use the legacy plain-text prompt flow');
  assert.match(readmeSource, /bash -c "\$\(curl -fsSL https:\/\/raw\.githubusercontent\.com\/caglaryalcin\/OmniSight\/main\/scripts\/proxmox-lxc\.sh\)"/);
  assert.ok(readmeSource.includes('Default Install') && readmeSource.includes('Advanced Install'));
  assert.ok(documentationSource.includes('Community Scripts storage-pool dialog'));
  assert.strictEqual(communityMetadata.install_methods[0].config_path, '/opt/omnisight/data/config.yaml');
  assert.strictEqual(communityMetadata.install_methods[0].script, 'ct/omnisight.sh');
  assert.ok(communityInstall.includes('/opt/omnisight/data/config.yaml'));
  assert.ok(communityInstall.includes('deploy/community-scripts/ct/omnisight.sh'), 'container update command must work before upstream acceptance');
  assert.ok(communityCt.includes('build_container') && communityCt.includes('update_script'));
  assert.ok(fs.existsSync(path.join(communityRoot, 'ct', 'headers', 'omnisight')));

  console.log('smoke ok — Community Scripts LXC interface and installer integration');
}

if (require.main === module) run();
module.exports = { run };
