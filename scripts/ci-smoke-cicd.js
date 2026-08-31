#!/usr/bin/env node
// CI smoke tests for CI/CD resource discovery. The injected request function
// returns bare JSON payloads, matching APIs where pagination headers are not
// exposed to the collector.
const assert = require('assert');

const {
  configuredProjects,
  discoverCiProjects,
  getGithubAllProjects,
  listGithubRepositories,
  listGitlabProjects,
  normalizeGitlabBaseUrl,
} = require('../src/cicd');
const { mergePreservingSecrets } = require('../src/config-merge');

function githubFixture(index, overrides = {}) {
  const suffix = String(index).padStart(3, '0');
  return {
    id: index,
    name: `repo-${suffix}`,
    full_name: `example/repo-${suffix}`,
    default_branch: index % 2 ? 'develop' : 'main',
    html_url: `https://github.com/example/repo-${suffix}`,
    private: index % 2 === 1,
    archived: false,
    ...overrides,
  };
}

function gitlabFixture(index, overrides = {}) {
  const suffix = String(index).padStart(3, '0');
  return {
    id: index,
    name: `project-${suffix}`,
    path_with_namespace: `group/project-${suffix}`,
    default_branch: index % 2 ? 'develop' : 'main',
    web_url: `https://gitlab.example.test/group/project-${suffix}`,
    visibility: index % 2 ? 'private' : 'internal',
    archived: false,
    ...overrides,
  };
}

async function testGithubDiscovery() {
  const calls = [];
  const requestFn = async (url, row, root, opts) => {
    const parsed = new URL(url);
    calls.push({ parsed, row, root, opts });
    const page = Number(parsed.searchParams.get('page'));
    if (page === 1) return Array.from({ length: 100 }, (_, index) => githubFixture(index));
    if (page === 2) return [
      githubFixture(0),
      githubFixture(100, { full_name: 'Example/Zeta', name: 'Zeta' }),
      { id: 'invalid', name: 'missing-full-name' },
    ];
    throw new Error(`unexpected GitHub page ${page}`);
  };

  const result = await listGithubRepositories({ token: 'github-secret' }, requestFn);
  assert.strictEqual(calls.length, 2, 'GitHub discovery must continue after a full headerless page');
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.items.length, 101, 'GitHub discovery must normalize and deduplicate repositories across pages');
  assert.deepStrictEqual(result.items[0], {
    value: 'example/repo-000',
    label: 'example/repo-000',
    resource: 'example/repo-000',
    repo: 'example/repo-000',
    name: 'repo-000',
    defaultBranch: 'main',
    webUrl: 'https://github.com/example/repo-000',
    private: false,
    archived: false,
  });
  assert.strictEqual(result.items.at(-1).label, 'Example/Zeta', 'GitHub choices must be sorted by their visible label');

  for (const [index, call] of calls.entries()) {
    assert.strictEqual(call.parsed.origin, 'https://api.github.com');
    assert.strictEqual(call.parsed.pathname, '/user/repos');
    assert.strictEqual(call.parsed.searchParams.get('visibility'), 'all');
    assert.strictEqual(call.parsed.searchParams.get('affiliation'), 'owner,collaborator,organization_member');
    assert.strictEqual(call.parsed.searchParams.get('sort'), 'full_name');
    assert.strictEqual(call.parsed.searchParams.get('direction'), 'asc');
    assert.strictEqual(call.parsed.searchParams.get('per_page'), '100');
    assert.strictEqual(call.parsed.searchParams.get('page'), String(index + 1));
    assert.strictEqual(call.row.provider, 'github');
    assert.strictEqual(call.row.token, 'github-secret');
    assert.deepStrictEqual(call.root, {});
    assert.deepStrictEqual(call.opts, {});
  }

  const dispatched = await discoverCiProjects({ provider: 'github', token: 'github-secret' }, async () => []);
  assert.deepStrictEqual(dispatched, { provider: 'github', items: [], truncated: false });
}

async function testGithubAllRepositoriesCollection() {
  const calls = [];
  const token = 'github-all-secret';
  const workflowRun = (id, name, conclusion = 'success') => ({
    id,
    name,
    display_title: `${name} build`,
    status: 'completed',
    conclusion,
    head_branch: 'main',
    head_sha: `sha-${id}`,
    html_url: `https://github.com/acme/${name}/actions/runs/${id}`,
    created_at: '2026-08-31T10:00:00Z',
    updated_at: '2026-08-31T10:01:00Z',
  });
  const requestFn = async (url, row, root, opts) => {
    const parsed = new URL(url);
    calls.push({ parsed, row, root, opts });
    assert.strictEqual(row.token, token, 'the account token must be reused for discovery and every repository');
    assert.strictEqual(root.concurrency, 2, 'the collection root must reach every injected request');
    assert.deepStrictEqual(opts, {});

    if (parsed.pathname === '/user/repos') {
      assert.strictEqual(parsed.searchParams.get('page'), '1');
      return [
        githubFixture(1, { full_name: 'acme/api', name: 'api', default_branch: 'main' }),
        githubFixture(2, { full_name: 'acme/broken', name: 'broken', default_branch: 'develop' }),
        githubFixture(3, { full_name: 'acme/web', name: 'web', default_branch: 'trunk' }),
      ];
    }
    if (parsed.pathname === '/repos/acme/api/actions/runs') {
      return { workflow_runs: [workflowRun(101, 'api')] };
    }
    if (parsed.pathname === '/repos/acme/broken/actions/runs') {
      const err = new Error('fixture repository failure');
      err.statusCode = 503;
      throw err;
    }
    if (parsed.pathname === '/repos/acme/web/actions/runs') {
      return { workflow_runs: [workflowRun(303, 'web', 'failure')] };
    }
    throw new Error(`unexpected GitHub all-repositories URL ${parsed}`);
  };

  const rows = await getGithubAllProjects(
    { provider: 'github', name: 'GitHub account', repo: '*', allRepositories: true, token, limit: 7 },
    { concurrency: 2 },
    requestFn,
  );

  assert.ok(Array.isArray(rows), 'all-repositories collection must return a flat project array');
  assert.strictEqual(rows.length, 3, 'every discovered repository must produce exactly one project row');
  assert.ok(rows.every(row => !Array.isArray(row)), 'all-repositories results must not contain nested arrays');

  const api = rows.find(row => row.owner === 'acme' && row.repo === 'api');
  const web = rows.find(row => row.owner === 'acme' && row.repo === 'web');
  const broken = rows.find(row => row.name === 'acme/broken' || (row.owner === 'acme' && row.repo === 'broken'));
  assert.ok(api?.online, 'a healthy discovered repository must remain online');
  assert.strictEqual(api.allRepositories, false, 'expanded rows must be concrete repositories');
  assert.strictEqual(api.pipelines.length, 1);
  assert.strictEqual(api.pipelines[0].id, 101);
  assert.ok(web?.online, 'collection must continue after a sibling repository fails');
  assert.strictEqual(web.pipelines[0].failed, true, 'workflow normalization must be retained for expanded repositories');
  assert.ok(broken && broken.online === false, 'a failed repository must be isolated as an offline project row');
  assert.strictEqual(broken.owner, 'acme', 'a failed repository must retain its canonical owner for the dashboard selector');
  assert.strictEqual(broken.repo, 'broken', 'a failed repository must retain its canonical repository for the dashboard selector');
  assert.match(broken.error, /fixture repository failure/);
  assert.deepStrictEqual(broken.pipelines, []);
  assert.deepStrictEqual(broken.jobs, []);

  assert.strictEqual(calls.filter(call => call.parsed.pathname === '/user/repos').length, 1);
  assert.strictEqual(calls.filter(call => call.parsed.pathname.endsWith('/actions/runs')).length, 3);
  for (const call of calls.filter(entry => entry.parsed.pathname.endsWith('/actions/runs'))) {
    assert.strictEqual(call.parsed.searchParams.get('per_page'), '7', 'the configured workflow-run limit must apply to every repository');
  }
}

async function testGithubAllRepositoriesEmptyAndTruncated() {
  const empty = await getGithubAllProjects(
    { provider: 'github', name: 'Company GitHub', repo: '*', allRepositories: true, token: 'empty-token' },
    {},
    async url => {
      assert.strictEqual(new URL(url).pathname, '/user/repos');
      return [];
    },
  );
  assert.strictEqual(empty.length, 1, 'an account with no accessible repositories must remain visible');
  assert.strictEqual(empty[0].online, false);
  assert.strictEqual(empty[0].provider, 'github');
  assert.strictEqual(empty[0].name, 'Company GitHub');
  assert.strictEqual(empty[0].error, 'No accessible GitHub repositories were found');
  assert.deepStrictEqual(empty[0].pipelines, []);
  assert.deepStrictEqual(empty[0].jobs, []);

  let discoveryPages = 0;
  let actionCalls = 0;
  const truncated = await getGithubAllProjects(
    { provider: 'github', repo: '*', allRepositories: true, token: 'truncated-token' },
    {},
    async url => {
      const parsed = new URL(url);
      if (parsed.pathname === '/user/repos') {
        discoveryPages += 1;
        return Array.from({ length: 100 }, () => githubFixture(1, {
          full_name: 'acme/only-once',
          name: 'only-once',
        }));
      }
      if (parsed.pathname === '/repos/acme/only-once/actions/runs') {
        actionCalls += 1;
        return { workflow_runs: [] };
      }
      throw new Error(`unexpected truncated-discovery URL ${parsed}`);
    },
  );
  assert.strictEqual(discoveryPages, 10, 'discovery must stop at its bounded 1000-repository limit');
  assert.strictEqual(actionCalls, 1, 'duplicate repositories across discovery pages must be collected only once');
  assert.strictEqual(truncated.length, 1);
  assert.strictEqual(truncated[0].online, true);
  assert.strictEqual(truncated[0].partial, true, 'a truncated account collection must be visibly partial');
  assert.strictEqual(truncated[0].discoveryTruncated, true);
  assert.ok(
    truncated[0].errors.includes('Repository discovery reached the 1000-repository limit; remaining repositories were not checked'),
    'the account project must explain that repositories beyond the discovery cap were skipped',
  );
}

async function testGithubAllRepositoriesCache() {
  let clock = 1_000_000;
  let networkCalls = 0;
  const isolatedCache = new Map();
  const token = 'github-cache-secret';
  const requestFn = async url => {
    networkCalls += 1;
    const parsed = new URL(url);
    if (parsed.pathname === '/user/repos') {
      return [githubFixture(1, { full_name: 'cache/example', name: 'example', default_branch: 'main' })];
    }
    if (parsed.pathname === '/repos/cache/example/actions/runs') {
      return { workflow_runs: [{ id: 501, name: 'cached workflow', status: 'completed', conclusion: 'success' }] };
    }
    throw new Error(`unexpected cached all-repositories URL ${parsed}`);
  };
  const row = {
    provider: 'github',
    repo: '*',
    allRepositories: true,
    token,
    allRepositoriesCacheTtlMs: 60_000,
  };
  const options = { now: () => clock, cache: isolatedCache };

  const first = await getGithubAllProjects(row, {}, requestFn, options);
  assert.strictEqual(networkCalls, 2, 'the first account collection must discover repositories and load their Actions runs');
  first[0].name = 'mutated caller copy';
  first[0].pipelines.push({ id: 'caller-only' });

  const second = await getGithubAllProjects(row, {}, requestFn, options);
  assert.strictEqual(networkCalls, 2, 'an immediate repeated account collection must not spend more GitHub API requests');
  assert.strictEqual(second[0].name, 'cache/example', 'cached project rows must be isolated from caller mutation');
  assert.deepStrictEqual(second[0].pipelines.map(run => run.id), [501], 'cached workflow rows must be isolated from caller mutation');

  clock += 59_999;
  await getGithubAllProjects(row, {}, requestFn, options);
  assert.strictEqual(networkCalls, 2, 'the full account result must remain cached until its configured TTL expires');

  clock += 2;
  await getGithubAllProjects(row, {}, requestFn, options);
  assert.strictEqual(networkCalls, 4, 'repository discovery and Actions runs must refresh after the cache TTL');
  assert.ok(
    [...isolatedCache.keys()].every(key => !String(key).includes(token)),
    'the all-repositories cache key must not retain the plaintext GitHub token',
  );
}

async function testGithubAllRepositoriesRateSafeCacheTtl() {
  let clock = 0;
  let networkCalls = 0;
  const isolatedCache = new Map();
  const requestFn = async url => {
    networkCalls += 1;
    const parsed = new URL(url);
    if (parsed.pathname === '/user/repos') {
      const page = Number(parsed.searchParams.get('page'));
      if (page === 1) {
        return Array.from({ length: 100 }, (_, index) => githubFixture(index + 1, {
          full_name: `rate/repo-${index + 1}`,
          name: `repo-${index + 1}`,
        }));
      }
      if (page === 2) return [];
    }
    if (/^\/repos\/rate\/repo-\d+\/actions\/runs$/.test(parsed.pathname)) return { workflow_runs: [] };
    throw new Error(`unexpected rate-safe cache URL ${parsed}`);
  };
  const row = {
    provider: 'github',
    repo: '*',
    allRepositories: true,
    token: 'github-rate-safe-secret',
    allRepositoriesCacheTtlMs: 60_000,
  };
  const options = { now: () => clock, cache: isolatedCache };

  await getGithubAllProjects(row, {}, requestFn, options);
  assert.strictEqual(networkCalls, 102, '100 repositories require two headerless discovery pages and 100 Actions requests');
  assert.strictEqual([...isolatedCache.values()][0].requestCount, 102, 'the rate budget must include every discovery page and repository request');
  assert.strictEqual([...isolatedCache.values()][0].ttl, 91_800, 'the cache TTL must cap projected usage at 4000 GitHub requests per hour');

  clock = 60_000;
  await getGithubAllProjects(row, {}, requestFn, options);
  assert.strictEqual(networkCalls, 102, 'the rate-safe TTL must override a shorter configured cache duration');
  clock = 91_799;
  await getGithubAllProjects(row, {}, requestFn, options);
  assert.strictEqual(networkCalls, 102, 'the account result must remain cached immediately before the rate-safe deadline');
  clock = 91_801;
  await getGithubAllProjects(row, {}, requestFn, options);
  assert.strictEqual(networkCalls, 204, 'all GitHub calls must refresh after the calculated rate-safe TTL');
}

async function testGitlabDiscovery() {
  const calls = [];
  const requestFn = async (url, row, root, opts) => {
    const parsed = new URL(url);
    calls.push({ parsed, row, root, opts });
    const page = Number(parsed.searchParams.get('page'));
    if (page === 1) return Array.from({ length: 100 }, (_, index) => gitlabFixture(index + 1));
    if (page === 2) return [
      gitlabFixture(1),
      gitlabFixture(101, { path_with_namespace: 'Another/Alpha', name: 'Alpha' }),
      { name: 'missing-id-and-path' },
    ];
    throw new Error(`unexpected GitLab page ${page}`);
  };

  const input = { token: 'gitlab-secret', baseUrl: 'https://gitlab.example.test/root/api/v4/' };
  const result = await listGitlabProjects(input, requestFn);
  assert.strictEqual(calls.length, 2, 'GitLab discovery must continue after a full headerless page');
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.items.length, 101, 'GitLab discovery must normalize and deduplicate projects across pages');
  assert.deepStrictEqual(result.items[0], {
    value: '101',
    label: 'Another/Alpha',
    resource: '101',
    projectId: '101',
    path: 'Another/Alpha',
    name: 'Alpha',
    defaultBranch: 'develop',
    webUrl: 'https://gitlab.example.test/group/project-101',
    visibility: 'private',
    archived: false,
  });

  for (const [index, call] of calls.entries()) {
    assert.strictEqual(call.parsed.origin, 'https://gitlab.example.test');
    assert.strictEqual(call.parsed.pathname, '/root/api/v4/projects');
    assert.strictEqual(call.parsed.searchParams.get('membership'), 'true');
    assert.strictEqual(call.parsed.searchParams.get('simple'), 'true');
    assert.strictEqual(call.parsed.searchParams.get('archived'), 'false');
    assert.strictEqual(call.parsed.searchParams.get('order_by'), 'path');
    assert.strictEqual(call.parsed.searchParams.get('sort'), 'asc');
    assert.strictEqual(call.parsed.searchParams.get('per_page'), '100');
    assert.strictEqual(call.parsed.searchParams.get('page'), String(index + 1));
    assert.strictEqual(call.row.provider, 'gitlab');
    assert.strictEqual(call.row.token, 'gitlab-secret');
    assert.strictEqual(call.row.baseUrl, 'https://gitlab.example.test/root');
    assert.deepStrictEqual(call.root, {});
    assert.deepStrictEqual(call.opts, {});
  }

  const dispatched = await discoverCiProjects({ provider: 'gitlab', token: 'gitlab-secret' }, async () => []);
  assert.deepStrictEqual(dispatched, { provider: 'gitlab', items: [], truncated: false });
}

async function testValidation() {
  const allProjects = configuredProjects({ projects: [{ provider: 'github', repo: '*', allRepositories: true }] });
  assert.strictEqual(allProjects[0].name, 'All GitHub repositories', 'an unnamed account-wide row must never render as a raw asterisk');
  await assert.rejects(() => listGithubRepositories({}), /GitHub token is required/);
  await assert.rejects(() => listGitlabProjects({}), /GitLab token is required/);
  await assert.rejects(() => discoverCiProjects({ provider: 'github' }), /GitHub token is required/);
  await assert.rejects(() => discoverCiProjects({ provider: 'unknown', token: 'secret' }), /Provider must be github or gitlab/);
  await assert.rejects(
    () => listGitlabProjects({ token: 'secret', baseUrl: 'http://gitlab.example.test' }, async () => []),
    /must use HTTPS/,
  );
  assert.throws(() => normalizeGitlabBaseUrl('not a URL'), /Invalid GitLab base URL/);
  assert.strictEqual(normalizeGitlabBaseUrl('https://gitlab.example.test/api/v4/'), 'https://gitlab.example.test');
}

function testConfigIdSecretPreservation() {
  const existing = {
    cicd: {
      projects: [
        { configId: 'github-a', provider: 'github', name: 'Old GitHub', repo: 'old/repo', token: 'github-secret' },
        { configId: 'gitlab-b', provider: 'gitlab', name: 'Old GitLab', projectId: '42', projectPath: 'old/project', token: 'gitlab-secret' },
      ],
    },
  };
  const incoming = {
    cicd: {
      projects: [
        { configId: 'gitlab-b', provider: 'gitlab', name: 'Renamed GitLab', projectId: '84', projectPath: 'new/project', token: '__set__' },
        { configId: 'github-a', provider: 'github', name: 'Renamed GitHub', repo: 'new/repo', token: '__set__' },
        { configId: 'new-project', provider: 'github', name: 'New project', repo: 'new/blank', token: '__set__' },
      ],
    },
  };

  const merged = mergePreservingSecrets(incoming, existing);
  assert.strictEqual(merged.cicd.projects[0].token, 'gitlab-secret', 'configId must preserve the matching GitLab token after reorder and rename');
  assert.strictEqual(merged.cicd.projects[1].token, 'github-secret', 'configId must preserve the matching GitHub token after reorder and rename');
  assert.strictEqual(Object.hasOwn(merged.cicd.projects[2], 'token'), false, 'a new configId must not steal another project token');

  const accountWide = mergePreservingSecrets(
    { cicd: { projects: [{ configId: 'github-a', provider: 'github', name: 'All GitHub', repo: '*', allRepositories: true, token: '__set__' }] } },
    existing,
  );
  assert.strictEqual(accountWide.cicd.projects[0].repo, '*', 'the canonical all-repositories marker must survive settings merge');
  assert.strictEqual(accountWide.cicd.projects[0].allRepositories, true, 'the account-wide selection flag must survive settings merge');
  assert.strictEqual(accountWide.cicd.projects[0].token, 'github-secret', 'switching a stable GitHub card to all repositories must preserve its token');

  const freshAccountWide = mergePreservingSecrets(
    { cicd: { projects: [{ configId: 'fresh-all-id', provider: 'github', name: 'New GitHub account', repo: '*', allRepositories: true, token: '__set__' }] } },
    { cicd: { projects: [{ provider: 'github', name: 'Only legacy row', repo: 'legacy/only', token: 'legacy-only-secret' }] } },
  );
  assert.strictEqual(
    Object.hasOwn(freshAccountWide.cicd.projects[0], 'token'),
    false,
    'a newly added All repositories row must not steal the sole unrelated legacy CI token',
  );

  const explicitlyMigratedAccountWide = mergePreservingSecrets(
    { cicd: { projects: [{ configId: 'migrated-all-id', originalResource: 'legacy/only', provider: 'github', name: 'Migrated GitHub account', repo: '*', allRepositories: true, token: '__set__' }] } },
    { cicd: { projects: [{ provider: 'github', name: 'Only legacy row', repo: 'legacy/only', token: 'legacy-only-secret' }] } },
  );
  assert.strictEqual(
    explicitlyMigratedAccountWide.cicd.projects[0].token,
    'legacy-only-secret',
    'an explicit originalResource match must still migrate a legacy CI token when switching that row to All repositories',
  );

  const unmarkedLegacy = mergePreservingSecrets(
    { cicd: { projects: [{ configId: 'generated-id', provider: 'github', repo: 'legacy/repo', token: '__set__' }] } },
    { cicd: { projects: [{ provider: 'github', repo: 'legacy/repo', token: 'legacy-secret' }] } },
  );
  assert.strictEqual(
    Object.hasOwn(unmarkedLegacy.cicd.projects[0], 'token'),
    false,
    'a generated configId must not infer legacy token ownership from the current repository alone',
  );

  const explicitlyMigratedLegacy = mergePreservingSecrets(
    { cicd: { projects: [{ configId: 'generated-id', originalResource: 'legacy/repo', provider: 'github', repo: 'legacy/repo', token: '__set__' }] } },
    { cicd: { projects: [{ provider: 'github', repo: 'legacy/repo', token: 'legacy-secret' }] } },
  );
  assert.strictEqual(explicitlyMigratedLegacy.cicd.projects[0].token, 'legacy-secret', 'originalResource must explicitly migrate the matching legacy row token');

  const modernRow = mergePreservingSecrets(
    { cicd: { projects: [{ configId: 'new-id', provider: 'github', repo: 'same/repo', token: '__set__' }] } },
    { cicd: { projects: [{ configId: 'existing-id', provider: 'github', repo: 'same/repo', token: 'existing-secret' }] } },
  );
  assert.strictEqual(Object.hasOwn(modernRow.cicd.projects[0], 'token'), false, 'a new configId must not inherit a modern row token through repo fallback');

  const changedLegacyResource = mergePreservingSecrets(
    { cicd: { projects: [
      { configId: 'generated-a', originalResource: 'old/a', provider: 'github', repo: 'new/a', token: '__set__' },
      { configId: 'generated-b', originalResource: 'old/b', provider: 'github', repo: 'new/b', token: '__set__' },
    ] } },
    { cicd: { projects: [
      { provider: 'github', repo: 'old/a', token: 'legacy-a' },
      { provider: 'github', repo: 'old/b', token: 'legacy-b' },
    ] } },
  );
  assert.strictEqual(changedLegacyResource.cicd.projects[0].token, 'legacy-a', 'originalResource must migrate the first changed legacy row token');
  assert.strictEqual(changedLegacyResource.cicd.projects[1].token, 'legacy-b', 'originalResource must migrate the second changed legacy row token');
  assert.strictEqual(Object.hasOwn(changedLegacyResource.cicd.projects[0], 'originalResource'), false, 'originalResource must remain a transient merge hint');

  for (const tokenKey of ['apiToken', 'accessToken', 'bearerToken']) {
    const aliasRow = mergePreservingSecrets(
      { cicd: { projects: [{ configId: `alias-${tokenKey}`, provider: 'github', repo: 'alias/repo', [tokenKey]: '__set__' }] } },
      { cicd: { projects: [{ configId: `alias-${tokenKey}`, provider: 'github', repo: 'alias/repo', [tokenKey]: `${tokenKey}-secret` }] } },
    );
    assert.strictEqual(aliasRow.cicd.projects[0][tokenKey], `${tokenKey}-secret`, `${tokenKey} must survive a masked CI settings save`);
  }

  for (const fixture of [
    { label: 'Dockhand', incomingKey: 'token', existingKey: 'apiToken' },
    { label: 'TrueNAS', incomingKey: 'apiKey', existingKey: 'apiToken' },
    { label: 'Portainer', incomingKey: 'apiKey', existingKey: 'accessToken' },
  ]) {
    const aliasMigration = mergePreservingSecrets(
      { service: { [fixture.incomingKey]: '__set__' } },
      { service: { [fixture.existingKey]: `${fixture.label}-secret` } },
    );
    assert.strictEqual(aliasMigration.service[fixture.incomingKey], `${fixture.label}-secret`, `${fixture.label} token aliases must survive canonicalized settings saves`);
  }

  const providerSwitch = mergePreservingSecrets(
    { cicd: { projects: [{ configId: 'shared-id', provider: 'gitlab', projectId: '12', token: '__set__' }] } },
    { cicd: { projects: [{ configId: 'shared-id', provider: 'github', repo: 'owner/repo', token: 'github-secret' }] } },
  );
  assert.strictEqual(Object.hasOwn(providerSwitch.cicd.projects[0], 'token'), false, 'a CI configId must not preserve a token across providers');
}

async function run() {
  await testGithubDiscovery();
  await testGithubAllRepositoriesCollection();
  await testGithubAllRepositoriesEmptyAndTruncated();
  await testGithubAllRepositoriesCache();
  await testGithubAllRepositoriesRateSafeCacheTtl();
  await testGitlabDiscovery();
  await testValidation();
  testConfigIdSecretPreservation();
  console.log('smoke ok — GitHub/GitLab discovery');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
