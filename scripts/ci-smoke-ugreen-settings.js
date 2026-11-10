// Exercise the real UGREEN settings renderer and collector without a browser.
// The minimal DOM below handles form values and visibility only; it is not UI
// acceptance testing and makes no requests to a NAS.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { configuredInstances } = require('../src/ugreen');
const { mergePreservingSecrets } = require('../src/config-merge');
const { encrypt } = require('../src/crypto');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing settings function ${name}`);
  let depth = 0;
  let args = source.indexOf('(', start);
  for (; args < source.length; args += 1) {
    if (source[args] === '(') depth += 1;
    if (source[args] === ')' && --depth === 0) break;
  }
  const body = source.indexOf('{', args + 1);
  depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated settings function ${name}`);
}

function decoded(value) {
  return String(value).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`));
  return match ? decoded(match[1]) : '';
}
class FormElement {
  constructor() {
    this.value = '';
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.fields = new Map();
    this.children = [];
  }
  set innerHTML(html) {
    this.html = html;
    this.fields.clear();
    for (const match of html.matchAll(/<(?:input|select|div|span)\b([^>]*)>/g)) {
      const field = new FormElement();
      field.value = attribute(match[1], 'value');
      for (const name of attribute(match[1], 'class').split(/\s+/).filter(Boolean)) this.fields.set('.' + name, field);
    }
    for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const options = [...match[2].matchAll(/<option\b([^>]*)>/g)];
      const selected = options.find(option => /\bselected\b/.test(option[1])) || options[0];
      this.querySelector('.' + attribute(match[1], 'class').split(/\s+/)[0]).value = attribute(selected[1], 'value');
    }
  }
  querySelector(selector) {
    const field = this.fields.get(selector);
    assert.ok(field, `missing actual settings control ${selector}`);
    return field;
  }
  appendChild(element) { this.children.push(element); }
}
function harness(html) {
  const list = new FormElement();
  const context = {
    document: {
      createElement: () => new FormElement(),
      getElementById: id => { assert.strictEqual(id, 'ugreen-list'); return list; },
      querySelectorAll: selector => { assert.strictEqual(selector, '#ugreen-list .arr-item'); return list.children; },
    },
    applyLanguageFragment: () => {},
  };
  vm.createContext(context);
  vm.runInContext([
    'let ugreenCount = 0;',
    ...['escHtml', 'normalizeConfigKeyPart', 'uniqueConfigItems', 'secVal', 'maskedVal',
      'ugreenSettingsInstances', 'collectUgreenInstances', 'addUgreenInstance', 'syncUgreenFields']
      .map(name => extractFunction(html, name)),
  ].join('\n'), context);
  function populate(config) {
    list.children = [];
    for (const instance of context.ugreenSettingsInstances(config)) context.addUgreenInstance(instance);
    return list.children;
  }
  return { context, list, populate, collect: () => JSON.parse(JSON.stringify(context.collectUgreenInstances())) };
}
function saveInheritedConfig(incoming, existing) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('if (incoming.ugreen && existing.ugreen)');
  const endStatement = 'const merged = mergePreservingSecrets(incoming, existing);';
  const end = source.indexOf(endStatement, start);
  assert.ok(start >= 0 && end > start, 'the actual config save path must resolve masked inherited UGREEN secrets');
  const context = { incoming, existing, ugreenConfigInstances: configuredInstances, mergePreservingSecrets };
  vm.runInNewContext(source.slice(start, end + endStatement.length) + '\nglobalThis.saved = merged;', context);
  return context.saved;
}

function testNasRendering() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const context = {
    hasNum: value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)),
    deviceTemperatureSeverity: () => 'normal', deviceTemperatureColor: () => 'green',
    offlineRatioBadgeClass: () => 'red', offlineRatioLabel: () => 'offline',
    avgPct: values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    nasSummaryMetricHtml: () => '', panelOpenState: () => true,
    escHtml: String, escAttr: String, jsStr: JSON.stringify, notifyBell: () => '',
    fmtPct: value => value + '%', fmtBytes: String, fmtUptime: String,
    pveHeadStat: (label, value) => `<stat>${label}:${value}</stat>`,
    temperatureSensorKind: () => 'hdd', bc: () => 'green',
    bdg: (color, label) => `<badge data-color="${color}">${label}</badge>`,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(html, 'buildSimpleNasPanel'), context);
  const options = { id: 'ugreen', title: 'Ugreen' };
  const render = instance => context.buildSimpleNasPanel({ online: true, summary: { up: 1, instances: 1 }, instances: [{ online: true, name: 'Fixture NAS', ...instance }] }, options);
  const web = render({ method: 'web', available: { system: false, storage: false, disks: false, services: false }, system: {} });
  assert.match(web.badge, /healthy/, 'a successful intentional web check must remain healthy');
  assert.match(web.body, /Reachability only/);
  assert.match(web.body, /Select UGOS API or SNMP/);
  assert.doesNotMatch(web.body, /Storage:0|Disks:0|No detailed NAS metrics available/, 'web checks must explain their scope instead of claiming empty storage');
  const system = render({ method: 'api', system: { cpuPercent: 12.5, memoryPercent: 33, uptimeSeconds: 3600 }, available: { system: true, storage: false, disks: false } });
  assert.match(system.body, /CPU:12.5%/);
  assert.match(system.body, /RAM:33%/);
  assert.match(system.body, /Uptime:3600/);
  assert.doesNotMatch(system.body, /No detailed NAS metrics available/, 'valid system telemetry must not be followed by a no-metrics message');
  for (const [key, status] of [['disks', 'critical'], ['disks', 'locked'], ['pools', 'corrupted'], ['volumes', 'danger'], ['volumes', 'faulty']]) {
    const faulty = render({ method: 'api', degraded: true, [key]: [{ name: 'Broken component', status }] });
    assert.match(faulty.badge, /data-color="yellow">attention/, `${key} ${status} must affect the UGREEN headline`);
    assert.match(faulty.body, /service-node-hdr warn/, `${key} ${status} must affect the instance state`);
    assert.match(faulty.body, /data-color="yellow">(?:warn|attention)/, `${key} ${status} must warn on the component row`);
  }
  const qnap = context.buildSimpleNasPanel({ online: true, summary: { up: 1, instances: 1 }, instances: [{ online: true, method: 'qts-api', degraded: true, system: {} }] }, { id: 'qnap', title: 'QNAP' });
  assert.match(qnap.badge, /healthy/, 'UGREEN-specific degraded fields must not alter QNAP behavior');

  const start = html.indexOf("  ['qnap','ugreen'].forEach(id => {");
  const end = html.indexOf('\n  const cf=data.cloudflare;', start);
  assert.ok(start >= 0 && end > start, 'global NAS health aggregation must be extractable');
  for (const [id, instance, expected] of [['ugreen', { partial: true }, 'degraded'], ['ugreen', { degraded: true }, 'degraded'], ['ugreen', {}, 'ok'], ['qnap', { degraded: true }, 'ok']]) {
    const health = { data: { [id]: { online: true, summary: { up: 1, instances: 1 }, instances: [{ online: true, ...instance }] } } };
    vm.runInNewContext('const platforms = [];\n' + html.slice(start, end) + '\nglobalThis.state = platforms[0];', health);
    assert.strictEqual(health.state, expected, `${id} global health must reflect the collector warning without changing other platforms`);
  }
}

function run() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  const h = harness(html);
  const [web] = h.populate({ name: 'Legacy web', url: 'https://nas.test/ugreen' });
  assert.strictEqual(web.querySelector('.ugreen-method').value, 'web');
  assert.strictEqual(web.querySelector('.ugreen-web-fields').hidden, false);
  assert.strictEqual(web.querySelector('.ugreen-api-fields').hidden, true);
  assert.strictEqual(web.querySelector('.ugreen-snmp-fields').hidden, true);
  assert.strictEqual(h.collect()[0].method, 'web');
  assert.ok(!('password' in h.collect()[0]), 'web mode must not submit API credentials');

  const root = {
    method: 'api', username: 'root-user', password: '__encrypted__', token: '__set__',
    insecureTLS: true, timeoutMs: 12000,
    instances: [{ name: 'First', url: 'https://first.test:9443' }, { name: 'Second', url: 'http://second.test:9999', username: 'row-user', insecureTLS: false }],
  };
  const [first, second] = h.populate(root);
  assert.strictEqual(first.querySelector('.ugreen-method').value, 'api', 'a root API method must not silently become web');
  assert.strictEqual(first.querySelector('.ugreen-api-fields').hidden, false);
  assert.strictEqual(first.querySelector('.ugreen-api-username').value, 'root-user');
  assert.strictEqual(second.querySelector('.ugreen-api-username').value, 'row-user', 'row overrides must win over root defaults');
  assert.strictEqual(first.querySelector('.ugreen-password').value, '');
  assert.strictEqual(first.querySelector('.ugreen-password').dataset.masked, '1');
  assert.strictEqual(first.querySelector('.ugreen-token').dataset.masked, '1');
  const apiSaved = h.collect();
  assert.strictEqual(apiSaved[0].password, '__set__');
  assert.strictEqual(apiSaved[0].token, '__set__');
  assert.strictEqual(apiSaved[0].timeoutMs, 12000, 'advanced inherited timeouts must survive a UI save');
  assert.strictEqual(apiSaved[0].insecureTLS, true);
  assert.ok(!apiSaved[1].insecureTLS, 'an explicit row TLS setting must survive inheritance');

  const previousSecret = process.env.OMNISIGHT_SECRET;
  process.env.OMNISIGHT_SECRET = 'ugreen-settings-fixture-only-secret';
  try {
    const savedPassword = encrypt('saved-root-password');
    const savedToken = encrypt('saved-root-token');
    const existing = { ugreen: { ...root, password: savedPassword, token: savedToken } };
    const saved = saveInheritedConfig({ ugreen: { enabled: true, instances: apiSaved } }, existing);
    assert.strictEqual(saved.ugreen.instances[0].password, savedPassword, 'masked inherited API passwords must remain encrypted after a real config save');
    assert.strictEqual(saved.ugreen.instances[1].token, savedToken, 'masked inherited API tokens must remain encrypted after a real config save');
    const savedCommunity = encrypt('saved-legacy-community');
    const savedAuth = encrypt('saved-legacy-auth');
    const savedPrivacy = encrypt('saved-legacy-privacy');
    h.populate({ method: 'snmp', host: 'legacy-nas.test', community: '__set__' });
    const legacyV2 = saveInheritedConfig({ ugreen: { instances: h.collect() } }, { ugreen: {
      method: 'snmp', host: 'legacy-nas.test', community: savedCommunity,
    } });
    assert.strictEqual(legacyV2.ugreen.instances[0].community, savedCommunity, 'host-only legacy SNMP community must survive migration to instance cards');
    h.populate({ method: 'snmp', host: 'legacy-nas.test', snmpVersion: 3, username: 'monitor', authPassword: '__set__', privPassword: '__set__' });
    const legacyV3 = saveInheritedConfig({ ugreen: { instances: h.collect() } }, { ugreen: {
      method: 'snmp', host: 'legacy-nas.test', snmpVersion: 3, username: 'monitor', authPassword: savedAuth, privPassword: savedPrivacy,
    } });
    assert.strictEqual(legacyV3.ugreen.instances[0].authPassword, savedAuth, 'host-only legacy SNMP authentication secret must survive migration');
    assert.strictEqual(legacyV3.ugreen.instances[0].privPassword, savedPrivacy, 'host-only legacy SNMP privacy secret must survive migration');
    const otherCommunity = encrypt('saved-other-port-community');
    const maskedPorts = { method: 'snmp', instances: [
      { host: 'ports-nas.test', port: 1161, community: '__set__' },
      { host: 'ports-nas.test', community: '__set__' },
    ] };
    h.populate(maskedPorts);
    const portsSaved = saveInheritedConfig({ ugreen: { instances: h.collect() } }, { ugreen: {
      method: 'snmp', instances: [
        { host: 'ports-nas.test', community: savedCommunity },
        { host: 'ports-nas.test', port: 1161, community: otherCommunity },
      ],
    } });
    assert.strictEqual(portsSaved.ugreen.instances[0].community, otherCommunity, 'port-specific secrets must follow the correct reordered service');
    assert.strictEqual(portsSaved.ugreen.instances[1].community, savedCommunity, 'omitted SNMP port must use the same identity as the default port 161');
    const [refreshedFirst] = h.populate(root);
    refreshedFirst.querySelector('.ugreen-password').value = 'new-password';
    refreshedFirst.querySelector('.ugreen-token').value = 'new-token';
    assert.strictEqual(h.collect()[0].password, 'new-password');
    assert.strictEqual(h.collect()[0].token, 'new-token');
  } finally {
    if (previousSecret === undefined) delete process.env.OMNISIGHT_SECRET;
    else process.env.OMNISIGHT_SECRET = previousSecret;
  }

  const snmpRoot = {
    method: 'snmp', snmpVersion: 3, username: 'snmp-user', securityLevel: 'authPriv',
    authProtocol: 'sha256', authPassword: '__encrypted__', privProtocol: 'aes256b', privPassword: '__set__',
    port: 1161, instances: [{ host: '192.0.2.28' }],
  };
  const [snmp] = h.populate(snmpRoot);
  assert.strictEqual(snmp.querySelector('.ugreen-snmp-fields').hidden, false);
  assert.strictEqual(snmp.querySelector('.ugreen-web-fields').hidden, true);
  assert.strictEqual(snmp.querySelector('.ugreen-snmp-v2-fields').hidden, true);
  assert.strictEqual(snmp.querySelector('.ugreen-snmp-v3-fields').hidden, false);
  const snmpSaved = h.collect()[0];
  assert.strictEqual(snmpSaved.host, '192.0.2.28', 'a host-only instance must survive saving without a name or URL');
  assert.strictEqual(snmpSaved.port, 1161);
  assert.strictEqual(snmpSaved.snmpVersion, 3);
  assert.strictEqual(snmpSaved.username, 'snmp-user');
  assert.strictEqual(snmpSaved.authPassword, '__set__');
  assert.strictEqual(snmpSaved.privPassword, '__set__');
  assert.strictEqual(snmpSaved.authProtocol, 'sha256');
  assert.strictEqual(snmpSaved.privProtocol, 'aes256b');
  const snmpStored = saveInheritedConfig({ ugreen: { instances: [snmpSaved] } }, { ugreen: {
    ...snmpRoot, authPassword: 'saved-root-auth-secret', privPassword: 'saved-root-priv-secret',
  } });
  assert.strictEqual(snmpStored.ugreen.instances[0].authPassword, 'saved-root-auth-secret', 'root SNMP authentication secrets must survive the actual config save path');
  assert.strictEqual(snmpStored.ugreen.instances[0].privPassword, 'saved-root-priv-secret', 'root SNMP privacy secrets must survive the actual config save path');
  snmp.querySelector('.ugreen-security-level').value = 'authNoPriv';
  h.context.syncUgreenFields(snmp);
  assert.strictEqual(snmp.querySelector('.ugreen-snmp-auth-fields').hidden, false);
  assert.strictEqual(snmp.querySelector('.ugreen-snmp-priv-fields').hidden, true);
  snmp.querySelector('.ugreen-security-level').value = 'noAuthNoPriv';
  h.context.syncUgreenFields(snmp);
  assert.strictEqual(snmp.querySelector('.ugreen-snmp-auth-fields').hidden, true);

  const [community] = h.populate({ method: 'snmp', host: 'nas.test', snmpVersion: 2, community: '__set__' });
  assert.strictEqual(community.querySelector('.ugreen-snmp-v2-fields').hidden, false);
  assert.strictEqual(community.querySelector('.ugreen-snmp-v3-fields').hidden, true);
  assert.strictEqual(h.collect()[0].community, '__set__', 'legacy top-level SNMP secrets must retain their masked marker');
  assert.strictEqual(h.collect()[0].port, 161);

  h.populate({ method: 'snmp', community: 'fixture', instances: [{ host: 'nas.test', port: 161 }, { host: 'nas.test', port: 1161 }] });
  assert.strictEqual(h.collect().length, 2, 'SNMP services on separate ports must not be deduplicated');
  testNasRendering();
  const [aliased] = h.populate({ method: 'web', username: 'global', instances: [{ url: 'http://nas.test', connectionMethod: 'api', user: 'local' }] });
  assert.strictEqual(aliased.querySelector('.ugreen-method').value, 'api', 'row method aliases must override inherited defaults in settings');
  assert.strictEqual(aliased.querySelector('.ugreen-api-username').value, 'local');
  console.log('smoke ok — UGREEN settings: modes, inherited defaults, encrypted secrets, legacy config, SNMP v2/v3 and NAS health rendering');
}

module.exports = { run };
if (require.main === module) {
  try { run(); } catch (error) { console.error(error); process.exitCode = 1; }
}
