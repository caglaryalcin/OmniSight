// Pure history retention and compaction policy, independent of disk/worker state.
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_POINT_INTERVAL_MS = 15000;
const HISTORY_ARCHIVE_BUCKET_MS = 5 * 60 * 1000;
const STATUS_SEVERITY = Object.freeze({
  down: 0, offline: 0, failed: 0, error: 0, critical: 0,
  warning: 1, warn: 1, degraded: 1,
  unknown: 2, pending: 2, maintenance: 2,
  up: 3, online: 3, ok: 3, healthy: 3, success: 3,
});

function normalizeHistoryRetentionDays(value) {
  const days = Number(value || 1);
  if (days <= 1) return 1;
  if (days <= 7) return 7;
  return 30;
}

function historyStorageMaxPoints(days = 1) {
  const retentionDays = normalizeHistoryRetentionDays(days);
  const rawPoints = Math.ceil(DAY_MS / HISTORY_POINT_INTERVAL_MS);
  const archivePoints = Math.ceil((retentionDays - 1) * DAY_MS / HISTORY_ARCHIVE_BUCKET_MS);
  return rawPoints + archivePoints + 2;
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function historyPointTime(point) {
  const raw = point?.time;
  if (raw == null || raw === '') return null;
  const numeric = optionalNumber(raw);
  if (numeric !== null) return numeric > 1e11 ? numeric : numeric * 1000;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function historyPointSeverity(point) {
  const up = optionalNumber(point.up);
  if (up === 0 || point.healthy === false) return 0;
  const status = String(point.status ?? point.health ?? '').trim().toLowerCase();
  const statusSeverity = STATUS_SEVERITY[status];
  if (Number.isFinite(statusSeverity)) return statusSeverity;
  const health = optionalNumber(point.health);
  if (health !== null) return 4 + Math.max(0, Math.min(100, health)) / 100;
  if (up === 1 || point.healthy === true) return 3;
  return Number.POSITIVE_INFINITY;
}

function archiveRepresentative(previous, candidate) {
  if (!previous) return candidate;
  const previousSeverity = historyPointSeverity(previous.point);
  const candidateSeverity = historyPointSeverity(candidate.point);
  if (candidateSeverity < previousSeverity) return candidate;
  if (candidateSeverity > previousSeverity) return previous;
  return candidate.time >= previous.time ? candidate : previous;
}

// Keep the most recent day at native resolution. Each older five-minute bucket
// keeps its worst health sample, or its newest sample when severity is equal.
function compactHistorySeries(series = [], options = {}) {
  if (!Array.isArray(series) || !series.length) return [];
  const days = normalizeHistoryRetentionDays(options.days);
  const newestPointTime = historyPointTime(series[series.length - 1]);
  let now = optionalNumber(options.now);
  if (now === null) now = Math.max(Date.now(), newestPointTime ?? 0);
  const cutoff = now - days * DAY_MS;
  const rawCutoff = now - DAY_MS;
  const archived = new Map();
  const recent = [];
  for (const point of series) {
    const time = historyPointTime(point);
    if (time === null || time < cutoff || time > now + HISTORY_POINT_INTERVAL_MS * 2) continue;
    if (time >= rawCutoff || days === 1) {
      recent.push({ point, time });
      continue;
    }
    const bucket = Math.floor(time / HISTORY_ARCHIVE_BUCKET_MS);
    archived.set(bucket, archiveRepresentative(archived.get(bucket), { point, time }));
  }
  return [...archived.values(), ...recent]
    .sort((a, b) => a.time - b.time)
    .slice(-historyStorageMaxPoints(days))
    .map(row => row.point);
}

module.exports = { normalizeHistoryRetentionDays, historyStorageMaxPoints, compactHistorySeries };
