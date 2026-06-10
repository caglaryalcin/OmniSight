const https = require('https');
const http = require('http');

function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}

function parseStatusPage(inputUrl, slug) {
  const out = { baseUrl: String(inputUrl || '').trim(), slug: String(slug || '').trim() };
  if (!out.baseUrl) return out;
  try {
    const u = new URL(out.baseUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const statusIdx = parts.findIndex(p => ['status', 'status-page'].includes(p));
    if (!out.slug && statusIdx >= 0 && parts[statusIdx + 1]) out.slug = parts[statusIdx + 1];
    if (statusIdx >= 0) {
      u.pathname = parts.slice(0, statusIdx).join('/');
      if (!u.pathname.startsWith('/')) u.pathname = '/' + u.pathname;
      if (u.pathname === '/') u.pathname = '';
      u.search = '';
      u.hash = '';
      out.baseUrl = u.toString().replace(/\/$/, '');
    }
  } catch {}
  return out;
}

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 140)}`));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Uptime Kuma')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const STATUS = {
  0: { status: 'down', healthy: false },
  1: { status: 'up', healthy: true },
  2: { status: 'pending', healthy: true },
  3: { status: 'maintenance', healthy: true },
};
const STATUS_ORDER = { down: 0, pending: 1, maintenance: 2, up: 3, unknown: 4 };

function latestHeartbeat(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return [...list].sort((a, b) => new Date(b.time || b.createdDate || 0) - new Date(a.time || a.createdDate || 0))[0];
}

function statusFromCode(code, monitor = {}) {
  return STATUS[Number(code)] || { status: monitor.active === false ? 'maintenance' : 'unknown', healthy: monitor.active !== false };
}

function heartbeatHistory(list, monitor = {}) {
  if (!Array.isArray(list) || !list.length) return [];
  return [...list]
    .sort((a, b) => new Date(a.time || a.createdDate || 0) - new Date(b.time || b.createdDate || 0))
    .slice(-36)
    .map(h => ({
      status: statusFromCode(h?.status, monitor).status,
      time: h?.time || h?.createdDate || null,
      ping: h?.ping ?? null,
    }));
}

async function getAllUptimeKuma(config = {}) {
  try {
    const parsed = parseStatusPage(config.url, config.slug);
    if (!parsed.baseUrl || !parsed.slug) throw new Error('Uptime Kuma URL and status page slug are required');
    const headers = {};
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
      headers['X-Api-Key'] = config.apiKey;
    }

    const pageUrl = joinUrl(parsed.baseUrl, `/api/status-page/${encodeURIComponent(parsed.slug)}`);
    const hbUrl = joinUrl(parsed.baseUrl, `/api/status-page/heartbeat/${encodeURIComponent(parsed.slug)}`);
    const [page, heartbeat] = await Promise.all([
      httpGetJson(pageUrl, headers),
      httpGetJson(hbUrl, headers).catch(() => ({})),
    ]);

    const monitors = [];
    const groups = page.publicGroupList || page.publicGroupListData || page.groups || [];
    groups.forEach(group => {
      (group.monitorList || group.monitor_list || group.monitors || []).forEach(m => {
        const id = m.id ?? m.monitorID ?? m.monitor_id;
        const hbList = (heartbeat.heartbeatList || heartbeat.heartbeats || {})[id];
        const hb = latestHeartbeat(hbList);
        const code = Number(hb?.status ?? m.status);
        const st = statusFromCode(code, m);
        monitors.push({
          id,
          name: m.name || m.displayName || `Monitor ${id}`,
          type: m.type || '',
          url: m.url || m.hostname || '',
          group: group.name || '',
          status: st.status,
          healthy: st.healthy,
          lastPing: hb?.time || hb?.createdDate || null,
          ping: hb?.ping ?? null,
          message: hb?.msg || hb?.message || '',
          history: heartbeatHistory(hbList, m),
        });
      });
    });

    monitors.sort((a, b) => (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5) || String(a.name).localeCompare(String(b.name)));

    const summary = {
      total: monitors.length,
      up: monitors.filter(m => m.status === 'up').length,
      down: monitors.filter(m => m.status === 'down').length,
      pending: monitors.filter(m => m.status === 'pending').length,
      maintenance: monitors.filter(m => m.status === 'maintenance').length,
      unknown: monitors.filter(m => m.status === 'unknown').length,
    };

    return { online: true, title: page.title || page.statusPage?.title || 'Uptime Kuma', slug: parsed.slug, summary, monitors };
  } catch (err) {
    console.warn('Uptime Kuma refresh failed:', err.message);
    return { online: false, error: err.message, summary: { total: 0, up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0 }, monitors: [] };
  }
}

module.exports = { getAllUptimeKuma };
