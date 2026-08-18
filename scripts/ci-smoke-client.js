// CI smoke tests for pure helpers in public/index.html — no browser, no network.
// Called from ci-smoke.js; also runnable standalone: node scripts/ci-smoke-client.js
//
// public/index.html has no build step and no module system, so its helpers can't
// be require()d. Functions wrapped in `/* ci-extract:begin <name> */ ... :end`
// markers are lifted out verbatim and evaluated in a bare vm context. A missing
// marker is a hard failure, so renaming or dropping a block breaks CI loudly
// rather than silently skipping its tests.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BLOCKS = ['fmtChartValue', 'localizeOperationalText', 'offlineRatioLabel', 'offlineRatioBadgeClass', 'mergeNotifySnapshot'];

function extract(source, name) {
  const begin = `/* ci-extract:begin ${name} */`;
  const end = `/* ci-extract:end ${name} */`;
  const from = source.indexOf(begin);
  const to = source.indexOf(end);
  assert.ok(from !== -1, `missing ci-extract:begin marker for "${name}" in public/index.html`);
  assert.ok(to > from, `missing or misordered ci-extract:end marker for "${name}" in public/index.html`);
  return source.slice(from + begin.length, to);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function "${name}" in public/index.html`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function "${name}" in public/index.html`);
}

function run() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(BLOCKS.map(name => extract(html, name)).join('\n'), ctx);
  const { fmtChartValue, localizeOperationalText, offlineRatioLabel, offlineRatioBadgeClass, mergeNotifySnapshot } = ctx;

  const pendingEnabled = new Map([
    ['lx:host-a', { off:true }],
    ['snmp:switch-a', { off:false }],
  ]);
  const pendingTopics = new Map([['lx:host-a', { topic:'ops' }]]);
  const mergedNotify = mergeNotifySnapshot(
    ['snmp:switch-a'],
    { 'lx:host-a':'default', 'snmp:switch-a':'network' },
    7,
    7,
    pendingEnabled,
    pendingTopics,
  );
  assert.deepStrictEqual(Array.from(mergedNotify.off), ['lx:host-a'], 'pending bell choices must override an in-flight status snapshot');
  assert.strictEqual(mergedNotify.topics['lx:host-a'], 'ops', 'pending topic choices must override an in-flight status snapshot');
  assert.strictEqual(mergeNotifySnapshot([], {}, 6, 7, new Map(), new Map()), null, 'an older refresh must not replace a confirmed notification revision');
  const confirmedNotify = mergeNotifySnapshot(['lx:host-a'], {}, 8, 7, new Map(), new Map());
  assert.deepStrictEqual(Array.from(confirmedNotify.off), ['lx:host-a'], 'a newer server revision must become canonical');

  assert.match(html, /<button type="button" class="nbell/, 'notification bells must be real buttons so row dragging cannot capture their click');
  assert.ok(html.includes('toggleNotify(this.dataset.notifyKey,this)') && html.includes('setNotifyTopic(this.dataset.notifyKey,this.value,this)'), 'notification keys must come from escaped data attributes instead of inline JavaScript strings');
  assert.ok(html.includes('function deferDetailRenderForPointer(detail, panelId)') && html.includes('detailPointerReleasePending'), 'detail refreshes must wait until the native click after pointerup');
  assert.ok(html.includes("if(oldNode.tagName === 'BUTTON') morphChildren(oldNode, newNode);") && html.includes("if(!statusStreamRefreshing) resetPbar();"), 'focused bells must reconcile in place and stale status fetches must not finish a newer refresh bar');
  assert.ok(html.includes("queuedStatusStreamData = event.data || ''") && html.includes('if(queued) queueMicrotask'), 'notification events received during a status fetch must be replayed');
  assert.ok(html.includes('closeStatusStream();\n    abortStatusFetches();\n    statusStreamRefreshing = false;'), 'pause and resume must not retain a stale refresh state after dropping stream events');

  const focusContext = { document: { activeElement:null } };
  vm.createContext(focusContext);
  vm.runInContext(extractFunction(html, 'focusedDetailControl'), focusContext);
  const focusedButton = { tagName:'BUTTON', isContentEditable:false };
  const buttonContainer = { tagName:'DIV', isContentEditable:false };
  focusContext.document.activeElement = focusedButton;
  assert.strictEqual(focusContext.focusedDetailControl(focusedButton), true, 'the active notification button itself must be preserved during a morph');
  assert.strictEqual(focusContext.focusedDetailControl(buttonContainer), false, 'an active child must not force a full detail replacement or freeze its siblings');

  const translations = { healthy: 'sağlıklı' };
  const translateText = text => translations[text] || text;
  assert.strictEqual(localizeOperationalText('healthy', 'tr', translateText), 'sağlıklı');
  assert.strictEqual(localizeOperationalText('3/3 online', 'tr', translateText), '3/3 çevrimiçi');
  assert.strictEqual(localizeOperationalText('16/16 up', 'tr', translateText), '16/16 aktif');
  assert.strictEqual(localizeOperationalText('2/2 servers', 'tr', translateText), '2/2 sunucu');
  assert.strictEqual(localizeOperationalText('1 reboot required', 'tr', translateText), '1 yeniden başlatma gerekli');
  assert.strictEqual(localizeOperationalText('4/4 services up', 'tr', translateText), '4/4 aktif servisler');
  assert.strictEqual(localizeOperationalText('7 reporting sources', 'tr', translateText), '7 raporlama kaynağı');
  assert.strictEqual(localizeOperationalText('CPU temperature · last known', 'tr', translateText), 'CPU sıcaklığı · son bilinen');
  assert.strictEqual(localizeOperationalText('2/2 pools', 'tr', translateText), '2/2 havuz');
  assert.strictEqual(localizeOperationalText('3/5 green', 'tr', translateText), '3/5 başarılı');
  assert.strictEqual(localizeOperationalText('Read 287 KB/s / Write 179 KB/s', 'tr', translateText), 'okuma 287 KB/s / yazma 179 KB/s');
  assert.strictEqual(localizeOperationalText('3/3 online', 'en', translateText), '3/3 online');
  assert.strictEqual(localizeOperationalText('download', 'tr', translateText), 'download');

  assert.strictEqual(offlineRatioLabel(1, 1), 'Offline');
  assert.strictEqual(offlineRatioLabel(1, 2), '1/2 Online');
  assert.strictEqual(offlineRatioLabel(1, 3), '2/3 Online');
  assert.strictEqual(offlineRatioLabel(2, 3), '1/3 Online');
  assert.strictEqual(offlineRatioLabel(2, 2), '0/2 Online');
  assert.strictEqual(offlineRatioLabel(1, 0), 'Offline');
  assert.strictEqual(offlineRatioLabel(1, 3, 1), '1/3 Online');
  assert.strictEqual(offlineRatioBadgeClass(1, 1), 'red');
  assert.strictEqual(offlineRatioBadgeClass(1, 3), 'yellow');
  assert.strictEqual(offlineRatioBadgeClass(3, 3), 'red');
  assert.strictEqual(offlineRatioBadgeClass(1, 3, 0), 'red');

  // Agrees with the card header: fmtPct(31.95…) renders "32%", so must the tooltip.
  assert.strictEqual(fmtChartValue(31.950000779339398), '32');
  assert.strictEqual(fmtChartValue(51.590000160270634), '51.6');
  assert.strictEqual(fmtChartValue(24.9), '24.9', 'one decimal preserved');
  assert.strictEqual(fmtChartValue(32), '32', 'trailing .0 dropped');
  assert.strictEqual(fmtChartValue(0), '0');
  assert.strictEqual(fmtChartValue(100), '100');

  // No float noise anywhere across the percentage range.
  for (let i = 0; i <= 1000; i++) {
    const out = fmtChartValue(i / 10 + 1e-12);
    assert.ok(/^\d+(\.\d)?$/.test(out), `float noise in "${out}"`);
  }

  // Charts also carry °C, MB/s and ms — no 0-100 clamp (which is why fmtPct
  // can't be reused here).
  assert.strictEqual(fmtChartValue(1234.56), '1234.6', 'above 100 not clamped');
  assert.strictEqual(fmtChartValue(-3.14), '-3.1', 'negatives not clamped to 0');

  // Small readings keep significance instead of collapsing to "0"...
  assert.strictEqual(fmtChartValue(0.0512), '0.051', 'sub-0.1 keeps 2 significant digits');
  assert.strictEqual(fmtChartValue(0.004), '0.004');
  assert.strictEqual(fmtChartValue(0.1), '0.1', 'boundary uses the one-decimal rule');

  // ...but never at the cost of leaking exponential notation into the tooltip.
  assert.strictEqual(fmtChartValue(1e-12), '0', 'tiny value floors, no exponential');
  assert.strictEqual(fmtChartValue(-1e-9), '0', 'tiny negative floors to 0, not -0');
  assert.strictEqual(fmtChartValue(0.0009), '0');

  // Gaps in a series must read as gaps, not as zeroes.
  for (const bad of [null, undefined, '', NaN, Infinity, 'abc', {}]) {
    assert.strictEqual(fmtChartValue(bad), '--', `non-numeric ${String(bad)} -> --`);
  }

  const scrollContext = {};
  vm.createContext(scrollContext);
  vm.runInContext(extractFunction(html, 'replaceOverviewHtml'), scrollContext);
  const retainedLogs = { scrollTop: 137 };
  const replacementLogs = { replaceWith(node) { detail.current = node; } };
  const detail = {
    current: retainedLogs,
    querySelector: () => detail.current,
    set innerHTML(value) { detail.rendered = value; detail.current = replacementLogs; },
  };
  scrollContext.replaceOverviewHtml(detail, '<section>updated</section>');
  assert.strictEqual(detail.current, retainedLogs);
  assert.strictEqual(detail.current.scrollTop, 137);
  assert.match(html, /\.overview-log-list\{[^}]*scrollbar-width:thin[^}]*scrollbar-gutter:stable/);

  const prefetchStart = html.indexOf('let embedPrefetchStarted = false;');
  const prefetchEnd = html.indexOf('let demoEmbedWarmupStarted = false;', prefetchStart);
  assert.ok(prefetchStart >= 0 && prefetchEnd > prefetchStart, 'embed prefetch block must be extractable');
  for (const options of [{ immediate: true }, undefined]) {
    const prefetchContext = {
      navigator: { connection: null },
      document: {
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ dataset: {} }),
        head: { appendChild: () => {} },
      },
      window: { requestIdleCallback: fn => fn() },
      requestIdleCallback: fn => fn(),
      setTimeout: fn => fn(),
    };
    vm.createContext(prefetchContext);
    vm.runInContext(html.slice(prefetchStart, prefetchEnd), prefetchContext);
    assert.doesNotThrow(() => prefetchContext.scheduleEmbedPrefetch(options), 'embed prefetch scheduling must run without undefined options');
  }

  console.log('smoke ok — client helpers: formatting, localization, availability, notification refresh guards, scroll preservation');
}

module.exports = { run };
if (require.main === module) {
  try { run(); } catch (err) { console.error(err); process.exit(1); }
}
