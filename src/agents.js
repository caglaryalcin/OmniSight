const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');

const AGENTS_PATH = path.join(__dirname, '..', 'data', 'agents.yaml');
const HISTORY_MAX = 1440;
const CMD_TIMEOUT = 60000;
const INSTALL_PENDING_TTL = 5 * 60 * 1000;
const SVC_NAME = /^[a-zA-Z0-9@._:-]+$/;

const agents = new Map();
const history = new Map();
const pending = new Map();
const pendingInstalls = new Map();
const waiters = new Map();
const pollWaiters = new Map();

let saveTimer = null;

function loadAgents() {
  try {
    const obj = yaml.load(fs.readFileSync(AGENTS_PATH, 'utf8')) || {};
    for (const [id, meta] of Object.entries(obj)) {
      agents.set(id, { ...meta, id, services: [], cpu: null, ram: null, live: false });
    }
  } catch {}
}
loadAgents();

function saveAgents() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const out = {};
      for (const [id, a] of agents) {
        out[id] = {
          hostname: a.hostname, ip: a.ip, os: a.os, kernel: a.kernel,
          platform: a.platform, role: a.role, agentVersion: a.agentVersion,
          interval: a.interval, lastSeen: a.lastSeen,
          hasDocker: !!a.docker, pveNode: a.pve?.node || null,
        };
      }
      fs.mkdirSync(path.dirname(AGENTS_PATH), { recursive: true });
      fs.writeFileSync(AGENTS_PATH, yaml.dump(out), 'utf8');
    } catch (e) { console.warn('agents save failed:', e.message); }
  }, 2000);
}

function num(v, max = 1e15) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

function rateObj(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    readBps: num(o.readBps),
    writeBps: num(o.writeBps),
    iops: num(o.iops, 1e9),
    util: num(o.util, 100),
    rxBps: num(o.rxBps),
    txBps: num(o.txBps),
  };
}

function cleanupPendingInstalls(now = Date.now()) {
  for (const [id, p] of pendingInstalls) {
    if (now - p.createdAt > INSTALL_PENDING_TTL) pendingInstalls.delete(id);
  }
}

function addPendingInstall(kind = 'linux') {
  cleanupPendingInstalls();
  kind = ['linux', 'proxmox', 'docker'].includes(kind) ? kind : 'linux';
  const id = `${kind}-${crypto.randomBytes(6).toString('hex')}`;
  const title = kind === 'proxmox' ? 'New Proxmox node' : kind === 'docker' ? 'New Docker host' : 'New system';
  const p = { id, kind, name: title, createdAt: Date.now(), expiresAt: Date.now() + INSTALL_PENDING_TTL };
  pendingInstalls.set(id, p);
  return p;
}

function removePendingInstall(id) {
  cleanupPendingInstalls();
  return pendingInstalls.delete(String(id || ''));
}

function clearPendingForKinds(kinds) {
  cleanupPendingInstalls();
  for (const kind of kinds) {
    const match = [...pendingInstalls.values()]
      .filter(p => p.kind === kind)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (match) pendingInstalls.delete(match.id);
  }
}

function pendingByKind(kind) {
  cleanupPendingInstalls();
  return [...pendingInstalls.values()].filter(p => p.kind === kind);
}

function handleReport(r) {
  const id = String(r.id || r.hostname || '').replace(/[^\w.-]/g, '').slice(0, 128);
  if (!id) throw new Error('missing agent id');
  const hostname = String(r.hostname || id).slice(0, 128);

  const services = Array.isArray(r.services) ? r.services.slice(0, 500).map(s => ({
    name: String(s.name || '').slice(0, 200),
    state: String(s.state || 'unknown').slice(0, 32),
    active: !!s.active,
  })).filter(s => s.name && SVC_NAME.test(s.name)) : [];

  const memTotal = num(r.mem?.totalKB), memUsed = num(r.mem?.usedKB);
  const diskTotal = num(r.disk?.totalKB), diskUsed = num(r.disk?.usedKB);
  const cpu = num(r.cpu, 100);
  const swapTotal = num(r.metrics?.swap?.totalKB), swapUsed = num(r.metrics?.swap?.usedKB);
  const diskIO = rateObj(r.metrics?.diskIO);
  const bandwidth = rateObj(r.metrics?.bandwidth);

  let docker = null;
  if (r.docker && typeof r.docker === 'object') {
    docker = {
      unused: num(r.docker.unused, 1e6) || 0,
      containers: (Array.isArray(r.docker.containers) ? r.docker.containers.slice(0, 500) : []).map(c => ({
        id: String(c.id || '').replace(/[^\w]/g, '').slice(0, 12),
        name: String(c.name || '').slice(0, 200),
        image: String(c.image || '').slice(0, 300),
        state: String(c.state || '').toLowerCase().slice(0, 24),
        status: String(c.status || '').slice(0, 100),
        ports: String(c.ports || '').slice(0, 500),
        cpu: num(c.cpu, 1e6),
        memPercent: num(c.memPercent, 1e6),
        netIO: String(c.netIO || '').slice(0, 80),
        blockIO: String(c.blockIO || '').slice(0, 80),
      })).filter(c => c.id),
    };
  }

  let pve = null;
  if (r.pve && typeof r.pve === 'object' && Array.isArray(r.pve.resources)) {
    pve = {
      node: String(r.pve.node || r.hostname || '').slice(0, 128),
      resources: r.pve.resources.slice(0, 2000),
      ceph: (r.pve.ceph && typeof r.pve.ceph === 'object') ? r.pve.ceph : null,
      backup: Array.isArray(r.pve.backup) ? r.pve.backup.slice(0, 5) : null,
    };
  }

  const a = {
    id,
    hostname,
    ip: String(r.ip || '').slice(0, 64),
    os: String(r.os || '').slice(0, 128),
    kernel: String(r.kernel || '').slice(0, 64),
    platform: ['proxmox', 'synology'].includes(r.platform) ? r.platform : 'linux',
    role: ['linux', 'docker', 'proxmox', 'synology', 'auto'].includes(r.role) ? r.role : 'auto',
    agentVersion: String(r.agentVersion || '').slice(0, 16),
    interval: Math.min(Math.max(num(r.interval) || 15, 5), 300),
    uptime: num(r.uptime),
    cpu,
    load: Array.isArray(r.load) ? r.load.slice(0, 3).map(x => num(x, 10000)) : null,
    temp: num(r.temp, 200),
    mem: memTotal ? { totalKB: memTotal, usedKB: memUsed || 0 } : null,
    disk: diskTotal ? { totalKB: diskTotal, usedKB: diskUsed || 0 } : null,
    metrics: {
      diskIO,
      bandwidth,
      swap: swapTotal ? { totalKB: swapTotal, usedKB: swapUsed || 0 } : null,
    },
    services,
    docker,
    pve,
    cores: num(r.cores, 4096),
    lastSeen: Date.now(),
    live: true,
  };
  agents.set(id, a);
  const reportKinds = (a.pve || a.platform === 'proxmox' || a.role === 'proxmox') ? ['proxmox'] : (a.role === 'docker' ? ['docker'] : ['linux']);
  clearPendingForKinds(reportKinds);

  if (cpu != null) {
    const hist = history.get(id) || [];
    hist.push({
      time: Date.now(),
      cpu,
      ram: memTotal ? Math.round((memUsed / memTotal) * 100) : 0,
      disk: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0,
    });
    if (hist.length > HISTORY_MAX) hist.shift();
    history.set(id, hist);
  }
  saveAgents();
  return a;
}

function isOnline(a, now) {
  const staleMs = ((a.interval || 15) * 2.5 + 10) * 1000;
  return a.live && (now - (a.lastSeen || 0)) < staleMs;
}

function getAllAgentData(config) {
  const excluded = (config && config.excludedServices?.linux) || {};
  const now = Date.now();
  const rows = [...agents.values()].filter(a => a.platform !== 'proxmox' && a.role !== 'docker').map(a => {
    const staleMs = ((a.interval || 15) * 2.5 + 10) * 1000;
    const online = a.live && (now - (a.lastSeen || 0)) < staleMs;
    const exList = excluded[a.hostname] || [];
    const services = (a.services || []).map(s => ({ ...s, excluded: exList.includes(s.name) }))
      .sort((x, y) => (x.active === y.active) ? x.name.localeCompare(y.name) : (x.active ? 1 : -1));
    const ram = a.mem ? {
      percent: Math.min(100, Math.round((a.mem.usedKB / a.mem.totalKB) * 100)),
      usedGB: (a.mem.usedKB / 1048576).toFixed(1),
      totalGB: (a.mem.totalKB / 1048576).toFixed(1),
    } : null;
    const disk = a.disk ? {
      percent: Math.min(100, Math.round((a.disk.usedKB / a.disk.totalKB) * 100)),
      usedGB: (a.disk.usedKB / 1048576).toFixed(1),
      totalGB: (a.disk.totalKB / 1048576).toFixed(1),
    } : null;
    const swap = a.metrics?.swap ? {
      percent: a.metrics.swap.totalKB ? Math.min(100, Math.round((a.metrics.swap.usedKB / a.metrics.swap.totalKB) * 100)) : 0,
      usedGB: (a.metrics.swap.usedKB / 1048576).toFixed(1),
      totalGB: (a.metrics.swap.totalKB / 1048576).toFixed(1),
      totalKB: a.metrics.swap.totalKB,
      usedKB: a.metrics.swap.usedKB,
    } : null;
    return {
      id: a.id,
      name: a.hostname,
      host: a.hostname,
      ip: a.ip,
      os: a.os,
      kernel: a.kernel,
      platform: a.platform,
      role: a.role,
      agentVersion: a.agentVersion,
      online,
      error: online ? undefined : (a.lastSeen ? `no report for ${Math.round((now - a.lastSeen) / 1000)}s` : 'never reported'),
      cpu: online ? a.cpu : null,
      ram: online ? ram : null,
      disk: online ? disk : null,
      swap: online ? swap : null,
      metrics: online ? { diskIO: a.metrics?.diskIO || null, bandwidth: a.metrics?.bandwidth || null } : null,
      temp: online ? a.temp : null,
      load: online ? a.load : null,
      uptime: online ? a.uptime : null,
      lastSeen: a.lastSeen || null,
      services: online ? services : [],
      history: [...(history.get(a.id) || [])],
    };
  });
  pendingByKind('linux').forEach(p => rows.push({
    id: p.id,
    name: p.name,
    host: 'waiting for agent',
    ip: '',
    os: '',
    platform: 'linux',
    online: false,
    _connecting: true,
    error: 'waiting for first report',
    lastSeen: p.createdAt,
    services: [],
    history: [],
  }));
  return rows.sort((x, y) => (x._connecting === y._connecting ? x.name.localeCompare(y.name) : x._connecting ? -1 : 1));
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

function parsePorts(raw) {
  const out = [];
  const seen = new Set();
  const re = /(\d+)->(\d+)/g;
  let m;
  while ((m = re.exec(String(raw))) && out.length < 3) {
    const key = `${m[1]}→${m[2]}`;
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}

function getDockerData() {
  const now = Date.now();
  const rows = [...agents.values()].filter(a => a.role === 'docker').map(a => {
    const online = isOnline(a, now) && !!a.docker;
    if (!online) return { source: 'agent', id: a.id, name: a.hostname, host: a.ip || '', online: false, error: 'agent offline', containers: [], summary: { total: 0, running: 0, stopped: 0, other: 0, unused: null } };
    const containers = (a.docker.containers || []).map(c => ({
      id: c.id,
      name: c.name,
      image: c.image,
      imageShort: c.image.split('/').pop().split(':')[0],
      state: c.state,
      status: c.status,
      uptime: null,
      ports: parsePorts(c.ports),
      color: stateColor(c.state),
      cpu: c.cpu ?? null,
      memPercent: c.memPercent ?? null,
      netIO: c.netIO || '',
      blockIO: c.blockIO || '',
    })).sort((x, y) => {
      const order = { running: 0, restarting: 1, paused: 2, exited: 3, dead: 4 };
      return (order[x.state] ?? 5) - (order[y.state] ?? 5);
    });
    const running = containers.filter(c => c.state === 'running').length;
    const stopped = containers.filter(c => c.state === 'exited' || c.state === 'dead').length;
    const cpu = Math.round(containers.reduce((s, c) => s + (c.cpu || 0), 0) * 10) / 10;
    const memPercent = Math.round(containers.reduce((s, c) => s + (c.memPercent || 0), 0) * 10) / 10;
    return {
      source: 'agent', id: a.id, name: a.hostname, host: a.ip || '', online: true, containers,
      metrics: { bandwidth: a.metrics?.bandwidth || null },
      summary: { total: containers.length, running, stopped, other: containers.length - running - stopped, unused: a.docker.unused ?? null, cpu, memPercent },
    };
  });
  pendingByKind('docker').forEach(p => rows.push({
    id: p.id,
    name: p.name,
    host: 'waiting for agent',
    online: false,
    _connecting: true,
    error: 'waiting for first report',
    containers: [],
    summary: { total: 0, running: 0, stopped: 0, other: 0, unused: null },
  }));
  return rows.sort((x, y) => (x._connecting === y._connecting ? x.name.localeCompare(y.name) : x._connecting ? -1 : 1));
}

function getProxmoxData(config) {
  const excluded = (config && config.excludedServices?.proxmox) || {};
  const now = Date.now();
  const pveAgents = [...agents.values()].filter(a => a.pve || a.pveNode || a.platform === 'proxmox');
  const pendingNodes = pendingByKind('proxmox').map(p => ({
    id: p.id,
    node: { name: p.name, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } },
    host: 'waiting for agent',
    services: [],
    vms: [],
    history: [],
    backup: null,
    storage: [],
    _connecting: true,
  }));
  if (!pveAgents.length) return { clusterSummary: null, nodes: pendingNodes, ceph: null };

  let ceph = null;
  const nodes = pveAgents.map(a => {
    const nodeName = a.pve?.node || a.pveNode || a.hostname;
    const online = isOnline(a, now) && !!a.pve;
    if (!online) {
      return { node: { name: nodeName, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } }, host: a.ip, services: [], vms: [], history: [...(history.get(a.id) || [])].map(h => ({ time: h.time, cpu: h.cpu, mem: h.ram })), backup: null, storage: [] };
    }
    const res = a.pve.resources || [];
    const ne = res.find(r => r.type === 'node' && r.node === nodeName) || {};
    const memUsed = ne.mem || 0, memTotal = ne.maxmem || 0;
    const vms = res.filter(r => (r.type === 'qemu' || r.type === 'lxc') && r.node === nodeName && !r.template).map(v => ({
      id: v.vmid,
      name: String(v.name || v.vmid || '').slice(0, 128),
      type: v.type === 'qemu' ? 'vm' : 'lxc',
      status: v.status,
      running: v.status === 'running',
      cpu: v.cpu ? Math.round(v.cpu * 100) : 0,
      ram: v.mem && v.maxmem ? Math.round((v.mem / v.maxmem) * 100) : 0,
    }));
    const storage = res.filter(r => r.type === 'storage' && r.node === nodeName).map(s => ({
      name: String(s.storage || '').slice(0, 128),
      type: s.plugintype || 'storage',
      active: s.status === 'available',
      total: s.maxdisk || 0,
      used: s.disk || 0,
      avail: (s.maxdisk || 0) - (s.disk || 0),
      percent: s.maxdisk ? Math.round(((s.disk || 0) / s.maxdisk) * 100) : 0,
    }));
    const exList = excluded[nodeName] || [];
    const services = (a.services || []).map(s => ({ name: s.name, desc: s.name, state: s.state, active: s.active, excluded: exList.includes(s.name) }));
    let backup = null;
    const b = a.pve.backup?.[0];
    if (b) {
      const running = !b.endtime;
      backup = { status: running ? 'running' : (b.status || 'unknown'), ok: b.status === 'OK', running, starttime: b.starttime || null, endtime: b.endtime || null };
    }
    if (!ceph && a.pve.ceph?.health) {
      const checks = [];
      const hc = a.pve.ceph.health.checks || {};
      for (const k of Object.keys(hc)) {
        const msg = hc[k]?.summary?.message;
        if (msg) checks.push(String(msg).slice(0, 300));
      }
      ceph = { health: a.pve.ceph.health.status || 'UNKNOWN', checks };
    }
    return {
      node: {
        name: nodeName,
        online: true,
        cpu: Math.round((ne.cpu || 0) * 100),
        cpuCores: ne.maxcpu || a.cores || 0,
        cpuRaw: ne.cpu || 0,
        ram: {
          percent: memTotal ? Math.round((memUsed / memTotal) * 100) : null,
          usedGB: (memUsed / 1024 ** 3).toFixed(1),
          totalGB: (memTotal / 1024 ** 3).toFixed(1),
          used: memUsed,
          total: memTotal,
        },
        uptime: ne.uptime || a.uptime || null,
      },
      host: a.ip,
      services,
      vms,
      history: [...(history.get(a.id) || [])].map(h => ({ time: h.time, cpu: h.cpu, mem: h.ram })),
      backup,
      storage,
    };
  });
  nodes.push(...pendingNodes);
  nodes.sort((x, y) => (x._connecting === y._connecting ? String(x.node.name).localeCompare(String(y.node.name)) : x._connecting ? -1 : 1));

  const onlineNodes = nodes.filter(n => n.node.online);
  const clusterSummary = {
    nodesOnline: onlineNodes.length,
    totalNodes: nodes.length,
    totalCores: nodes.reduce((s, n) => s + (n.node.cpuCores || 0), 0),
    usedCores: onlineNodes.reduce((s, n) => s + (n.node.cpuRaw || 0) * (n.node.cpuCores || 0), 0),
    totalRAM: nodes.reduce((s, n) => s + (n.node.ram?.total || 0), 0),
    usedRAM: onlineNodes.reduce((s, n) => s + (n.node.ram?.used || 0), 0),
  };

  return { clusterSummary, nodes, ceph };
}

function hasPve() {
  cleanupPendingInstalls();
  return [...agents.values()].some(a => a.pve || a.pveNode || a.platform === 'proxmox') || pendingByKind('proxmox').length > 0;
}

function hasDocker() {
  cleanupPendingInstalls();
  return [...agents.values()].some(a => a.role === 'docker' && (a.docker || a.hasDocker)) || pendingByKind('docker').length > 0;
}

function findAgent(hostOrName) {
  for (const a of agents.values()) {
    if (a.id === hostOrName || a.hostname === hostOrName || a.ip === hostOrName || a.pve?.node === hostOrName || a.pveNode === hostOrName) return a;
  }
  return null;
}

function takeCommands(agentId) {
  const list = pending.get(agentId) || [];
  pending.delete(agentId);
  return list;
}

function commandLines(cmds) {
  return cmds.map(c => `CMD\t${c.id}\t${c.action}\t${c.service}`).join('\n');
}

function queueCommand(hostOrName, action, service) {
  return new Promise((resolve, reject) => {
    const agent = findAgent(hostOrName);
    if (!agent) return reject(new Error('agent not found'));
    if (!SVC_NAME.test(service)) return reject(new Error('invalid target name'));
    if (!['status', 'start', 'stop', 'restart', 'docker_logs', 'docker_prune'].includes(action)) return reject(new Error('invalid action'));
    const id = crypto.randomBytes(8).toString('hex');
    const list = pending.get(agent.id) || [];
    list.push({ id, action, service });
    pending.set(agent.id, list);
    waiters.set(id, {
      resolve, reject,
      timer: setTimeout(() => { waiters.delete(id); reject(new Error('agent did not respond in time')); }, CMD_TIMEOUT),
    });
    const pw = pollWaiters.get(agent.id);
    if (pw) { pollWaiters.delete(agent.id); pw(); }
  });
}

function waitForCommands(agentId, waitMs) {
  if (pending.has(agentId)) return Promise.resolve(takeCommands(agentId));
  return new Promise(res => {
    const t = setTimeout(() => { pollWaiters.delete(agentId); res([]); }, waitMs);
    pollWaiters.set(agentId, () => { clearTimeout(t); res(takeCommands(agentId)); });
  });
}

function handleResult(r) {
  const w = waiters.get(String(r.id || ''));
  if (!w) return false;
  clearTimeout(w.timer);
  waiters.delete(String(r.id));
  let out = '';
  try { out = Buffer.from(String(r.output || ''), 'base64').toString('utf8'); } catch {}
  w.resolve(out);
  return true;
}

function removeAgent(id) {
  if (removePendingInstall(id)) return true;
  const a = findAgent(id);
  if (!a) return false;
  agents.delete(a.id);
  history.delete(a.id);
  pending.delete(a.id);
  pollWaiters.delete(a.id);
  saveAgents();
  return true;
}

module.exports = { handleReport, getAllAgentData, getDockerData, getProxmoxData, hasPve, hasDocker, queueCommand, takeCommands, waitForCommands, handleResult, removeAgent, findAgent, commandLines, addPendingInstall };
