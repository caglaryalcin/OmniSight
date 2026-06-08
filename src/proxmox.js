const https = require('https');

async function proxmoxRequest(config, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: config.host,
      port: config.port || 8006,
      path: `/api2/json${path}`,
      method,
      headers: { 'Authorization': `PVEAPIToken=${config.tokenId}=${config.tokenSecret}` },
      rejectUnauthorized: false,
    };
    if (method === 'POST') options.headers['Content-Length'] = 0;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data).data); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function proxmoxServiceAction(config, node, service, action) {
  if (!/^[a-zA-Z0-9@._-]+$/.test(node) || !/^[a-zA-Z0-9@._-]+$/.test(service)) throw new Error('invalid name');
  if (action === 'status') {
    const s = await proxmoxRequest(config, `/nodes/${node}/services/${service}/state`);
    return `${service}\nstate: ${s?.state || s?.['active-state'] || 'unknown'}\nsub: ${s?.['sub-state'] || ''}\n${s?.desc || ''}`;
  }
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('invalid action');
  await proxmoxRequest(config, `/nodes/${node}/services/${service}/${action}`, 'POST');
  const s = await proxmoxRequest(config, `/nodes/${node}/services/${service}/state`).catch(() => null);
  return `${action} requested — state: ${s?.state || s?.['active-state'] || 'unknown'}`;
}

async function getNodeStatus(config, nodeName) {
  try {
    const s = await proxmoxRequest(config, `/nodes/${nodeName}/status`);
    const cpuCores = s?.cpuinfo?.cpus || 0;
    const cpuRaw = s?.cpu || 0;
    const memUsed = s?.memory?.used || 0;
    const memTotal = s?.memory?.total || 0;
    return {
      name: nodeName,
      online: true,
      cpu: Math.round(cpuRaw * 100),
      cpuCores,
      cpuRaw,
      ram: {
        percent: memTotal ? Math.round((memUsed / memTotal) * 100) : null,
        usedGB: (memUsed / 1024 ** 3).toFixed(1),
        totalGB: (memTotal / 1024 ** 3).toFixed(1),
        used: memUsed,
        total: memTotal,
      },
      uptime: s?.uptime || null,
    };
  } catch {
    return { name: nodeName, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } };
  }
}

async function getNodeHistory(config, nodeName) {
  try {
    const data = (await proxmoxRequest(config, `/nodes/${nodeName}/rrddata?timeframe=hour&cf=AVERAGE`) || []).filter(d => d != null);
    const maxMem = Math.max(...data.map(d => d.memtotal || 0), 1);
    return data.map(d => ({
      time: d.time,
      cpu: Math.round((d.cpu || 0) * 100),
      mem: Math.round(((d.memused || 0) / maxMem) * 100),
    }));
  } catch {
    return [];
  }
}

async function getServices(config, nodeName) {
  try {
    const services = await proxmoxRequest(config, `/nodes/${nodeName}/services`);
    const excluded = config.excludedServices?.proxmox?.[nodeName] || [];
    return (services || []).map(s => ({
      name: s.name,
      desc: s.desc,
      state: s.state,
      active: s.state === 'running',
      excluded: excluded.includes(s.name)
    }));
  } catch {
    return [];
  }
}

async function getVMs(config, nodeName) {
  try {
    const [qemu, lxc] = await Promise.allSettled([
      proxmoxRequest(config, `/nodes/${nodeName}/qemu`),
      proxmoxRequest(config, `/nodes/${nodeName}/lxc`),
    ]);
    const vms = (qemu.value || []).map(v => ({ ...v, type: 'vm' }));
    const containers = (lxc.value || []).map(c => ({ ...c, type: 'lxc' }));
    return [...vms, ...containers].map(v => ({
      id: v.vmid,
      name: v.name,
      type: v.type,
      status: v.status,
      running: v.status === 'running',
      cpu: v.cpu ? Math.round(v.cpu * 100) : 0,
      ram: v.mem && v.maxmem ? Math.round((v.mem / v.maxmem) * 100) : 0,
    }));
  } catch {
    return [];
  }
}

async function getNodeBackup(config, nodeName) {
  try {
    const tasks = await proxmoxRequest(config, `/nodes/${nodeName}/tasks?limit=200`);
    const vz = (tasks || []).filter(t => t.type === 'vzdump' || /vzdump|backup/i.test(t.type || '')).sort((a, b) => (b.starttime || 0) - (a.starttime || 0));
    if (!vz.length) return null;
    const last = vz[0];
    const running = !last.endtime || last.status === undefined;
    return {
      status: running ? 'running' : (last.status || 'unknown'),
      ok: last.status === 'OK',
      running,
      starttime: last.starttime || null,
      endtime: last.endtime || null,
    };
  } catch { return null; }
}

async function getNodeStorage(config, nodeName) {
  try {
    const res = await proxmoxRequest(config, `/nodes/${nodeName}/storage`);
    return (res || []).map(s => ({
      name: s.storage,
      type: s.type,
      active: s.active === 1 || s.active === true,
      total: s.total || 0,
      used: s.used || 0,
      avail: s.avail || 0,
      percent: s.total ? Math.round((s.used / s.total) * 100) : 0
    }));
  } catch {
    return [];
  }
}

async function getClusterStatus(config) {
  try {
    const data = await proxmoxRequest(config, '/cluster/status');
    const map = {};
    (data || []).forEach(e => { if (e.type === 'node' && e.name) map[e.name] = e.ip || null; });
    return map;
  } catch { return {}; }
}

async function getCephStatus(config) {
  try {
    const res = await proxmoxRequest(config, `/nodes/${config.nodes[0]}/ceph/status`);
    if (res && res.health) {
      const checks = [];
      if (res.health.checks) {
        for (const key in res.health.checks) {
          const check = res.health.checks[key];
          if (check && check.summary && check.summary.message) {
            checks.push(check.summary.message);
          }
        }
      }
      return {
        health: res.health.status || 'UNKNOWN',
        checks
      };
    }
  } catch {
    return null;
  }
}

async function getAllProxmoxData(config) {
  const nodeNames = config.nodes || [];
  const ipMap = await getClusterStatus(config);

  const [cephResult, ...results] = await Promise.allSettled([
    nodeNames.length ? getCephStatus(config) : Promise.resolve(null),
    ...nodeNames.map(async (nodeName) => {
      const [nodeStatus, services, vms, history, backup, storage] = await Promise.allSettled([
        getNodeStatus(config, nodeName),
        getServices(config, nodeName),
        getVMs(config, nodeName),
        getNodeHistory(config, nodeName),
        getNodeBackup(config, nodeName),
        getNodeStorage(config, nodeName),
      ]);
      return {
        node: nodeStatus.value || { name: nodeName, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } },
        services: services.value || [],
        vms: vms.value || [],
        history: history.value || [],
        backup: backup.value || null,
        storage: storage.value || [],
      };
    })
  ]);

  const ceph = cephResult.status === 'fulfilled' ? cephResult.value : null;

  const nodes = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { node: { name: nodeNames[i], online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } }, services: [], vms: [], history: [], storage: [] }
  );
  nodes.forEach(n => { n.host = ipMap[n.node.name] || config.host; });

  const onlineNodes = nodes.filter(n => n.node.online);
  const clusterSummary = {
    nodesOnline: onlineNodes.length,
    totalNodes: nodeNames.length,
    totalCores: nodes.reduce((s, n) => s + (n.node.cpuCores || 0), 0),
    usedCores: onlineNodes.reduce((s, n) => s + (n.node.cpuRaw || 0) * (n.node.cpuCores || 0), 0),
    totalRAM: nodes.reduce((s, n) => s + (n.node.ram?.total || 0), 0),
    usedRAM: onlineNodes.reduce((s, n) => s + (n.node.ram?.used || 0), 0),
  };

  return { clusterSummary, nodes, ceph };
}

module.exports = { getAllProxmoxData, proxmoxServiceAction };