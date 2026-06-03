const https = require('https');

async function proxmoxRequest(config, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: config.host,
      port: config.port || 8006,
      path: `/api2/json${path}`,
      method: 'GET',
      headers: { 'Authorization': `PVEAPIToken=${config.tokenId}=${config.tokenSecret}` },
      rejectUnauthorized: false,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).data); }
        catch { reject(new Error('Invalid JSON from Proxmox')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
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
    return (services || []).map(s => ({
      name: s.name,
      desc: s.desc,
      state: s.state,
      active: s.state === 'running',
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

async function getClusterStatus(config) {
  try {
    const data = await proxmoxRequest(config, '/cluster/status');
    const map = {};
    (data || []).forEach(e => { if (e.type === 'node' && e.name) map[e.name] = e.ip || null; });
    return map;
  } catch { return {}; }
}

async function getAllProxmoxData(config) {
  const nodeNames = config.nodes || [];
  const ipMap = await getClusterStatus(config);

  const results = await Promise.allSettled(
    nodeNames.map(async (nodeName) => {
      const [nodeStatus, services, vms, history] = await Promise.allSettled([
        getNodeStatus(config, nodeName),
        getServices(config, nodeName),
        getVMs(config, nodeName),
        getNodeHistory(config, nodeName),
      ]);
      return {
        node: nodeStatus.value || { name: nodeName, online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } },
        services: services.value || [],
        vms: vms.value || [],
        history: history.value || [],
      };
    })
  );

  const nodes = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { node: { name: nodeNames[i], online: false, cpuCores: 0, cpuRaw: 0, ram: { used: 0, total: 0 } }, services: [], vms: [], history: [] }
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

  return { clusterSummary, nodes };
}

module.exports = { getAllProxmoxData };
