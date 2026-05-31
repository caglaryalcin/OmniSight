const http = require('http');
const fs = require('fs');
const os = require('os');
const { Client } = require('ssh2');

function expandPath(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
}

function buildSshOpts(host) {
  const opts = {
    host: host.sshHost,
    port: host.sshPort || 22,
    username: host.sshUser || 'root',
    readyTimeout: 8000,
    tryKeyboard: true,
  };
  if (host.privateKey) {
    try { opts.privateKey = fs.readFileSync(expandPath(host.privateKey)); }
    catch (e) { throw new Error(`cannot read key (${host.privateKey}): ${e.message}`); }
  }
  if (host.sshKey) opts.privateKey = host.sshKey;
  if (host.sshPassword) opts.password = host.sshPassword;
  return opts;
}

function sshConnect(host) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let opts;
    try { opts = buildSshOpts(host); }
    catch (e) { return reject(e); }
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    if (opts.tryKeyboard) {
      conn.on('keyboard-interactive', (n, i, l, p, finish) => finish([host.sshPassword || '']));
    }
    conn.connect(opts);
  });
}

function httpBodyBuffer(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep === -1) return Buffer.alloc(0);
  const head = raw.slice(0, sep).toString('utf8');
  let body = raw.slice(sep + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    let decoded = Buffer.alloc(0);
    let rest = body;
    while (rest.length) {
      const nl = rest.indexOf('\r\n');
      if (nl === -1) break;
      const size = parseInt(rest.slice(0, nl).toString('utf8').trim(), 16);
      if (!size) break;
      decoded = Buffer.concat([decoded, rest.slice(nl + 2, nl + 2 + size)]);
      rest = rest.slice(nl + 2 + size + 2);
    }
    body = decoded;
  }
  return body;
}

function socketRawSSH(conn, host, reqPath) {
  return new Promise((resolve, reject) => {
    const socketPath = host.socketPath || '/var/run/docker.sock';
    const timeout = setTimeout(() => reject(new Error('socket forward timeout')), 12000);
    conn.openssh_forwardOutStreamLocal(socketPath, (err, stream) => {
      if (err) { clearTimeout(timeout); err.forwardFailed = true; return reject(err); }
      const chunks = [];
      stream.on('data', d => { chunks.push(d); });
      stream.on('end', () => { clearTimeout(timeout); resolve(httpBodyBuffer(Buffer.concat(chunks))); });
      stream.on('error', e => { clearTimeout(timeout); reject(e); });
      stream.end(`GET ${reqPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
  });
}

async function socketJsonSSH(conn, host, reqPath) {
  const body = await socketRawSSH(conn, host, reqPath);
  const text = body.toString('utf8');
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid JSON: ' + text.slice(0, 120)); }
}

function rawLocal(host, reqPath) {
  return new Promise((resolve, reject) => {
    const opts = host.socketPath
      ? { socketPath: host.socketPath, path: reqPath, method: 'GET', headers: { Host: 'localhost' } }
      : { hostname: host.host, port: host.port || 2375, path: reqPath, method: 'GET' };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function jsonLocal(host, reqPath) {
  const text = (await rawLocal(host, reqPath)).toString('utf8');
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid JSON: ' + text.slice(0, 120)); }
}

function parseExecPorts(str) {
  if (!str) return [];
  const seen = new Set();
  const out = [];
  str.split(',').forEach(part => {
    const m = part.trim().match(/(?:[\w.:\[\]]+:)?(\d+)->(\d+)\/\w+/);
    if (m) {
      const key = m[1] + '->' + m[2];
      if (!seen.has(key)) { seen.add(key); out.push({ PublicPort: +m[1], PrivatePort: +m[2] }); }
    }
  });
  return out;
}

function execOnce(conn, host, dockerArgs, useSudo) {
  return new Promise((resolve, reject) => {
    const base = `PATH=$PATH:/usr/bin:/usr/local/bin:/snap/bin docker ${dockerArgs}`;
    const cmd = useSudo ? `sudo -S -p '' sh -c "${base}"` : base;
    const timeout = setTimeout(() => reject(new Error('exec timeout')), 15000);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timeout); return reject(err); }
      let out = '', errOut = '';
      if (useSudo && host.sshPassword) stream.write(host.sshPassword + '\n');
      stream.on('data', d => { out += d; });
      stream.stderr.on('data', d => { errOut += d; });
      stream.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) return reject(new Error(`exit ${code}: ${(errOut || out).trim().slice(0, 200)}`));
        resolve(out);
      });
    });
  });
}

async function execAuto(conn, host, dockerArgs) {
  const attempts = host.sudo === true ? [true] : host.sudo === false ? [false] : [false, true];
  let lastErr;
  for (const useSudo of attempts) {
    try { return await execOnce(conn, host, dockerArgs, useSudo); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function parsePsJson(out) {
  return out.trim().split('\n').filter(Boolean).map(l => {
    let c; try { c = JSON.parse(l); } catch { return null; }
    return {
      Id: c.ID || '',
      Names: [c.Names || ''],
      Image: c.Image || '',
      State: c.State || '',
      Status: c.Status || '',
      Ports: parseExecPorts(c.Ports || ''),
    };
  }).filter(Boolean);
}

const DANGLING = '/images/json?filters=' + encodeURIComponent('{"dangling":["true"]}');

async function fetchHostData(host) {
  if (host.type !== 'ssh') {
    const [containers, imgs] = await Promise.all([
      jsonLocal(host, '/containers/json?all=1'),
      jsonLocal(host, DANGLING).catch(() => null),
    ]);
    return { containers, unused: Array.isArray(imgs) ? imgs.length : null };
  }
  const conn = await sshConnect(host);
  try {
    try {
      const containers = await socketJsonSSH(conn, host, '/containers/json?all=1');
      const imgs = await socketJsonSSH(conn, host, DANGLING).catch(() => null);
      return { containers, unused: Array.isArray(imgs) ? imgs.length : null };
    } catch (e) {
      if (!e.forwardFailed) throw e;
      const containers = parsePsJson(await execAuto(conn, host, `ps -a --format '{{json .}}'`));
      let unused = null;
      try {
        const o = (await execAuto(conn, host, 'images -f dangling=true -q')).trim();
        unused = o ? o.split('\n').filter(Boolean).length : 0;
      } catch {}
      return { containers, unused };
    }
  } finally {
    conn.end();
  }
}

function demuxDockerLog(buf) {
  if (!buf.length) return '';
  const parts = [];
  let i = 0, framed = true;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    if (type > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) { framed = false; break; }
    const size = buf.readUInt32BE(i + 4);
    if (i + 8 + size > buf.length) { framed = false; break; }
    parts.push(buf.slice(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  if (framed && i === buf.length) return parts.join('');
  return buf.toString('utf8');
}

async function getContainerLogs(config, hostName, id, tail) {
  const host = (config.hosts || []).find(h => h.name === hostName);
  if (!host) throw new Error('host not found: ' + hostName);
  const t = Math.min(2000, Math.max(1, parseInt(tail) || 300));
  const reqPath = `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${t}`;
  if (host.type !== 'ssh') return demuxDockerLog(await rawLocal(host, reqPath));
  const conn = await sshConnect(host);
  try {
    try {
      return demuxDockerLog(await socketRawSSH(conn, host, reqPath));
    } catch (e) {
      if (!e.forwardFailed) throw e;
      return await execAuto(conn, host, `logs --timestamps --tail ${t} ${id} 2>&1`);
    }
  } finally {
    conn.end();
  }
}

function parseUptime(startedAt) {
  if (!startedAt || startedAt.startsWith('0001')) return null;
  const s = Math.floor((Date.now() - new Date(startedAt)) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function stateColor(state) {
  switch (state) {
    case 'running':    return 'green';
    case 'paused':     return 'yellow';
    case 'restarting': return 'yellow';
    case 'exited':     return 'red';
    case 'dead':       return 'red';
    default:           return 'gray';
  }
}

async function getHostData(host) {
  const { containers: rawContainers, unused } = await fetchHostData(host);

  const containers = rawContainers.map(c => {
    const name = (Array.isArray(c.Names) ? c.Names[0] : c.Names || '').replace(/^\//, '');
    const image = c.Image || '';
    const imageShort = image.split('/').pop().split(':')[0];
    const state = (c.State || '').toLowerCase();
    const ports = Array.isArray(c.Ports)
      ? c.Ports.filter(p => p.PublicPort).map(p => `${p.PublicPort}→${p.PrivatePort}`).slice(0, 3)
      : [];
    return {
      id: (c.Id || c.ID || '').slice(0, 12),
      name, image, imageShort, state,
      status: c.Status || state,
      uptime: parseUptime(c.StartedAt),
      ports,
      color: stateColor(state),
    };
  }).sort((a, b) => {
    const order = { running: 0, restarting: 1, paused: 2, exited: 3, dead: 4 };
    return (order[a.state] ?? 5) - (order[b.state] ?? 5);
  });

  const running = containers.filter(c => c.state === 'running').length;
  const stopped = containers.filter(c => c.state === 'exited' || c.state === 'dead').length;
  const other   = containers.length - running - stopped;

  return { name: host.name, online: true, containers, summary: { total: containers.length, running, stopped, other, unused } };
}

async function getAllDockerData(config) {
  const hosts = config.hosts || [];
  const results = await Promise.allSettled(hosts.map(getHostData));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: hosts[i].name, online: false, error: r.reason?.message, containers: [], summary: { total: 0, running: 0, stopped: 0, other: 0, unused: null } }
  );
}

module.exports = { getAllDockerData, getContainerLogs };
