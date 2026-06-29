const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');
const { imageUpdateInfo } = require('./imageUpdates');

function configInstances(cfg = {}) {
  const src = Array.isArray(cfg.instances) && cfg.instances.length ? cfg.instances : (cfg.url ? [cfg] : []);
  return src
    .filter(i => i && (i.url || i.name))
    .map((i, idx) => ({
      name: String(i.name || i.label || i.url || `Dockhand ${idx + 1}`).trim(),
      url: String(i.url || '').trim().replace(/\/+$/, ''),
      token: i.token || i.apiToken || i.bearerToken || cfg.token || cfg.apiToken || cfg.bearerToken || '',
      insecureTLS: i.insecureTLS ?? cfg.insecureTLS,
    }));
}

function request(instance, path, opts = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(path, instance.url + '/'); } catch { return reject(new Error('invalid Dockhand URL')); }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json,text/plain,*/*', ...(opts.headers || {}) };
    if (instance.token) headers.Authorization = `Bearer ${instance.token}`;
    const req = lib.request(url, {
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: instance.insecureTLS ? false : undefined,
      timeout: Number(opts.timeoutMs || 10000),
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
        }
        resolve({ text, statusCode: res.statusCode });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function jsonFrom(text) {
  if (!String(text || '').trim()) return null;
  return JSON.parse(text);
}

function arrayFrom(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of ['containers', 'images', 'environments', 'envs', 'data', 'items', 'results', 'rows', 'resources', 'list']) {
    if (Array.isArray(body[key])) return body[key];
  }
  for (const root of ['data', 'result', 'payload']) {
    if (body[root] && typeof body[root] === 'object') {
      for (const key of ['containers', 'images', 'environments', 'envs', 'items', 'rows', 'results', 'resources', 'list']) {
        if (Array.isArray(body[root][key])) return body[root][key];
      }
    }
  }
  return [];
}

async function firstJson(instance, paths) {
  let lastErr;
  for (const path of paths) {
    try {
      const { text } = await request(instance, path);
      return jsonFrom(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Dockhand API endpoint not found');
}

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

function shortImage(image) {
  return str(image).replace(/@sha256:[a-f0-9]+$/i, '').replace(/^docker.io\//, '');
}

function hasExplicitTag(ref) {
  const s = str(ref);
  if (!s || s.includes('@') || s.startsWith('sha256:')) return true;
  return s.lastIndexOf(':') > s.lastIndexOf('/');
}

function addImageRef(set, value) {
  let ref = str(value).trim();
  if (!ref || ref === '<none>' || ref === '<none>:<none>') return;
  ref = ref.replace(/^\/+/, '').replace(/^docker\.io\//, '');
  const variants = [ref];
  if (ref.startsWith('library/')) variants.push(ref.slice(8));
  for (const item of variants) {
    if (!item || item === '<none>' || item === '<none>:<none>') continue;
    set.add(item);
    if (item.startsWith('sha256:')) set.add(item.slice(7));
    if (!hasExplicitTag(item)) set.add(`${item}:latest`);
  }
}

function addImageIdRef(set, value) {
  const id = str(value).trim();
  if (/^sha256:[a-f0-9]{12,}$/i.test(id) || /^[a-f0-9]{12,}$/i.test(id)) addImageRef(set, id);
}

function usedImageRefs(containers) {
  const refs = new Set();
  (Array.isArray(containers) ? containers : []).forEach(c => {
    addImageRef(refs, c.image || c.Image);
    addImageRef(refs, c.imageID || c.imageId || c.ImageID);
  });
  return refs;
}

function imageRefs(img = {}) {
  const refs = new Set();
  addImageIdRef(refs, img.Id ?? img.ID ?? img.id ?? img.imageId ?? img.imageID ?? img.image_id);
  const repo = str(img.repository ?? img.Repository ?? img.repo ?? img.Repo ?? '').trim();
  const tag = str(img.tag ?? img.Tag ?? '').trim();
  const digest = str(img.digest ?? img.Digest ?? '').trim();
  if (repo && repo !== '<none>') {
    if (tag && tag !== '<none>') addImageRef(refs, `${repo}:${tag}`);
    else addImageRef(refs, repo);
    if (digest && digest !== '<none>') addImageRef(refs, `${repo}@${digest}`);
  }
  [img.name, img.Name, img.image, img.Image, img.imageName, img.fullName, img.reference, img.ref].forEach(v => addImageRef(refs, v));
  for (const value of [img.RepoTags, img.repoTags, img.tags, img.Tags]) {
    if (!Array.isArray(value)) continue;
    value.forEach(item => {
      if (typeof item === 'string' && repo && item && !item.includes('/') && !item.includes(':') && !item.includes('@')) addImageRef(refs, `${repo}:${item}`);
      else addImageRef(refs, typeof item === 'string' ? item : (item?.name || item?.tag || item?.value));
    });
  }
  for (const value of [img.RepoDigests, img.repoDigests, img.digests, img.Digests]) {
    if (Array.isArray(value)) value.forEach(d => addImageRef(refs, d));
  }
  return refs;
}

function imageRepoDigests(img = {}) {
  const out = [];
  for (const value of [img.RepoDigests, img.repoDigests, img.digests, img.Digests]) {
    if (Array.isArray(value)) value.forEach(d => { if (str(d).trim()) out.push(str(d).trim()); });
    else if (str(value).trim()) out.push(str(value).trim());
  }
  const repo = str(img.repository ?? img.Repository ?? img.repo ?? img.Repo ?? img.name ?? img.Name ?? img.image ?? img.Image).trim();
  const digest = str(img.digest ?? img.Digest ?? img.imageDigest ?? img.ImageDigest).trim();
  if (repo && repo !== '<none>' && digest && digest !== '<none>') {
    const normalizedDigest = digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
    out.push(`${repo}@${normalizedDigest}`);
  }
  return [...new Set(out)];
}

function imageDigest(img = {}) {
  const digest = str(img.digest ?? img.Digest ?? img.imageDigest ?? img.ImageDigest).trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(digest)) return digest;
  if (/^[a-f0-9]{64}$/i.test(digest)) return `sha256:${digest}`;
  return '';
}

function updateStatusFromText(value) {
  const raw = str(value).trim().toLowerCase();
  if (!raw) return '';
  if (/up[\s_-]*to[\s_-]*date|current|latest|fresh|\bok\b/.test(raw)) return 'current';
  if (/update|outdated|stale|behind|newer/.test(raw)) return 'update';
  if (/unknown|error|fail/.test(raw)) return 'unknown';
  return '';
}

function updateInfo(status, base = {}) {
  if (!status) return null;
  return {
    ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}),
    status,
    label: base.label || (status === 'update' ? 'update available' : status),
  };
}

function normalizeImageUpdateValue(value, key = '') {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const status = updateStatusFromText(value.status ?? value.state ?? value.label ?? value.value ?? value.updateStatus ?? value.result);
    if (status) return updateInfo(status, value);
    return normalizeImageUpdateFrom(value);
  }
  if (typeof value === 'boolean') {
    const k = String(key || '').toLowerCase();
    if (/available|outdated|update|stale|behind/.test(k)) return updateInfo(value ? 'update' : 'current');
    if (/current|latest|uptodate|up_to_date|up-to-date/.test(k)) return updateInfo(value ? 'current' : 'update');
    return null;
  }
  return updateInfo(updateStatusFromText(value));
}

function normalizeImageUpdateFrom(obj = {}) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['imageUpdate', 'updateStatus', 'updateState', 'update', 'updates']) {
    const info = normalizeImageUpdateValue(obj[key], key);
    if (info) return info;
  }
  for (const key of ['updateAvailable', 'hasUpdate', 'outdated', 'isOutdated', 'stale', 'behind', 'current', 'isCurrent', 'latest', 'isLatest', 'upToDate', 'up_to_date']) {
    if (typeof obj[key] === 'boolean') {
      const info = normalizeImageUpdateValue(obj[key], key);
      if (info) return info;
    }
  }
  return null;
}

function imageUnusedFlag(img = {}) {
  for (const key of ['unused', 'isUnused', 'Unused', 'dangling', 'Dangling']) {
    if (typeof img[key] === 'boolean') return img[key];
  }
  for (const key of ['used', 'isUsed', 'inUse']) {
    if (typeof img[key] === 'boolean') return !img[key];
  }
  const count = num(img.containers ?? img.Containers ?? img.containerCount ?? img.usedByContainers ?? img.runningContainers);
  if (count != null) return count === 0;
  const status = str(img.status ?? img.state ?? img.badge).toLowerCase();
  if (/\bunused\b/.test(status)) return true;
  if (/\bin\s*use\b|\bused\b/.test(status)) return false;
  return null;
}

function imageDisplayName(img = {}) {
  const repo = str(img.repository ?? img.Repository ?? img.repo ?? img.Repo ?? '').trim();
  const tag = str(img.tag ?? img.Tag ?? '').trim();
  if (repo && repo !== '<none>' && tag && tag !== '<none>') return `${repo}:${tag}`;
  return str(img.name ?? img.Name ?? img.image ?? img.Image ?? img.imageName ?? img.fullName ?? repo ?? '').trim();
}

function mapImage(img, instance, env = null, refsInUse = new Set()) {
  const refs = imageRefs(img);
  const explicitUnused = imageUnusedFlag(img);
  const unused = explicitUnused == null ? (refs.size ? ![...refs].some(ref => refsInUse.has(ref)) : false) : explicitUnused;
  const name = imageDisplayName(img);
  const repoDigests = imageRepoDigests(img);
  const digest = imageDigest(img);
  return {
    id: str(img.Id ?? img.ID ?? img.id ?? img.imageId ?? img.imageID ?? name),
    name,
    unused,
    imageUpdate: normalizeImageUpdateFrom(img),
    digest,
    _refs: [...refs],
    _repoDigests: repoDigests,
    sourceName: instance.name,
    sourceUrl: instance.url,
    environment: env?.name || img.environment || img.environmentName || '',
    environmentId: env?.id || img.environmentId || img.environment_id || '',
  };
}

function envValue(env) {
  if (!env) return '';
  if (typeof env !== 'object') return str(env);
  return str(env.id ?? env.ID ?? env.environmentId ?? env.environment_id ?? env.uuid ?? env.key ?? env.name ?? env.Name ?? env.slug);
}

function envName(env) {
  if (!env) return '';
  if (typeof env !== 'object') return str(env);
  return str(env.name ?? env.Name ?? env.label ?? env.title ?? env.slug ?? envValue(env));
}

function mapEnvironment(env, idx) {
  const value = envValue(env) || String(idx + 1);
  const name = envName(env) || value;
  return { id: value, name };
}

function uniqueBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function stateOf(c) {
  const raw = str(c.state || c.status || c.State || c.Status || c.containerState || c.health).toLowerCase();
  if (raw.includes('running') || raw === 'up' || raw === 'healthy') return 'running';
  if (raw.includes('restart')) return 'restarting';
  if (raw.includes('pause')) return 'paused';
  if (raw.includes('dead')) return 'dead';
  if (raw.includes('created')) return 'created';
  if (raw.includes('exit') || raw.includes('stop') || raw === 'down') return 'exited';
  return raw || 'unknown';
}

function colorOf(state) {
  if (state === 'running') return 'green';
  if (['restarting', 'paused', 'created'].includes(state)) return 'yellow';
  if (['dead', 'exited'].includes(state)) return 'red';
  return 'gray';
}

function portsOf(c) {
  const ports = c.ports || c.Ports || c.portBindings || c.publicPorts || [];
  if (Array.isArray(ports)) {
    return ports.map(p => {
      if (typeof p === 'string') return p;
      const pub = p.PublicPort || p.publicPort || p.hostPort || p.publishedPort || '';
      const priv = p.PrivatePort || p.privatePort || p.containerPort || p.targetPort || '';
      const type = p.Type || p.type || '';
      return [pub, priv].filter(Boolean).join(':') + (type ? `/${type}` : '');
    }).filter(Boolean);
  }
  if (typeof ports === 'object' && ports) return Object.keys(ports);
  return str(ports) ? [str(ports)] : [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapContainer(c, instance, env = null) {
  const names = c.Names || c.names;
  const name = str(c.name || c.Name || c.containerName || c.displayName || (Array.isArray(names) ? names[0] : names)).replace(/^\//, '');
  const state = stateOf(c);
  const image = str(c.image?.name || c.image || c.Image || c.Config?.Image || c.repository || c.repo || c.imageName);
  return {
    id: str(c.id || c.ID || c.containerId || c.containerID || c.container_id || name),
    name: name || str(c.id || c.ID || 'container').slice(0, 12),
    image,
    imageShort: shortImage(image),
    state,
    status: state,
    color: colorOf(state),
    ports: portsOf(c),
    cpu: num(c.cpu ?? c.cpuPercent ?? c.cpu_percentage),
    memPercent: num(c.memPercent ?? c.memoryPercent ?? c.memory_percentage),
    netIO: c.netIO || c.networkIO || c.network || '',
    blockIO: c.blockIO || c.diskIO || c.io || '',
    imageUpdate: normalizeImageUpdateFrom(c),
    host: instance.url,
    sourceName: instance.name,
    sourceUrl: instance.url,
    environment: env?.name || c.environment || c.environmentName || '',
    environmentId: env?.id || c.environmentId || c.environment_id || '',
  };
}

function refsForImage(image) {
  const refs = new Set();
  addImageRef(refs, image);
  return refs;
}

function findDockhandImage(image, images = []) {
  const refs = refsForImage(image);
  if (!refs.size) return null;
  return images.find(img => {
    if ((img._refs || []).some(ref => refs.has(ref))) return true;
    const nameRefs = refsForImage(img.name);
    return [...nameRefs].some(ref => refs.has(ref));
  }) || null;
}

function inspectFromDockhandImage(img = {}) {
  return {
    Id: img.id || '',
    RepoDigests: img._repoDigests || [],
    digest: img.digest || '',
  };
}

async function attachImageUpdates(containers, images) {
  const uniqueImages = [...new Set((containers || []).map(c => c.image).filter(Boolean))].slice(0, 80);
  const updates = new Map();
  await mapLimit(uniqueImages, 3, async image => {
    const img = findDockhandImage(image, images);
    const direct = normalizeImageUpdateFrom(img || {});
    if (direct && direct.status !== 'unknown') {
      updates.set(image, direct);
      return;
    }
    const info = await imageUpdateInfo(image, async () => inspectFromDockhandImage(img || {}));
    updates.set(image, info.status !== 'unknown' ? info : (direct || info));
  });
  containers.forEach(c => {
    const direct = normalizeImageUpdateValue(c.imageUpdate);
    c.imageUpdate = direct && direct.status !== 'unknown'
      ? direct
      : updates.get(c.image) || direct || { status: 'unknown', label: 'unknown' };
  });
}

function summarize(containers, instances, images = []) {
  const running = containers.filter(c => c.state === 'running').length;
  const stopped = containers.filter(c => ['exited', 'dead'].includes(c.state)).length;
  const pending = containers.filter(c => ['paused', 'restarting'].includes(c.state)).length;
  return {
    servers: instances.length,
    serverUp: instances.filter(i => i.online).length,
    serverDown: instances.filter(i => !i.online && !i._connecting).length,
    total: containers.length,
    running,
    stopped,
    pending,
    images: images.length,
    unusedImages: images.filter(i => i.unused).length,
  };
}

async function getDockhandInstance(instance) {
  const basePaths = [
    '/api/containers',
    '/api/v1/containers',
    '/api/docker/containers',
    '/api/containers/json',
    '/api/container/list',
    '/api/container',
  ];
  const baseBody = await firstJson(instance, basePaths);
  const baseContainers = arrayFrom(baseBody).map(c => mapContainer(c, instance));
  const environments = await getDockhandEnvironments(instance);
  const envContainers = environments.length
    ? (await mapLimit(environments, 3, env => getDockhandContainersForEnv(instance, env))).flat()
    : [];
  const containers = uniqueBy([...baseContainers, ...envContainers], c => c.id || `${c.sourceUrl}:${c.environmentId}:${c.name}`);
  const refsInUse = usedImageRefs(containers);
  const baseImages = await getDockhandImages(instance, null, refsInUse);
  const envImages = environments.length
    ? (await mapLimit(environments, 3, env => getDockhandImages(instance, env, refsInUse))).flat()
    : [];
  const images = uniqueBy([...baseImages, ...envImages], i => i.id || `${i.sourceUrl}:${i.environmentId}:${i.name}`);
  await attachImageUpdates(containers, images);
  const summary = summarize(containers, [{ ...instance, online: true }], images);
  return {
    name: instance.name,
    url: instance.url,
    online: true,
    summary,
    environments,
    containers,
    images,
  };
}

async function getDockhandEnvironments(instance) {
  const paths = ['/api/environments', '/api/v1/environments', '/api/envs'];
  let body = null;
  try {
    body = await firstJson(instance, paths);
  } catch {
    return [];
  }
  return uniqueBy(arrayFrom(body).map(mapEnvironment), env => env.id);
}

function envContainerPaths(env) {
  const values = uniqueBy([env.id, env.name].filter(Boolean), v => String(v));
  const bases = ['/api/containers', '/api/v1/containers'];
  const params = ['env', 'environment', 'environmentId', 'environment_id'];
  return values.flatMap(value => {
    const enc = encodeURIComponent(value);
    return bases.flatMap(base => params.map(param => `${base}?${param}=${enc}`));
  });
}

async function getDockhandContainersForEnv(instance, env) {
  let fallback = [];
  try {
    for (const path of envContainerPaths(env)) {
      try {
        const { text } = await request(instance, path);
        const rows = arrayFrom(jsonFrom(text)).map(c => mapContainer(c, instance, env));
        if (rows.length) return rows;
        fallback = rows;
      } catch {
        // Try the next query parameter shape.
      }
    }
    return fallback;
  } catch {
    return [];
  }
}

function envImagePaths(env) {
  const bases = ['/api/images', '/api/v1/images', '/api/docker/images', '/api/images/json', '/api/image/list', '/api/image'];
  if (!env) return bases;
  const values = uniqueBy([env.id, env.name].filter(Boolean), v => String(v));
  const params = ['env', 'environment', 'environmentId', 'environment_id'];
  return values.flatMap(value => {
    const enc = encodeURIComponent(value);
    return bases.flatMap(base => params.map(param => `${base}?${param}=${enc}`));
  });
}

async function getDockhandImages(instance, env = null, refsInUse = new Set()) {
  let fallback = [];
  for (const path of envImagePaths(env)) {
    try {
      const { text } = await request(instance, path);
      const rows = arrayFrom(jsonFrom(text)).map(img => mapImage(img, instance, env, refsInUse)).filter(img => img.name || img.id);
      if (rows.length) return rows;
      fallback = rows;
    } catch {
      // Try the next known image endpoint shape.
    }
  }
  return fallback;
}

async function getAllDockhand(cfg = {}) {
  const configured = configInstances(cfg);
  const rows = await mapLimit(configured, Number(cfg.concurrency || cfg.collectorConcurrency || 3), async inst => {
    try {
      return await getDockhandInstance(inst);
    } catch (err) {
      return {
        name: inst.name,
        url: inst.url,
        online: false,
        error: err.message,
        summary: summarize([], [{ ...inst, online: false }], []),
        containers: [],
        images: [],
      };
    }
  });
  const containers = rows.flatMap(r => r.containers || []);
  const images = rows.flatMap(r => r.images || []);
  return {
    online: rows.length > 0 && rows.some(r => r.online),
    summary: summarize(containers, rows, images),
    instances: rows,
    containers,
    images,
  };
}

async function dockhandLogs(cfg = {}, instanceName, id, env = '') {
  const inst = configInstances(cfg).find(i => i.name === instanceName || i.url === instanceName);
  if (!inst) throw new Error('Dockhand instance not found');
  const safeId = encodeURIComponent(id);
  const safeEnv = str(env).trim() ? encodeURIComponent(str(env).trim()) : '';
  const qs = safeEnv ? [`env=${safeEnv}&tail=300`, `env=${safeEnv}`] : [];
  qs.push('tail=300', '');
  const paths = [
    ...qs.map(q => `/api/containers/${safeId}/logs${q ? `?${q}` : ''}`),
    ...qs.map(q => `/api/v1/containers/${safeId}/logs${q ? `?${q}` : ''}`),
    ...qs.map(q => `/api/docker/containers/${safeId}/logs${q ? `?${q}` : ''}`),
    ...qs.map(q => `/api/container/${safeId}/logs${q ? `?${q}` : ''}`),
    ...qs.map(q => `/api/logs/container/${safeId}${q ? `?${q}` : ''}`),
  ];
  let lastErr;
  for (const path of paths) {
    try {
      const { text } = await request(inst, path, { headers: { Accept: 'text/plain,application/json,*/*' } });
      try {
        const body = jsonFrom(text);
        return str(body?.logs || body?.log || body?.output || body?.data || text);
      } catch {
        return text;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Dockhand logs endpoint not found');
}

module.exports = { getAllDockhand, dockhandLogs, configInstances };
