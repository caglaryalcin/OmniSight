#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

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

async function run() {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  const { app, demoAppVersion } = require('../demo-server');
  assert.strictEqual(demoAppVersion(), packageVersion);

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
    assert.match(String(page.headers['cache-control'] || ''), /no-cache/);

    for (const pathname of ['/healthz', '/api/about', '/api/auth-status']) {
      const response = await request(server, { pathname, headers: { Cookie: sessionCookie } });
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(JSON.parse(response.body).version, packageVersion);
    }
  } finally {
    await close(server);
  }
  console.log(`smoke ok — demo version: ${packageVersion}`);
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exit(1); });
