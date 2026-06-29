const k8s = require('@kubernetes/client-node');
const os = require('os');
const path = require('path');

function resolvePath(p) {
  if (!p) return path.join(os.homedir(), '.kube', 'config');
  return p.replace(/^~/, os.homedir());
}

function createK8sClient(kubeconfigPath) {
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(resolvePath(kubeconfigPath));
  return kc;
}

function extractItems(res) {
  return res?.body?.items || res?.items || [];
}

function errText(err) {
  return err?.body?.message || err?.response?.body?.message || err?.message || String(err || 'unknown error');
}

async function listClusterOrNamespaces(clusterList, namespaceList, namespaces) {
  try {
    const res = await clusterList();
    return extractItems(res);
  } catch (clusterErr) {
    const scoped = (namespaces || []).filter(ns => ns && ns !== '*');
    let ok = 0;
    const items = [];
    const errors = [];
    for (const ns of scoped) {
      try {
        const res = await namespaceList(ns);
        ok += 1;
        items.push(...extractItems(res));
      } catch (err) {
        errors.push(`${ns}: ${errText(err)}`);
      }
    }
    if (!ok) {
      const suffix = errors.length ? ` (${errors.join('; ')})` : '';
      throw new Error(`${errText(clusterErr)}${suffix}`);
    }
    return items;
  }
}

function inNs(namespaces, ns) {
  if (!namespaces || !namespaces.length || namespaces.includes('*')) return true;
  return namespaces.includes(ns);
}

function parseCpuToMilli(value) {
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  const n = Number(raw.replace(/[a-z]+$/, ''));
  if (!Number.isFinite(n)) return null;
  if (raw.endsWith('n')) return Math.round((n / 1e6) * 10) / 10;
  if (raw.endsWith('u')) return Math.round((n / 1000) * 10) / 10;
  if (raw.endsWith('m')) return Math.round(n * 10) / 10;
  return Math.round((n * 1000) * 10) / 10;
}

function parseMemoryBytes(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const m = raw.match(/^([0-9.]+)\s*([a-zA-Z]+)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  const scale = {
    ki: 1024,
    mi: 1024 ** 2,
    gi: 1024 ** 3,
    ti: 1024 ** 4,
    k: 1000,
    m: 1000 ** 2,
    g: 1000 ** 3,
    t: 1000 ** 4,
  };
  return Math.round(n * (scale[unit] || 1));
}

function podMetricKey(ns, name) {
  return `${ns || 'default'}/${name || ''}`;
}

async function getPodMetrics(kc, namespaces) {
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const group = 'metrics.k8s.io';
  const version = 'v1beta1';
  const plural = 'pods';

  let items = [];
  try {
    const res = await custom.listClusterCustomObject({ group, version, plural });
    items = extractItems(res);
  } catch {
    for (const ns of namespaces) {
      try {
        const res = await custom.listNamespacedCustomObject({ group, version, namespace: ns, plural });
        items.push(...extractItems(res));
      } catch {}
    }
  }

  const out = new Map();
  items.filter(m => inNs(namespaces, m.metadata?.namespace)).forEach(metric => {
    let cpuMilli = 0;
    let memoryBytes = 0;
    let hasCpu = false;
    let hasMemory = false;
    const containers = (metric.containers || []).map(c => {
      const cpu = parseCpuToMilli(c.usage?.cpu);
      const memory = parseMemoryBytes(c.usage?.memory);
      if (cpu != null) { cpuMilli += cpu; hasCpu = true; }
      if (memory != null) { memoryBytes += memory; hasMemory = true; }
      return {
        name: c.name,
        cpuMilli: cpu,
        memoryBytes: memory,
      };
    });
    out.set(podMetricKey(metric.metadata?.namespace, metric.metadata?.name), {
      cpuMilli: hasCpu ? Math.round(cpuMilli * 10) / 10 : null,
      memoryBytes: hasMemory ? memoryBytes : null,
      containers,
      timestamp: metric.timestamp,
      window: metric.window,
    });
  });
  return out;
}

async function getPods(kc, namespaces) {
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  const items = await listClusterOrNamespaces(
    () => coreV1.listPodForAllNamespaces(),
    namespace => coreV1.listNamespacedPod({ namespace }),
    namespaces,
  );

  return items.filter(pod => inNs(namespaces, pod.metadata?.namespace)).map(pod => {
    const phase = pod.status?.phase || 'Unknown';
    const owner = (pod.metadata?.ownerReferences || []).find(o => o.controller) || (pod.metadata?.ownerReferences || [])[0] || {};
    const containerStatuses = pod.status?.containerStatuses || [];
    const ready = containerStatuses.length > 0 && containerStatuses.every(c => c.ready);
    const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);
    return {
      name: pod.metadata.name,
      namespace: pod.metadata.namespace,
      phase,
      reason: pod.status?.reason || '',
      ownerKind: owner.kind || '',
      ownerName: owner.name || '',
      restartPolicy: pod.spec?.restartPolicy || '',
      ready,
      restarts,
      running: phase === 'Running' && ready,
      failed: phase === 'Failed' || (!ready && phase === 'Running' && restarts > 5),
    };
  });
}

async function getServices(kc, namespaces) {
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  const items = await listClusterOrNamespaces(
    () => coreV1.listServiceForAllNamespaces(),
    namespace => coreV1.listNamespacedService({ namespace }),
    namespaces,
  );

  return items.filter(svc => inNs(namespaces, svc.metadata?.namespace)).map(svc => ({
    name: svc.metadata.name,
    namespace: svc.metadata.namespace,
    type: svc.spec?.type || 'ClusterIP',
    clusterIP: svc.spec?.clusterIP,
    ports: (svc.spec?.ports || []).map(p => ({ port: p.port, nodePort: p.nodePort, target: p.targetPort, protocol: p.protocol })),
  }));
}

async function getDeployments(kc, namespaces) {
  const appsV1 = kc.makeApiClient(k8s.AppsV1Api);

  const items = await listClusterOrNamespaces(
    () => appsV1.listDeploymentForAllNamespaces(),
    namespace => appsV1.listNamespacedDeployment({ namespace }),
    namespaces,
  );

  return items.filter(d => inNs(namespaces, d.metadata?.namespace)).map(d => {
    const desired = d.spec?.replicas || 0;
    const ready = d.status?.readyReplicas || 0;
    return {
      name: d.metadata.name,
      namespace: d.metadata.namespace,
      desired,
      ready,
      healthy: ready === desired,
    };
  });
}

async function getAllKubernetesData(config) {
  const kubeconfigPath = config.kubeconfig;
  const namespaces = config.namespaces || ['default'];

  try {
    const kc = createK8sClient(kubeconfigPath);

    const [pods, services, deployments, metrics] = await Promise.allSettled([
      getPods(kc, namespaces),
      getServices(kc, namespaces),
      getDeployments(kc, namespaces),
      getPodMetrics(kc, namespaces),
    ]);

    const coreResults = [pods, services, deployments];
    const coreErrors = coreResults
      .filter(r => r.status === 'rejected')
      .map(r => errText(r.reason));
    if (coreErrors.length === coreResults.length) {
      throw new Error(`Kubernetes API unavailable: ${coreErrors[0] || 'all resource requests failed'}`);
    }

    const metricMap = metrics.status === 'fulfilled' ? metrics.value : new Map();
    const serviceList = services.status === 'fulfilled' ? (services.value || []) : [];
    const deploymentList = deployments.status === 'fulfilled' ? (deployments.value || []) : [];
    const podList = (pods.value || []).map(pod => {
      const usage = metricMap.get(podMetricKey(pod.namespace, pod.name));
      if (!usage) return pod;
      return {
        ...pod,
        cpuMilli: usage.cpuMilli,
        memoryBytes: usage.memoryBytes,
        metrics: usage,
      };
    });
    const summary = {
      total: podList.length,
      running: podList.filter(p => p.running).length,
      failed: podList.filter(p => p.failed).length,
      pending: podList.filter(p => p.phase === 'Pending').length,
      succeeded: podList.filter(p => p.phase === 'Succeeded').length,
      metrics: podList.filter(p => p.cpuMilli != null || p.memoryBytes != null).length,
      services: serviceList.length,
      deployments: deploymentList.length,
      resources: podList.length + serviceList.length + deploymentList.length,
    };
    const empty = summary.resources === 0;
    const resourceError = coreErrors.length ? coreErrors.join('; ') : null;

    return {
      online: true,
      healthy: !empty && !resourceError && summary.failed === 0,
      _empty: empty,
      summary,
      pods: podList,
      services: serviceList,
      deployments: deploymentList,
      error: empty ? 'No Kubernetes resources found. Check the kubeconfig, namespace filter, or RBAC permissions.' : resourceError,
      resourceError,
      metricsError: metrics.status === 'rejected' ? metrics.reason?.message : null,
    };
  } catch (err) {
    return {
      online: false,
      error: err.message,
      summary: { total: 0, running: 0, failed: 0, pending: 0 },
      pods: [],
      services: [],
      deployments: [],
    };
  }
}


async function getPodLogs(config, namespace, pod, container, tail) {
  const kc = createK8sClient(config.kubeconfig);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  const t = Math.min(2000, Math.max(1, parseInt(tail) || 300));
  const res = await coreV1.readNamespacedPodLog({
    name: pod,
    namespace,
    container: container || undefined,
    follow: false,
    previous: false,
    tailLines: t,
    timestamps: true,
  });
  const body = res && res.body !== undefined ? res.body : res;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

module.exports = { getAllKubernetesData, getPodLogs };
