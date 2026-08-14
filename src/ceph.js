'use strict';

function metricNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numAny(...values) {
  for (const value of values) {
    const number = metricNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function cephHealthStatus(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      const nested = cephHealthStatus(value.status, value.health, value.health_status, value.overall_status);
      if (nested) return nested;
      continue;
    }
    const raw = String(value).trim().toUpperCase();
    if (!raw) continue;
    if (raw === 'OK') return 'HEALTH_OK';
    if (raw === 'WARN' || raw === 'WARNING') return 'HEALTH_WARN';
    if (raw === 'ERR' || raw === 'ERROR') return 'HEALTH_ERR';
    const match = raw.match(/\bHEALTH_(OK|WARN|ERR)\b/);
    if (match) return `HEALTH_${match[1]}`;
  }
  return '';
}

function roundedAverage(values) {
  const numbers = values.map(metricNumber).filter(value => value !== null);
  if (!numbers.length) return null;
  return Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10;
}

function normalizeOsdLatency(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rows = [];
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const type = String(value.type || '').toLowerCase();
    const name = String(value.name || value.id || '');
    if (type === 'osd' || /^osd\.\d+$/i.test(name)) {
      const status = String(value.status || '').toLowerCase();
      if (status !== 'down') {
        const applyMs = numAny(value.apply_latency_ms, value.applyLatencyMs, value.apply_latency);
        const commitMs = numAny(value.commit_latency_ms, value.commitLatencyMs, value.commit_latency);
        if (applyMs !== null || commitMs !== null) rows.push({ applyMs, commitMs });
      }
    }

    if (Array.isArray(value.children)) value.children.forEach(visit);
    if (value.root && value.root !== value) visit(value.root);
  }

  visit(raw);
  if (!rows.length) return null;
  return {
    averageMs: roundedAverage(rows.flatMap(row => [row.applyMs, row.commitMs])),
    applyMs: roundedAverage(rows.map(row => row.applyMs)),
    commitMs: roundedAverage(rows.map(row => row.commitMs)),
    osds: rows.length,
  };
}

function normalizeMonQuorum(statusData) {
  if (!statusData || typeof statusData !== 'object') return null;
  const monmap = statusData.monmap?.monmap || statusData.monmap || {};
  const monitors = Array.isArray(monmap.mons) ? monmap.mons : [];
  const quorumNames = Array.isArray(statusData.quorum_names)
    ? statusData.quorum_names.map(String).filter(Boolean)
    : [];
  const quorumIds = Array.isArray(statusData.quorum) ? statusData.quorum : [];
  const names = quorumNames.length ? quorumNames : quorumIds.map(id => {
    const monitor = monitors.find(item => String(item.rank) === String(id) || String(item.name) === String(id));
    return monitor?.name ? String(monitor.name) : '';
  }).filter(Boolean);

  let total = numAny(monmap.num_mons, monmap.num_mon, monitors.length || null);
  let inQuorum = quorumNames.length ? quorumNames.length : (quorumIds.length ? quorumIds.length : null);
  if (total === null && inQuorum !== null) total = inQuorum;
  if (inQuorum === null && total === 1 && cephHealthStatus(statusData.health) === 'HEALTH_OK') inQuorum = 1;
  if (total === null && inQuorum === null) return null;

  const quorate = total > 0 && inQuorum !== null ? inQuorum > total / 2 : null;
  const status = total === null || inQuorum === null || total <= 0
    ? 'unknown'
    : inQuorum >= total
      ? 'healthy'
      : quorate
        ? 'degraded'
        : 'lost';
  return {
    total,
    inQuorum,
    names: names.slice(0, 16),
    quorate,
    status,
  };
}

function normalizeCephStatus(raw, dfRaw = null, osdRaw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const statusData = raw.statusData || raw.cephStatus || raw.status_data || raw;
  const dfData = raw.df || raw.dfData || raw.cephDf || dfRaw || null;
  const osdData = raw.osdData || raw.cephOsd || raw.osd_data || osdRaw || null;
  const health = statusData.health || statusData.health_status || statusData.status || statusData;
  const status = cephHealthStatus(health, statusData.health, statusData.health_status, statusData.status, raw.health, raw.status);
  if (!status) return null;
  const checks = [];
  const source = health.checks || statusData.checks || {};
  if (Array.isArray(source)) {
    source.forEach(check => {
      const message = check?.summary?.message || check?.message || check?.summary || check?.name;
      if (message) checks.push(String(message).slice(0, 300));
    });
  } else if (source && typeof source === 'object') {
    for (const key of Object.keys(source)) {
      const check = source[key];
      const message = check?.summary?.message || check?.message || check?.summary || key;
      if (message) checks.push(String(message).slice(0, 300));
    }
  }
  const osdmap = statusData.osdmap?.osdmap || statusData.osdmap || {};
  const osd = {
    total: numAny(osdmap.num_osds, osdmap.num_osd, osdmap.osd_count),
    up: numAny(osdmap.num_up_osds, osdmap.num_up_osd, osdmap.up),
    in: numAny(osdmap.num_in_osds, osdmap.num_in_osd, osdmap.in),
  };
  const stats = dfData?.stats || statusData.pgmap || {};
  const totalBytes = numAny(stats.total_bytes, stats.bytes_total, statusData.pgmap?.bytes_total);
  const usedBytes = numAny(stats.total_used_bytes, stats.bytes_used, statusData.pgmap?.bytes_used);
  const availBytes = numAny(stats.total_avail_bytes, stats.bytes_avail, statusData.pgmap?.bytes_avail);
  const usage = totalBytes ? {
    totalBytes,
    usedBytes: usedBytes || 0,
    availBytes: availBytes ?? Math.max(0, totalBytes - (usedBytes || 0)),
    percent: Math.round(((usedBytes || 0) / totalBytes) * 1000) / 10,
  } : null;
  return {
    health: status,
    checks,
    osd,
    usage,
    latency: normalizeOsdLatency(osdData),
    mon: normalizeMonQuorum(statusData),
  };
}

module.exports = { normalizeCephStatus };
