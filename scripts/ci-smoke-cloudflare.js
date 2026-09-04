// Exercise the server's real alert state machine without starting the server or
// contacting notification providers. Time and delivery completion are controlled.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const alertHelpers = require('../src/alerts');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing server function ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `missing closing brace for server function ${name}`);
  return source.slice(start, end + 2);
}

function createHarness(source, { stored = null, disabled = [] } = {}) {
  const clock = { now: 1700000000000 };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const deliveries = [];
  const history = [];
  let persisted = stored || { version: 1, active: {} };
  const stickyState = alertHelpers.resolveStickyAlertState(persisted);
  const context = {
    ...alertHelpers,
    Date: FakeDate,
    Map,
    Set,
    Promise,
    config: { alerts: { enabled: true } },
    ALERT_STARTUP_GRACE_MS: 60000,
    ALERT_NOTIFICATION_COOLDOWN_MS: 3600000,
    DEFAULT_ALERT_RULE: { durationSeconds: 60 },
    DEFAULT_SNMP_ALERT_RULE: { durationSeconds: 120 },
    prevChecks: null,
    alertFirstSeen: new Map(),
    alertProblemSince: new Map(),
    alertActiveSeverity: new Map(stickyState),
    alertEpisodeSequence: 0,
    alertEpisodeRevisions: new Map(),
    alertSentAtBySignature: new Map(),
    stickyAlertState: stickyState,
    notifyDisabled: new Set(disabled),
    extractChecks: data => new Map(data.checks.map(check => [check.key, { ...check }])),
    isAlertMuted: () => false,
    inMaintenanceWindow: () => false,
    alertConfigForKey: value => value,
    saveAlertHistory() {},
    logAlertResult() {},
    saveStickyAlertState(state) { persisted = alertHelpers.stickyAlertStateDocument(state); },
    pushAlertHistory(entry) {
      const saved = { t: clock.now, ...entry };
      history.push(saved);
      return saved;
    },
    dispatchAlert(_config, alert) {
      return new Promise((resolve, reject) => {
        deliveries.push({ alert, resolve, reject, settled: false });
      });
    },
  };
  vm.createContext(context);
  const functions = [
    'beginAlertEpisode', 'invalidateAlertEpisode', 'invalidateAllAlertEpisodes',
    'alertDispatchIsCurrent', 'rememberStickyAlert', 'forgetStickyAlert', 'migrateCloudflareAlertEpisodes',
    'notifyDisabledForKey', 'alertDeliverySignature', 'alertNotificationInCooldown',
    'secondsValue', 'configuredAlertRule', 'alertRuleForCheck', 'alertDelayMs',
    'dispatchTrackedAlert', 'alertInfoText', 'runAlertChecks',
  ];
  vm.runInContext(functions.map(name => extractFunction(source, name)).join('\n'), context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    context,
    deliveries,
    history,
    persisted: () => JSON.parse(JSON.stringify(persisted)),
    advance(ms = 61000) { clock.now += ms; },
    poll(checks, cloudflare = null) { context.runAlertChecks({ checks, cloudflare }); },
    mature(checks, cloudflare = null) {
      this.poll(checks, cloudflare);
      this.advance();
      this.poll(checks, cloudflare);
      this.advance();
      this.poll(checks, cloudflare);
    },
    async settle(index, success = true, rejected = false) {
      const delivery = deliveries[index];
      assert.ok(delivery && !delivery.settled, `delivery ${index} must be pending`);
      delivery.settled = true;
      if (rejected) delivery.reject(new Error('simulated provider failure'));
      else delivery.resolve([{ channel: 'ntfy', ok: success }]);
      await flush();
    },
    async settleAll() {
      for (let index = 0; index < deliveries.length; index += 1) {
        if (!deliveries[index].settled) await this.settle(index);
      }
    },
    problems(key) { return history.filter(entry => entry.type === 'problem' && (!key || entry.key === key)); },
  };
}

const check = (key, ok = false) => ({ key, ok, label: key, detail: ok ? 'healthy' : 'needs attention' });
const DOMAIN = 'cloudflare:domain:d1';
const EXPIRING = `${DOMAIN}:expiring`;
const EXPIRED = `${DOMAIN}:expired`;

async function run() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // A legacy aggregate becomes independent row incidents, even when one expiry
  // is unknown. It must never re-seed a resolved row and swallow a new incident.
  {
    const legacyKey = 'cloudflare-domains-expiring';
    const unknownKey = 'cloudflare:domain:d2:expiring';
    const harness = createHarness(source, { stored: { version: 1, active: { [legacyKey]: 'critical' } } });
    const cloudflare = {
      online: true,
      registrarDomainsAuthoritative: true,
      domains: [
        { id: 'd1', name: 'first.test', daysToExpire: 10, expiring: true, expired: false },
        { id: 'd2', name: 'second.test', daysToExpire: null, expiring: false, expired: false },
      ],
    };
    const pollInventory = () => harness.poll(alertHelpers.buildCloudflareDomainDetections(cloudflare), cloudflare);
    harness.mature(alertHelpers.buildCloudflareDomainDetections(cloudflare), cloudflare);
    assert.strictEqual(harness.problems().length, 0, 'a previously delivered aggregate must not notify known rows again');
    assert.strictEqual(harness.persisted().active[legacyKey], undefined, 'migration must consume the legacy aggregate');
    assert.strictEqual(harness.persisted().active[EXPIRING], 'critical');
    assert.strictEqual(harness.persisted().active[unknownKey], 'critical', 'unknown expiry must provisionally retain the delivered incident');
    cloudflare.domains[0] = { ...cloudflare.domains[0], daysToExpire: 100, expiring: false };
    pollInventory();
    await harness.settleAll();
    assert.strictEqual(harness.persisted().active[EXPIRING], undefined, 'a known healthy row must resolve its incident');
    assert.strictEqual(harness.persisted().active[unknownKey], 'critical', 'an unknown sibling must remain unresolved');
    cloudflare.domains[0] = { ...cloudflare.domains[0], daysToExpire: 10, expiring: true };
    pollInventory();
    harness.advance();
    pollInventory();
    assert.strictEqual(harness.problems(EXPIRING).length, 1, 'the next row incident must notify rather than inherit the old aggregate again');
    await harness.settleAll();
    cloudflare.domains[1] = { ...cloudflare.domains[1], daysToExpire: 100 };
    pollInventory();
    await harness.settleAll();
    assert.strictEqual(harness.persisted().active[unknownKey], undefined, 'a later known healthy expiry must resolve the provisional incident');
    assert.strictEqual(harness.problems(EXPIRING).length, 1, 'resolving the sibling must not notify the active row again');
  }

  // Disabling one row must not silence its siblings or another resource type.
  {
    const harness = createHarness(source, { disabled: ['cloudflare:zone:z1', 'cloudflare:tunnel:t1', DOMAIN] });
    const checks = [
      check('cloudflare:zone:z1'), check('cloudflare:zone:z2'),
      check('cloudflare:tunnel:t1'), check('cloudflare:tunnel:t2'),
      check(EXPIRING), check(EXPIRED), check('cloudflare:domain:d2:expiring'),
    ];
    harness.mature(checks);
    assert.deepStrictEqual(harness.problems().map(entry => entry.key).sort(), [
      'cloudflare:domain:d2:expiring', 'cloudflare:tunnel:t2', 'cloudflare:zone:z2',
    ]);
    await harness.settleAll();
    harness.context.notifyDisabled.delete('cloudflare:zone:z1');
    harness.poll(checks);
    assert.strictEqual(harness.problems('cloudflare:zone:z1').length, 1, 'enabling a zone should resume only that row');
    assert.strictEqual(harness.problems(EXPIRING).length, 0, 'a domain row mute must cover expiration warnings');
    assert.strictEqual(harness.problems(EXPIRED).length, 0, 'the same domain row mute must cover expired warnings');
    await harness.settleAll();
  }

  // Successful domain deliveries survive later polls, absent/transient data and restart.
  {
    const harness = createHarness(source);
    harness.mature([check(EXPIRING)]);
    assert.strictEqual(harness.problems(EXPIRING).length, 1);
    await harness.settleAll();
    assert.strictEqual(harness.persisted().active[EXPIRING], 'critical');
    harness.advance(86400000);
    harness.poll([check(EXPIRING)]);
    harness.poll([]);
    harness.advance();
    harness.poll([check(EXPIRING)]);
    harness.advance();
    harness.poll([check(EXPIRING)]);
    assert.strictEqual(harness.problems(EXPIRING).length, 1, 'temporary absence must not create a second domain alert');
    const restarted = createHarness(source, { stored: harness.persisted() });
    restarted.mature([check(EXPIRING)]);
    assert.strictEqual(restarted.problems(EXPIRING).length, 0, 'persisted delivery must suppress a duplicate after restart');
    restarted.poll([check(EXPIRING, true)]);
    await restarted.settleAll();
    assert.strictEqual(restarted.persisted().active[EXPIRING], undefined, 'authoritative healthy state must clear the persisted incident');
    restarted.poll([check(EXPIRING)]);
    restarted.advance();
    restarted.poll([check(EXPIRING)]);
    assert.strictEqual(restarted.problems(EXPIRING).length, 1, 'a new incident must notify inside the old one-hour cooldown');
    await restarted.settleAll();
  }

  // Expiring and expired are separate incidents; another domain remains independent.
  {
    const harness = createHarness(source);
    const otherDomain = 'cloudflare:domain:d2:expiring';
    harness.mature([check(EXPIRING), check(EXPIRED, true), check(otherDomain)]);
    await harness.settleAll();
    assert.strictEqual(harness.problems(EXPIRING).length, 1);
    assert.strictEqual(harness.problems(otherDomain).length, 1);
    harness.poll([check(EXPIRING, true), check(EXPIRED), check(otherDomain)]);
    harness.advance();
    harness.poll([check(EXPIRING, true), check(EXPIRED), check(otherDomain)]);
    await harness.settleAll();
    assert.strictEqual(harness.problems(EXPIRED).length, 1, 'expiration must notify after an earlier expiring warning');
    assert.strictEqual(harness.problems(otherDomain).length, 1, 'another domain must not be notified again');
    assert.strictEqual(harness.persisted().active[EXPIRING], undefined);
    assert.strictEqual(harness.persisted().active[EXPIRED], 'critical');
    assert.strictEqual(harness.persisted().active[otherDomain], 'critical');
  }

  // Failure is not a completed incident: retry both unsuccessful results and rejected promises.
  for (const rejected of [false, true]) {
    const harness = createHarness(source);
    harness.mature([check(EXPIRING)]);
    await harness.settle(0, false, rejected);
    assert.strictEqual(harness.context.alertActiveSeverity.has(EXPIRING), false);
    assert.strictEqual(harness.persisted().active[EXPIRING], undefined);
    harness.poll([check(EXPIRING)]);
    assert.strictEqual(harness.problems(EXPIRING).length, 2, 'failed delivery should be retried without a stale cooldown');
    await harness.settle(1);
    harness.poll([check(EXPIRING)]);
    assert.strictEqual(harness.problems(EXPIRING).length, 2, 'successful retry completes the incident');
  }

  // An older delivery cannot revive a recovered incident, even after a new incident begins.
  for (const oldSuccess of [false, true]) {
    const harness = createHarness(source);
    harness.mature([check(EXPIRING)]);
    harness.poll([check(EXPIRING, true)]);
    assert.strictEqual(harness.persisted().active[EXPIRING], undefined);
    harness.poll([check(EXPIRING)]);
    harness.advance();
    harness.poll([check(EXPIRING)]);
    assert.strictEqual(harness.problems(EXPIRING).length, 2);
    await harness.settle(0, oldSuccess);
    assert.strictEqual(harness.persisted().active[EXPIRING], undefined, 'old completion must not persist the new incident');
    assert.strictEqual(harness.context.alertActiveSeverity.get(EXPIRING), 'critical', 'old failure must not delete a new in-flight incident');
    await harness.settleAll();
    assert.strictEqual(harness.persisted().active[EXPIRING], 'critical', 'only the current incident may persist success');
    harness.poll([check(EXPIRING)]);
    assert.strictEqual(harness.problems(EXPIRING).length, 2);
  }

  // Import/reset invalidation protects the replacement state from older provider callbacks.
  {
    const harness = createHarness(source);
    harness.mature([check(EXPIRING)]);
    harness.context.invalidateAllAlertEpisodes();
    harness.context.stickyAlertState.clear();
    harness.context.alertActiveSeverity.clear();
    harness.context.prevChecks = null;
    harness.context.alertFirstSeen.clear();
    harness.context.alertProblemSince.clear();
    await harness.settle(0);
    assert.strictEqual(harness.persisted().active[EXPIRING], undefined, 'invalidated delivery must not overwrite imported state');
    harness.mature([check(EXPIRING)]);
    assert.strictEqual(harness.problems(EXPIRING).length, 2, 'replacement state may start its own incident');
    await harness.settleAll();
  }

  console.log('smoke ok — Cloudflare alert state: per-resource mute, persistence, recovery, retries and async delivery races');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
