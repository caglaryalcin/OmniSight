const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

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

function execSsh(host, command) {
  return new Promise((resolve, reject) => {
    const port = Number(host.sshPort) || 22;
    const user = host.sshUser || 'root';
    const target = `${user}@${host.sshHost}`;
    const password = host.sshPassword == null ? '' : String(host.sshPassword);
    const hasPassword = !!password;
    const sshArgs = [
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(port),
    ];
    if (hasPassword) {
      sshArgs.unshift('-o', 'PreferredAuthentications=password,keyboard-interactive');
    } else {
      sshArgs.unshift('-o', 'BatchMode=yes');
    }
    if (host.sshKey) sshArgs.push('-i', host.sshKey);
    sshArgs.push(target, command);
    const bin = hasPassword ? 'sshpass' : 'ssh';
    const args = hasPassword ? ['-e', 'ssh', ...sshArgs] : sshArgs;
    const opts = { timeout: 20000, maxBuffer: 1024 * 1024 * 3 };
    if (hasPassword) opts.env = { ...process.env, SSHPASS: password };
    execFile(bin, args, opts, (err, stdout, stderr) => {
      if (err) {
        const msg = cleanSshError(stderr || err.message || '');
        if (hasPassword && err.code === 'ENOENT') return reject(new Error('sshpass is required for SSH password authentication'));
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

async function getDockerSshHost(host) {
  const name = host.name || host.sshHost || 'docker';
  try {
    const [psTxt, statsTxt, danglingTxt] = await Promise.all([
      execSsh(host, "docker ps -a --no-trunc --format '{{json .}}'"),
      execSsh(host, "docker stats --no-stream --no-trunc --format '{{json .}}'").catch(() => ''),
      execSsh(host, "docker images -f dangling=true -q | wc -l").catch(() => '0'),
    ]);
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
    const running = containers.filter(c => c.state === 'running').length;
    const stopped = containers.filter(c => c.state === 'exited' || c.state === 'dead').length;
    const cpuVals = containers.filter(c => c.cpu != null).map(c => c.cpu);
    const memVals = containers.filter(c => c.memPercent != null).map(c => c.memPercent);
    return {
      name,
      host: `${host.sshUser || 'root'}@${host.sshHost}:${Number(host.sshPort) || 22}`,
      online: true,
      summary: {
        total: containers.length,
        running,
        stopped,
        unused: Number(String(danglingTxt || '0').trim()) || 0,
        cpu: cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) * 10) / 10 : 0,
        memPercent: memVals.length ? Math.round((memVals.reduce((a, b) => a + b, 0) / memVals.length) * 10) / 10 : 0,
      },
      containers,
    };
  } catch (err) {
    return { name, host: host.sshHost || '', online: false, error: err.message, summary: { total: 0, running: 0, stopped: 0, unused: 0 }, containers: [] };
  }
}

async function getDockerHost(host) {
  if (host.sshHost) return getDockerSshHost(host);
  const name = host.name || host.url || host.socketPath || 'docker';
  try {
    const [containers, df] = await Promise.all([
      reqJson(host, '/containers/json?all=1'),
      reqJson(host, '/system/df').catch(() => ({})),
    ]);
    const detailed = await Promise.all((containers || []).slice(0, 200).map(async c => {
      const id = String(c.Id || '').slice(0, 12);
      const stats = c.State === 'running' ? await reqJson(host, `/containers/${id}/stats?stream=false`).catch(() => null) : null;
      return {
        id,
        name: String((c.Names?.[0] || '').replace(/^\//, '') || id),
        image: c.Image || '',
        imageShort: String(c.Image || '').split('/').pop().slice(0, 40),
        state: String(c.State || '').toLowerCase(),
        status: c.Status || '',
        ports: ports(c.Ports),
        color: c.State === 'running' ? 'green' : (c.State === 'exited' || c.State === 'dead') ? 'red' : 'yellow',
        cpu: stats ? cpuPercent(stats) : null,
        memPercent: stats ? memPercent(stats) : null,
        netIO: stats ? netIO(stats) : '',
        blockIO: stats ? blockIO(stats) : '',
      };
    }));
    const running = detailed.filter(c => c.state === 'running').length;
    const stopped = detailed.filter(c => c.state === 'exited' || c.state === 'dead').length;
    const cpuVals = detailed.filter(c => c.cpu != null).map(c => c.cpu);
    const memVals = detailed.filter(c => c.memPercent != null).map(c => c.memPercent);
    return {
      name,
      host: host.url || host.socketPath || '',
      online: true,
      summary: {
        total: detailed.length,
        running,
        stopped,
        unused: (df.Images || []).filter(i => i.Containers === 0).length,
        cpu: cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) * 10) / 10 : 0,
        memPercent: memVals.length ? Math.round((memVals.reduce((a, b) => a + b, 0) / memVals.length) * 10) / 10 : 0,
      },
      containers: detailed,
    };
  } catch (err) {
    return { name, host: host.url || host.socketPath || '', online: false, error: err.message, summary: { total: 0, running: 0, stopped: 0, unused: 0 }, containers: [] };
  }
}

async function getDockerApiData(cfg = {}) {
  const hosts = cfg.hosts || [];
  if (!hosts.length) return [];
  return Promise.all(hosts.map(getDockerHost));
}

async function dockerLogs(cfg = {}, hostName, id) {
  const host = (cfg.hosts || []).find(h => h.name === hostName);
  if (!host) throw new Error('docker host not configured');
  if (host.sshHost) return execSsh(host, `docker logs --tail 300 ${String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '')} 2>&1 | tail -c 200000`);
  return reqJson(host, `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=300`, { text: true });
}

async function dockerPrune(cfg = {}, hostName) {
  const host = (cfg.hosts || []).find(h => h.name === hostName);
  if (!host) throw new Error('docker host not configured');
  if (host.sshHost) return execSsh(host, 'docker image prune -f 2>&1');
  return reqJson(host, '/images/prune', { method: 'POST' });
}

module.exports = { getDockerApiData, dockerLogs, dockerPrune };
