#!/usr/bin/env node
// CI smoke test: syntax-load core modules and exercise alert dispatch
// against a local mock HTTP endpoint. No network, no Docker, no config.
const http = require('http');
const assert = require('assert');

async function main() {
  // 1) Core modules load
  const {
    dispatchAlert,
    serverUpdateNotificationsEnabled,
    buildServerUpdateDetections,
    isStickyAlertKey,
    alertDeliverySucceeded,
    rebuildStickyAlertState,
    resolveStickyAlertState,
    stickyAlertStateDocument,
    stickyAlertDispatchIsCurrent,
    alertDeliveryCooldownEnabled,
    notificationKeyCandidates,
    buildCloudflareDomainDetections,
    shouldDispatchProblem,
    clearAlertCooldownsForType,
  } = require('../src/alerts');
  const { encryptConfigValue, isEncrypted, decryptConfig } = require('../src/crypto');

  assert.strictEqual(serverUpdateNotificationsEnabled({}), false);
  assert.strictEqual(serverUpdateNotificationsEnabled({ detections: { serverUpdates: true } }), true);
  const updateDetections = buildServerUpdateDetections({
    linux: [
      { name: 'deb01', online: true, updates: { count: 2 } },
      { name: 'offline-linux', online: false, updates: { count: 5 } },
      { name: 'unknown-linux', online: true, updates: null },
    ],
    windows: [
      { name: 'win01', online: true, updates: { count: 0 } },
      { name: 'connecting-windows', online: true, _connecting: true, updates: { count: 3 } },
    ],
    proxmox: {
      nodes: [
        { clusterName: 'production', node: { name: 'pve01', online: true }, updates: { count: 7 } },
        { clusterName: 'staging', node: { name: 'pve01', online: true }, updates: { count: 0 } },
        { node: { name: 'standalone-pve', online: true }, updates: { count: '0' } },
        { clusterName: 'production', node: { name: 'offline-pve', online: false }, updates: { count: 4 } },
        { clusterName: 'production', node: { name: 'connecting-pve', online: true }, _connecting: true, updates: { count: 6 } },
      ],
    },
  });
  assert.deepStrictEqual(updateDetections.map(d => [d.key, d.ok, d.severity, d.value]), [
    ['lx:deb01:updates', false, 'warning', 2],
    ['win:win01:updates', true, 'normal', 0],
    ['px:production:pve01:updates', false, 'warning', 7],
    ['px:staging:pve01:updates', true, 'normal', 0],
    ['px:standalone-pve:updates', true, 'normal', 0],
  ]);
  assert.strictEqual(shouldDispatchProblem(undefined, 'critical'), true);
  assert.strictEqual(shouldDispatchProblem('warning', 'critical'), true);
  assert.strictEqual(shouldDispatchProblem('critical', 'critical'), false);
  const cooldowns = new Map([
    ['problem|win:M4A1|critical', 1],
    ['problem|win:M4A1|warning', 2],
    ['recovery|win:M4A1|normal', 3],
    ['problem|win:OTHER|critical', 4],
  ]);
  assert.strictEqual(clearAlertCooldownsForType(cooldowns, 'problem', 'win:M4A1'), 2);
  assert.deepStrictEqual(Array.from(cooldowns.keys()), [
    'recovery|win:M4A1|normal',
    'problem|win:OTHER|critical',
  ]);
  assert.deepStrictEqual(notificationKeyCandidates('px:pve01:cpu'), ['px:pve01:cpu', 'px:pve01', 'px']);
  assert.deepStrictEqual(notificationKeyCandidates('cloudflare-domains-expiring'), ['cloudflare-domains-expiring', 'cloudflare']);
  assert.strictEqual(isStickyAlertKey('cloudflare-domains-expiring'), true);
  assert.strictEqual(isStickyAlertKey('cloudflare-zones'), false);
  assert.strictEqual(alertDeliverySucceeded({ status: 'failed', channels: [{ channel: 'ntfy', ok: true }] }), true);
  const stickyHistory = [
    { type: 'problem', key: 'cloudflare-domains-expiring', severity: 'critical', status: 'sent' },
    { type: 'problem', key: 'cloudflare-domains-expired', severity: 'critical', status: 'failed' },
    { type: 'problem', key: 'lx:deb01', severity: 'critical', status: 'sent' },
  ];
  assert.deepStrictEqual(Array.from(rebuildStickyAlertState(stickyHistory)), [
    ['cloudflare-domains-expiring', 'critical'],
  ]);
  assert.deepStrictEqual(Array.from(resolveStickyAlertState(null, stickyHistory)), [
    ['cloudflare-domains-expiring', 'critical'],
  ], 'legacy installs must migrate the unresolved Cloudflare episode from alert history');
  assert.deepStrictEqual(Array.from(resolveStickyAlertState({ version: 1, active: {} }, stickyHistory)), [], 'a stored healthy state must override old problem history after restart');
  assert.deepStrictEqual(stickyAlertStateDocument(new Map([
    ['cloudflare-domains-expiring', 'critical'],
    ['lx:deb01', 'critical'],
  ])), { version: 1, active: { 'cloudflare-domains-expiring': 'critical' } });
  assert.strictEqual(stickyAlertDispatchIsCurrent('cloudflare-domains-expiring', 1, 1), true, 'the active Cloudflare alert episode may persist its successful delivery');
  assert.strictEqual(stickyAlertDispatchIsCurrent('cloudflare-domains-expiring', 1, 2), false, 'a healthy result or backup import must invalidate an older in-flight delivery');
  assert.strictEqual(stickyAlertDispatchIsCurrent('cloudflare-domains-expiring', 1, 3), false, 'a new same-severity episode must not accept an older delivery result');
  assert.strictEqual(stickyAlertDispatchIsCurrent('lx:deb01', 0, undefined), true, 'ordinary alerts must keep their existing dispatch behavior');
  assert.strictEqual(alertDeliveryCooldownEnabled('cloudflare-domains-expiring'), false, 'persistent Cloudflare alert episodes must not inherit stale hourly cooldowns');
  assert.strictEqual(alertDeliveryCooldownEnabled('lx:deb01'), true, 'ordinary alerts must retain their hourly delivery cooldown');
  stickyHistory.push({ type: 'recovery', key: 'cloudflare-domains-expiring', severity: 'normal', status: 'failed' });
  assert.deepStrictEqual(Array.from(rebuildStickyAlertState(stickyHistory)), []);
  assert.deepStrictEqual(buildCloudflareDomainDetections({ registrarDomainsAuthoritative: false, summary: { domainsExpiring: 1 } }), []);
  assert.deepStrictEqual(
    buildCloudflareDomainDetections({ registrarDomainsAuthoritative: true, summary: { domainsExpired: 0, domainsExpiring: 1 } })
      .map(check => [check.key, check.ok, check.detail]),
    [
      ['cloudflare-domains-expired', true, 'no domains expired'],
      ['cloudflare-domains-expiring', false, '1 domain(s) expiring soon'],
    ],
  );

  // 2) Crypto round-trip for a sensitive key
  const enc = encryptConfigValue('password', 's3cret');
  assert.ok(isEncrypted(enc), 'sensitive key must be encrypted');
  assert.strictEqual(decryptConfig({ a: { password: enc } }).a.password, 's3cret');

  // 3) Alert dispatch against a mock receiver
  const hits = [];
  const srv = http.createServer((req, res) => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => { hits.push({ url: req.url, body: d }); res.end('ok'); });
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;

  const cfg = {
    enabled: true,
    ntfy: { enabled: true, url: `http://127.0.0.1:${port}`, topic: 'ci' },
    // Exercised only on branches where the mattermost channel exists;
    // silently ignored elsewhere.
    mattermost: { enabled: true, webhookUrl: `http://127.0.0.1:${port}/hooks/ci` },
  };
  const results = await dispatchAlert(cfg, { title: 'CI', message: 'smoke test' });
  srv.close();

  const byChannel = Object.fromEntries(results.map(r => [r.channel, r]));
  assert.ok(byChannel.ntfy && byChannel.ntfy.ok, `ntfy dispatch failed: ${JSON.stringify(results)}`);
  if (byChannel.mattermost) {
    assert.ok(byChannel.mattermost.ok, `mattermost dispatch failed: ${JSON.stringify(results)}`);
    const mm = hits.find(h => h.url === '/hooks/ci');
    assert.ok(mm, 'mattermost webhook not hit');
    const payload = JSON.parse(mm.body);
    assert.ok(payload.text.includes('CI'), 'mattermost payload missing title');
  }
  console.log(`smoke ok — channels tested: ${results.map(r => r.channel).join(', ') || 'none'}`);

  // 4) UniFi collector against fixture controllers (no network, no config)
  await require('./ci-smoke-unifi').run();

  // 5) GitHub/GitLab resource discovery with injected headerless API fixtures
  await require('./ci-smoke-cicd').run();

  // 6) Pure helpers extracted from public/index.html (no browser)
  require('./ci-smoke-client').run();

  // 7) Native installer defaults, input validation, and failed-LXC cleanup
  require('./ci-smoke-lxc').run();

  // 8) Open-issue regressions and collector fixtures
  await require('./ci-smoke-issues').run();
}

main().catch(err => { console.error(err); process.exit(1); });
