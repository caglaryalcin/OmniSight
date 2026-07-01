const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Client } = require('ssh2');
const { imageUpdateInfo } = require('./imageUpdates');

const warnTimes = new Map();

function warnThrottled(key, message) {
  const now = Date.now();
  const last = warnTimes.get(key) || 0;
  if (now - last < 60000) return;
  warnTimes.set(key, now);
  console.warn(message);
}

function reqJson(host, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const isSocket = !!host.socketPath;
    const base = isSocket ? {} : new URL(host.url || 'http://127.0.0.1:2375');
    const mod = isSocket || base.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: opts.method || 'GET',
      socketPath: host.socketPath || undefined,
      hostname: isSocket ? undefined : base.hostname,
      port: isSocket ? undefined : base.port,
      path,
      rejectUnauthorized: host.insecureTLS ? false : undefined,
      timeout: opts.timeout || 10000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(txt || res.statusMessage));
        if (opts.text) return resolve(txt);
        try { resolve(txt ? JSON.parse(txt) : null); } catch { resolve(txt); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(opts.body);
  });
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function cpuPercent(stats) {
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage || 0) - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (stats.cpu_stats?.system_cpu_usage || 0) - (stats.precpu_stats?.system_cpu_usage || 0);
  const cpus = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  return sysDelta > 0 && cpuDelta > 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : 0;
}

function memPercent(stats) {
  const usage = Number(stats.memory_stats?.usage) || 0;
  const limit = Number(stats.memory_stats?.limit) || 0;
  return limit ? Math.round((usage / limit) * 1000) / 10 : 0;
}

function netIO(stats) {
  const nets = stats.networks || {};
  const rx = Object.values(nets).reduce((a, n) => a + (Number(n.rx_bytes) || 0), 0);
  const tx = Object.values(nets).reduce((a, n) => a + (Number(n.tx_bytes) || 0), 0);
  return rx || tx ? `${fmtBytes(rx)} / ${fmtBytes(tx)}` : '';
}

function blockIO(stats) {
  const entries = stats.blkio_stats?.io_service_bytes_recursive || [];
  const read = entries.filter(x => String(x.op).toLowerCase() === 'read').reduce((a, x) => a + (Number(x.value) || 0), 0);
  const write = entries.filter(x => String(x.op).toLowerCase() === 'write').reduce((a, x) => a + (Number(x.value) || 0), 0);
  return read || write ? `${fmtBytes(read)} / ${fmtBytes(write)}` : '';
}

function ports(ports = []) {
  return ports.map(p => p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`).slice(0, 8);
}

function pct(v) {
  const n = Number(String(v || '').replace('%', '').trim());
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function cleanLabels(labels) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  return Object.fromEntries(Object.entries(labels).slice(0, 80).map(([k, v]) => [
    String(k).slice(0, 160),
    String(v ?? '').slice(0, 500),
  ]));
}

function cleanSshError(message) {
  const lines = String(message || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => {
      const l = line.toLowerCase();
      return !(
        l.includes('post-quantum key exchange') ||
        l.includes('store now, decrypt later') ||
        l.includes('openssh.com/pq.html') ||
        l.includes('server may need to be upgraded')
      );
    });
  const cleaned = lines.join('\n').trim();
  if (/(\b|sh:\s*)docker:\s*(command\s+)?not found/i.test(cleaned)) {
    return 'Docker CLI not found on remote host. Install Docker or add it to PATH for the SSH user.';
  }
  return cleaned || 'SSH command failed';
}

function expandPath(p) {
  return p ? String(p).replace(/^~(?=$|[\\/])/, os.homedir()) : p;
}

function shQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function execSshNode(host, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => done(new Error('SSH command timed out')), 45000);
    const cfg = {
      host: host.sshHost,
      port: Number(host.sshPort) || 22,
      username: host.sshUser || 'root',
      readyTimeout: 30000,
      tryKeyboard: true,
    };
    if (host.sshPassword) cfg.password = String(host.sshPassword);
    if (host.sshKey) {
      try { cfg.privateKey = fs.readFileSync(expandPath(host.sshKey)); } catch {}
    }
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return done(new Error(cleanSshError(err.message)));
        let stdout = '', stderr = '';
        if (/sudo\s+-S/.test(command) && host.sshPassword) stream.write(`${host.sshPassword}\n`);
        stream.on('data', d => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', d => { stderr += d.toString('utf8'); });
        stream.on('close', code => {
          if (code === 0) return done(null, stdout);
          done(new Error(cleanSshError(stderr || stdout || `SSH command failed (${code})`)));
        });
      });
    });
    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish(prompts.map(() => String(host.sshPassword || '')));
    });
    conn.on('error', err => done(new Error(cleanSshError(err.message))));
    conn.connect(cfg);
  });
}

function execSsh(host, command) {
  if (host.sshPassword || host.sshMode === 'synology') return execSshNode(host, command);
  return new Promise((resolve, reject) => {
    const port = Number(host.sshPort) || 22;
    const user = host.sshUser || 'root';
    const target = `${user}@${host.sshHost}`;
    const sshArgs = [
      '-o', 'ConnectTimeout=20',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(port),
    ];
    sshArgs.unshift('-o', 'BatchMode=yes');
    if (host.sshKey) sshArgs.push('-i', expandPath(host.sshKey));
    sshArgs.push(target, command);
    const bin = 'ssh';
    const args = sshArgs;
    const opts = { timeout: 45000, maxBuffer: 1024 * 1024 * 3 };
    execFile(bin, args, opts, (err, stdout, stderr) => {
      if (err) {
        const msg = cleanSshError(stderr || err.message || '');
        return reject(new Error(msg));
      }
      resolve(stdout);
    });
  });
}

function parseJsonLines(txt) {
  return String(txt || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function parsePortsText(raw) {
  const out = [];
  const re = /(?:0\.0\.0\.0:|\[::\]:|:)?(\d+)->(\d+)\/\w+/g;
  let m;
  while ((m = re.exec(String(raw || ''))) && out.length < 8) out.push(`${m[1]}:${m[2]}`);
  if (!out.length && raw) out.push(String(raw).slice(0, 80));
  return out;
}

function hasExplicitTag(ref) {
  const s = String(ref || '');
  if (!s || s.includes('@') || s.startsWith('sha256:')) return true;
  return s.lastIndexOf(':') > s.lastIndexOf('/');
}

function addImageRef(set, value) {
  let ref = String(value || '').trim();
  if (!ref || ref === '<none>' || ref === '<none>:<none>') return;
  ref = ref.replace(/^\/+/, '').replace(/^docker\.io\//, '');
  const variants = [ref];
  if (ref.startsWith('library/')) variants.push(ref.slice(8));
  for (const item of variants) {
    if (!item || item === '<none>' || item === '<none>:<none>') continue;
    set.add(item);
    if (item.startsWith('sha256:')) set.add(item.slice(7));
    if (!hasExplicitTag(item)) set.add(`${item}:latest`);
  }
}

function apiImageRefs(img = {}) {
  const refs = new Set();
  addImageRef(refs, img.Id || img.ID || img.id);
  (Array.isArray(img.RepoTags) ? img.RepoTags : []).forEach(tag => addImageRef(refs, tag));
  (Array.isArray(img.RepoDigests) ? img.RepoDigests : []).forEach(digest => addImageRef(refs, digest));
  return refs;
}

function cliImageRefs(img = {}) {
  const refs = new Set();
  addImageRef(refs, img.ID || img.Id || img.id);
  const repo = String(img.Repository || img.repository || '').trim();
  const tag = String(img.Tag || img.tag || '').trim();
  const digest = String(img.Digest || img.digest || '').trim();
  if (repo && repo !== '<none>') {
    if (tag && tag !== '<none>') addImageRef(refs, `${repo}:${tag}`);
    if (digest && digest !== '<none>') addImageRef(refs, `${repo}@${digest}`);
  }
  return refs;
}

function addContainerImageRefs(set, container = {}) {
  addImageRef(set, container.Image || container.image);
  addImageRef(set, container.ImageID || container.imageID || container.imageId);
}

function unusedImageCount(imageRows, containers, refFn) {
  const rows = Array.isArray(imageRows) ? imageRows : [];
  const used = new Set();
  (Array.isArray(containers) ? containers : []).forEach(c => addContainerImageRefs(used, c));
  return rows.reduce((count, img) => {
    const refs = refFn(img);
    if (!refs.size) return count;
    return [...refs].some(ref => used.has(ref)) ? count : count + 1;
  }, 0);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function dockerSudoAttempts(host) {
  if (host.sudo === true) return [true];
  if (host.sudo === false) return [false];
  return host.sshMode === 'synology' ? [true, false] : [false, true];
}

async function execDockerCli(host, args) {
  const base = `PATH=$PATH:/usr/bin:/usr/local/bin:/snap/bin docker ${args}`;
  const attempts = dockerSudoAttempts(host);
  let lastErr;
  for (const useSudo of attempts) {
    const command = useSudo ? `sudo -S -p '' sh -c ${shQuote(base)}` : base;
    try { return await execSsh(host, command); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

function dockerCliCaptured(host, args, tailBytes = 200000) {
  const base = `PATH=$PATH:/usr/bin:/usr/local/bin:/snap/bin docker ${args}`;
  return `out=$(${base} 2>&1); rc=$?; printf '%s' "$out" | tail -c ${Number(tailBytes) || 200000}; exit $rc`;
}

async function execDockerCliCaptured(host, args, tailBytes) {
  const base = dockerCliCaptured(host, args, tailBytes);
  const attempts = dockerSudoAttempts(host);
  let lastErr;
  for (const useSudo of attempts) {
    const command = useSudo ? `sudo -S -p '' sh -c ${shQuote(base)}` : base;
    try { return await execSsh(host, command); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function getDockerSshHost(host) {
  const name = host.name || host.sshHost || 'docker';
  try {
    const psTxt = await execDockerCli(host, "ps -a --no-trunc --format '{{json .}}'");
    const statsTxt = await execDockerCli(host, "stats --no-stream --no-trunc --format '{{json .}}'").catch(err => {
      warnThrottled(`docker-stats:${name}`, `[Docker ${name}] stats unavailable: ${err.message}`);
      return '';
    });
    const imagesTxt = await execDockerCli(host, "images --no-trunc --format '{{json .}}'")
      .catch(err => {
        warnThrottled(`docker-images:${name}`, `[Docker ${name}] unused image check failed: ${err.message}`);
        return '';
      });
    const stats = new Map(parseJsonLines(statsTxt).map(s => [String(s.ID || '').slice(0, 12), s]));
    const containers = parseJsonLines(psTxt).slice(0, 200).map(c => {
      const id = String(c.ID || '').slice(0, 12);
      const st = stats.get(id) || {};
      const state = String(c.State || '').toLowerCase();
      return {
        id,
        name: String(c.Names || id).split(',')[0].slice(0, 200),
        image: String(c.Image || ''),
        imageShort: String(c.Image || '').split('/').pop().slice(0, 40),
        state,
        status: String(c.Status || ''),
        ports: parsePortsText(c.Ports),
        color: state === 'running' ? 'green' : (state === 'exited' || state === 'dead') ? 'red' : 'yellow',
        cpu: pct(st.CPUPerc),
        memPercent: pct(st.MemPerc),
        netIO: String(st.NetIO || ''),
        blockIO: String(st.BlockIO || ''),
      };
    });
    const inspectIds = containers.map(c => String(c.id || '').replace(/[^\w]/g, '')).filter(Boolean);
    if (inspectIds.length) {
      const inspectTxt = await execDockerCli(host, `inspect --format '{{json .}}' ${inspectIds.join(' ')}`).catch(() => '');
      const inspectRows = parseJsonLines(inspectTxt);
      const imageIds = new Map(inspectRows.map(row => [String(row.Id || '').slice(0, 12), String(row.Image || '')]));
      const labelsById = new Map(inspectRows.map(row => [String(row.Id || '').slice(0, 12), cleanLabels(row.Config?.Labels || row.Labels)]));
      containers.forEach(c => {
        c.imageID = imageIds.get(c.id) || '';
        c.labels = labelsById.get(c.id) || {};
      });
    }
    const unusedImages = unusedImageCount(parseJsonLines(imagesTxt), containers, cliImageRefs);
    const uniqueImages = [...new Set(containers.map(c => c.image).filter(Boolean))].slice(0, 80);
    const imageUpdates = new Map();
    await mapLimit(uniqueImages, 3, async image => {
      const info = await imageUpdateInfo(image, async img => {
        const txt = await execDockerCli(host, `image inspect ${shQuote(img)}`);
        const parsed = JSON.parse(txt || '[]');
        return Array.isArray(parsed) ? parsed[0] : parsed;
      });
      imageUpdates.set(image, info);
    });
    containers.forEach(c => { c.imageUpdate = imageUpdates.get(c.image) || { status: 'unknown', label: 'unknown' }; });
    const running = containers.filter(c => c.state === 'running').length;
    const stopped = containers.filter(c => c.state === 'exited' || c.state === 'dead').length;
    const updates = containers.filter(c => c.imageUpdate?.status === 'update').length;
    const cpuVals = containers.filter(c => c.cpu != null).map(c => c.cpu);
    const memVals = containers.filter(c => c.memPercent != null).map(c => c.memPercent);
    return {
      source: 'configured',
      name,
      host: `${host.sshUser || 'root'}@${host.sshHost}:${Number(host.sshPort) || 22}`,
      online: true,
      summary: {
        total: containers.length,
        running,
        stopped,
        unused: Number(unusedImages) || 0,
        updates,
        cpu: cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) * 10) / 10 : 0,
        memPercent: memVals.length ? Math.round((memVals.reduce((a, b) => a + b, 0) / memVals.length) * 10) / 10 : 0,
      },
      containers,
    };
  } catch (err) {
    warnThrottled(`docker-host:${name}`, `[Docker ${name}] refresh failed: ${err.message}`);
    return { source: 'configured', name, host: host.sshHost || '', online: false, error: err.message, summary: { total: 0, running: 0, stopped: 0, unused: 0 }, containers: [] };
  }
}

async function getDockerHost(host) {
  if (host.sshHost) return getDockerSshHost(host);
  const name = host.name || host.url || host.socketPath || 'docker';
  try {
    const [containers, images] = await Promise.all([
      reqJson(host, '/containers/json?all=1'),
      reqJson(host, '/images/json').catch(err => {
        warnThrottled(`docker-images:${name}`, `[Docker ${name}] unused image check failed: ${err.message}`);
        return [];
      }),
    ]);
    const detailed = await mapLimit((containers || []).slice(0, 200), 6, async c => {
      const id = String(c.Id || '').slice(0, 12);
      const stats = c.State === 'running' ? await reqJson(host, `/containers/${id}/stats?stream=false`).catch(() => null) : null;
      const image = c.Image || '';
      return {
        id,
        name: String((c.Names?.[0] || '').replace(/^\//, '') || id),
        image,
        imageID: c.ImageID || '',
        imageShort: String(image).split('/').pop().slice(0, 40),
        state: String(c.State || '').toLowerCase(),
        status: c.Status || '',
        labels: cleanLabels(c.Labels),
        ports: ports(c.Ports),
        color: c.State === 'running' ? 'green' : (c.State === 'exited' || c.State === 'dead') ? 'red' : 'yellow',
        cpu: stats ? cpuPercent(stats) : null,
        memPercent: stats ? memPercent(stats) : null,
        netIO: stats ? netIO(stats) : '',
        blockIO: stats ? blockIO(stats) : '',
      };
    });
    const uniqueImages = [...new Set(detailed.map(c => c.image).filter(Boolean))].slice(0, 80);
    const imageUpdates = new Map();
    await mapLimit(uniqueImages, 3, async image => {
      const info = await imageUpdateInfo(image, img => reqJson(host, `/images/${encodeURIComponent(img)}/json`));
      imageUpdates.set(image, info);
    });
    detailed.forEach(c => { c.imageUpdate = imageUpdates.get(c.image) || { status: 'unknown', label: 'unknown' }; });
    const running = detailed.filter(c => c.state === 'running').length;
    const stopped = detailed.filter(c => c.state === 'exited' || c.state === 'dead').length;
    const updates = detailed.filter(c => c.imageUpdate?.status === 'update').length;
    const cpuVals = detailed.filter(c => c.cpu != null).map(c => c.cpu);
    const memVals = detailed.filter(c => c.memPercent != null).map(c => c.memPercent);
    return {
      source: 'configured',
      name,
      host: host.url || host.socketPath || '',
      online: true,
      summary: {
        total: detailed.length,
        running,
        stopped,
        unused: unusedImageCount(images, containers, apiImageRefs),
        updates,
        cpu: cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) * 10) / 10 : 0,
        memPercent: memVals.length ? Math.round((memVals.reduce((a, b) => a + b, 0) / memVals.length) * 10) / 10 : 0,
      },
      containers: detailed,
    };
  } catch (err) {
    warnThrottled(`docker-api:${name}`, `[Docker ${name}] refresh failed: ${err.message}`);
    return { source: 'configured', name, host: host.url || host.socketPath || '', online: false, error: err.message, summary: { total: 0, running: 0, stopped: 0, unused: 0 }, containers: [] };
  }
}

async function getDockerApiData(cfg = {}) {
  const hosts = cfg.hosts || [];
  if (!hosts.length) return [];
  return mapLimit(hosts, Number(cfg.concurrency || cfg.collectorConcurrency || 3), getDockerHost);
}

async function dockerLogs(cfg = {}, hostName, id) {
  const host = (cfg.hosts || []).find(h => h.name === hostName);
  if (!host) throw new Error('docker host not configured');
  if (host.sshHost) {
    const safeId = String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
    return execDockerCliCaptured(host, `logs --tail 300 ${safeId}`, 200000);
  }
  return reqJson(host, `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=300`, { text: true });
}

async function dockerPrune(cfg = {}, hostName) {
  const host = (cfg.hosts || []).find(h => h.name === hostName);
  if (!host) throw new Error('docker host not configured');
  if (host.sshHost) return execDockerCli(host, 'image prune -a -f');
  const filters = encodeURIComponent(JSON.stringify({ dangling: ['false'] }));
  return reqJson(host, `/images/prune?filters=${filters}`, { method: 'POST' });
}

module.exports = { getDockerApiData, dockerLogs, dockerPrune };
