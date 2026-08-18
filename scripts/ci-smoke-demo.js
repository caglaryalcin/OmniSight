#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

function request(server, { method = 'GET', pathname = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    get length() { return data.size; },
    key(index) { return Array.from(data.keys())[index] ?? null; },
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
  };
}

function testDemoBrowserDailyReset() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'demo-reset.js'), 'utf8');
  const localStorage = memoryStorage({
    os_theme: 'light',
    os_token: 'keep-local-token',
    omnisight_topology_positions: '{"changed":true}',
    unrelated: 'keep',
  });
  const sessionStorage = memoryStorage({
    os_status_cache_v2: '{"changed":true}',
    os_token: 'keep-session-token',
  });
  const window = {};
  vm.runInNewContext(source, {
    window,
    document: { cookie: 'omnisight_demo_day=2026-08-16' },
    localStorage,
    sessionStorage,
  });

  assert.strictEqual(localStorage.getItem('os_theme'), null);
  assert.strictEqual(localStorage.getItem('omnisight_topology_positions'), null);
  assert.strictEqual(sessionStorage.getItem('os_status_cache_v2'), null);
  assert.strictEqual(localStorage.getItem('os_token'), 'keep-local-token');
  assert.strictEqual(sessionStorage.getItem('os_token'), 'keep-session-token');
  assert.strictEqual(localStorage.getItem('unrelated'), 'keep');
  assert.strictEqual(localStorage.getItem('omnisight_demo_reset_day'), '2026-08-16');

  localStorage.setItem('os_theme', 'light');
  assert.strictEqual(window.omnisightApplyDemoDailyReset('2026-08-16'), false);
  assert.strictEqual(localStorage.getItem('os_theme'), 'light');
  assert.strictEqual(window.omnisightApplyDemoDailyReset('2026-08-17'), true);
  assert.strictEqual(localStorage.getItem('os_theme'), null);
}

function testDemoFileUploadLock() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'demo-upload-lock.js'), 'utf8');
  const attributes = new Map();
  const fileInput = {
    nodeType: 1,
    disabled: false,
    value: 'selected.pem',
    matches: selector => selector === 'input[type="file"]',
    setAttribute: (name, value) => attributes.set(`input:${name}`, String(value)),
    querySelectorAll: () => [],
  };
  const uploadButton = {
    nodeType: 1,
    disabled: false,
    dataset: {},
    matches: () => false,
    getAttribute: name => name === 'onclick' ? "document.getElementById('cert-file').click()" : '',
    setAttribute: (name, value) => attributes.set(`button:${name}`, String(value)),
    querySelectorAll: () => [],
  };
  const documentElement = {
    nodeType: 1,
    setAttribute: (name, value) => attributes.set(`html:${name}`, String(value)),
  };
  const document = {
    readyState: 'complete',
    documentElement,
    head: { appendChild: () => {} },
    createElement: () => ({ textContent: '' }),
    getElementById: id => id === 'cert-file' ? fileInput : null,
    querySelectorAll: selector => selector === 'input[type="file"]' ? [fileInput] : selector === '[onclick]' ? [uploadButton] : [],
    addEventListener: () => {},
  };
  const window = {};
  vm.runInNewContext(source, { window, document });

  assert.strictEqual(fileInput.disabled, true);
  assert.strictEqual(fileInput.value, '');
  assert.strictEqual(uploadButton.disabled, true);
  assert.strictEqual(uploadButton.dataset.demoFileUploadTrigger, 'true');
  assert.strictEqual(attributes.get('html:data-demo-file-uploads'), 'disabled');
  assert.strictEqual(attributes.get('button:title'), 'File uploads are disabled in demo mode.');
}

async function run() {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  const { app, demoAppVersion, demoConfig, topologyData, ensureDemoDailyReset } = require('../demo-server');
  assert.strictEqual(demoAppVersion(), packageVersion);
  testDemoBrowserDailyReset();
  testDemoFileUploadLock();

  const server = await listen(app);
  try {
    const loginBody = JSON.stringify({ username: 'demo', password: 'demo' });
    const login = await request(server, {
      method: 'POST',
      pathname: '/api/login',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(loginBody),
      },
      body: loginBody,
    });
    assert.strictEqual(login.statusCode, 200);
    const sessionCookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    assert.ok(sessionCookie.startsWith('omnisight_demo_session='));

    const page = await request(server, { pathname: '/', headers: { Cookie: sessionCookie } });
    assert.strictEqual(page.statusCode, 200);
    assert.ok(page.body.includes(`const APP_VERSION = ${JSON.stringify(packageVersion)};`));
    assert.ok(page.body.includes('<script src="/demo-reset.js"></script>'));
    assert.match(page.body, /<script src="\/demo-upload-lock\.js\?v=[^"]+"><\/script>/);
    assert.match(String(page.headers['cache-control'] || ''), /no-cache/);
    assert.ok([].concat(page.headers['set-cookie'] || []).some(cookie => cookie.startsWith('omnisight_demo_day=')));

    for (const pathname of ['/healthz', '/api/about', '/api/auth-status']) {
      const response = await request(server, { pathname, headers: { Cookie: sessionCookie } });
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(JSON.parse(response.body).version, packageVersion);
    }

    const summaryResponse = await request(server, { pathname: '/api/status/summary', headers: { Cookie: sessionCookie } });
    assert.strictEqual(summaryResponse.statusCode, 200);
    const summary = JSON.parse(summaryResponse.body);
    assert.match(summary.demoResetDay, /^\d{4}-\d{2}-\d{2}$/);
    const summaryById = Object.fromEntries(summary.health.map(item => [item.id, item]));
    assert.deepStrictEqual({ offline: summaryById.unifi.offline, online: summaryById.unifi.online, total: summaryById.unifi.total }, { offline: 1, online: 3, total: 5 });
    assert.deepStrictEqual({ offline: summaryById.uptimekuma.offline, online: summaryById.uptimekuma.online, total: summaryById.uptimekuma.total }, { offline: 1, online: 3, total: 4 });

    const changedConfig = JSON.stringify({ preferredLanguage: 'tr', publicStatus: true, publicTitle: 'Changed demo', publicDescription: 'Changed' });
    const configUpdate = await request(server, {
      method: 'POST',
      pathname: '/api/config',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(changedConfig) },
      body: changedConfig,
    });
    assert.strictEqual(configUpdate.statusCode, 200);

    const changedTopology = JSON.stringify({ links: [], nodes: ['changed-node'], hidden: [], positions: { 'changed-node': { x: 1, y: 2 } }, view: { scale: 1, x: 0, y: 0 } });
    const topologyUpdate = await request(server, {
      method: 'POST',
      pathname: '/api/topology/links',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(changedTopology) },
      body: changedTopology,
    });
    assert.strictEqual(topologyUpdate.statusCode, 200);

    const removeAgent = JSON.stringify({ id: 'demo-agent' });
    const agentUpdate = await request(server, {
      method: 'POST',
      pathname: '/api/agent/remove',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(removeAgent) },
      body: removeAgent,
    });
    assert.strictEqual(agentUpdate.statusCode, 200);
    assert.strictEqual(demoConfig().publicTitle, 'Changed demo');
    assert.deepStrictEqual(topologyData().topologyNodes, ['changed-node']);

    assert.strictEqual(ensureDemoDailyReset(Date.now() + (3 * 86400000)), true);
    assert.strictEqual(demoConfig().publicTitle, 'OmniSight Demo Status');
    assert.ok(topologyData().topologyNodes.includes('kubernetes:cluster'));
    assert.ok(!topologyData().topologyNodes.includes('changed-node'));

    const agentsAfterReset = await request(server, { pathname: '/api/agents', headers: { Cookie: sessionCookie } });
    assert.strictEqual(JSON.parse(agentsAfterReset.body).agents.length, 2);

    for (const pathname of [
      '/api/upload/certificate',
      '/API/upload/certificate/',
      '/api/upload/icon',
      '/api/upload/kubeconfig',
      '/api/profile/avatar',
      '/api/config/import',
      '/api/backup/import',
      '/api/onboarding/import',
    ]) {
      const blockedBody = JSON.stringify({ name: 'blocked', dataUrl: 'data:text/plain;base64,WA==', backup: 'blocked' });
      const blocked = await request(server, {
        method: 'POST',
        pathname,
        headers: { Cookie: sessionCookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(blockedBody) },
        body: blockedBody,
      });
      assert.strictEqual(blocked.statusCode, 403, `${pathname} should be blocked in demo mode`);
      const blockedResult = JSON.parse(blocked.body);
      assert.strictEqual(blockedResult.code, 'DEMO_FILE_UPLOADS_DISABLED');
      assert.strictEqual(blockedResult.error, 'File uploads are disabled in demo mode.');
    }
    ensureDemoDailyReset(Date.now());
  } finally {
    await close(server);
  }
  console.log(`smoke ok — demo version: ${packageVersion}`);
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exit(1); });
