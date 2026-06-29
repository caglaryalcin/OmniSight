const http = require('http');
const https = require('https');

const imageUpdateCache = new Map();
const IMAGE_UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ');

function requestUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.request(parsed, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: opts.timeout || 8000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function parseImageRef(image) {
  let ref = String(image || '').trim();
  if (!ref || ref === '<none>:<none>') return null;
  ref = ref.replace(/^docker\.io\//, '');
  const digestMatch = ref.match(/@sha256:[a-f0-9]+$/i);
  const pinnedDigest = digestMatch ? digestMatch[0].slice(1) : '';
  if (digestMatch) ref = ref.slice(0, digestMatch.index);
  const parts = ref.split('/');
  let registry = 'registry-1.docker.io';
  let repository;
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift();
    repository = parts.join('/');
  } else {
    repository = parts.join('/');
  }
  let tag = 'latest';
  const lastSlash = repository.lastIndexOf('/');
  const lastColon = repository.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = repository.slice(lastColon + 1) || 'latest';
    repository = repository.slice(0, lastColon);
  }
  if (!repository) return null;
  if (registry === 'registry-1.docker.io' && !repository.includes('/')) repository = `library/${repository}`;
  return { registry, repository, tag, pinnedDigest, display: image };
}

function parseAuthChallenge(header) {
  const text = String(Array.isArray(header) ? header[0] : header || '');
  if (!/^Bearer\s+/i.test(text)) return null;
  const out = {};
  text.replace(/(\w+)="([^"]*)"/g, (_, k, v) => { out[k] = v; return ''; });
  return out.realm ? out : null;
}

async function registryToken(challenge) {
  const u = new URL(challenge.realm);
  if (challenge.service) u.searchParams.set('service', challenge.service);
  if (challenge.scope) u.searchParams.set('scope', challenge.scope);
  const r = await requestUrl(u.toString(), { timeout: 8000 });
  if (r.statusCode >= 400) throw new Error(`token HTTP ${r.statusCode}`);
  const body = JSON.parse(r.body || '{}');
  const token = body.token || body.access_token;
  if (!token) throw new Error('registry token missing');
  return token;
}

async function remoteManifestDigest(image) {
  const parsed = parseImageRef(image);
  if (!parsed) return null;
  const url = `https://${parsed.registry}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;
  const headers = { Accept: MANIFEST_ACCEPT };
  let r = await requestUrl(url, { method: 'HEAD', headers, timeout: 8000 });
  if (r.statusCode === 401) {
    const challenge = parseAuthChallenge(r.headers['www-authenticate']);
    if (challenge) {
      const token = await registryToken(challenge);
      r = await requestUrl(url, { method: 'HEAD', headers: { ...headers, Authorization: `Bearer ${token}` }, timeout: 8000 });
    }
  }
  if (r.statusCode >= 400) throw new Error(`registry HTTP ${r.statusCode}`);
  return String(r.headers['docker-content-digest'] || '').trim() || null;
}

function digestFromInspect(inspect = {}, image = '') {
  const repo = parseImageRef(image);
  if (repo?.pinnedDigest) return repo.pinnedDigest;
  const digestKeys = [
    inspect.RepoDigests,
    inspect.repoDigests,
    inspect.Digests,
    inspect.digests,
  ];
  const digests = digestKeys.flatMap(value => Array.isArray(value) ? value : (value ? [value] : []));
  const exact = digests.find(d => String(d || '').includes('@sha256:'));
  if (exact) return String(exact).split('@').pop();
  const direct = String(inspect.Digest || inspect.digest || inspect.imageDigest || inspect.ImageDigest || '').trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(direct)) return direct;
  return /^[a-f0-9]{64}$/i.test(direct) ? `sha256:${direct}` : '';
}

async function imageUpdateInfo(image, inspectFn) {
  const parsed = parseImageRef(image);
  if (!parsed) return { status: 'unknown', label: 'unknown' };
  const key = `${parsed.registry}/${parsed.repository}:${parsed.tag}`;
  const cached = imageUpdateCache.get(key);
  if (cached && Date.now() - cached.at < IMAGE_UPDATE_TTL_MS) return cached.value;
  let value;
  try {
    const inspect = await inspectFn(image).catch(() => null);
    const localDigest = digestFromInspect(inspect || {}, image);
    const remoteDigest = await remoteManifestDigest(image);
    if (!remoteDigest || !localDigest) {
      value = { status: 'unknown', label: 'unknown', checkedAt: new Date().toISOString(), localDigest, remoteDigest };
    } else {
      const current = localDigest === remoteDigest || String(localDigest).endsWith(remoteDigest.replace(/^sha256:/, ''));
      value = { status: current ? 'current' : 'update', label: current ? 'current' : 'update available', checkedAt: new Date().toISOString(), localDigest, remoteDigest };
    }
  } catch (err) {
    value = { status: 'unknown', label: 'unknown', checkedAt: new Date().toISOString(), error: err.message };
  }
  imageUpdateCache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { imageUpdateInfo, parseImageRef };
