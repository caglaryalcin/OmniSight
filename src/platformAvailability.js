function availabilityCounts(offline, total, online) {
  const totalCount = Math.max(0, Math.floor(Number(total) || 0));
  const offlineCount = Math.max(0, Math.min(totalCount, Math.floor(Number(offline) || 0)));
  const onlineCount = online == null
    ? Math.max(0, totalCount - offlineCount)
    : Math.max(0, Math.min(totalCount, Math.floor(Number(online) || 0)));
  return totalCount > 0 ? { offline: offlineCount, online: onlineCount, total: totalCount } : {};
}

function rowAvailability(rows, isOffline = row => !row?.online, isOnline = row => !!row?.online) {
  const list = Array.isArray(rows) ? rows : [];
  return availabilityCounts(
    list.filter(row => !row?._connecting && isOffline(row)).length,
    list.length,
    list.filter(row => !row?._connecting && isOnline(row)).length,
  );
}

function summaryInstanceAvailability(value, rows = value?.instances) {
  const counts = rowAvailability(rows);
  if (counts.total) return counts;
  return availabilityCounts(value?.summary?.down, value?.summary?.instances, value?.summary?.up);
}

function snmpProfile(row) {
  const profile = String(row?.profile || row?.preset || '').trim().toLowerCase();
  return ['synology', 'mikrotik', 'unifi'].includes(profile) ? profile : 'snmp';
}

function unifiAvailability(data) {
  const instances = data.unifi?.instances || [];
  const devices = instances.flatMap(instance => instance.devices || []);
  const snmpRows = (data.snmp || []).filter(row => snmpProfile(row) === 'unifi');
  const controllerKeys = new Set();
  devices.forEach(device => {
    [device.ip, ...(device.aliases || []), device.name && String(device.name).toLowerCase()]
      .filter(Boolean)
      .forEach(key => controllerKeys.add(key));
  });
  const unmatchedSnmp = snmpRows.filter(row => !controllerKeys.has(row.host) && !controllerKeys.has(String(row.name || '').toLowerCase()));
  const total = devices.length + unmatchedSnmp.length;
  const offline = devices.filter(device => device.alertable).length
    + unmatchedSnmp.filter(row => !row.online && !row._connecting).length;
  const online = devices.filter(device => device.online).length + unmatchedSnmp.filter(row => row.online).length;
  return total > 0 ? availabilityCounts(offline, total, online) : rowAvailability(instances);
}

function platformAvailability(data = {}, id = '') {
  if (id === 'proxmox') return rowAvailability(data.proxmox?.nodes, row => !row.node?.online, row => !!row.node?.online);
  if (id === 'linux') return rowAvailability(data.linux);
  if (id === 'windows') return rowAvailability(data.windows);
  if (id === 'kubernetes') {
    const row = data.kubernetes;
    return row ? availabilityCounts(!row._connecting && !row.online ? 1 : 0, 1, row.online ? 1 : 0) : {};
  }
  if (['synology', 'mikrotik', 'snmp'].includes(id)) return rowAvailability((data.snmp || []).filter(row => snmpProfile(row) === id));
  if (id === 'unifi') return unifiAvailability(data);
  if (id === 'healthchecks') {
    const row = data.healthchecks;
    if (!row) return {};
    if (row._connecting && !row.online) return availabilityCounts(0, 1, 0);
    if (!row.online) return availabilityCounts(1, 1, 0);
    return availabilityCounts(row.summary?.down, row.summary?.total || row.checks?.length, row.summary?.up);
  }
  if (id === 'uptimekuma') {
    const row = data.uptimekuma;
    if (!row) return {};
    if (row._connecting && !row.online) return availabilityCounts(0, 1, 0);
    if (!row.online) return availabilityCounts(1, 1, 0);
    return availabilityCounts(row.summary?.down, row.summary?.total || row.monitors?.length, row.summary?.up);
  }
  if (id === 'checks') return availabilityCounts(data.checks?.summary?.down, data.checks?.summary?.total || data.checks?.checks?.length, data.checks?.summary?.up);
  if (id === 'prometheus') {
    const row = data.prometheus;
    if (!row) return {};
    if (row._connecting && !row.online) return availabilityCounts(0, row.instances?.length || 1, 0);
    if (!row.online) {
      const counts = rowAvailability(row.instances);
      return counts.total ? counts : availabilityCounts(1, 1, 0);
    }
    const targetDown = Number(row.summary?.down || 0);
    if (targetDown > 0) return availabilityCounts(targetDown, row.summary?.total || row.targets?.length, row.summary?.up);
    return availabilityCounts(row.summary?.instanceDown, row.summary?.instances || row.instances?.length, row.summary?.instanceUp);
  }
  if (id === 'docker') return rowAvailability(data.docker);
  if (id === 'dockhand') {
    const counts = rowAvailability(data.dockhand?.instances);
    return counts.total ? counts : availabilityCounts(data.dockhand?.summary?.serverDown, data.dockhand?.summary?.servers, data.dockhand?.summary?.serverUp);
  }
  if (id === 'database') return rowAvailability(data.database);
  if (['firewall', 'truenas', 'qnap', 'ugreen', 'pbs', 'veeam'].includes(id)) return summaryInstanceAvailability(data[id]);
  if (id === 'cloudflare') {
    const row = data.cloudflare;
    if (!row) return {};
    if (row._connecting && !row.online) return availabilityCounts(0, 1, 0);
    if (!row.online) return availabilityCounts(1, 1, 0);
    const zoneCounts = rowAvailability(row.zones);
    if (zoneCounts.offline > 0) return zoneCounts;
    return availabilityCounts(row.summary?.tunnelsDown, row.summary?.tunnels || row.tunnels?.length, row.summary?.tunnelsHealthy);
  }
  if (id === 'cicd') {
    const counts = rowAvailability(data.cicd?.projects);
    return counts.total ? counts : availabilityCounts(data.cicd?.summary?.down, data.cicd?.summary?.projects, data.cicd?.summary?.up);
  }
  if (id === 'portainer') {
    const serverCounts = summaryInstanceAvailability(data.portainer);
    if (serverCounts.offline > 0) return serverCounts;
    return availabilityCounts(data.portainer?.summary?.environmentsDown, data.portainer?.summary?.environments, data.portainer?.summary?.environmentsUp);
  }
  return {};
}

module.exports = { availabilityCounts, rowAvailability, platformAvailability };
