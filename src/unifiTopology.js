function safeId(value) {
  return String(value || 'node').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizedMac(value) {
  return String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

function normalizedHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function snmpRef(row = {}) {
  return `snmp:${safeId(row.name || row.host || 'device')}`;
}

function unifiDeviceKeys(device = {}) {
  return {
    mac: normalizedMac(device.mac || device.macAddress),
    hosts: new Set([device.ip, device.ipAddress, ...(device.aliases || [])].map(normalizedHost).filter(Boolean)),
    name: normalizedName(device.name),
  };
}

function snmpDeviceKeys(device = {}) {
  return {
    mac: normalizedMac(device.mac || device.macAddress),
    hosts: new Set([device.host, device.ip, ...(device.aliases || [])].map(normalizedHost).filter(Boolean)),
    name: normalizedName(device.name),
  };
}

function findSnmpMatch(device, snmpRows, usedRefs) {
  const keys = unifiDeviceKeys(device);
  const available = snmpRows.filter(row => !usedRefs.has(snmpRef(row)));
  if (keys.mac) {
    const row = available.find(candidate => snmpDeviceKeys(candidate).mac === keys.mac);
    if (row) return row;
  }
  if (keys.hosts.size) {
    const row = available.find(candidate => [...snmpDeviceKeys(candidate).hosts].some(host => keys.hosts.has(host)));
    if (row) return row;
  }
  if (keys.name) {
    const matches = available.filter(candidate => snmpDeviceKeys(candidate).name === keys.name);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function deviceTypeLabel(kind) {
  if (kind === 'gateway') return 'Gateway';
  if (kind === 'switch') return 'Switch';
  if (kind === 'access-point') return 'Access Point';
  return 'UniFi device';
}

function deviceStatus(device = {}) {
  if (device._connecting) return 'idle';
  if (device.alertable || String(device.state).toLowerCase() === 'offline') return 'bad';
  if (device.warn) return 'warn';
  if (device.online === false) return 'idle';
  return ['online', 'up'].includes(String(device.state || '').toLowerCase()) || device.online ? 'good' : 'idle';
}

function buildUnifiTopology(instances = [], snmpRows = []) {
  const nodes = [];
  const matchedSnmpRefs = new Set();
  const usedRefs = new Set();

  for (const instance of instances || []) {
    const devices = Array.isArray(instance?.devices) ? instance.devices : [];
    if (!devices.length) continue;
    const instanceKey = safeId(instance.site || instance.name || instance.url || 'unifi');
    const byId = new Map(devices.map(device => [String(device.id), device]));
    const refs = new Map();

    for (const device of devices) {
      const match = findSnmpMatch(device, snmpRows || [], matchedSnmpRefs);
      let ref = match ? snmpRef(match) : `unifi:${instanceKey}:${safeId(device.id || device.mac || device.name)}`;
      if (match) matchedSnmpRefs.add(ref);
      if (usedRefs.has(ref)) ref = `unifi:${instanceKey}:${safeId(device.id || device.mac || device.name)}`;
      usedRefs.add(ref);
      refs.set(String(device.id), ref);
    }

    const depthMemo = new Map();
    const depthOf = (deviceId, trail = new Set()) => {
      if (depthMemo.has(deviceId)) return depthMemo.get(deviceId);
      if (trail.has(deviceId)) return 0;
      const device = byId.get(deviceId);
      const parentId = String(device?.uplinkDeviceId || '');
      if (!parentId || !byId.has(parentId)) {
        depthMemo.set(deviceId, 0);
        return 0;
      }
      const nextTrail = new Set(trail);
      nextTrail.add(deviceId);
      const depth = Math.min(8, depthOf(parentId, nextTrail) + 1);
      depthMemo.set(deviceId, depth);
      return depth;
    };

    const sorted = [...devices].sort((left, right) => {
      const depthDiff = depthOf(String(left.id)) - depthOf(String(right.id));
      return depthDiff || String(left.name || '').localeCompare(String(right.name || ''));
    });

    for (const device of sorted) {
      const id = String(device.id);
      const parentId = String(device.uplinkDeviceId || '');
      const kind = device.kind || (device.isGateway ? 'gateway' : 'device');
      const meta = [...new Set([deviceTypeLabel(kind), device.model, device.ip || device.ipAddress].filter(Boolean))].join(' · ');
      nodes.push({
        ref: refs.get(id),
        parentRef: parentId && refs.has(parentId) ? refs.get(parentId) : null,
        level: -2 + depthOf(id),
        label: device.name || device.model || device.ip || 'UniFi device',
        meta,
        status: deviceStatus(device),
        icon: kind === 'switch' ? 'switch' : 'unifi',
        kind: 'host',
        deviceKind: kind,
        platform: 'unifi',
      });
    }
  }

  return { nodes, matchedSnmpRefs: [...matchedSnmpRefs] };
}

module.exports = { buildUnifiTopology, snmpRef };
