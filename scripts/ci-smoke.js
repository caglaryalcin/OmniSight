#!/usr/bin/env node
// CI smoke test: syntax-load core modules and exercise alert dispatch
// against a local mock HTTP endpoint. No network, no Docker, no config.
const http = require('http');
const assert = require('assert');

async function main() {
  // 1) Core modules load
  const { dispatchAlert } = require('../src/alerts');
  const { encryptConfigValue, isEncrypted, decryptConfig } = require('../src/crypto');

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
}

main().catch(err => { console.error(err); process.exit(1); });
