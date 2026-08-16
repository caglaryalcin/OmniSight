const http = require('http');
const https = require('https');
const { mapLimit } = require('./concurrency');

const MB = 1024 * 1024;

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlDecode(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function localName(name) {
  return String(name || '').split(':').pop();
}

function parseAttributes(source = '') {
  const out = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source))) out[match[1]] = xmlDecode(match[2] ?? match[3] ?? '');
  return out;
}

function parseXml(source) {
  const xml = String(source || '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsafe XML response');
  const documentNode = { name: '#document', attrs: {}, children: [] };
  const stack = [documentNode];
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/[\s\S]*?>|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (!token || token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      stack[stack.length - 1].children.push({ name: '#text', text: token.slice(9, -3) });
      continue;
    }
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith('<!')) continue;
    if (token.startsWith('<')) {
      const match = token.match(/^<([^\s/>]+)([\s\S]*?)(\/?)>$/);
      if (!match) continue;
      const node = { name: match[1], attrs: parseAttributes(match[2]), children: [] };
      stack[stack.length - 1].children.push(node);
      if (match[3] !== '/') stack.push(node);
      continue;
    }
    if (token) stack[stack.length - 1].children.push({ name: '#text', text: xmlDecode(token) });
  }
  return documentNode.children.find(child => child.name !== '#text') || documentNode;
}

function elementChildren(node, name = '') {
  const rows = (node?.children || []).filter(child => child.name !== '#text');
  return name ? rows.filter(child => localName(child.name) === name) : rows;
}

function firstChild(node, name) {
  return elementChildren(node, name)[0] || null;
}

function findFirst(node, name) {
  if (!node) return null;
  if (localName(node.name) === name) return node;
  for (const child of node.children || []) {
    const found = findFirst(child, name);
    if (found) return found;
  }
  return null;
}

function findAll(node, name, out = []) {
  if (!node) return out;
  if (localName(node.name) === name) out.push(node);
  for (const child of node.children || []) findAll(child, name, out);
  return out;
}

function nodeText(node) {
  if (!node) return '';
  return (node.children || []).map(child => child.name === '#text' ? child.text : nodeText(child)).join('').trim();
}

function scalarValue(text, type = '') {
  const value = String(text ?? '').trim();
  const normalizedType = String(type || '').toLowerCase().split(':').pop();
  if (normalizedType === 'string' || normalizedType === 'datetime') return value;
  if (normalizedType === 'boolean') return value.toLowerCase() === 'true' || value === '1';
  if (/^(?:byte|short|int|integer|long|float|double|decimal|unsignedbyte|unsignedshort|unsignedint|unsignedlong)$/.test(normalizedType)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function nodeValue(node) {
  if (!node) return null;
  if (String(node.attrs?.['xsi:nil'] || node.attrs?.nil || '').toLowerCase() === 'true') return null;
  const children = elementChildren(node);
  const directType = node.attrs?.type;
  if (!children.length) {
    const value = scalarValue(nodeText(node), node.attrs?.['xsi:type'] || node.attrs?.type || '');
    if (directType && !String(node.attrs?.['xsi:type'] || '').startsWith('xsd:')) return { type: directType, value: String(value ?? '') };
    return value;
  }
  const out = {};
  for (const child of children) {
    const key = localName(child.name);
    const value = nodeValue(child);
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  const xsiType = node.attrs?.['xsi:type'];
  if (xsiType) out._type = String(xsiType).split(':').pop();
  return out;
}

function mor(node) {
  if (!node) return null;
  const value = nodeText(node);
  return value ? { type: node.attrs?.type || '', value } : null;
}

function asArray(value, key = '') {
  if (Array.isArray(value)) return value;
  if (key && Array.isArray(value?.[key])) return value[key];
  if (key && value?.[key] != null) return [value[key]];
  if (value == null) return [];
  return [value];
}

function extractRefs(value) {
  const refs = [];
  const visit = item => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== 'object') return;
    if (typeof item.value === 'string' && typeof item.type === 'string') refs.push(item);
    for (const nested of Object.values(item)) visit(nested);
  };
  visit(value);
  return refs;
}

function parsePropertyResult(xml) {
  const root = typeof xml === 'string' ? parseXml(xml) : xml;
  const objects = findAll(root, 'objects').map(objectNode => {
    const objectRef = mor(firstChild(objectNode, 'obj')) || { type: '', value: '' };
    const properties = {};
    for (const property of elementChildren(objectNode, 'propSet')) {
      const name = nodeText(firstChild(property, 'name'));
      if (!name) continue;
      properties[name] = nodeValue(firstChild(property, 'val'));
    }
    return { type: objectRef.type, ref: objectRef.value, properties };
  });
  const tokenNode = findFirst(root, 'token');
  return { objects, token: tokenNode ? nodeText(tokenNode) : '' };
}

function cleanEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  parsed.pathname = String(parsed.pathname || '').replace(/\/+$/, '');
  if (!/\/sdk$/i.test(parsed.pathname)) parsed.pathname = '/sdk';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function instanceName(config = {}, index = 0) {
  return String(config.name || config.label || config.url || `VMware ${index + 1}`).trim();
}

function configuredInstances(config = {}) {
  const rows = Array.isArray(config?.instances) && config.instances.length
    ? config.instances
    : config?.url ? [config] : [];
  return rows
    .filter(row => row && (row.url || row.name))
    .map((row, index) => ({ ...row, name: instanceName(row, index) }));
}

function timeoutMs(config = {}) {
  const value = Number(config.timeoutMs || config.timeout || 15000);
  return Math.max(3000, Math.min(60000, Number.isFinite(value) ? value : 15000));
}

class VsphereSoapClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = cleanEndpoint(config.url);
    this.cookie = '';
    this.apiVersion = String(config.apiVersion || '6.5').trim() || '6.5';
  }

  updateCookie(headers = {}) {
    const values = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [];
    const cookies = values.map(value => String(value).split(';')[0]).filter(Boolean);
    if (cookies.length) this.cookie = cookies.join('; ');
  }

  async call(method, body) {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soapenv:Body>` +
      `<${method} xmlns="urn:vim25">${body}</${method}></soapenv:Body></soapenv:Envelope>`;
    const parsed = new URL(this.endpoint);
    const transport = parsed.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const headers = {
        Accept: 'text/xml',
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(envelope),
        SOAPAction: `"urn:vim25/${this.apiVersion}"`,
      };
      if (this.cookie) headers.Cookie = this.cookie;
      const request = transport.request(parsed, {
        method: 'POST',
        headers,
        rejectUnauthorized: this.config.insecureTLS ? false : undefined,
        timeout: timeoutMs(this.config),
      }, response => {
        let data = '';
        const maxBytes = Math.max(MB, Math.min(32 * MB, Number(this.config.maxResponseBytes) || 16 * MB));
        response.setEncoding('utf8');
        response.on('data', chunk => {
          data += chunk;
          if (data.length > maxBytes) request.destroy(new Error('VMware API response too large'));
        });
        response.on('end', () => {
          this.updateCookie(response.headers);
          let document;
          try { document = parseXml(data); }
          catch (error) { return reject(new Error(`Invalid XML from VMware API: ${error.message}`)); }
          const fault = findFirst(document, 'Fault');
          if (fault) {
            const message = nodeText(findFirst(fault, 'faultstring')) || nodeText(findFirst(fault, 'localizedMessage')) || 'VMware SOAP fault';
            return reject(new Error(message));
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new Error(`HTTP ${response.statusCode}: ${nodeText(document).slice(0, 180) || response.statusMessage}`));
          }
          resolve(document);
        });
      });
      request.on('timeout', () => request.destroy(new Error('VMware API timeout')));
      request.on('error', reject);
      request.end(envelope);
    });
  }
}

function serviceContentFrom(document) {
  const content = findFirst(document, 'returnval');
  if (!content) throw new Error('VMware service content is missing');
  return {
    rootFolder: mor(firstChild(content, 'rootFolder')),
    propertyCollector: mor(firstChild(content, 'propertyCollector')),
    sessionManager: mor(firstChild(content, 'sessionManager')),
    viewManager: mor(firstChild(content, 'viewManager')),
    about: nodeValue(firstChild(content, 'about')) || {},
  };
}

function morXml(name, reference) {
  if (!reference?.value) throw new Error(`VMware ${name} reference is missing`);
  return `<${name} type="${xmlEscape(reference.type)}">${xmlEscape(reference.value)}</${name}>`;
}

function propertySpecs() {
  const specs = {
    HostSystem: [
      'name', 'overallStatus', 'parent', 'runtime.connectionState', 'runtime.powerState', 'runtime.inMaintenanceMode',
      'summary.quickStats', 'summary.config.product', 'hardware.cpuInfo', 'hardware.memorySize',
    ],
    VirtualMachine: [
      'name', 'overallStatus', 'runtime.powerState', 'runtime.host', 'summary.quickStats', 'summary.config', 'summary.storage',
      'guest.guestFullName', 'guest.ipAddress', 'guest.toolsRunningStatus',
    ],
    Datastore: ['name', 'overallStatus', 'summary', 'host'],
    ClusterComputeResource: ['name', 'overallStatus', 'summary', 'host'],
    Datacenter: ['name', 'overallStatus'],
  };
  return Object.entries(specs).map(([type, paths]) => `<propSet><type>${type}</type><all>false</all>${paths.map(path => `<pathSet>${path}</pathSet>`).join('')}</propSet>`).join('');
}

async function retrieveInventory(client, content) {
  const types = ['HostSystem', 'VirtualMachine', 'Datastore', 'ClusterComputeResource', 'Datacenter'];
  const viewDocument = await client.call('CreateContainerView',
    `${morXml('_this', content.viewManager)}${morXml('container', content.rootFolder)}` +
    types.map(type => `<type>${type}</type>`).join('') + '<recursive>true</recursive>');
  const view = mor(findFirst(viewDocument, 'returnval'));
  if (!view) throw new Error('VMware inventory view could not be created');
  const objectSet = `<objectSet>${morXml('obj', view)}<skip>true</skip><selectSet xsi:type="TraversalSpec"><name>inventoryView</name><type>ContainerView</type><path>view</path><skip>false</skip></selectSet></objectSet>`;
  const first = await client.call('RetrievePropertiesEx',
    `${morXml('_this', content.propertyCollector)}<specSet>${propertySpecs()}${objectSet}</specSet><options><maxObjects>500</maxObjects></options>`);
  const parsed = parsePropertyResult(first);
  const objects = [...parsed.objects];
  let token = parsed.token;
  let pages = 0;
  const configuredMaxPages = Number(client.config.maxInventoryPages || 100);
  const maxPages = Math.max(1, Math.min(500, Number.isFinite(configuredMaxPages) ? configuredMaxPages : 100));
  while (token && pages < maxPages) {
    const next = await client.call('ContinueRetrievePropertiesEx', `${morXml('_this', content.propertyCollector)}<token>${xmlEscape(token)}</token>`);
    const page = parsePropertyResult(next);
    objects.push(...page.objects);
    token = page.token;
    pages += 1;
  }
  if (token) throw new Error(`VMware inventory exceeded ${maxPages * 500} objects; increase maxInventoryPages`);
  return { view, objects };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(used, total) {
  used = number(used);
  total = number(total);
  if (used == null || total == null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10));
}

function referenceValue(value) {
  if (value && typeof value === 'object' && typeof value.value === 'string') return value.value;
  return '';
}

function normalizeInventory(objects = [], about = {}, configuredName = 'VMware') {
  const byType = type => objects.filter(object => object.type === type);
  const datacenters = byType('Datacenter').map(object => ({
    id: object.ref,
    name: String(object.properties.name || object.ref || 'Datacenter'),
    health: String(object.properties.overallStatus || 'gray').toLowerCase(),
  }));
  const clusters = byType('ClusterComputeResource').map(object => {
    const summary = object.properties.summary || {};
    const hostRefs = extractRefs(object.properties.host).filter(ref => ref.type === 'HostSystem').map(ref => ref.value);
    return {
      id: object.ref,
      name: String(object.properties.name || object.ref || 'Cluster'),
      health: String(object.properties.overallStatus || 'gray').toLowerCase(),
      hostRefs,
      totalHosts: number(summary.numHosts) ?? hostRefs.length,
      effectiveHosts: number(summary.numEffectiveHosts),
      totalCpuMhz: number(summary.totalCpu),
      effectiveCpuMhz: number(summary.effectiveCpu),
      totalMemoryBytes: number(summary.totalMemory),
      effectiveMemoryBytes: number(summary.effectiveMemory) != null ? number(summary.effectiveMemory) * MB : null,
      cpuCores: number(summary.numCpuCores),
      cpuThreads: number(summary.numCpuThreads),
    };
  });
  const clusterByHost = new Map();
  clusters.forEach(cluster => cluster.hostRefs.forEach(ref => clusterByHost.set(ref, cluster)));

  const hosts = byType('HostSystem').map(object => {
    const properties = object.properties;
    const quick = properties['summary.quickStats'] || {};
    const cpuInfo = properties['hardware.cpuInfo'] || {};
    const product = properties['summary.config.product'] || {};
    const cpuCores = number(cpuInfo.numCpuCores);
    const cpuHz = number(cpuInfo.hz);
    const cpuTotalMhz = cpuCores != null && cpuHz != null ? cpuCores * cpuHz / 1_000_000 : null;
    const cpuUsedMhz = number(quick.overallCpuUsage);
    const memoryTotalBytes = number(properties['hardware.memorySize']);
    const memoryUsedBytes = number(quick.overallMemoryUsage) != null ? number(quick.overallMemoryUsage) * MB : null;
    const connectionState = String(properties['runtime.connectionState'] || 'unknown').toLowerCase();
    const powerState = String(properties['runtime.powerState'] || 'unknown').toLowerCase();
    const online = connectionState === 'connected' && powerState !== 'poweredoff';
    const cluster = clusterByHost.get(object.ref);
    return {
      id: object.ref,
      name: String(properties.name || object.ref || 'ESXi host'),
      online,
      connectionState,
      powerState,
      maintenance: properties['runtime.inMaintenanceMode'] === true,
      health: String(properties.overallStatus || 'gray').toLowerCase(),
      clusterId: cluster?.id || '',
      clusterName: cluster?.name || '',
      cpuCores,
      cpuThreads: number(cpuInfo.numCpuThreads),
      cpuSockets: number(cpuInfo.numCpuPackages),
      cpuUsedMhz,
      cpuTotalMhz,
      cpuPercent: percent(cpuUsedMhz, cpuTotalMhz),
      memoryUsedBytes,
      memoryTotalBytes,
      memoryPercent: percent(memoryUsedBytes, memoryTotalBytes),
      uptimeSeconds: number(quick.uptime),
      version: String(product.version || about.version || ''),
      build: String(product.build || about.build || ''),
      productName: String(product.fullName || product.name || about.fullName || ''),
      vmRefs: [],
    };
  });
  const hostByRef = new Map(hosts.map(host => [host.id, host]));

  const allVirtualMachines = byType('VirtualMachine').map(object => {
    const properties = object.properties;
    const quick = properties['summary.quickStats'] || {};
    const configSummary = properties['summary.config'] || {};
    const storageSummary = properties['summary.storage'] || {};
    const hostRef = referenceValue(properties['runtime.host']);
    const powerState = String(properties['runtime.powerState'] || 'unknown').toLowerCase();
    const host = hostByRef.get(hostRef);
    const row = {
      id: object.ref,
      name: String(properties.name || object.ref || 'Virtual machine'),
      hostId: hostRef,
      hostName: host?.name || '',
      clusterName: host?.clusterName || '',
      powerState,
      running: powerState === 'poweredon',
      template: configSummary.template === true,
      health: String(properties.overallStatus || 'gray').toLowerCase(),
      cpuCount: number(configSummary.numCpu),
      memoryMb: number(configSummary.memorySizeMB),
      cpuUsedMhz: number(quick.overallCpuUsage),
      guestMemoryMb: number(quick.guestMemoryUsage),
      hostMemoryMb: number(quick.hostMemoryUsage),
      storageCommittedBytes: number(storageSummary.committed),
      storageUncommittedBytes: number(storageSummary.uncommitted),
      storageUnsharedBytes: number(storageSummary.unshared),
      storageProvisionedBytes: number(storageSummary.committed) != null || number(storageSummary.uncommitted) != null
        ? Number(storageSummary.committed || 0) + Number(storageSummary.uncommitted || 0)
        : null,
      uptimeSeconds: number(quick.uptimeSeconds),
      guestOs: String(properties['guest.guestFullName'] || configSummary.guestFullName || ''),
      ipAddress: String(properties['guest.ipAddress'] || ''),
      toolsStatus: String(properties['guest.toolsRunningStatus'] || ''),
    };
    if (host && !row.template) host.vmRefs.push(row.id);
    return row;
  });
  const templates = allVirtualMachines.filter(vm => vm.template);
  const vms = allVirtualMachines.filter(vm => !vm.template);

  const datastores = byType('Datastore').map(object => {
    const properties = object.properties;
    const summary = properties.summary || {};
    const capacityBytes = number(summary.capacity);
    const freeBytes = number(summary.freeSpace);
    const usedBytes = capacityBytes != null && freeBytes != null ? Math.max(0, capacityBytes - freeBytes) : null;
    return {
      id: object.ref,
      name: String(properties.name || summary.name || object.ref || 'Datastore'),
      type: String(summary.type || ''),
      url: String(summary.url || ''),
      accessible: summary.accessible !== false,
      multipleHostAccess: summary.multipleHostAccess === true,
      health: String(properties.overallStatus || 'gray').toLowerCase(),
      capacityBytes,
      freeBytes,
      usedBytes,
      usedPercent: percent(usedBytes, capacityBytes),
      hostRefs: extractRefs(properties.host).filter(ref => ref.type === 'HostSystem').map(ref => ref.value),
    };
  });

  const cpuTotalMhz = hosts.reduce((sum, host) => sum + Number(host.cpuTotalMhz || 0), 0);
  const cpuUsedMhz = hosts.filter(host => host.online).reduce((sum, host) => sum + Number(host.cpuUsedMhz || 0), 0);
  const cpuCores = hosts.reduce((sum, host) => sum + Number(host.cpuCores || 0), 0);
  const cpuUsedCores = hosts.filter(host => host.online).reduce((sum, host) => {
    const cores = Number(host.cpuCores || 0);
    const usedMhz = number(host.cpuUsedMhz);
    const totalMhz = number(host.cpuTotalMhz);
    const usage = usedMhz != null && totalMhz != null && totalMhz > 0 ? usedMhz / totalMhz : (number(host.cpuPercent) ?? 0) / 100;
    return sum + (cores > 0 ? cores * usage : 0);
  }, 0);
  const memoryTotalBytes = hosts.reduce((sum, host) => sum + Number(host.memoryTotalBytes || 0), 0);
  const memoryUsedBytes = hosts.filter(host => host.online).reduce((sum, host) => sum + Number(host.memoryUsedBytes || 0), 0);
  const storageTotalBytes = datastores.reduce((sum, datastore) => sum + Number(datastore.capacityBytes || 0), 0);
  const storageUsedBytes = datastores.reduce((sum, datastore) => sum + Number(datastore.usedBytes || 0), 0);
  const apiType = String(about.apiType || '').toLowerCase();
  return {
    name: configuredName,
    type: apiType === 'virtualcenter' ? 'vcenter' : 'esxi',
    product: String(about.fullName || about.name || (apiType === 'virtualcenter' ? 'VMware vCenter Server' : 'VMware ESXi')),
    version: String(about.version || ''),
    build: String(about.build || ''),
    apiVersion: String(about.apiVersion || ''),
    datacenters,
    clusters,
    hosts,
    vms,
    templates,
    datastores,
    summary: {
      datacenters: datacenters.length,
      clusters: clusters.length,
      hosts: hosts.length,
      hostsOnline: hosts.filter(host => host.online).length,
      hostsMaintenance: hosts.filter(host => host.maintenance).length,
      hostsWarning: hosts.filter(host => ['yellow', 'red'].includes(host.health)).length,
      vms: vms.length,
      runningVms: vms.filter(vm => vm.running).length,
      vmsWarning: vms.filter(vm => vm.running && ['yellow', 'red'].includes(vm.health)).length,
      templates: templates.length,
      datastores: datastores.length,
      datastoresWarning: datastores.filter(datastore => !datastore.accessible || ['yellow', 'red'].includes(datastore.health)).length,
      cpuUsedMhz,
      cpuTotalMhz,
      cpuUsedCores,
      cpuCores,
      cpuPercent: percent(cpuUsedMhz, cpuTotalMhz),
      memoryUsedBytes,
      memoryTotalBytes,
      memoryPercent: percent(memoryUsedBytes, memoryTotalBytes),
      storageUsedBytes,
      storageTotalBytes,
      storagePercent: percent(storageUsedBytes, storageTotalBytes),
    },
  };
}

async function getVmwareInstance(config = {}, index = 0) {
  const instance = { ...config, name: instanceName(config, index) };
  if (!instance.url) throw new Error('VMware URL is required');
  if (!instance.username || !instance.password) throw new Error('VMware username and password are required');
  const client = new VsphereSoapClient(instance);
  let content;
  let view;
  let loggedIn = false;
  try {
    const serviceDocument = await client.call('RetrieveServiceContent', '<_this type="ServiceInstance">ServiceInstance</_this>');
    content = serviceContentFrom(serviceDocument);
    await client.call('Login', `${morXml('_this', content.sessionManager)}<userName>${xmlEscape(instance.username)}</userName><password>${xmlEscape(instance.password)}</password><locale>en</locale>`);
    loggedIn = true;
    const inventory = await retrieveInventory(client, content);
    view = inventory.view;
    const normalized = normalizeInventory(inventory.objects, content.about, instance.name);
    return { ...normalized, online: true, url: instance.url, error: '', permissionHint: '' };
  } catch (error) {
    const message = String(error?.message || error || 'VMware API failed');
    const permissionHint = /permission|privilege|nopermission|not authorized/i.test(message)
      ? 'Grant read-only inventory access to hosts, virtual machines and datastores.'
      : '';
    throw Object.assign(new Error(message), { permissionHint });
  } finally {
    if (view) {
      try { await client.call('DestroyView', morXml('_this', view)); } catch {}
    }
    if (loggedIn && content?.sessionManager) {
      try { await client.call('Logout', morXml('_this', content.sessionManager)); } catch {}
    }
  }
}

function summarizeInstances(instances = []) {
  const datacenters = instances.flatMap(instance => instance.datacenters || []);
  const hosts = instances.flatMap(instance => instance.hosts || []);
  const vms = instances.flatMap(instance => instance.vms || []);
  const templates = instances.flatMap(instance => instance.templates || []);
  const datastores = instances.flatMap(instance => instance.datastores || []);
  const cpuTotalMhz = hosts.reduce((sum, host) => sum + Number(host.cpuTotalMhz || 0), 0);
  const cpuUsedMhz = hosts.filter(host => host.online).reduce((sum, host) => sum + Number(host.cpuUsedMhz || 0), 0);
  const cpuCores = hosts.reduce((sum, host) => sum + Number(host.cpuCores || 0), 0);
  const cpuUsedCores = hosts.filter(host => host.online).reduce((sum, host) => {
    const cores = Number(host.cpuCores || 0);
    const usedMhz = number(host.cpuUsedMhz);
    const totalMhz = number(host.cpuTotalMhz);
    const usage = usedMhz != null && totalMhz != null && totalMhz > 0 ? usedMhz / totalMhz : (number(host.cpuPercent) ?? 0) / 100;
    return sum + (cores > 0 ? cores * usage : 0);
  }, 0);
  const memoryTotalBytes = hosts.reduce((sum, host) => sum + Number(host.memoryTotalBytes || 0), 0);
  const memoryUsedBytes = hosts.filter(host => host.online).reduce((sum, host) => sum + Number(host.memoryUsedBytes || 0), 0);
  const storageTotalBytes = datastores.reduce((sum, datastore) => sum + Number(datastore.capacityBytes || 0), 0);
  const storageUsedBytes = datastores.reduce((sum, datastore) => sum + Number(datastore.usedBytes || 0), 0);
  return {
    instances: instances.length,
    up: instances.filter(instance => instance.online).length,
    down: instances.filter(instance => !instance.online).length,
    datacenters: datacenters.length,
    clusters: instances.reduce((sum, instance) => sum + Number(instance.clusters?.length || 0), 0),
    hosts: hosts.length,
    hostsOnline: hosts.filter(host => host.online).length,
    hostsMaintenance: hosts.filter(host => host.maintenance).length,
    hostsWarning: hosts.filter(host => ['yellow', 'red'].includes(host.health)).length,
    vms: vms.length,
    runningVms: vms.filter(vm => vm.running).length,
    vmsWarning: vms.filter(vm => vm.running && ['yellow', 'red'].includes(vm.health)).length,
    templates: templates.length,
    datastores: datastores.length,
    datastoresWarning: datastores.filter(datastore => !datastore.accessible || ['yellow', 'red'].includes(datastore.health)).length,
    cpuUsedMhz,
    cpuTotalMhz,
    cpuUsedCores,
    cpuCores,
    cpuPercent: percent(cpuUsedMhz, cpuTotalMhz),
    memoryUsedBytes,
    memoryTotalBytes,
    memoryPercent: percent(memoryUsedBytes, memoryTotalBytes),
    storageUsedBytes,
    storageTotalBytes,
    storagePercent: percent(storageUsedBytes, storageTotalBytes),
  };
}

async function getAllVmwareData(config = {}) {
  const instances = configuredInstances(config);
  if (!instances.length) return { online: false, error: 'No VMware instances configured', summary: summarizeInstances([]), instances: [] };
  const rows = await mapLimit(instances, Number(config.concurrency || config.collectorConcurrency || 2), async (instance, index) => {
    try {
      return await getVmwareInstance(instance, index);
    } catch (error) {
      return {
        online: false,
        name: instance.name,
        url: instance.url || '',
        type: 'unknown',
        error: error.message,
        permissionHint: error.permissionHint || '',
        datacenters: [],
        clusters: [],
        hosts: [],
        vms: [],
        templates: [],
        datastores: [],
        summary: {},
      };
    }
  });
  const summary = summarizeInstances(rows);
  return {
    online: summary.up > 0,
    error: rows.find(instance => !instance.online)?.error || '',
    summary,
    instances: rows,
  };
}

module.exports = {
  configuredInstances,
  getAllVmwareData,
  normalizeInventory,
  parsePropertyResult,
  parseXml,
};
