const http = require('http');
const https = require('https');

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

async function getDockerHost(host) {
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
  return reqJson(host, `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=300`, { text: true });
}

async function dockerPrune(cfg = {}, hostName) {
  const host = (cfg.hosts || []).find(h => h.name === hostName);
  if (!host) throw new Error('docker host not configured');
  return reqJson(host, '/images/prune', { method: 'POST' });
}

module.exports = { getDockerApiData, dockerLogs, dockerPrune };
