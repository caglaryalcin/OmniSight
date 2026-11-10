// UGOS protocol regressions against local HTTP and WebSocket fixtures.
// Shapes follow published hardware responses and source references in the
// UGREEN integration documentation; these fixtures are not a real NAS capture.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');

const PASSWORD = 'Fixture-password-28!';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { getAllUgreenData, configuredInstances, _resetRuntime } = require('../src/ugreen');

function decryptLoginPassword(ciphertext) {
  // Recent Node/OpenSSL rejects PKCS#1 v1.5 privateDecrypt. Inspect the test
  // key's raw RSA block instead; production only needs publicEncrypt.
  const block = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(ciphertext, 'base64'));
  assert.strictEqual(block[0], 0);
  assert.strictEqual(block[1], 2, 'login password must use RSA PKCS#1 v1.5 padding');
  const separator = block.indexOf(0, 2);
  assert.ok(separator >= 10, 'PKCS#1 v1.5 needs at least eight padding bytes');
  return block.subarray(separator + 1).toString('utf8');
}

function decryptAes(key, encoded) {
  const bytes = Buffer.from(encoded, 'base64');
  assert.ok(bytes.length >= 28, 'AES-GCM payload must contain a 12-byte IV and 16-byte tag');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
}

function encryptAes(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

async function fixture(options = {}) {
  const name = options.name || 'Fixture NAS';
  const tokens = new Set(options.token ? [options.token] : []);
  const requests = [];
  const sockets = new Set();
  const state = { checks: 0, logins: 0, stats: 0, wsConnections: 0, subscriptions: [], loginBodies: [], expired: false, encryptedDiskReads: 0 };
  const now = Math.floor(Date.now() / 1000);
  const ok = data => ({ code: 200, msg: 'success', data });
  const machine = {
    common: { nas_name: name, model: 'DXP4800 Plus', system_version: '1.18.1.0098', run_time: 86400 },
    hardware: {
      cpu: [{ model: 'Fixture CPU', core: 5, thread: 6, temperature: 44 }],
      mem: [{ size: 8589934592 }], net: [], usb: null, ups: null, gpu: null,
    },
  };
  const pool = {
    name: 'pool1', label: 'Storage Pool 1', level: 'raid1', status: options.poolStatus ?? 0,
    total: 1000, used: 1000, available: 0,
    volumes: [{ name: 'volume1', label: 'Volume 1', status: options.volumeStatus ?? 0, health: 0, filesystem: 'btrfs', mntpath: '/volume1', total: 900, used: 180, available: 720 }],
  };
  const disks = [
    { name: 'sda', dev_name: '/dev/sda', slot: 'ata1', label: 'Disk 1', model: 'Fixture HDD', type: 0, interface_type: 'sata', size: 4000000000000, status: options.diskStatus ?? 1, temperature: 35, is_standby: false },
    { name: 'nvme0n1', dev_name: '/dev/nvme0n1', slot: 'nvme1', label: 'M.2 Drive 1', model: 'Fixture NVMe', type: 2, interface_type: 'm2', size: 1000000000000, status: 1, temperature: 41, is_standby: false },
  ];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    let responseKey;
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      const payload = responseKey ? { encrypt_resp_body: encryptAes(responseKey, JSON.stringify(body)) } : body;
      if (responseKey && options.corruptEncryptedResponse) {
        const raw = Buffer.from(payload.encrypt_resp_body, 'base64');
        raw[raw.length - 1] ^= 1;
        payload.encrypt_resp_body = raw.toString('base64');
      }
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/' || url.pathname === options.webPath) {
      res.writeHead(options.webStatus || 200, { 'Content-Type': 'text/html' });
      return res.end('<html><title>UGOS Pro</title></html>');
    }
    if (url.pathname === '/ugreen/v1/verify/check') {
      state.checks += 1;
      if (options.htmlApi) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>Sign in</html>');
      }
      let key = options.badKey ? 'not-a-key' : options.derKey
        ? publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
        : Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
      if (options.mislabelledSpki) {
        const pem = publicKey.export({ type: 'spki', format: 'pem' }).replace(/PUBLIC KEY/g, 'RSA PUBLIC KEY');
        key = Buffer.from(pem).toString('base64');
      }
      return json(200, ok({}), { 'x-rsa-token': key, 'Set-Cookie': 'ug-check=fixture; Path=/' });
    }
    if (url.pathname === '/ugreen/v1/verify/login') {
      state.logins += 1;
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw);
          state.loginBodies.push(body);
          assert.strictEqual(body.username, options.username || 'monitor');
          assert.notStrictEqual(body.password, PASSWORD, 'credentials must never fall back to plaintext');
          assert.strictEqual(decryptLoginPassword(body.password), PASSWORD);
          assert.strictEqual(body.keepalive, true);
          assert.strictEqual(body.otp, true, 'login must request a detectable 2FA handshake');
          if (options.cookies) assert.match(req.headers.cookie || '', /ug-check=fixture/, 'handshake cookies must survive until login');
          if (options.rejectLogin) return json(200, { code: 1003, msg: 'Incorrect account or password', data: {} });
          if (options.otp) return json(200, ok({ enable_otp: true, token_id: 'pending-second-factor' }));
          const token = `${name.replace(/\W/g, '')}-secret-token-${state.logins}`;
          tokens.add(token);
          const sessionPem = publicKey.export({ type: 'spki', format: 'pem' });
          const sessionPublicKey = options.encryptedDisks ? options.sessionKeyAsPem ? sessionPem : Buffer.from(sessionPem).toString('base64') : undefined;
          return json(200, ok({ token, auth_type: 'header', nas_name: name, model: 'DXP4800 Plus', public_key: sessionPublicKey }), { 'Set-Cookie': 'ug-session=fixture; Path=/; HttpOnly' });
        } catch (error) {
          state.protocolError = error;
          return json(400, { code: 1005, msg: 'Fixture rejected login', data: {} });
        }
      });
      return;
    }
    if (url.pathname === '/ugreen/v1/verify/heartbeat') return json(200, ok({}));
    let token = url.searchParams.get('token') || req.headers['x-ugreen-token'];
    if (url.pathname === '/ugreen/v2/storage/disk/list' && options.encryptedDisks) {
      try {
        const requestKey = decryptLoginPassword(req.headers['x-ugreen-security-code']);
        assert.match(requestKey, /^[0-9a-f]{32}$/, 'UGOS AES key must be 32 ASCII hex characters, not 16 decoded bytes');
        responseKey = Buffer.from(requestKey, 'ascii');
        const query = new URLSearchParams(decryptAes(responseKey, url.searchParams.get('encrypt_query')));
        token = query.get('token');
        assert.ok(token, 'encrypted query must contain the session token');
        assert.strictEqual(decryptLoginPassword(req.headers['x-ugreen-token']), token, 'token header must be RSA sealed with the session key');
        assert.strictEqual(req.headers['x-ugreen-security-key'], crypto.createHash('md5').update(token).digest('hex'));
        assert.strictEqual(url.searchParams.has('token'), false, 'encrypted disk requests must not expose a plaintext token query parameter');
        state.encryptedDiskReads += 1;
      } catch (error) {
        state.protocolError = error;
        responseKey = null;
        return json(400, { code: 1005, msg: 'Fixture rejected encrypted transport', data: {} });
      }
    }
    if (!tokens.has(token)) return json(200, { code: 1024, msg: 'Login expired', data: {} });
    if (options.cookies && !/ug-session=fixture/.test(req.headers.cookie || '')) return json(401, { code: 1024, msg: 'Session cookie missing', data: {} });
    if (url.pathname === '/ugreen/v1/sysinfo/machine/common') {
      if (options.alwaysExpired || (options.expireOnce && !state.expired)) {
        state.expired = true;
        tokens.delete(token);
        return json(200, { code: 1024, msg: 'Login expired', data: {} });
      }
      return json(200, ok(machine));
    }
    if (['/ugreen/v1/taskmgr/stat/get_all', '/ugreen/v1/taskmgr/stat/overview'].includes(url.pathname)) {
      if (options.legacyStats) return json(404, { code: 9404, msg: 'Not found', data: {} });
      if (options.statsForbidden) return json(403, { code: 1008, msg: 'Permission denied', data: {} });
      if (options.requireWs !== false && !sockets.size) return json(503, { code: 9999, msg: 'Telemetry is asleep', data: {} });
      state.stats += 1;
      const overview = {
        cpu: [{ used_percent: 12, temp: 40, time: now - 5 }, { used_percent: options.zeroStats ? 0 : 31.5 + state.stats - 1, temp: 47.25, time: now }],
        mem: [{ used_percent: 12, time: now - 5 }, { used_percent: options.zeroStats ? '0' : '38', time: now }],
        net: [{ recv_rate: 1250000, send_rate: 250000, time: now }],
        cpu_fan: [{ speed: 1200, status: 1 }], device_fan: [{ speed: 800, status: 1 }],
      };
      const data = options.overviewOnly || url.pathname.endsWith('/overview') ? overview : {
        overview, mem: { structure: { total: 8589934592, used: 3264175145, free: 5325759447 } },
      };
      return json(200, ok(data));
    }
    if (url.pathname === '/ugreen/v1/desktop/components/data') {
      if (url.searchParams.get('id') === 'desktop.component.DeviceMonitoring') return json(200, ok({ cpu_usage_rate: 31.5, ram_usage_rate: '38', upload_speed: { raw: 250000 }, download_speed: { raw: 1250000 } }));
      if (url.searchParams.get('id') === 'desktop.component.TemperatureMonitoring') return json(200, ok({ cpu_temperature: 47.25, fan_speed: 800 }));
      if (url.searchParams.get('id') === 'desktop.component.SystemStatus') return json(200, ok({ total_run_time: 86400 }));
    }
    if (url.pathname === '/ugreen/v1/storage/pool/list') return json(200, ok({ result: [pool] }));
    if (url.pathname === '/ugreen/v2/storage/disk/list') {
      if (options.disksForbidden) return json(403, { code: 1008, msg: 'Permission denied', data: {} });
      return json(200, ok({ result: disks }));
    }
    return json(404, { code: 9404, msg: 'Not found', data: {} });
  });
  const wsServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (url.pathname !== '/ugreen/v1/desktop/ws' || !tokens.has(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, ws => {
      state.wsConnections += 1;
      sockets.add(ws);
      ws.on('message', raw => {
        try { state.subscriptions.push(JSON.parse(raw.toString())); } catch {}
      });
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state, requests,
    async waitForTelemetryClose() {
      if (!sockets.size) return;
      let timer;
      try {
        await Promise.race([
          Promise.all([...sockets].map(ws => new Promise(resolve => ws.once('close', resolve)))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Disabled integration left its telemetry socket open')), 2000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
    async close() {
      _resetRuntime();
      for (const ws of sockets) ws.terminate();
      wsServer.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (state.protocolError) throw state.protocolError;
    },
  };
}

function config(url, extra = {}) {
  return { url, method: 'api', username: 'monitor', password: PASSWORD, timeoutMs: 2000, ...extra };
}

async function withFixture(options, callback) {
  _resetRuntime();
  const server = await fixture(options);
  try { await callback(server); } finally { await server.close(); }
}

async function run() {
  await withFixture({ cookies: true }, async server => {
    const first = await getAllUgreenData(config(server.url));
    const nas = first.instances[0];
    assert.strictEqual(nas.online, true, nas.error);
    assert.strictEqual(nas.method, 'api');
    assert.strictEqual(nas.system.hostname, 'Fixture NAS');
    assert.strictEqual(nas.system.model, 'DXP4800 Plus');
    assert.strictEqual(nas.system.version, '1.18.1.0098');
    assert.strictEqual(nas.system.uptimeSeconds, 86400);
    assert.strictEqual(nas.system.cpuPercent, 31.5, 'the most recent CPU sample must be used, already in percent');
    assert.strictEqual(nas.system.memoryPercent, 38);
    assert.strictEqual(nas.system.cpuTemp, 47.25);
    assert.strictEqual(nas.volumes.length, 1);
    assert.strictEqual(nas.volumes[0].totalBytes, 900);
    assert.strictEqual(nas.volumes[0].usedBytes, 180);
    assert.strictEqual(nas.volumes[0].usedPercent, 20);
    assert.strictEqual(nas.summary.usedPercent, 20, 'pool allocation must not make a mostly empty filesystem look full');
    assert.strictEqual(nas.disks.length, 2);
    assert.strictEqual(nas.disks[0].temperature, 35);
    assert.strictEqual(nas.disks[1].type, 'ssd', 'NVMe must use SSD temperature limits');
    assert.strictEqual(nas.available.system, true);
    assert.strictEqual(nas.available.storage, true);
    assert.strictEqual(nas.available.disks, true);
    assert.strictEqual(nas.partial, false, (nas.errors || []).join('; '));
    const second = await getAllUgreenData(config(server.url));
    assert.strictEqual(second.instances[0].system.cpuPercent, 32.5, 'polling must obtain a fresh sample');
    assert.strictEqual(server.state.logins, 1, 'polls must reuse an authenticated session');
    assert.strictEqual(server.state.wsConnections, 1, 'polls must reuse the telemetry keepalive socket');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(server.state.subscriptions.some(message => message.op === 'subscribe' && message.topics?.includes('cpu_usage') && message.topics?.includes('cpu_temp')), 'telemetry socket must subscribe to wake UGOS monitoring');
    assert.ok(!server.requests.some(request => /smart|\/start|\/stop|\/delete|\/create/.test(request.path)), 'monitoring must not start SMART tests or storage operations');
    assert.ok(!JSON.stringify(first).includes(PASSWORD), 'collector output must not expose credentials');
    assert.ok(!JSON.stringify(first).includes('secret-token'), 'collector output must not expose session tokens');
  });

  for (const keyFormat of [{ derKey: true }, { mislabelledSpki: true }]) {
    await withFixture(keyFormat, async server => {
      const result = await getAllUgreenData(config(server.url));
      assert.strictEqual(result.instances[0].online, true, 'DER keys and firmware-mislabelled SPKI login keys must work');
    });
  }

  await withFixture({ zeroStats: true }, async server => {
    const result = await getAllUgreenData(config(server.url));
    assert.strictEqual(result.instances[0].system.cpuPercent, 0, 'a zero CPU reading must not become missing telemetry');
    assert.strictEqual(result.instances[0].system.memoryPercent, 0, 'a numeric-string zero RAM reading must remain valid');
  });

  await withFixture({ diskStatus: 4, poolStatus: 3, volumeStatus: 2 }, async server => {
    const result = await getAllUgreenData(config(server.url));
    const nas = result.instances[0];
    assert.strictEqual(nas.online, true, 'a NAS with a hardware fault can still be reachable');
    assert.strictEqual(nas.partial, false, 'successfully collected hardware faults are distinct from unavailable telemetry');
    assert.strictEqual(nas.degraded, true, 'known disk, pool and volume problems must affect the NAS health');
    assert.strictEqual(nas.summary.disksWarn, 1);
    assert.strictEqual(nas.summary.poolsWarn, 1);
    assert.strictEqual(nas.summary.volumesWarn, 1);
    assert.strictEqual(nas.disks[0].status, 'failure');
    assert.strictEqual(result.summary.degraded, 1);
  });

  await withFixture({ poolStatus: 1 }, async server => {
    const result = await getAllUgreenData(config(server.url));
    const nas = result.instances[0];
    assert.strictEqual(nas.pools[0].status, 'syncing');
    assert.strictEqual(nas.summary.poolsWarn, 0, 'normal RAID synchronization must not be reported as pool failure');
    assert.strictEqual(nas.degraded, false);
    assert.strictEqual(nas.partial, false);
  });

  for (const sessionKeyAsPem of [false, true]) {
    await withFixture({ encryptedDisks: true, sessionKeyAsPem }, async server => {
      const result = await getAllUgreenData(config(server.url));
      const nas = result.instances[0];
      assert.strictEqual(nas.online, true, nas.error);
      assert.strictEqual(nas.available.disks, true, (nas.errors || []).join('; '));
      assert.strictEqual(nas.disks.length, 2, 'AES-GCM disk responses must be decrypted into a verified API envelope');
      assert.strictEqual(nas.disks[1].temperature, 41);
      assert.strictEqual(server.state.encryptedDiskReads, 1);
    });
  }

  await withFixture({ encryptedDisks: true, corruptEncryptedResponse: true }, async server => {
    const result = await getAllUgreenData(config(server.url));
    const nas = result.instances[0];
    assert.strictEqual(nas.online, true, 'a corrupt optional disk response must retain valid system telemetry');
    assert.strictEqual(nas.available.disks, false, 'an invalid AES-GCM authentication tag must not produce a disk inventory');
    assert.strictEqual(nas.partial, true);
  });

  await withFixture({ expireOnce: true }, async server => {
    const result = await getAllUgreenData(config(server.url));
    assert.strictEqual(result.instances[0].online, true, 'one expired session must transparently reauthenticate');
    assert.strictEqual(server.state.logins, 2);
  });

  await withFixture({ alwaysExpired: true }, async server => {
    const result = await getAllUgreenData(config(server.url));
    assert.strictEqual(result.instances[0].online, false, 'permanently refused sessions must not look healthy');
    assert.ok(server.state.logins <= 2, 'authentication retry must be bounded');
    assert.ok(!JSON.stringify(result).includes('secret-token'), 'authentication errors must redact tokens');
  });

  await withFixture({ otp: true }, async server => {
    const result = await getAllUgreenData(config(server.url));
    assert.strictEqual(result.instances[0].online, false);
    assert.match(result.instances[0].error, /2fa|two.factor|otp/i, 'a second-factor requirement needs an actionable error');
    assert.strictEqual(server.state.logins, 1);
    assert.strictEqual(server.state.stats, 0);
  });

  for (const options of [{ rejectLogin: true }, { badKey: true }, { htmlApi: true }]) {
    await withFixture(options, async server => {
      const result = await getAllUgreenData(config(server.url));
      assert.strictEqual(result.instances[0].online, false, 'API failures must not silently fall back to a healthy web page');
      assert.ok(server.state.logins <= 1, 'credential/key failures must not repeatedly log in');
      assert.ok(!server.requests.some(request => request.path === '/'), 'API mode must not masquerade as web-check success');
      assert.ok(!JSON.stringify(result).includes(PASSWORD));
      const attemptedChecks = server.state.checks;
      const attemptedLogins = server.state.logins;
      const second = await getAllUgreenData(config(server.url));
      assert.strictEqual(second.instances[0].online, false);
      assert.strictEqual(server.state.checks, attemptedChecks, 'the next poll must respect the failed-login backoff');
      assert.strictEqual(server.state.logins, attemptedLogins, 'bad credentials must not be sent again on every poll');
    });
  }

  await withFixture({ disksForbidden: true }, async server => {
    const result = await getAllUgreenData(config(server.url));
    const nas = result.instances[0];
    assert.strictEqual(nas.online, true, 'a refused optional disk endpoint must retain valid system telemetry');
    assert.strictEqual(nas.system.cpuPercent, 31.5);
    assert.strictEqual(nas.partial, true);
    assert.strictEqual(nas.available.disks, false);
    assert.ok(nas.errors?.length);
  });

  await withFixture({ legacyStats: true }, async server => {
    const result = await getAllUgreenData(config(server.url));
    const nas = result.instances[0];
    assert.strictEqual(nas.online, true, nas.error);
    assert.strictEqual(nas.system.cpuPercent, 31.5, 'older firmware must use the desktop DeviceMonitoring response');
    assert.strictEqual(nas.system.memoryPercent, 38);
    assert.strictEqual(nas.system.cpuTemp, 47.25);
    assert.ok(server.requests.some(request => request.path === '/ugreen/v1/desktop/components/data'));
  });

  await withFixture({ token: 'preconfigured-fixture-token' }, async server => {
    const result = await getAllUgreenData({ url: server.url, method: 'api', token: 'preconfigured-fixture-token', timeoutMs: 2000 });
    assert.strictEqual(result.instances[0].online, true, result.instances[0].error);
    assert.strictEqual(server.state.logins, 0, 'a supplied API token must not require password login');
    assert.ok(!JSON.stringify(result).includes('preconfigured-fixture-token'));
  });

  await withFixture({}, async server => {
    const result = await getAllUgreenData({ url: server.url, method: 'web' });
    const nas = result.instances[0];
    assert.strictEqual(nas.online, true);
    assert.strictEqual(nas.method, 'web');
    assert.strictEqual(nas.available.system, false, 'web reachability must not claim NAS telemetry');
    assert.strictEqual(nas.available.storage, false);
    assert.strictEqual(nas.available.disks, false);
    assert.ok(nas.system.cpuPercent == null);
    assert.strictEqual(server.state.logins, 0);
    const before = server.requests.length;
    const unsupported = await getAllUgreenData({ url: server.url, method: 'invalid-fixture-method' });
    assert.strictEqual(unsupported.instances[0].online, false);
    assert.match(unsupported.instances[0].error, /unsupported|unknown|invalid/i);
    assert.strictEqual(server.requests.length, before, 'an unknown collection method must not send requests');
  });

  await withFixture({ webPath: '/ugreen/login' }, async server => {
    const result = await getAllUgreenData({ url: server.url + '/ugreen/login?returnTo=%2Fstorage&view=health', method: 'web' });
    assert.strictEqual(result.instances[0].online, true);
    assert.strictEqual(server.requests.length, 1);
    assert.strictEqual(server.requests[0].path, '/ugreen/login', 'web mode must probe the configured path without API-base normalization');
    assert.deepStrictEqual(server.requests[0].query, { returnTo: '/storage', view: 'health' }, 'web mode must preserve the configured query');
  });

  await withFixture({}, async server => {
    const input = config(server.url);
    const first = await getAllUgreenData(input);
    assert.strictEqual(first.instances[0].online, true);
    assert.strictEqual(server.state.wsConnections, 1);
    const before = server.requests.length;
    const disabled = await getAllUgreenData({ ...input, enabled: false });
    assert.strictEqual(disabled.instances.length, 0, 'disabled configuration must not continue collecting NAS telemetry');
    assert.strictEqual(server.requests.length, before);
    await server.waitForTelemetryClose();
  });

  await withFixture({}, async server => {
    const result = await getAllUgreenData({ instances: [config(server.url, { name: 'Reachable' }), config('http://127.0.0.1:1', { name: 'Unavailable' })] });
    assert.strictEqual(result.online, true, 'an unavailable NAS must not hide another working instance');
    assert.strictEqual(result.summary.up, 1);
    assert.strictEqual(result.summary.down, 1);
    assert.strictEqual(result.instances[0].online, true);
    assert.strictEqual(result.instances[1].online, false);
    assert.ok(result.instances[1].error);
  });

  _resetRuntime();
  const left = await fixture({ name: 'Left NAS', username: 'left' });
  const right = await fixture({ name: 'Right NAS', username: 'right' });
  try {
    const input = { method: 'api', password: PASSWORD, timeoutMs: 2000, instances: [{ name: 'Left', url: left.url, username: 'left' }, { name: 'Right', url: right.url, username: 'right' }] };
    const configured = configuredInstances(input);
    assert.ok(configured.every(row => row.method === 'api' && row.password === PASSWORD), 'global connection options must be inherited by instance rows');
    const result = await getAllUgreenData(input);
    assert.strictEqual(result.summary.up, 2);
    assert.deepStrictEqual(result.instances.map(row => row.system.hostname), ['Left NAS', 'Right NAS']);
    assert.strictEqual(left.state.logins, 1);
    assert.strictEqual(right.state.logins, 1);
  } finally {
    await left.close();
    await right.close();
  }

  _resetRuntime();
  const [aliased] = configuredInstances({ method: 'web', username: 'global', instances: [{ url: 'http://nas.test', connectionMethod: 'api', user: 'local' }] });
  assert.strictEqual(aliased.method, 'api', 'explicit row aliases must override inherited defaults');
  assert.strictEqual(aliased.username, 'local');
  const empty = await getAllUgreenData({});
  assert.strictEqual(empty.online, false);
  assert.deepStrictEqual(empty.instances, []);
  console.log('smoke ok — UGREEN: RSA auth, sessions, 2FA, live WebSocket telemetry, legacy firmware, partial data, web mode and instance isolation');
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exit(1); });
