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
    cloudflareResourceNotifyKey,
    buildCloudflareDomainDetections,
    buildCloudflareResourceDetections,
    migrateCloudflareStickyState,
    migrateCloudflareNotificationState,
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
  const cloudflare = {
    online: true, zonesAuthoritative: true, tunnelsAuthoritative: true, registrarDomainsAuthoritative: true,
    zones: [{ id: 'same', name: 'example.test', online: false, paused: true, status: 'active' }],
    tunnels: [{ id: 'same', name: 'example.test', online: false, status: 'down' }],
    domains: [
      { id: 'same', name: 'example.test', daysToExpire: 12, expired: false, expiring: true },
      { id: 'second', name: 'second.test', daysToExpire: 90, expired: false, expiring: false },
    ],
  };
  assert.deepStrictEqual(
    buildCloudflareDomainDetections(cloudflare)
      .map(check => [check.key, check.ok, check.detail]),
    [
      ['cloudflare:domain:same:expired', true, 'not expired'],
      ['cloudflare:domain:same:expiring', false, 'expiring in 12 day(s)'],
      ['cloudflare:domain:second:expired', true, 'not expired'],
      ['cloudflare:domain:second:expiring', true, 'not expiring soon'],
    ],
  );
  assert.strictEqual(cloudflareResourceNotifyKey('zone', { id: 'a:b/c', name: 'fallback' }), 'cloudflare:zone:a%3Ab%2Fc');
  assert.strictEqual(cloudflareResourceNotifyKey('domain', { name: 'example.test' }), 'cloudflare:domain:example.test');
  assert.strictEqual(cloudflareResourceNotifyKey('domain', {}), '');
  assert.strictEqual(isStickyAlertKey('cloudflare:domain:same:expiring'), true);
  assert.strictEqual(isStickyAlertKey('cloudflare:domain:same:expired'), true);
  assert.strictEqual(isStickyAlertKey('cloudflare:zone:same'), false);
  assert.strictEqual(alertDeliveryCooldownEnabled('cloudflare:domain:same:expiring'), false);
  assert.deepStrictEqual(notificationKeyCandidates('cloudflare:domain:same:expired'), [
    'cloudflare:domain:same:expired', 'cloudflare:domain:same', 'cloudflare:domain', 'cloudflare',
  ]);
  const resourceChecks = buildCloudflareResourceDetections(cloudflare);
  assert.deepStrictEqual(resourceChecks.filter(check => !check.ok).map(check => check.key), [
    'cloudflare:domain:same:expiring', 'cloudflare:zone:same', 'cloudflare:tunnel:same',
  ]);
  assert.deepStrictEqual(buildCloudflareResourceDetections({ ...cloudflare, _stale: true }), []);
  assert.deepStrictEqual(buildCloudflareResourceDetections({ ...cloudflare, _connecting: true }), []);
  assert.deepStrictEqual(buildCloudflareDomainDetections({ ...cloudflare, domains: [{ id: 'same', daysToExpire: null }] }), [], 'unknown expiration must not resolve an existing problem');
  assert.deepStrictEqual(buildCloudflareResourceDetections(null), []);
  assert.ok(!buildCloudflareResourceDetections({ ...cloudflare, tunnelsAuthoritative: false }).some(check => check.key.includes(':tunnel:')), 'a failed tunnel inventory must not create tunnel checks');
  const legacyEpisode = new Map([['cloudflare-domains-expiring', 'critical']]);
  const migratedEpisode = migrateCloudflareStickyState(legacyEpisode, cloudflare);
  assert.deepStrictEqual([...migratedEpisode], [['cloudflare:domain:same:expiring', 'critical']]);
  assert.deepStrictEqual([...resolveStickyAlertState(stickyAlertStateDocument(migratedEpisode))], [...migratedEpisode]);
  assert.deepStrictEqual([...migrateCloudflareStickyState(legacyEpisode, { ...cloudflare, _stale: true })], [...legacyEpisode]);
  assert.deepStrictEqual([...migrateCloudflareStickyState(legacyEpisode, { ...cloudflare, registrarDomainsAuthoritative: false })], [...legacyEpisode]);
  const withUnknownDomain = { ...cloudflare, domains: [cloudflare.domains[0], { id: 'unknown', daysToExpire: null }] };
  const migratedUnknown = migrateCloudflareStickyState(legacyEpisode, withUnknownDomain);
  assert.deepStrictEqual([...migratedUnknown], [
    ['cloudflare:domain:same:expiring', 'critical'],
    ['cloudflare:domain:unknown:expiring', 'critical'],
  ], 'unknown expiry must retain the previous delivered incident on its own row');
  migratedUnknown.delete('cloudflare:domain:same:expiring');
  assert.strictEqual(migrateCloudflareStickyState(migratedUnknown, withUnknownDomain).has('cloudflare:domain:same:expiring'), false, 'an unresolved unknown domain must not reseed another domain after recovery');
  const disabledResources = new Set(['cloudflare', 'lx:example']);
  const resourceTopics = new Map([['cloudflare', 'cf-topic']]);
  let legacyNotifications = migrateCloudflareNotificationState(disabledResources, resourceTopics, {}, { ...cloudflare, domains: [] });
  assert.deepStrictEqual([...disabledResources].sort(), ['cloudflare:api', 'cloudflare:tunnel:same', 'cloudflare:zone:same', 'lx:example']);
  assert.strictEqual(resourceTopics.get('cloudflare:api'), 'cf-topic', 'the API health alert must retain its previous mute and topic without muting resource children');
  assert.strictEqual(resourceTopics.get('cloudflare:zone:same'), 'cf-topic');
  disabledResources.delete('cloudflare:zone:same');
  legacyNotifications = JSON.parse(JSON.stringify(legacyNotifications));
  legacyNotifications = migrateCloudflareNotificationState(disabledResources, resourceTopics, legacyNotifications, cloudflare);
  assert.strictEqual(disabledResources.has('cloudflare:zone:same'), false, 'explicit re-enable must survive refresh and restart');
  assert.strictEqual(disabledResources.has('cloudflare:domain:same'), true, 'a previously unavailable inventory must inherit the old global mute');
  assert.strictEqual(disabledResources.has('cloudflare:domain:second'), true);
  assert.strictEqual(resourceTopics.get('cloudflare:domain:same'), 'cf-topic');
  legacyNotifications = migrateCloudflareNotificationState(disabledResources, resourceTopics, legacyNotifications, {}, 'cloudflare:domain:late');
  disabledResources.delete('cloudflare:domain:late');
  legacyNotifications = migrateCloudflareNotificationState(disabledResources, resourceTopics, legacyNotifications, { domains: [{ id: 'late' }] });
  assert.strictEqual(disabledResources.has('cloudflare:domain:late'), false, 'a stale browser row enabled before discovery must retain the explicit choice');
  const rowDisabled = new Set(['cloudflare:domain:same']);
  const unmutedProblems = resourceChecks.filter(check => !check.ok && !notificationKeyCandidates(check.key).some(key => rowDisabled.has(key)));
  assert.deepStrictEqual(unmutedProblems.map(check => check.key), ['cloudflare:zone:same', 'cloudflare:tunnel:same'], 'a domain mute must not suppress a zone or tunnel sharing its ID');

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

  // Resource notification episodes, failures and delayed delivery callbacks.
  await require('./ci-smoke-cloudflare').run();
}

main().catch(err => { console.error(err); process.exit(1); });
