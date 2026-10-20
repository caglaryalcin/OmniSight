const MAX_SAMPLE_AGE_MS = 120000;

function hostOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  try { return new URL(text.includes('://') ? text : `https://${text}`).hostname; }
  catch { return ''; }
}

function normalizeUnpollerTemperatures(body, now = Date.now()) {
  if (body?.status !== 'success' || !['vector', 'matrix'].includes(body.data?.resultType)) return [];
  return (body.data.result || []).flatMap(row => {
    const labels = row.metric || {};
    if (!/^cpu$/i.test(labels.temp_type || '') && !/^cpu$/i.test(labels.temp_area || '')) return [];
    const point = body.data.resultType === 'matrix' ? row.values?.at(-1) : row.value;
    const value = Number(point?.[1]);
    const at = Number(point?.[0]) * 1000;
    if (!Number.isFinite(value) || value <= 0 || value >= 200 || !Number.isFinite(at)
      || at > now + 30000 || now - at > MAX_SAMPLE_AGE_MS) return [];
    return [{
      value, at, name: String(labels.name || ''), type: String(labels.type || ''),
      site: String(labels.site_name || ''), sourceHost: hostOf(labels.source),
      ip: hostOf(labels.ip || labels.ip_address || ''),
      mac: String(labels.mac || labels.mac_address || '').toLowerCase().replace(/[^a-f0-9]/g, ''),
    }];
  });
}

function applyUnpollerTemperature(device, system, samples = [], now = Date.now()) {
  if (String(device.profile || device.preset || '').toLowerCase() !== 'unifi') return system;
  if (system.cpuTemp != null && !system.temperatureStale) return system;
  const host = hostOf(device.host);
  const mac = String(device.mac || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  const name = String(device.name || '').trim().toLowerCase();
  const candidates = samples.flatMap(sample => {
    if (now - sample.at > MAX_SAMPLE_AGE_MS || sample.at > now + 30000) return [];
    const score = (host && sample.ip === host) || (mac && sample.mac === mac) ? 3
      // Only a console gateway's metric may use its controller URL as identity.
      : host && sample.sourceHost === host && /^(udm|udr|ucg)\b/i.test(sample.type) ? 2
      : name && sample.name.toLowerCase() === name ? 1 : 0;
    return score ? [{ sample, score }] : [];
  }).sort((a, b) => b.score - a.score || b.sample.at - a.sample.at);
  const best = candidates[0];
  if (!best) return system;
  const identity = s => `${s.sourceHost}|${s.site}|${s.mac || s.ip || s.name}`;
  if (candidates.some(c => c.score === best.score && identity(c.sample) !== identity(best.sample))) return system;
  const { value, at } = best.sample;
  const stale = system.temperatureStale;
  return {
    ...system,
    ...(stale ? { systemTemperature: null, systemTemperatureLabel: null, nvmeTemps: [] } : {}),
    cpuTemp: value, cpuTempLabel: 'CPU temperature',
    systemTemp: value, systemTempLabel: 'CPU temperature',
    temperatureStale: false, temperatureLastKnownAt: at, temperatureSource: 'unpoller',
    sensors: {
      ...system.sensors,
      temperatures: [
        ...(stale ? [] : system.sensors?.temperatures || []),
        { label: 'CPU temperature', value, source: 'unpoller' },
      ],
    },
  };
}

module.exports = { normalizeUnpollerTemperatures, applyUnpollerTemperature };
