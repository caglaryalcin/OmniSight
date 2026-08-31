const https = require('https');
const { createHash } = require('crypto');
const { mapLimit } = require('./concurrency');

const GITHUB_API_BASE = 'https://api.github.com';
const GITLAB_DEFAULT_BASE = 'https://gitlab.com';
const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_MAX_PAGES = 10;
const GITHUB_ALL_CACHE_TTL_MS = 5 * 60 * 1000;
const GITHUB_ALL_MIN_CACHE_TTL_MS = 60 * 1000;
const GITHUB_ALL_CACHE_MAX_ENTRIES = 8;
const githubAllProjectsCache = new Map();
const githubRequestFnIds = new WeakMap();
let nextGithubRequestFnId = 1;

function cleanBaseUrl(url, fallback) {
  return String(url || fallback || '').trim().replace(/\/+$/, '');
}

function tokenValue(row = {}, root = {}) {
  return row.token || row.apiToken || row.accessToken || row.bearerToken || root.token || root.apiToken || root.accessToken || root.bearerToken || '';
}

function normalizeGitlabBaseUrl(value = GITLAB_DEFAULT_BASE) {
  const raw = String(value || GITLAB_DEFAULT_BASE).trim();
  if (!raw || raw.length > 2048) throw new Error('Invalid GitLab base URL');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Invalid GitLab base URL'); }
  if (parsed.protocol !== 'https:') throw new Error('GitLab base URL must use HTTPS');
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Invalid GitLab base URL');
  }
  let pathname = parsed.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/api\/v4$/i, '');
  parsed.pathname = pathname || '/';
  return parsed.toString().replace(/\/+$/, '');
}

function gitlabApiBase(value) {
  return `${normalizeGitlabBaseUrl(value)}/api/v4`;
}

function timeoutMs(config = {}) {
  const n = Number(config.timeoutMs || config.timeout || 10000);
  return Math.max(2000, Math.min(60000, Number.isFinite(n) ? n : 10000));
}

function arr(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.workflow_runs)) return value.workflow_runs;
  if (Array.isArray(value?.workflows)) return value.workflows;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function configuredProjects(config = {}) {
  config = config || {};
  const rows = Array.isArray(config.projects) && config.projects.length
    ? config.projects
    : (Array.isArray(config.instances) ? config.instances : []);
  return rows
    .filter(row => row && (row.provider || row.repo || row.projectId || row.project || row.allRepositories === true))
    .map((row, idx) => {
      const provider = String(row.provider || row.type || 'github').toLowerCase();
      const isAllRepositories = provider === 'github'
        && (row.allRepositories === true || String(row.repo || row.repository || '').trim() === '*');
      return {
        ...row,
        provider,
        name: String(row.name || row.label || (isAllRepositories ? 'All GitHub repositories' : '') || row.repo || row.projectPath || row.projectId || row.project || `CI Project ${idx + 1}`).trim(),
      };
    });
}

function appendQuery(url, params = {}) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') u.searchParams.set(key, String(value));
  }
  return u;
}

function requestJson(url, row = {}, root = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (parsed.protocol !== 'https:') return reject(new Error('Only HTTPS URLs are supported'));
    const body = opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;
    const headers = { Accept: 'application/json', 'User-Agent': 'OmniSight', ...(opts.headers || {}) };
    const token = tokenValue(row, root);
    if (row.provider === 'gitlab') {
      if (token) headers['PRIVATE-TOKEN'] = token;
    } else {
      headers.Accept = 'application/vnd.github+json';
      headers['X-GitHub-Api-Version'] = '2026-03-10';
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (body && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(parsed, {
      method: opts.method || 'GET',
      headers,
      timeout: timeoutMs(row.timeoutMs ? row : root),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > Number(row.maxResponseBytes || root.maxResponseBytes || 2 * 1024 * 1024)) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        if (!data.trim()) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from CI/CD API')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function discoveryRows(value) {
  return Array.isArray(value) ? value : arr(value);
}

function githubRepositoryItem(repo = {}) {
  const fullName = String(repo.full_name || '').trim();
  if (!fullName || !fullName.includes('/')) return null;
  return {
    value: fullName,
    label: fullName,
    resource: fullName,
    repo: fullName,
    name: String(repo.name || fullName.split('/').pop() || '').trim(),
    defaultBranch: String(repo.default_branch || '').trim(),
    webUrl: String(repo.html_url || '').trim(),
    private: repo.private === true,
    archived: repo.archived === true,
  };
}

function gitlabProjectItem(project = {}) {
  const projectId = project.id == null ? '' : String(project.id).trim();
  const path = String(project.path_with_namespace || '').trim();
  const value = projectId || path;
  if (!value) return null;
  return {
    value,
    label: path || String(project.name_with_namespace || project.name || value).trim(),
    resource: value,
    projectId: value,
    path,
    name: String(project.name || '').trim(),
    defaultBranch: String(project.default_branch || '').trim(),
    webUrl: String(project.web_url || '').trim(),
    visibility: String(project.visibility || '').trim(),
    archived: project.archived === true,
  };
}

function normalizedDiscoveryItems(rows, normalize, keyFn) {
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const item = normalize(row);
    if (!item) continue;
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

async function listGithubRepositories(input = {}, requestFn = requestJson, root = {}) {
  const token = tokenValue(input, root);
  if (!token) throw new Error('GitHub token is required');
  const rows = [];
  let truncated = false;
  let pagesFetched = 0;
  const requestRow = { ...input, provider: 'github', baseUrl: GITHUB_API_BASE };
  for (let page = 1; page <= DISCOVERY_MAX_PAGES; page += 1) {
    const url = appendQuery(`${GITHUB_API_BASE}/user/repos`, {
      visibility: 'all',
      affiliation: 'owner,collaborator,organization_member',
      sort: 'full_name',
      direction: 'asc',
      per_page: DISCOVERY_PAGE_SIZE,
      page,
    }).toString();
    const pageRows = discoveryRows(await requestFn(url, requestRow, root, {}));
    pagesFetched += 1;
    rows.push(...pageRows);
    if (pageRows.length < DISCOVERY_PAGE_SIZE) break;
    if (page === DISCOVERY_MAX_PAGES) truncated = true;
  }
  const result = {
    items: normalizedDiscoveryItems(rows, githubRepositoryItem, item => item.value.toLowerCase()),
    truncated,
  };
  Object.defineProperty(result, 'pagesFetched', { value: pagesFetched, enumerable: false });
  return result;
}

async function listGitlabProjects(input = {}, requestFn = requestJson) {
  const token = tokenValue(input);
  if (!token) throw new Error('GitLab token is required');
  const apiBase = gitlabApiBase(input.baseUrl);
  const rows = [];
  let truncated = false;
  const requestRow = { ...input, provider: 'gitlab', baseUrl: normalizeGitlabBaseUrl(input.baseUrl) };
  for (let page = 1; page <= DISCOVERY_MAX_PAGES; page += 1) {
    const url = appendQuery(`${apiBase}/projects`, {
      membership: true,
      simple: true,
      archived: false,
      order_by: 'path',
      sort: 'asc',
      per_page: DISCOVERY_PAGE_SIZE,
      page,
    }).toString();
    const pageRows = discoveryRows(await requestFn(url, requestRow, {}, {}));
    rows.push(...pageRows);
    if (pageRows.length < DISCOVERY_PAGE_SIZE) break;
    if (page === DISCOVERY_MAX_PAGES) truncated = true;
  }
  return {
    items: normalizedDiscoveryItems(rows, gitlabProjectItem, item => item.value),
    truncated,
  };
}

function safeDiscoveryError(provider, err) {
  const label = provider === 'gitlab' ? 'GitLab' : 'GitHub';
  const statusCode = Number(err?.statusCode || String(err?.message || '').match(/^HTTP\s+(\d{3})/)?.[1] || 0);
  let message = `Could not load ${label} projects`;
  let clientStatus = 502;
  if (statusCode === 401 || statusCode === 403) {
    message = `${label} token was rejected or lacks required permissions`;
    clientStatus = 400;
  } else if (statusCode === 404) {
    message = `${label} API endpoint was not found`;
  } else if (statusCode === 429) {
    message = `${label} API rate limit was reached`;
  } else if (/timeout/i.test(String(err?.message || ''))) {
    message = `${label} request timed out`;
    clientStatus = 504;
  }
  const safe = new Error(message);
  safe.clientStatus = clientStatus;
  safe.upstreamStatus = statusCode || undefined;
  return safe;
}

async function discoverCiProjects(input = {}, requestFn = requestJson) {
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!['github', 'gitlab'].includes(provider)) throw new Error('Provider must be github or gitlab');
  if (!tokenValue(input)) throw new Error(`${provider === 'gitlab' ? 'GitLab' : 'GitHub'} token is required`);
  const normalizedInput = provider === 'gitlab'
    ? { ...input, provider, baseUrl: normalizeGitlabBaseUrl(input.baseUrl) }
    : { ...input, provider, baseUrl: GITHUB_API_BASE };
  try {
    const result = provider === 'gitlab'
      ? await listGitlabProjects(normalizedInput, requestFn)
      : await listGithubRepositories(normalizedInput, requestFn);
    return { provider, ...result };
  } catch (err) {
    throw safeDiscoveryError(provider, err);
  }
}

function githubRepo(row = {}) {
  const full = String(row.repo || row.repository || '').trim();
  if (full.includes('/')) {
    const [owner, repo] = full.split('/');
    return { owner, repo };
  }
  return { owner: row.owner || row.org || row.organization || '', repo: row.repo || row.repository || '' };
}

function normalizeGithubRun(run = {}, project = {}) {
  const conclusion = String(run.conclusion || '').toLowerCase();
  const status = String(run.status || '').toLowerCase();
  const done = status === 'completed';
  const failed = done && !['success', 'skipped', 'neutral'].includes(conclusion);
  return {
    provider: 'github',
    projectName: project.name,
    id: run.id,
    name: run.name || run.display_title || 'workflow',
    workflowName: run.name || '',
    status: done ? (conclusion || status) : status,
    rawStatus: status,
    conclusion,
    ref: run.head_branch || '',
    sha: run.head_sha || '',
    title: run.display_title || '',
    actor: run.actor?.login || run.triggering_actor?.login || '',
    url: run.html_url || '',
    createdAt: run.created_at || '',
    updatedAt: run.updated_at || '',
    durationSeconds: null,
    running: ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(status),
    failed,
    success: done && !failed,
  };
}

function normalizeGitlabPipeline(pipe = {}, project = {}) {
  const status = String(pipe.status || '').toLowerCase();
  return {
    provider: 'gitlab',
    projectName: project.name,
    id: pipe.id,
    iid: pipe.iid,
    name: pipe.name || `pipeline #${pipe.iid || pipe.id}`,
    status,
    rawStatus: status,
    conclusion: status,
    ref: pipe.ref || '',
    sha: pipe.sha || '',
    title: pipe.name || '',
    actor: pipe.user?.username || pipe.user?.name || '',
    url: pipe.web_url || '',
    createdAt: pipe.created_at || '',
    updatedAt: pipe.updated_at || '',
    durationSeconds: pipe.duration ?? null,
    running: ['created', 'waiting_for_resource', 'preparing', 'pending', 'running'].includes(status),
    failed: ['failed'].includes(status),
    success: ['success', 'skipped'].includes(status),
  };
}

function normalizeGitlabJob(job = {}, project = {}, pipeline = {}) {
  const status = String(job.status || '').toLowerCase();
  return {
    provider: 'gitlab',
    projectName: project.name,
    pipelineId: pipeline.id,
    id: job.id,
    name: job.name || 'job',
    stage: job.stage || '',
    status,
    ref: job.ref || pipeline.ref || '',
    url: job.web_url || '',
    createdAt: job.created_at || '',
    startedAt: job.started_at || '',
    finishedAt: job.finished_at || '',
    durationSeconds: job.duration ?? null,
    running: ['created', 'waiting_for_resource', 'preparing', 'pending', 'running'].includes(status),
    failed: status === 'failed',
    success: ['success', 'skipped'].includes(status),
  };
}

async function getGithubProject(row = {}, root = {}, requestFn = requestJson) {
  const project = { ...row, provider: 'github' };
  const { owner, repo } = githubRepo(row);
  if (!owner || !repo) throw new Error('GitHub owner/repo is required');
  const base = cleanBaseUrl(row.baseUrl, 'https://api.github.com');
  const params = { per_page: Math.max(1, Math.min(Number(row.limit || row.runLimit || 10), 30)) };
  if (row.branch) params.branch = row.branch;
  if (row.event) params.event = row.event;
  const runsJson = await requestFn(appendQuery(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`, params), project, root, {});
  const runs = arr(runsJson).map(r => normalizeGithubRun(r, project));
  return {
    online: true,
    provider: 'github',
    name: project.name || `${owner}/${repo}`,
    owner,
    repo,
    branch: row.branch || '',
    url: `https://github.com/${owner}/${repo}`,
    pipelines: runs,
    jobs: [],
    partial: false,
    errors: [],
  };
}

function isGithubAllRepositories(row = {}) {
  const provider = String(row.provider || row.type || 'github').trim().toLowerCase();
  const repo = String(row.repo || row.repository || '').trim();
  return provider === 'github' && (row.allRepositories === true || repo === '*');
}

function failedGithubProject(row = {}, error, name) {
  const { owner, repo } = githubRepo(row);
  return {
    online: false,
    provider: 'github',
    allRepositories: false,
    name: String(name || row.name || row.repo || row.repository || 'GitHub repository'),
    owner,
    repo,
    branch: row.branch || row.ref || '',
    url: row.url || row.webUrl || (owner && repo ? `https://github.com/${owner}/${repo}` : ''),
    error: String(error?.message || error || 'GitHub repository could not be loaded'),
    pipelines: [],
    jobs: [],
    partial: false,
    errors: [],
  };
}

function githubRequestFnId(requestFn) {
  if (requestFn === requestJson) return 'default';
  if (!githubRequestFnIds.has(requestFn)) githubRequestFnIds.set(requestFn, nextGithubRequestFnId++);
  return String(githubRequestFnIds.get(requestFn));
}

function githubAllCacheKey(row = {}, root = {}, requestFn = requestJson) {
  const tokenHash = createHash('sha256').update(String(tokenValue(row, root))).digest('hex');
  return JSON.stringify({
    tokenHash,
    branch: String(row.branch || row.ref || ''),
    event: String(row.event || ''),
    runLimit: Math.max(1, Math.min(Number(row.limit || row.runLimit || 10), 30)),
    requestFn: githubRequestFnId(requestFn),
  });
}

function githubAllConfiguredCacheTtl(row = {}, root = {}) {
  const configured = Number(row.allRepositoriesCacheTtlMs ?? root.allRepositoriesCacheTtlMs ?? GITHUB_ALL_CACHE_TTL_MS);
  const finite = Number.isFinite(configured) ? configured : GITHUB_ALL_CACHE_TTL_MS;
  return Math.max(GITHUB_ALL_MIN_CACHE_TTL_MS, Math.min(finite, 24 * 60 * 60 * 1000));
}

function githubAllRateSafeCacheTtl(requestCount) {
  // Keep projected primary REST usage at or below a conservative 4,000
  // requests/hour. The 60s floor also prevents a 15s dashboard refresh from
  // repeatedly polling even very small accounts.
  const count = Math.max(1, Number(requestCount) || 1);
  return Math.max(GITHUB_ALL_MIN_CACHE_TTL_MS, Math.ceil((count * 60 * 60 * 1000) / 4000));
}

function cloneGithubProjects(rows) {
  return JSON.parse(JSON.stringify(Array.isArray(rows) ? rows : []));
}

function githubProjectsForCaller(rows, row = {}) {
  const copy = cloneGithubProjects(rows);
  if (copy.length === 1 && !copy[0].online && row.name) copy[0].name = String(row.name);
  return copy;
}

function githubAllNow(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : (options.now ?? Date.now());
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function pruneGithubAllCache(cache, now, maxEntries) {
  for (const [key, entry] of cache) {
    if (!entry?.promise && Number(entry?.expiresAt || 0) <= now) cache.delete(key);
  }
  while (cache.size > maxEntries) {
    const removable = Array.from(cache.entries()).find(([, entry]) => !entry?.promise);
    if (!removable) break;
    cache.delete(removable[0]);
  }
}

function clearGithubAllProjectsCache() {
  githubAllProjectsCache.clear();
}

async function collectGithubAllProjects(row = {}, root = {}, requestFn = requestJson) {
  const selection = { ...row, provider: 'github', baseUrl: GITHUB_API_BASE };
  let discovery;
  try {
    discovery = await listGithubRepositories(selection, requestFn, root);
  } catch (err) {
    const safeError = /token is required/i.test(String(err?.message || ''))
      ? new Error('GitHub token is required to load all repositories')
      : safeDiscoveryError('github', err);
    return {
      rows: [failedGithubProject(selection, safeError, 'All GitHub repositories')],
      requestCount: 1,
    };
  }

  if (!discovery.items.length) {
    return {
      rows: [failedGithubProject(selection, new Error('No accessible GitHub repositories were found'), 'All GitHub repositories')],
      requestCount: Number(discovery.pagesFetched || 1),
    };
  }

  // Listing is capped at ten 100-item pages and Actions requests are kept to a
  // small bounded pool so a large account cannot create unbounded API pressure.
  const requestedConcurrency = Number(row.allRepositoriesConcurrency
    || root.allRepositoriesConcurrency
    || 1);
  const concurrency = Math.max(1, Math.min(Number.isFinite(requestedConcurrency) ? requestedConcurrency : 1, 5));
  const projects = await mapLimit(discovery.items, concurrency, async item => {
    const concrete = {
      ...row,
      provider: 'github',
      allRepositories: false,
      repo: item.repo,
      repository: item.repo,
      name: item.label || item.repo,
      branch: row.branch || row.ref || '',
      url: item.webUrl || `https://github.com/${item.repo}`,
      baseUrl: GITHUB_API_BASE,
    };
    try {
      return { ...(await getGithubProject(concrete, root, requestFn)), allRepositories: false };
    } catch (err) {
      return failedGithubProject(concrete, err, item.label || item.repo);
    }
  });

  if (discovery.truncated && projects.length) {
    const warningTarget = projects.find(project => project.online) || projects[0];
    warningTarget.partial = true;
    warningTarget.discoveryTruncated = true;
    warningTarget.errors = [
      ...(Array.isArray(warningTarget.errors) ? warningTarget.errors : []),
      `Repository discovery reached the ${DISCOVERY_PAGE_SIZE * DISCOVERY_MAX_PAGES}-repository limit; remaining repositories were not checked`,
    ];
  }

  return {
    rows: projects,
    requestCount: Number(discovery.pagesFetched || 1) + discovery.items.length,
  };
}

async function getGithubAllProjects(row = {}, root = {}, requestFn = requestJson, options = {}) {
  const cache = options.cache instanceof Map ? options.cache : githubAllProjectsCache;
  const now = githubAllNow(options);
  const cacheKey = githubAllCacheKey(row, root, requestFn);
  const cached = cache.get(cacheKey);
  if (cached?.rows && cached.expiresAt > now) return githubProjectsForCaller(cached.rows, row);
  if (cached?.promise) return githubProjectsForCaller(await cached.promise, row);

  const maxEntriesValue = Number(row.allRepositoriesCacheMaxEntries
    ?? root.allRepositoriesCacheMaxEntries
    ?? GITHUB_ALL_CACHE_MAX_ENTRIES);
  const maxEntries = Math.max(1, Math.min(Number.isFinite(maxEntriesValue) ? maxEntriesValue : GITHUB_ALL_CACHE_MAX_ENTRIES, 25));
  pruneGithubAllCache(cache, now, maxEntries);

  const pending = (async () => {
    const collected = await collectGithubAllProjects(row, root, requestFn);
    const configuredTtl = githubAllConfiguredCacheTtl(row, root);
    const safeTtl = githubAllRateSafeCacheTtl(collected.requestCount);
    const ttl = Math.max(configuredTtl, safeTtl);
    const canonicalRows = cloneGithubProjects(collected.rows);
    cache.set(cacheKey, {
      rows: canonicalRows,
      expiresAt: githubAllNow(options) + ttl,
      requestCount: collected.requestCount,
      ttl,
    });
    pruneGithubAllCache(cache, githubAllNow(options), maxEntries);
    return canonicalRows;
  })();

  cache.set(cacheKey, { promise: pending, expiresAt: Number.POSITIVE_INFINITY });
  try {
    return githubProjectsForCaller(await pending, row);
  } catch (err) {
    if (cache.get(cacheKey)?.promise === pending) cache.delete(cacheKey);
    throw err;
  }
}

function gitlabProjectId(row = {}) {
  const id = row.projectId || row.project || row.projectPath || row.path || '';
  return encodeURIComponent(String(id).trim()).replace(/%2F/gi, '%2F');
}

async function getGitlabProject(row = {}, root = {}) {
  const project = { ...row, provider: 'gitlab' };
  const id = gitlabProjectId(row);
  if (!id) throw new Error('GitLab project ID or path is required');
  const base = cleanBaseUrl(row.baseUrl || root.gitlabBaseUrl, 'https://gitlab.com');
  const apiBase = base.endsWith('/api/v4') ? base : `${base}/api/v4`;
  const params = { per_page: Math.max(1, Math.min(Number(row.limit || row.pipelineLimit || 10), 30)) };
  if (row.branch || row.ref) params.ref = row.branch || row.ref;
  const pipes = arr(await requestJson(appendQuery(`${apiBase}/projects/${id}/pipelines`, params), project, root)).map(p => normalizeGitlabPipeline(p, project));
  const errors = [];
  let jobs = [];
  if (row.includeJobs !== false && pipes.length) {
    const selected = pipes.slice(0, Math.max(1, Math.min(Number(row.jobPipelineLimit || 3), 10)));
    const jobRows = await mapLimit(selected, Number(row.jobConcurrency || 2), async pipeline => {
      try {
        const data = await requestJson(appendQuery(`${apiBase}/projects/${id}/pipelines/${encodeURIComponent(pipeline.id)}/jobs`, {
          per_page: Math.max(1, Math.min(Number(row.jobLimit || 20), 100)),
        }), project, root);
        return arr(data).map(j => normalizeGitlabJob(j, project, pipeline));
      } catch (err) {
        errors.push(`jobs ${pipeline.id}: ${err.message}`);
        return [];
      }
    });
    jobs = jobRows.flat();
  }
  return {
    online: true,
    provider: 'gitlab',
    name: project.name || String(row.projectPath || row.projectId || row.project),
    projectId: row.projectId || row.project || row.projectPath || '',
    projectPath: row.projectPath || row.path || '',
    branch: row.branch || row.ref || '',
    url: row.webUrl || '',
    pipelines: pipes,
    jobs,
    partial: errors.length > 0,
    errors: errors.slice(0, 5),
  };
}

function summarize(projects = []) {
  const pipelines = projects.flatMap(p => p.pipelines || []);
  const jobs = projects.flatMap(p => p.jobs || []);
  return {
    projects: projects.length,
    up: projects.filter(p => p.online).length,
    down: projects.filter(p => !p.online).length,
    partial: projects.filter(p => p.partial).length,
    pipelines: pipelines.length,
    success: pipelines.filter(p => p.success).length,
    failed: pipelines.filter(p => p.failed).length,
    running: pipelines.filter(p => p.running).length,
    canceled: pipelines.filter(p => ['cancelled', 'canceled', 'timed_out'].includes(p.status)).length,
    jobs: jobs.length,
    jobsFailed: jobs.filter(j => j.failed).length,
    jobsRunning: jobs.filter(j => j.running).length,
  };
}

async function getCiProject(row = {}, root = {}) {
  if (String(row.provider || row.type || '').toLowerCase() === 'gitlab') return getGitlabProject(row, root);
  return getGithubProject(row, root);
}

async function getAllCiData(config = {}) {
  config = config || {};
  const projects = configuredProjects(config);
  if (!projects.length) return { online: false, error: 'No CI/CD projects configured', summary: summarize([]), projects: [] };
  const rowGroups = await mapLimit(projects, Number(config.concurrency || config.collectorConcurrency || 3), async row => {
    if (isGithubAllRepositories(row)) return getGithubAllProjects(row, config);
    try {
      return [await getCiProject(row, config)];
    } catch (err) {
      const provider = String(row.provider || row.type || 'github').trim().toLowerCase();
      if (provider !== 'gitlab') return [failedGithubProject(row, err)];
      return [{
        online: false,
        provider: 'gitlab',
        name: row.name || row.projectPath || row.projectId || row.project || 'GitLab project',
        projectId: row.projectId || row.project || row.projectPath || '',
        projectPath: row.projectPath || row.path || '',
        branch: row.branch || row.ref || '',
        url: row.webUrl || row.url || '',
        error: err.message,
        pipelines: [],
        jobs: [],
        partial: false,
        errors: [],
      }];
    }
  });
  const rows = rowGroups.flat();
  const summary = summarize(rows);
  return { online: summary.up > 0, error: rows.find(r => !r.online)?.error || '', summary, projects: rows };
}

module.exports = {
  getAllCiData,
  configuredProjects,
  tokenValue,
  normalizeGitlabBaseUrl,
  listGithubRepositories,
  listGitlabProjects,
  discoverCiProjects,
  getGithubAllProjects,
  clearGithubAllProjectsCache,
};
