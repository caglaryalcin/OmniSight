const https = require('https');
const { mapLimit } = require('./concurrency');

function cleanBaseUrl(url, fallback) {
  return String(url || fallback || '').trim().replace(/\/+$/, '');
}

function tokenValue(row = {}, root = {}) {
  return row.token || row.apiToken || row.accessToken || row.bearerToken || root.token || root.apiToken || root.accessToken || root.bearerToken || '';
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
    .filter(row => row && (row.provider || row.repo || row.projectId || row.project))
    .map((row, idx) => ({
      ...row,
      provider: String(row.provider || row.type || 'github').toLowerCase(),
      name: String(row.name || row.label || row.repo || row.projectPath || row.projectId || row.project || `CI Project ${idx + 1}`).trim(),
    }));
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
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 180) || res.statusMessage}`));
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

async function getGithubProject(row = {}, root = {}) {
  const project = { ...row, provider: 'github' };
  const { owner, repo } = githubRepo(row);
  if (!owner || !repo) throw new Error('GitHub owner/repo is required');
  const base = cleanBaseUrl(row.baseUrl, 'https://api.github.com');
  const params = { per_page: Math.max(1, Math.min(Number(row.limit || row.runLimit || 10), 30)) };
  if (row.branch) params.branch = row.branch;
  if (row.event) params.event = row.event;
  const runsJson = await requestJson(appendQuery(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`, params), project, root);
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
  const rows = await mapLimit(projects, Number(config.concurrency || config.collectorConcurrency || 3), async row => {
    try {
      return await getCiProject(row, config);
    } catch (err) {
      return {
        online: false,
        provider: row.provider || 'github',
        name: row.name || row.repo || row.projectId || 'CI Project',
        branch: row.branch || row.ref || '',
        error: err.message,
        pipelines: [],
        jobs: [],
        partial: false,
        errors: [],
      };
    }
  });
  const summary = summarize(rows);
  return { online: summary.up > 0, error: rows.find(r => !r.online)?.error || '', summary, projects: rows };
}

module.exports = { getAllCiData, configuredProjects };
