const https = require('https');
const http = require('http');

const pveHistory = new Map();

function normBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

function authHeader(cfg) {
  if (!cfg.tokenId || !cfg.tokenSecret) return null;
  return `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`;
}

async function pveFetch(cfg, path) {
  return new Promise((resolve, reject) => {
    const base = normBase(cfg.url);
    if (!base) return reject(new Error('Proxmox URL is required'));
    const u = new URL(base + path);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { Authorization: authHeader(cfg) },
      rejectUnauthorized: cfg.insecureTLS ? false : undefined,
      timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = txt ? JSON.parse(txt) : {}; } catch {}
        if (res.statusCode >= 400) return reject(new Error(body?.errors ? JSON.stringify(body.errors) : (body?.message || res.statusMessage)));
        resolve(body.data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function ramObj(used, total) {
  used = Number(used) || 0;
  total = Number(total) || 0;
  return {
    percent: total ? Math.round((used / total) * 100) : null,
    usedGB: (used / 1024 ** 3).toFixed(1),
    totalGB: (total / 1024 ** 3).toFixed(1),
    used,
    total,
  };
}

function svcName(s) {
  return String(s.name || s.service || s.id || '').replace(/\.service$/, '');
}

async function nodeData(cfg, node, excluded) {
  const name = node.node || node.name;
  try {
    const [status, qemu, lxc, storage, services] = await Promise.all([
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/status`).catch(() => ({})),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/qemu`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/lxc`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/storage`).catch(() => []),
      pveFetch(cfg, `/api2/json/nodes/${encodeURIComponent(name)}/services`).catch(() => []),
    ]);
    const cpu = Math.round((Number(status.cpu) || 0) * 100);
    const mem = ramObj(status.memory?.used, status.memory?.total);
    const hist = pveHistory.get(name) || [];
    hist.push({ time: Date.now(), cpu, mem: mem.percent || 0 });
    if (hist.length > 240) hist.shift();
    pveHistory.set(name, hist);
    const exList = excluded[name] || [];
    return {
      node: {
        name,
        online: node.status !== 'offline',
        cpu,
        cpuRaw: Number(status.cpu) || 0,
        cpuCores: Number(status.cpuinfo?.cpus || node.maxcpu || 0),
        ram: mem,
        uptime: Number(status.uptime) || null,
      },
      host: cfg.url,
      services: (services || []).map(s => {
        const n = svcName(s);
        return { name: n, desc: s.desc || n, state: s.state || s.status || 'unknown', active: (s.state || s.status) === 'running', excluded: exList.includes(n) };
      }).filter(s => s.name),
      vms: [...(qemu || []).map(v => ({ ...v, type: 'vm' })), ...(lxc || []).map(v => ({ ...v, type: 'lxc' }))].filter(v => !v.template).map(v => ({
        id: v.vmid,
        name: String(v.name || v.vmid || '').slice(0, 128),
        type: v.type,
        status: v.status,
        running: v.status === 'running',
        cpu: v.cpu ? Math.round(v.cpu * 100) : 0,
        ram: v.mem && v.maxmem ? Math.round((v.mem / v.maxmem) * 100) : 0,
      })),
      storage: (storage || []).map(s => ({
        name: String(s.storage || '').slice(0, 128),
        type: s.type || 'storage',
        active: Number(s.enabled) !== 0 && Number(s.active) !== 0,
        total: s.total || 0,
        used: s.used || 0,
        avail: s.avail || 0,
        percent: s.total ? Math.round(((s.used || 0) / s.total) * 100) : 0,
      })),
      history: [...hist],
      backup: null,
    };
  } catch (err) {
    return { node: { name, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } }, host: cfg.url, services: [], vms: [], history: [...(pveHistory.get(name) || [])], backup: null, storage: [], error: err.message };
  }
}

async function getProxmoxApiData(cfg = {}) {
  if (!cfg.url || !cfg.tokenId || !cfg.tokenSecret) return { clusterSummary: null, nodes: [], ceph: null };
  const excluded = cfg.excludedServices?.proxmox || {};
  const nodesRaw = await pveFetch(cfg, '/api2/json/nodes');
  const nodes = (await Promise.all((nodesRaw || []).map(n => nodeData(cfg, n, excluded))))
    .sort((a, b) => String(a.node.name).localeCompare(String(b.node.name)));
  const onlineNodes = nodes.filter(n => n.node.online);
  const clusterSummary = {
    nodesOnline: onlineNodes.length,
    totalNodes: nodes.length,
    totalCores: nodes.reduce((s, n) => s + (n.node.cpuCores || 0), 0),
    usedCores: onlineNodes.reduce((s, n) => s + (n.node.cpuRaw || 0) * (n.node.cpuCores || 0), 0),
    totalRAM: nodes.reduce((s, n) => s + (n.node.ram?.total || 0), 0),
    usedRAM: onlineNodes.reduce((s, n) => s + (n.node.ram?.used || 0), 0),
  };
  return { clusterSummary, nodes, ceph: null };
}

module.exports = { getProxmoxApiData };
