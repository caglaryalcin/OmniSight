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

function inNs(namespaces, ns) {
  if (!namespaces || !namespaces.length || namespaces.includes('*')) return true;
  return namespaces.includes(ns);
}

async function getPods(kc, namespaces) {
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  let items = [];
  try {
    const res = await coreV1.listPodForAllNamespaces();
    items = extractItems(res);
  } catch {
    for (const ns of namespaces) {
      try {
        const res = await coreV1.listNamespacedPod({ namespace: ns });
        items.push(...extractItems(res));
      } catch {}
    }
  }

  return items.filter(pod => inNs(namespaces, pod.metadata?.namespace)).map(pod => {
    const phase = pod.status?.phase || 'Unknown';
    const containerStatuses = pod.status?.containerStatuses || [];
    const ready = containerStatuses.length > 0 && containerStatuses.every(c => c.ready);
    const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);
    return {
      name: pod.metadata.name,
      namespace: pod.metadata.namespace,
      phase,
      ready,
      restarts,
      running: phase === 'Running' && ready,
      failed: phase === 'Failed' || (!ready && phase === 'Running' && restarts > 5),
    };
  });
}

async function getServices(kc, namespaces) {
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  let items = [];
  try {
    const res = await coreV1.listServiceForAllNamespaces();
    items = extractItems(res);
  } catch {
    for (const ns of namespaces) {
      try {
        const res = await coreV1.listNamespacedService({ namespace: ns });
        items.push(...extractItems(res));
      } catch {}
    }
  }

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

  let items = [];
  try {
    const res = await appsV1.listDeploymentForAllNamespaces();
    items = extractItems(res);
  } catch {
    for (const ns of namespaces) {
      try {
        const res = await appsV1.listNamespacedDeployment({ namespace: ns });
        items.push(...extractItems(res));
      } catch {}
    }
  }

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

    const [pods, services, deployments] = await Promise.allSettled([
      getPods(kc, namespaces),
      getServices(kc, namespaces),
      getDeployments(kc, namespaces),
    ]);

    const podList = pods.value || [];
    const summary = {
      total: podList.length,
      running: podList.filter(p => p.running).length,
      failed: podList.filter(p => p.failed).length,
      pending: podList.filter(p => p.phase === 'Pending').length,
      succeeded: podList.filter(p => p.phase === 'Succeeded').length,
    };

    return {
      online: true,
      summary,
      pods: podList,
      services: services.value || [],
      deployments: deployments.value || [],
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
