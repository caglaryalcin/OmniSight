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
  const argsStart = source.indexOf('(', start);
  let argsDepth = 0;
  let bodyStart = -1;
  for (let index = argsStart; index < source.length; index += 1) {
    if (source[index] === '(') argsDepth += 1;
    else if (source[index] === ')') {
      argsDepth -= 1;
      if (argsDepth === 0) {
        bodyStart = source.indexOf('{', index + 1);
        break;
      }
    }
  }
  assert.ok(bodyStart >= 0, `missing body for function "${name}" in public/index.html`);
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

function createMorphFixture() {
  class FakeNode {
    get nextSibling() {
      if (!this.parentNode) return null;
      const index = this.parentNode.childNodes.indexOf(this);
      return index >= 0 ? this.parentNode.childNodes[index + 1] || null : null;
    }
    replaceWith(replacement) {
      assert.ok(this.parentNode, 'cannot replace a detached fake node');
      this.parentNode.replaceChild(replacement, this);
    }
    remove() {
      this.parentNode?.removeChild(this);
    }
  }

  class FakeText extends FakeNode {
    constructor(value = '') {
      super();
      this.nodeType = 3;
      this.nodeName = '#text';
      this.nodeValue = String(value);
      this.parentNode = null;
    }
    cloneNode() { return new FakeText(this.nodeValue); }
    get textContent() { return this.nodeValue; }
    set textContent(value) { this.nodeValue = String(value); }
  }

  class FakeElement extends FakeNode {
    constructor(tagName = 'div', attrs = {}, children = []) {
      super();
      this.nodeType = 1;
      this.tagName = String(tagName).toUpperCase();
      this.nodeName = this.tagName;
      this.parentNode = null;
      this.childNodes = [];
      this._attrs = new Map();
      Object.entries(attrs).forEach(([name, value]) => this.setAttribute(name, value));
      children.forEach(child => this.appendChild(child));
    }
    get attributes() {
      return Array.from(this._attrs, ([name, value]) => ({ name, value }));
    }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get classList() {
      const read = () => new Set(this.className.split(/\s+/).filter(Boolean));
      const write = values => { this.className = Array.from(values).join(' '); };
      return {
        contains: name => read().has(String(name)),
        add: (...names) => {
          const values = read();
          names.forEach(name => values.add(String(name)));
          write(values);
        },
        remove: (...names) => {
          const values = read();
          names.forEach(name => values.delete(String(name)));
          write(values);
        },
        toggle: (name, force) => {
          const values = read();
          const key = String(name);
          const enabled = force === undefined ? !values.has(key) : !!force;
          if (enabled) values.add(key); else values.delete(key);
          write(values);
          return enabled;
        },
      };
    }
    get dataset() {
      const out = {};
      for (const [name, value] of this._attrs) {
        if (!name.startsWith('data-')) continue;
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        out[key] = value;
      }
      return out;
    }
    getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; }
    hasAttribute(name) { return this._attrs.has(String(name)); }
    setAttribute(name, value) { this._attrs.set(String(name), String(value)); }
    removeAttribute(name) { this._attrs.delete(String(name)); }
    querySelectorAll(selector) {
      const directClass = String(selector).match(/^:scope\s*>\s*\.([\w-]+)$/);
      const descendantClass = String(selector).match(/^\.([\w-]+)$/);
      if (directClass) return this.children.filter(node => node.classList.contains(directClass[1]));
      if (!descendantClass) throw new Error(`unsupported fake selector: ${selector}`);
      const matches = [];
      const visit = node => {
        node.children.forEach(child => {
          if (child.classList.contains(descendantClass[1])) matches.push(child);
          visit(child);
        });
      };
      visit(this);
      return matches;
    }
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    insertBefore(node, reference) {
      if (reference == null) return this.appendChild(node);
      let index = this.childNodes.indexOf(reference);
      assert.ok(index >= 0, 'fake insertBefore reference must be a child');
      if (node.parentNode) {
        const sameParent = node.parentNode === this;
        const oldIndex = sameParent ? this.childNodes.indexOf(node) : -1;
        node.parentNode.removeChild(node);
        if (sameParent && oldIndex < index) index -= 1;
      }
      node.parentNode = this;
      this.childNodes.splice(index, 0, node);
      return node;
    }
    replaceChild(replacement, current) {
      const index = this.childNodes.indexOf(current);
      assert.ok(index >= 0, 'fake replaceChild target must be a child');
      if (replacement.parentNode) replacement.parentNode.removeChild(replacement);
      replacement.parentNode = this;
      current.parentNode = null;
      this.childNodes[index] = replacement;
      return current;
    }
    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      assert.ok(index >= 0, 'fake removeChild target must be a child');
      this.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    }
    cloneNode(deep = false) {
      const clone = new this.constructor(this.tagName, Object.fromEntries(this._attrs));
      if ('type' in this) clone.type = this.type;
      if ('value' in this) clone.value = this.value;
      if ('checked' in this) clone.checked = this.checked;
      if (deep) this.childNodes.forEach(child => clone.appendChild(child.cloneNode(true)));
      return clone;
    }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) {
      this.childNodes.forEach(node => { node.parentNode = null; });
      this.childNodes = [];
      this.appendChild(new FakeText(value));
    }
  }

  class FakeInputElement extends FakeElement {
    constructor(tagName = 'input', attrs = {}, children = []) {
      super(tagName, attrs, children);
      this.type = attrs.type || 'text';
      this.value = attrs.value || '';
      this.checked = attrs.checked === true || attrs.checked === 'checked';
    }
  }
  class FakeTextAreaElement extends FakeInputElement {}
  class FakeSelectElement extends FakeInputElement {}

  const text = value => new FakeText(value);
  const element = (tagName, attrs = {}, children = []) => {
    const tag = String(tagName).toLowerCase();
    const Type = tag === 'input' ? FakeInputElement : tag === 'textarea' ? FakeTextAreaElement : tag === 'select' ? FakeSelectElement : FakeElement;
    return new Type(tagName, attrs, children);
  };
  return { FakeNode, FakeText, FakeElement, FakeInputElement, FakeTextAreaElement, FakeSelectElement, text, element };
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
  assert.ok(html.includes("if(oldNode.tagName === 'BUTTON') morphChildren(oldNode, newNode);"), 'focused bells must reconcile in place during live updates');
  assert.ok(html.includes('let queuedStatusStreamEvents = []') && html.includes('queuedStatusStreamEvents.push(queuedData)') && html.includes('queuedStatusStreamEvents.length > 12') && html.includes('queuedStatusStreamEvents.splice(0)') && html.includes('queued.forEach(data => handleStatusStreamEvent({ data, replayed:true }))'), 'status events received during a fetch must be bounded and replayed in arrival order');
  const activityLineCssStart = html.indexOf('#activity-line{');
  const activityLineCssEnd = html.indexOf('}', activityLineCssStart);
  const activityLineCss = activityLineCssStart >= 0 && activityLineCssEnd > activityLineCssStart
    ? html.slice(activityLineCssStart, activityLineCssEnd + 1)
    : '';
  assert.ok(html.includes('<div id="activity-line" aria-hidden="true"></div>'), 'the refresh activity line must be a decorative, non-layout body child');
  assert.ok(activityLineCss.includes('position:fixed') && activityLineCss.includes('top:0') && activityLineCss.includes('height:2px') && activityLineCss.includes('pointer-events:none'), 'the activity line must remain a fixed 2px non-interactive overlay');
  assert.ok(html.includes('#activity-line.is-active') && html.includes('#activity-line.is-done') && html.includes('#activity-line.is-offline') && html.includes('#activity-line.is-error'), 'the activity line must expose active, completion, offline and error visuals');
  assert.ok(html.includes('@keyframes activity-line-sweep'), 'the active refresh line must use an indeterminate animation');
  assert.ok(!html.includes('id="pbtn"') && !html.includes('id="pbtn-icon"') && !html.includes('#pbtn') && !html.includes('onclick="togglePause()"'), 'the removed Pause control must not remain in markup or CSS');
  assert.ok(!html.includes('function togglePause(') && !html.includes('let paused = false;'), 'the removed Pause control must not leave refresh gating state behind');
  assert.ok(html.includes('function activityLineStart(') && html.includes('function activityLineComplete(') && html.includes('function activityLineFail(') && html.includes('function activityLineSetOffline('), 'the activity line must keep explicit lifecycle helpers for refresh and connection state');
  assert.ok(html.includes('id="rbtn"') && html.includes('onclick="doRefresh()"'), 'manual Refresh must remain available without restoring Pause');

  const activityLineBlockStart = html.indexOf('/* ── Activity line ── */');
  const activityLineBlockEnd = html.indexOf('let faviconTimer = null;', activityLineBlockStart);
  assert.ok(activityLineBlockStart >= 0 && activityLineBlockEnd > activityLineBlockStart, 'the activity-line state block must remain independently testable');
  const activityLineElement = { className:'' };
  const activityLineTimers = new Map();
  let nextActivityLineTimer = 1;
  const activityLineContext = {
    navigator:{ onLine:true },
    document:{ getElementById:id => id === 'activity-line' ? activityLineElement : null },
    window:{ addEventListener:() => {} },
    setTimeout:fn => {
      const id = nextActivityLineTimer++;
      activityLineTimers.set(id, fn);
      return id;
    },
    clearTimeout:id => activityLineTimers.delete(id),
  };
  vm.createContext(activityLineContext);
  vm.runInContext(html.slice(activityLineBlockStart, activityLineBlockEnd), activityLineContext);
  activityLineContext.activityLineStart('stream');
  activityLineContext.activityLineStart('manual');
  assert.strictEqual(activityLineElement.className, 'is-active', 'refresh activity must become visible immediately');
  activityLineContext.activityLineComplete('manual');
  assert.strictEqual(activityLineElement.className, 'is-active', 'finishing one overlapping refresh must not hide another active source');
  activityLineContext.activityLineComplete('stream');
  assert.strictEqual(activityLineElement.className, 'is-done', 'the final active source must transition through the completion state');
  activityLineTimers.get(Math.max(...activityLineTimers.keys()))();
  assert.strictEqual(activityLineElement.className, '', 'the completion state must clear after its short timer');
  activityLineContext.activityLineSetOffline(true);
  assert.strictEqual(activityLineElement.className, 'is-offline', 'an offline connection must show the amber state');
  activityLineContext.activityLineStart('stream');
  assert.strictEqual(activityLineElement.className, 'is-offline', 'offline state must remain visible while a stale refresh source is still active');
  activityLineContext.activityLineFail('stream');
  assert.strictEqual(activityLineElement.className, 'is-error', 'a failed refresh must briefly take precedence over offline state');
  activityLineTimers.get(Math.max(...activityLineTimers.keys()))();
  assert.strictEqual(activityLineElement.className, 'is-offline', 'the error flash must return to the persistent offline state');
  activityLineContext.activityLineSetOffline(false);
  assert.strictEqual(activityLineElement.className, '', 'reconnecting must clear the offline state when no refresh is active');
  activityLineContext.activityLineSetOffline(true);
  activityLineContext.activityLineStart('collector');
  activityLineContext.activityLineReset();
  assert.strictEqual(activityLineElement.className, '', 'reset must clear offline, transient and active-source state together');
  activityLineContext.activityLineComplete('collector');
  assert.strictEqual(activityLineElement.className, '', 'a completion from a cancelled source must not revive the line after reset');

  const memoryStorage = initial => {
    const values = new Map(Object.entries(initial || {}).map(([key, value]) => [key, String(value)]));
    return {
      getItem:key => values.has(String(key)) ? values.get(String(key)) : null,
      setItem:(key, value) => values.set(String(key), String(value)),
      removeItem:key => values.delete(String(key)),
      values,
    };
  };
  const scopedSessionStorage = memoryStorage({ os_token:'user-token-a' });
  const scopedLocalStorage = memoryStorage();
  const storageScopeContext = { sessionStorage:scopedSessionStorage, localStorage:scopedLocalStorage };
  vm.createContext(storageScopeContext);
  vm.runInContext([
    extractFunction(html, 'browserUserStorageScope'),
    extractFunction(html, 'scopedUserStorageKey'),
  ].join('\n'), storageScopeContext);
  const userAHiddenKey = storageScopeContext.scopedUserStorageKey('os_dashboard_hidden_platforms');
  scopedSessionStorage.setItem('os_token', 'user-token-b');
  const userBHiddenKey = storageScopeContext.scopedUserStorageKey('os_dashboard_hidden_platforms');
  assert.notStrictEqual(userAHiddenKey, userBHiddenKey, 'browser-backed hidden-platform state must be scoped to the authenticated token');
  assert.ok(!userAHiddenKey.includes('user-token-a') && !userBHiddenKey.includes('user-token-b'), 'token-scoped storage keys must not expose the raw session token');
  const legacyHiddenStorage = memoryStorage({
    os_dashboard_hidden_platforms:JSON.stringify(['kubernetes']),
    os_dashboard_hidden_platforms_cleared_at:'1',
    [userAHiddenKey]:JSON.stringify(['docker']),
  });
  const legacyHiddenContext = {
    localStorage:legacyHiddenStorage,
    DASHBOARD_HIDDEN_KEY:userAHiddenKey,
    DASHBOARD_HIDDEN_LEGACY_KEY:'os_dashboard_hidden_platforms',
    DASHBOARD_HIDDEN_CLEARED_LEGACY_KEY:'os_dashboard_hidden_platforms_cleared_at',
  };
  vm.createContext(legacyHiddenContext);
  vm.runInContext(extractFunction(html, 'readScopedDashboardHiddenPlatforms'), legacyHiddenContext);
  assert.deepStrictEqual(Array.from(legacyHiddenContext.readScopedDashboardHiddenPlatforms()), ['docker'], 'the current account may restore only its scoped hidden-platform state');
  assert.strictEqual(legacyHiddenStorage.getItem('os_dashboard_hidden_platforms'), null, 'an unattributable legacy hidden list must be discarded instead of assigned to the first token after upgrade');
  assert.strictEqual(legacyHiddenStorage.getItem('os_dashboard_hidden_platforms_cleared_at'), null, 'an unattributable legacy clear tombstone must also be discarded instead of overriding the first token after upgrade');

  const cacheKey = 'status-cache:test-user';
  const legacyCachedBox = JSON.stringify({
    t:Date.now(),
    data:{ timestamp:'2026-08-19T00:00:00.000Z', ui:{ dashboardHiddenPlatforms:['kubernetes'] }, status:'ok' },
  });
  const cacheSessionStorage = memoryStorage({ [cacheKey]:legacyCachedBox });
  const cacheLocalStorage = memoryStorage({ [cacheKey]:legacyCachedBox });
  const statusCacheContext = {
    sessionStorage:cacheSessionStorage,
    localStorage:cacheLocalStorage,
    STATUS_CACHE_MAX_AGE:10 * 60 * 1000,
    statusCacheKey:() => cacheKey,
    statusPayloadLooksTransientShell:() => false,
    statusCacheWriteTimer:null,
    window:{},
    setTimeout:fn => { fn(); return 1; },
  };
  vm.createContext(statusCacheContext);
  vm.runInContext([
    extractFunction(html, 'statusCacheDataWithoutUi'),
    extractFunction(html, 'readStatusCache'),
    extractFunction(html, 'writeStatusCache'),
  ].join('\n'), statusCacheContext);
  const migratedCachedStatus = statusCacheContext.readStatusCache();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(migratedCachedStatus, 'ui'), false, 'a legacy cached status must never return its embedded UI preference');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(JSON.parse(cacheSessionStorage.getItem(cacheKey)).data, 'ui'), false, 'reading a legacy session cache must rewrite it without UI preferences');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(JSON.parse(cacheLocalStorage.getItem(cacheKey)).data, 'ui'), false, 'reading a legacy local cache must rewrite it without UI preferences');
  const statusWithUi = { timestamp:'2026-08-19T00:00:15.000Z', ui:{ dashboardHiddenPlatforms:['docker'] }, status:'degraded' };
  statusCacheContext.writeStatusCache(statusWithUi);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(JSON.parse(cacheLocalStorage.getItem(cacheKey)).data, 'ui'), false, 'new status cache writes must omit request-scoped UI preferences');
  assert.ok(statusWithUi.ui, 'status cache sanitization must not mutate the live response object');
  const liveTransientUi = { dashboardHiddenPlatforms:['prometheus'] };
  const fallbackContext = {
    statusPayloadLooksTransientShell:() => true,
    readStatusCache:() => ({ timestamp:'2026-08-19T00:00:00.000Z', status:'ok' }),
    statusPayloadHasUsefulData:() => true,
  };
  vm.createContext(fallbackContext);
  vm.runInContext(extractFunction(html, 'statusCachedFallback'), fallbackContext);
  const fallbackStatus = fallbackContext.statusCachedFallback({ refreshing:true, ui:liveTransientUi });
  assert.strictEqual(fallbackStatus.ui, liveTransientUi, 'a transient inventory fallback must overlay the fresh request-scoped UI onto sanitized cached metrics');
  assert.strictEqual(fallbackStatus.status, 'ok', 'a transient inventory fallback must still retain useful cached status data');

  const tombstoneStorage = memoryStorage({ clear_marker:'1', dirty_marker:'1' });
  const tombstoneContext = {
    localStorage:tombstoneStorage,
    DASHBOARD_HIDDEN_CLEARED_KEY:'clear_marker',
    DASHBOARD_HIDDEN_DIRTY_KEY:'dirty_marker',
    ALL_IDS:['kubernetes','docker'],
    validUiPlatform:id => ['kubernetes','docker'].includes(id),
  };
  vm.createContext(tombstoneContext);
  vm.runInContext(`
    var dashboardHiddenPlatforms = new Set();
    var dashboardHiddenSavedRevision = 0;
    var dashboardHiddenLocalEditRevision = 1;
    var dashboardHiddenLocalEditUntil = 1;
    ${extractFunction(html, 'normalizedDashboardHiddenList')}
    ${extractFunction(html, 'sameDashboardHiddenList')}
    ${extractFunction(html, 'clearDashboardHiddenClearPending')}
    ${extractFunction(html, 'dashboardHiddenClearPending')}
    ${extractFunction(html, 'clearDashboardHiddenDirtyPending')}
    ${extractFunction(html, 'acknowledgeDashboardHiddenPlatforms')}
  `, tombstoneContext);
  assert.strictEqual(tombstoneContext.dashboardHiddenClearPending(), true, 'a restore tombstone must not expire based on its stored timestamp');
  assert.strictEqual(tombstoneContext.acknowledgeDashboardHiddenPlatforms(['kubernetes']), false, 'a mismatched server response must not acknowledge a pending restore');
  assert.strictEqual(tombstoneStorage.getItem('clear_marker'), '1', 'the restore tombstone must survive until the server returns the desired empty list');
  assert.strictEqual(tombstoneStorage.getItem('dirty_marker'), '1', 'the hidden-platform dirty marker must survive a mismatched response');
  assert.strictEqual(tombstoneContext.acknowledgeDashboardHiddenPlatforms([]), true, 'the desired empty server list must acknowledge a pending restore');
  assert.strictEqual(tombstoneStorage.getItem('clear_marker'), null, 'the restore tombstone must clear after server acknowledgement');
  assert.strictEqual(tombstoneStorage.getItem('dirty_marker'), null, 'the hidden-platform dirty marker must clear after server acknowledgement');

  const retryDelays = [];
  const retryContext = {
    uiPrefsDirty:true,
    uiPrefsDirtyRevision:9,
    uiPrefsRetryAttempt:0,
    UI_PREFS_RETRY_BASE_MS:750,
    UI_PREFS_RETRY_MAX_MS:30000,
    queueUiPreferencesSave:delay => retryDelays.push(delay),
  };
  vm.createContext(retryContext);
  vm.runInContext(extractFunction(html, 'scheduleUiPreferencesRetry'), retryContext);
  for(let attempt = 0; attempt < 12; attempt += 1) retryContext.scheduleUiPreferencesRetry(9);
  assert.deepStrictEqual(retryDelays.slice(0, 7), [750,1500,3000,6000,12000,24000,30000], 'UI preference retries must use exponential backoff capped at 30 seconds');
  assert.strictEqual(retryDelays.length, 12, 'UI preference retries must continue at the capped delay until an ACK or a replacement edit');
  assert.ok(retryDelays.slice(6).every(delay => delay === 30000), 'all later UI preference retries must remain capped');
  retryContext.scheduleUiPreferencesRetry(8);
  retryContext.uiPrefsDirty = false;
  retryContext.scheduleUiPreferencesRetry(9);
  assert.strictEqual(retryDelays.length, 12, 'stale revisions and acknowledged preferences must not schedule retries');

  const schedulePrefsSource = extractFunction(html, 'scheduleUiPreferencesSave');
  const savePrefsSource = extractFunction(html, 'saveUiPreferences');
  const applyPrefsSource = extractFunction(html, 'applyServerUiPreferences');
  assert.ok(schedulePrefsSource.includes('uiPrefsDirty = true') && schedulePrefsSource.includes('uiPrefsDirtyRevision += 1') && schedulePrefsSource.includes('450'), 'preference edits must become dirty while retaining the existing debounce');
  assert.ok(savePrefsSource.includes('uiPrefsSaveController?.abort?.()') && savePrefsSource.includes('signal: ctrl.signal'), 'a replacement preference save must retain abort-controller cancellation');
  assert.ok(savePrefsSource.includes('if(!r.ok) throw new Error') && savePrefsSource.includes('scheduleUiPreferencesRetry(revision)'), 'failed preference responses must remain dirty and enter the retry backoff');
  assert.ok(savePrefsSource.includes('acknowledgeUiPreferences(savedUi)') && savePrefsSource.includes('uiPrefsDirty = false'), 'only an acknowledged matching save may clear dirty preference state');
  assert.match(applyPrefsSource, /if\(!data\.ui[^\n]+\) return;/, 'status data without request-scoped UI must not hydrate browser preferences');
  assert.ok(applyPrefsSource.includes('uiPrefsReady && (uiPrefsDirty || signature === uiPrefsLastSignature)'), 'an in-flight dirty preference must not be overwritten by a status refresh');
  const noUiHydrationContext = {};
  vm.createContext(noUiHydrationContext);
  vm.runInContext(applyPrefsSource, noUiHydrationContext);
  assert.doesNotThrow(() => noUiHydrationContext.applyServerUiPreferences({ status:'ok' }), 'rendering a UI-free status cache must not enter preference hydration or schedule an early save');

  const focusContext = { document: { activeElement:null } };
  vm.createContext(focusContext);
  vm.runInContext(extractFunction(html, 'focusedDetailControl'), focusContext);
  const insideInput = { tagName:'INPUT', isContentEditable:false };
  const insideSelect = { tagName:'SELECT', isContentEditable:false };
  const focusRoot = { tagName:'DIV', isContentEditable:false, contains: node => node === insideInput || node === insideSelect };
  focusContext.document.activeElement = insideInput;
  assert.strictEqual(focusContext.focusedDetailControl(insideInput), true, 'the actively focused input node itself must defer replacement');
  assert.strictEqual(focusContext.focusedDetailControl(focusRoot), false, 'an ancestor must not freeze its whole subtree merely because it contains the focused input');
  focusContext.document.activeElement = insideSelect;
  assert.strictEqual(focusContext.focusedDetailControl(insideSelect), true, 'the actively focused select node itself must defer replacement');
  assert.strictEqual(focusContext.focusedDetailControl(focusRoot), false, 'a select focus must not freeze an ancestor morph root');
  focusContext.document.activeElement = focusRoot;
  assert.strictEqual(focusContext.focusedDetailControl(focusRoot), false, 'an active non-control div must not defer replacement');

  assert.ok(html.includes('function morphNodeIdentity(') && html.includes('function morphElementHtml('), 'live refresh must expose keyed identity and in-place HTML morph helpers');
  const overviewCardSource = extractFunction(html, 'renderDashboardOverview');
  const overviewKpiSource = extractFunction(html, 'overviewKpi');
  const overviewRowSource = extractFunction(html, 'overviewRow');
  assert.ok(overviewCardSource.includes('data-morph-key') && overviewKpiSource.includes('data-morph-key') && overviewRowSource.includes('data-morph-key'), 'overview cards, KPIs and rows must have stable morph keys');
  assert.ok(overviewCardSource.includes('data-morph-key="overview-summary:${escAttr(id)}"') && overviewCardSource.includes('data-morph-key="overview-list:${escAttr(id)}"'), 'overview summaries and lists must be keyed per platform instead of shifting card children positionally');
  assert.match(overviewRowSource, /function overviewRow\([^)]*entityKey\s*=\s*''\)/, 'overview rows must accept an optional stable entity key');
  assert.ok(overviewRowSource.includes('entityKey || name ||'), 'overview row identity must prefer the stable entity key over mutable display text');
  const overviewRowContext = {
    escAttr: value => String(value ?? ''),
    escHtml: value => String(value ?? ''),
    bdg: (badgeClass, text) => `<span class="${badgeClass}">${text}</span>`,
  };
  vm.createContext(overviewRowContext);
  vm.runInContext(overviewRowSource, overviewRowContext);
  const overviewEntityRow = overviewRowContext.overviewRow('linux', 'Visible host name', 'summary', 'green', 'ok', 'md-green', null, '', 'host-uuid-1');
  const renamedOverviewEntityRow = overviewRowContext.overviewRow('linux', 'Renamed host', 'new summary', 'green', 'ok', 'md-green', null, '', 'host-uuid-1');
  const otherOverviewEntityRow = overviewRowContext.overviewRow('linux', 'Visible host name', 'summary', 'green', 'ok', 'md-green', null, '', 'host-uuid-2');
  const overviewMorphKey = rowHtml => rowHtml.match(/data-morph-key="([^"]+)"/)?.[1] || '';
  assert.strictEqual(overviewMorphKey(overviewEntityRow), overviewMorphKey(renamedOverviewEntityRow), 'renaming an overview entity must not change its explicit morph identity');
  assert.notStrictEqual(overviewMorphKey(overviewEntityRow), overviewMorphKey(otherOverviewEntityRow), 'different explicit overview entity keys must produce different morph identities');

  const kubernetesDetailSource = extractFunction(html, 'buildKubernetes');
  const deploymentKeyStart = kubernetesDetailSource.indexOf('data-morph-key="k8s-deployment:');
  const serviceKeyStart = kubernetesDetailSource.indexOf('data-morph-key="k8s-service:');
  const deploymentKeySource = deploymentKeyStart >= 0 ? kubernetesDetailSource.slice(deploymentKeyStart, deploymentKeyStart + 220) : '';
  const serviceKeySource = serviceKeyStart >= 0 ? kubernetesDetailSource.slice(serviceKeyStart, serviceKeyStart + 220) : '';
  assert.ok(deploymentKeySource.includes("d.namespace || 'default'") && deploymentKeySource.includes('d.uid || d.id || d.name'), 'Kubernetes deployment rows must use namespace-scoped native identities');
  assert.ok(serviceKeySource.includes("sv.namespace || 'default'") && serviceKeySource.includes('sv.uid || sv.id || sv.name'), 'Kubernetes service rows must use namespace-scoped native identities');

  const ciCdDetailSource = extractFunction(html, 'buildCiCd');
  assert.ok(ciCdDetailSource.includes('data-morph-key="cicd-project:${escAttr(project.id || project.url || project.name || idx)}"'), 'CI/CD project wrappers must have stable endpoint-scoped identities');
  const ciPipelineKeyStart = ciCdDetailSource.indexOf('const pipelineKey =');
  const ciPipelineKeySource = ciPipelineKeyStart >= 0 ? ciCdDetailSource.slice(ciPipelineKeyStart, ciPipelineKeyStart + 260) : '';
  assert.ok(ciPipelineKeySource.includes("project.id || project.url || project.name || ''") && ciPipelineKeySource.includes('p.id || p.pipelineId || p.runId || p.createdAt || p.name || p.workflowName'), 'CI/CD pipeline keys must combine their parent identity with native run or creation identity');
  assert.ok(ciCdDetailSource.includes('data-morph-key="cicd-pipeline:${escAttr(pipelineKey)}"'), 'CI/CD pipeline rows must expose their scoped key to the morph reconciler');

  const veeamDetailSource = extractFunction(html, 'buildVeeam');
  assert.ok(veeamDetailSource.includes('data-morph-key="veeam-instance:${escAttr(inst.id || inst.url || inst.name || idx)}"'), 'Veeam instance wrappers must have stable endpoint identities');
  const veeamSessionKeyStart = veeamDetailSource.indexOf('const sessionKey =');
  const veeamRepositoryKeyStart = veeamDetailSource.indexOf('const repoKey =');
  const veeamSessionKeySource = veeamSessionKeyStart >= 0 ? veeamDetailSource.slice(veeamSessionKeyStart, veeamSessionKeyStart + 260) : '';
  const veeamRepositoryKeySource = veeamRepositoryKeyStart >= 0 ? veeamDetailSource.slice(veeamRepositoryKeyStart, veeamRepositoryKeyStart + 240) : '';
  assert.ok(veeamSessionKeySource.includes("inst.id || inst.url || inst.name || ''") && veeamSessionKeySource.includes('s.id || s.sessionId || s.uuid || s.creationTime || s.name'), 'Veeam session keys must combine their parent with native or creation-time identity');
  assert.ok(veeamRepositoryKeySource.includes("inst.id || inst.url || inst.name || ''") && veeamRepositoryKeySource.includes('r.id || r.uuid || r.path || r.name'), 'Veeam repository keys must combine their parent with native or path identity');
  assert.ok(veeamDetailSource.includes('data-morph-key="veeam-session:${escAttr(sessionKey)}"') && veeamDetailSource.includes('data-morph-key="veeam-repository:${escAttr(repoKey)}"'), 'Veeam session and repository rows must expose their scoped keys to the morph reconciler');

  for (const name of ['pollOnce', 'handleStatusStreamEvent', 'doRefresh']) {
    const refreshSource = extractFunction(html, name);
    assert.match(refreshSource, /render\(data,\s*\{\s*live\s*:\s*true\s*\}\)/, `${name} must use the live refresh path`);
    assert.doesNotMatch(refreshSource, /render\(data\);/, `${name} must not fall back to an unconditional structural render`);
  }
  const streamEventSource = extractFunction(html, 'handleStatusStreamEvent');
  assert.match(streamEventSource, /if\s*\(\s*!event\.replayed\s*&&\s*msg\.type\s*===\s*'refreshing'\s*\)\s*\{\s*activityLineStart\('collector'\);\s*return;\s*\}/, 'collector-start events must activate the line without starting a redundant status fetch');
  assert.ok(streamEventSource.includes("if(msg.type === 'hello')") && streamEventSource.includes("if(msg.refreshing === true) activityLineStart('collector')") && streamEventSource.includes("else activityLineComplete('collector')"), 'stream hello events must restore or clear collector activity after reconnect');
  assert.ok(streamEventSource.includes('queuedStatusStreamEvents.push(queuedData)') && streamEventSource.includes('queuedStatusStreamEvents.length > 12') && streamEventSource.includes('queuedStatusStreamEvents.splice(0)') && streamEventSource.includes('queued.forEach(data => handleStatusStreamEvent({ data, replayed:true }))'), 'busy stream fetches must retain a bounded ordered event queue instead of overwriting an earlier updated event');
  assert.ok(streamEventSource.includes("activityLineStart('stream')") && streamEventSource.includes("activityLineComplete('stream')") && streamEventSource.includes("activityLineFail('stream', 'collector')"), 'status-stream fetches must finish or fail each activity source without leaving a stale line');
  assert.ok(streamEventSource.includes("if(msg.type === 'updated') activityLineComplete('collector')"), 'collector completion must finish the line after the updated snapshot is handled, including duplicate timestamps');
  assert.doesNotMatch(streamEventSource, /msg\.refreshing[^\n]*return/, 'updated and notification events must not be dropped merely because their payload still says refreshing');
  const pollSource = extractFunction(html, 'pollOnce');
  assert.ok(pollSource.includes("activityLineStart('poll')") && pollSource.includes("activityLineComplete('poll')") && pollSource.includes("activityLineFail('poll')"), 'fallback polling must drive the same activity lifecycle');
  assert.ok(pollSource.includes("e?.name === 'AbortError' && (embedOpen || pageHidden())") && pollSource.includes('activityLineReset()'), 'an intentionally aborted poll must reset quietly during navigation or page hiding');
  const manualRefreshSource = extractFunction(html, 'doRefresh');
  assert.ok(manualRefreshSource.includes("activityLineStart('manual')") && manualRefreshSource.includes("activityLineComplete('manual')") && manualRefreshSource.includes("activityLineFail('manual')"), 'manual refresh must complete on either the direct response or abort fallback and flash error only when both fail');
  assert.ok(manualRefreshSource.includes('let activityCancelled = false') && manualRefreshSource.includes('if(embedOpen || pageHidden()) activityCancelled = true') && manualRefreshSource.includes('if(activityCancelled) activityLineReset()'), 'navigation and visibility aborts must cancel manual activity without a false error flash');
  const streamConnectSource = extractFunction(html, 'connectStatusStream');
  assert.ok(streamConnectSource.includes('const stream = new EventSource') && streamConnectSource.includes('if(statusStream !== stream) return') && streamConnectSource.includes('activityLineSetOffline(false)') && streamConnectSource.includes('activityLineSetOffline(true)'), 'SSE callbacks must ignore superseded streams while clearing and setting persistent offline state');
  const closeStreamSource = extractFunction(html, 'closeStatusStream');
  assert.ok(closeStreamSource.includes('queuedStatusStreamEvents.length = 0') && closeStreamSource.includes('activityLineReset()'), 'closing the stream must clear queued events and all activity state');
  assert.ok(streamEventSource.includes("e?.name === 'AbortError' && (embedOpen || pageHidden())") && streamEventSource.includes('activityLineReset()'), 'an intentionally aborted stream fetch must not flash an error after navigation');
  assert.match(html, /abortStatusFetches\(\);\r?\n\s+activityLineReset\(\);/, 'hiding the page must clear stale activity after aborting status requests');
  const renderSource = extractFunction(html, 'render');
  const staleGuardStart = renderSource.indexOf('if(opts.live && window._lastData){');
  const staleGuardEnd = renderSource.indexOf('if(opts.live && window._lastData && (data?.loading || data?.refreshing))', staleGuardStart);
  assert.ok(staleGuardStart >= 0 && staleGuardEnd > staleGuardStart, 'the stale live-status guard must remain independently testable');
  const staleGuardSource = renderSource.slice(staleGuardStart, staleGuardEnd);
  assert.ok(staleGuardSource.includes('...window._lastData') && !staleGuardSource.includes('...data,'), 'a stale notification advance must start from the newer retained status snapshot');
  const staleGuardContext = { window:{ _lastData:null } };
  vm.createContext(staleGuardContext);
  vm.runInContext(`function applyStaleGuard(data, opts = {}){\n${staleGuardSource}\nreturn data;\n}`, staleGuardContext);
  const newerStatusSnapshot = {
    timestamp:'2026-08-19T12:02:00.000Z',
    status:'healthy-t2',
    inventory:{ instances:[{ id:'host-t2', cpu:42 }] },
    notifyDisabled:['old-disabled'],
    notifyTopics:{ 'host-t2':'old-topic' },
    notifyRevision:7,
    ntfyTopics:['old-topic'],
  };
  staleGuardContext.window._lastData = newerStatusSnapshot;
  const delayedNotificationSnapshot = {
    timestamp:'2026-08-19T12:01:00.000Z',
    status:'stale-t1',
    inventory:{ instances:[{ id:'host-t1', cpu:3 }] },
    notifyDisabled:['new-disabled'],
    notifyTopics:{ 'host-t2':'new-topic' },
    notifyRevision:8,
    ntfyTopics:['new-topic'],
  };
  const notificationOnlyMerge = staleGuardContext.applyStaleGuard(delayedNotificationSnapshot, { live:true });
  assert.strictEqual(notificationOnlyMerge.timestamp, newerStatusSnapshot.timestamp, 'an older notification response must not roll back the retained status timestamp');
  assert.strictEqual(notificationOnlyMerge.status, newerStatusSnapshot.status, 'an older notification response must not roll back global status');
  assert.strictEqual(notificationOnlyMerge.inventory, newerStatusSnapshot.inventory, 'an older notification response must preserve the newer inventory snapshot');
  assert.deepStrictEqual(Array.from(notificationOnlyMerge.notifyDisabled), ['new-disabled'], 'an older response with a newer notification revision must still apply disabled keys');
  assert.strictEqual(notificationOnlyMerge.notifyTopics['host-t2'], 'new-topic', 'an older response with a newer notification revision must still apply per-entity topics');
  assert.strictEqual(notificationOnlyMerge.notifyRevision, 8, 'the newer notification revision must advance independently of status time');
  assert.deepStrictEqual(Array.from(notificationOnlyMerge.ntfyTopics), ['new-topic'], 'the delayed notification response must carry forward its current ntfy topic list');
  assert.ok(/selectPanel\(activePanel,\s*\{[^}]*live\s*:\s*!{0,2}opts\.live/.test(renderSource), 'render must pass live mode through to the active panel patch');
  const sidebarCardSource = extractFunction(html, 'updateSidebarCard');
  const sidebarSource = extractFunction(html, 'renderSidebar');
  assert.ok(sidebarCardSource.split('morphElementHtml(').length - 1 >= 3 && !sidebarCardSource.includes('.innerHTML ='), 'sidebar meta, badges and summaries must update without replacing their retained wrappers');
  assert.ok(sidebarSource.includes('morphElementHtml(sidebar,'), 'sidebar inventory changes must use keyed reconciliation instead of replacing every card');
  assert.ok(html.includes('<span class="gh-dot"></span><span class="gh-text"></span>'), 'global health must expose a stable text node beside its retained status dot');
  for (const source of [renderSource, extractFunction(html, 'applyShellSummary')]) {
    assert.ok(source.includes("gh.querySelector('.gh-text')") && source.includes('text.textContent = txt') && !source.includes('gh.innerHTML'), 'global health refreshes must update status text without replacing the dot');
    assert.ok(source.includes("getElementById('lupd')") && source.includes("getElementById('rail-upd')"), 'full and summary refreshes must keep both updated-at labels current');
  }
  const detailSystemSource = extractFunction(html, 'detailSystemUnits');
  assert.ok(detailSystemSource.includes('`${key}:header`') && detailSystemSource.includes('`${key}:body`'), 'detail system header and body identities must carry distinct role suffixes');
  const annotateMorphSource = extractFunction(html, 'annotateMorphTree');
  const nodeHeaderHeuristicStart = annotateMorphSource.indexOf("root.querySelectorAll('.node-hdr')");
  const nodeHeaderHeuristicEnd = annotateMorphSource.indexOf("root.querySelectorAll('.prom-instance')", nodeHeaderHeuristicStart);
  const nodeHeaderHeuristic = nodeHeaderHeuristicStart >= 0 && nodeHeaderHeuristicEnd > nodeHeaderHeuristicStart
    ? annotateMorphSource.slice(nodeHeaderHeuristicStart, nodeHeaderHeuristicEnd)
    : '';
  assert.ok(nodeHeaderHeuristic.includes("entity.hasAttribute('data-detail-system-key')"), 'detail system headers must opt out of heuristic morph keys so their role-suffixed identities remain authoritative');
  assert.ok((annotateMorphSource.match(/entity\.hasAttribute\('data-detail-system-key'\)/g) || []).length >= 2, 'both notify-derived and generic node-header heuristics must preserve detail system identities');
  assert.match(annotateMorphSource, /root\.querySelectorAll\('[^']*\.chart-row[^']*'\)/, 'chart rows must participate in heuristic morph-key annotation');
  assert.ok(annotateMorphSource.includes('const stablePart = ownAction || nestedAction || label;'), 'row morph identities must prefer structural actions over mutable display labels');
  assert.ok(annotateMorphSource.includes("const stablePart = (notifyKey.includes(':') ? notifyKey.slice(notifyKey.indexOf(':') + 1) : notifyKey) || label;"), 'notify-backed entity identities must prefer the stable notification key over their display label');
  assert.ok(annotateMorphSource.split('morphSourceText(').length - 1 >= 3, 'entity and row annotation labels must consistently use their untranslated source text');
  const annotationContext = {
    Node: { TEXT_NODE:3, ELEMENT_NODE:1 },
    detailSystemUnits: () => {},
  };
  vm.createContext(annotationContext);
  vm.runInContext([
    extractFunction(html, 'morphNodeIdentity'),
    extractFunction(html, 'morphSourceText'),
    annotateMorphSource,
  ].join('\n'), annotationContext);
  const annotationRow = (visibleText, sourceText) => {
    const textNode = { nodeType:3, nodeValue:visibleText };
    if(sourceText !== undefined) textNode._osOrigText = sourceText;
    const label = { nodeType:1, childNodes:[textNode] };
    const attrs = new Map();
    return {
      nodeType:1,
      tagName:'DIV',
      id:'',
      hasAttribute: name => attrs.has(name),
      getAttribute: name => attrs.get(name) || '',
      setAttribute: (name, value) => attrs.set(name, String(value)),
      querySelector: selector => selector === '[onclick]:not(.nbell)' ? null : label,
    };
  };
  const annotationRoot = row => ({
    querySelectorAll: selector => selector.includes('.chart-row') ? [row] : [],
  });
  const translatedTemperatureRow = annotationRow('Sıcaklık', 'Temperature');
  const desiredEnglishTemperatureRow = annotationRow('Temperature');
  annotationContext.annotateMorphTree(annotationRoot(translatedTemperatureRow), 'snmp');
  annotationContext.annotateMorphTree(annotationRoot(desiredEnglishTemperatureRow), 'snmp');
  assert.strictEqual(translatedTemperatureRow.getAttribute('data-morph-key'), 'row:Temperature', 'a translated row key must be derived from its original source label');
  assert.strictEqual(translatedTemperatureRow.getAttribute('data-morph-key'), desiredEnglishTemperatureRow.getAttribute('data-morph-key'), 'translated current and English desired labels must receive the same annotated row key');
  assert.strictEqual(annotationContext.morphNodeIdentity(translatedTemperatureRow), annotationContext.morphNodeIdentity(desiredEnglishTemperatureRow), 'translated current and English desired rows must reconcile as the same DOM identity');
  const deferPointerSource = extractFunction(html, 'deferDetailRenderForPointer');
  const resumePointerSource = extractFunction(html, 'resumeDeferredDetailRender');
  const overviewDragSource = extractFunction(html, 'initOverviewDrag');
  assert.ok(overviewCardSource.includes("deferDetailRenderForPointer(detail, '')") && deferPointerSource.includes("querySelector?.(':scope > .overview')"), 'dashboard live morphs must defer while a native pointer interaction is active');
  assert.ok(/window\._overviewDragging\)\s*\{\s*detailRenderDeferred\s*=\s*true;\s*return;\s*\}/.test(overviewCardSource), 'dashboard live morphs must mark themselves deferred instead of mutating a card during drag');
  assert.ok(overviewDragSource.includes('window._overviewDragging = false') && overviewDragSource.includes('if(detailRenderDeferred) resumeDeferredDetailRender()'), 'ending an overview drag must resume the deferred live morph');
  assert.ok(resumePointerSource.includes('dashboardOpen || activePanel') && /render\(window\._lastData,\s*\{\s*live\s*:\s*true,\s*interactionResume\s*:\s*true\s*\}\)/.test(resumePointerSource), 'a deferred dashboard or detail morph must resume through the live path after pointer release');

  const fixture = createMorphFixture();
  const morphContext = {
    Node: { TEXT_NODE:3, ELEMENT_NODE:1 },
    Element: fixture.FakeElement,
    HTMLElement: fixture.FakeElement,
    HTMLInputElement: fixture.FakeInputElement,
    HTMLTextAreaElement: fixture.FakeTextAreaElement,
    HTMLSelectElement: fixture.FakeSelectElement,
    OmniI18n: { ATTRS:['title','aria-label'] },
    document: { activeElement:null },
  };
  vm.createContext(morphContext);
  vm.runInContext([
    'focusedDetailControl',
    'morphNodeIdentity',
    'sameMorphNode',
    'syncAttrs',
    'morphOverviewGrid',
    'morphNode',
    'morphChildren',
  ].map(name => extractFunction(html, name)).join('\n'), morphContext);

  const detailHeader = fixture.element('div', { 'data-detail-system-key':'system-a:header' });
  const detailBody = fixture.element('div', { 'data-detail-system-key':'system-a:body' });
  assert.notStrictEqual(morphContext.morphNodeIdentity(detailHeader), morphContext.morphNodeIdentity(detailBody), 'detail header and body roles must never collide in the keyed map');

  const uiStateOld = fixture.element('section', { class:'overview-kpi open sel-open online' });
  const uiStateNext = fixture.element('section', { class:'overview-kpi offline' });
  morphContext.syncAttrs(uiStateOld, uiStateNext);
  assert.ok(uiStateOld.classList.contains('open') && uiStateOld.classList.contains('sel-open'), 'live attribute sync must retain client-owned open menu state');
  assert.ok(uiStateOld.classList.contains('offline') && !uiStateOld.classList.contains('online'), 'live attribute sync must still replace server-owned status classes');

  const localizedText = fixture.text('Eski çeviri');
  localizedText._osOrigText = 'Old source';
  const desiredLocalizedText = fixture.text('Yeni çeviri');
  desiredLocalizedText._osOrigText = 'New source';
  morphContext.morphNode(localizedText, desiredLocalizedText);
  assert.strictEqual(localizedText.nodeValue, 'Yeni çeviri', 'a live text morph must apply the desired localized value');
  assert.strictEqual(localizedText._osOrigText, 'New source', 'a live text morph must refresh the i18n source cache instead of retaining stale source text');

  const localizedAttrs = fixture.element('button', { title:'Eski başlık', 'aria-label':'Eski etiket' });
  localizedAttrs._osOrig_title = 'Old title source';
  localizedAttrs['_osOrig_aria-label'] = 'Old label source';
  const desiredLocalizedAttrs = fixture.element('button', { title:'New title source', 'aria-label':'New label source' });
  morphContext.syncAttrs(localizedAttrs, desiredLocalizedAttrs);
  assert.strictEqual(localizedAttrs._osOrig_title, 'New title source', 'attribute morphing must refresh the cached title source');
  assert.strictEqual(localizedAttrs['_osOrig_aria-label'], 'New label source', 'attribute morphing must refresh the cached aria-label source');
  const removedLocalizedAttr = fixture.element('span', { title:'Retired source' });
  removedLocalizedAttr._osOrig_title = 'Retired source';
  morphContext.syncAttrs(removedLocalizedAttr, fixture.element('span'));
  assert.strictEqual(removedLocalizedAttr.hasAttribute('title'), false, 'an attribute removed by the desired tree must be removed from the live node');
  assert.strictEqual(removedLocalizedAttr._osOrig_title, undefined, 'removing an attribute must also clear its stale i18n source cache');

  const busyButton = fixture.element('button', { 'data-morph-key':'action:restart' }, [fixture.text('…')]);
  busyButton.disabled = true;
  const idleButton = fixture.element('button', { 'data-morph-key':'action:restart' }, [fixture.text('Restart')]);
  idleButton.disabled = false;
  morphContext.morphNode(busyButton, idleButton);
  assert.strictEqual(busyButton.disabled, true, 'an in-flight action button must remain disabled during a live morph');
  assert.strictEqual(busyButton.textContent, '…', 'an in-flight action label must not be reset by a live morph');

  const keyed = (tag, key, children = [], attrs = {}) => fixture.element(tag, { ...attrs, 'data-morph-key':key }, children);
  const focusedBell = keyed('button', 'control:focused-bell', [fixture.text('Notifications on')]);
  const siblingMetric = keyed('span', 'metric:focused-row-cpu', [fixture.text('10%')]);
  const focusedRow = keyed('div', 'row:focused-bell', [focusedBell, siblingMetric]);
  const desiredFocusedRow = keyed('div', 'row:focused-bell', [
    keyed('button', 'control:focused-bell', [fixture.text('Notifications off')]),
    keyed('span', 'metric:focused-row-cpu', [fixture.text('64%')]),
  ]);
  morphContext.document.activeElement = focusedBell;
  morphContext.morphNode(focusedRow, desiredFocusedRow);
  assert.strictEqual(focusedRow.childNodes[0], focusedBell, 'a focused button must retain its DOM identity during a row morph');
  assert.strictEqual(focusedRow.childNodes[1], siblingMetric, 'a metric beside a focused button must still retain its DOM identity');
  assert.strictEqual(siblingMetric.textContent, '64%', 'a focused button must not prevent its sibling metric from receiving a live update');

  const oldCpuA = keyed('span', 'metric:cpu', [fixture.text('12%')]);
  const oldActionA = keyed('button', 'control:notify', [fixture.text('Notifications')]);
  const oldInputA = keyed('input', 'control:topic', [], { value:'confirmed' });
  oldInputA.value = 'locally edited';
  const oldHostA = keyed('section', 'host:a', [oldCpuA, oldActionA, oldInputA], { class:'entity open online' });
  const oldCpuB = keyed('span', 'metric:cpu', [fixture.text('28%')]);
  const oldHostB = keyed('section', 'host:b', [oldCpuB], { class:'entity open online' });
  const liveRoot = fixture.element('main', {}, [oldHostA, oldHostB]);

  const nextHostB = keyed('section', 'host:b', [keyed('span', 'metric:cpu', [fixture.text('31%')])], { class:'entity open online' });
  const nextInputA = keyed('input', 'control:topic', [], { value:'server refresh' });
  nextInputA.value = 'server refresh';
  const nextHostA = keyed('section', 'host:a', [
    keyed('span', 'metric:cpu', [fixture.text('42%')]),
    keyed('button', 'control:notify', [fixture.text('Notifications off')]),
    nextInputA,
  ], { class:'entity open offline' });
  const nextRoot = fixture.element('main', {}, [nextHostB, nextHostA]);

  morphContext.document.activeElement = oldInputA;
  assert.strictEqual(morphContext.morphNodeIdentity(oldHostA), morphContext.morphNodeIdentity(nextHostA), 'the same entity key must produce the same morph identity');
  assert.notStrictEqual(morphContext.morphNodeIdentity(oldHostA), morphContext.morphNodeIdentity(nextHostB), 'different entity keys must not collide');
  morphContext.morphChildren(liveRoot, nextRoot);
  assert.strictEqual(liveRoot.childNodes[0], oldHostB, 'a reordered keyed entity must be moved instead of recreated');
  assert.strictEqual(liveRoot.childNodes[1], oldHostA, 'all surviving keyed entities must retain node identity after reorder');
  assert.strictEqual(oldHostA.childNodes[0], oldCpuA, 'metric leaves must retain node identity during live updates');
  assert.strictEqual(oldHostA.childNodes[1], oldActionA, 'controls must retain node identity during live updates');
  assert.strictEqual(oldHostA.childNodes[2], oldInputA, 'focused form controls must retain node identity during live updates');
  assert.strictEqual(oldCpuA.textContent, '42%', 'live metrics must still update in place');
  assert.strictEqual(oldActionA.textContent, 'Notifications off', 'status controls must reconcile their visible state in place');
  assert.match(oldHostA.className, /\bopen\b/, 'open entity state must survive a live status transition');
  assert.match(oldHostA.className, /\boffline\b/, 'status classes must update on the retained entity');
  assert.strictEqual(oldInputA.value, 'locally edited', 'an in-flight refresh must not overwrite the focused control value');
  assert.strictEqual(morphContext.document.activeElement, oldInputA, 'live updates must preserve focus');

  const nextHostC = keyed('section', 'host:c', [keyed('span', 'metric:cpu', [fixture.text('7%')])], { class:'entity online' });
  const structuralRoot = fixture.element('main', {}, [nextHostA.cloneNode(true), nextHostC]);
  morphContext.morphChildren(liveRoot, structuralRoot);
  assert.strictEqual(liveRoot.childNodes[0], oldHostA, 'a surviving keyed entity must be reused across add/remove reconciliation');
  assert.strictEqual(oldHostB.parentNode, null, 'a removed inventory entity must be detached');
  assert.strictEqual(morphContext.morphNodeIdentity(liveRoot.childNodes[1]), morphContext.morphNodeIdentity(nextHostC), 'a newly added inventory entity must be inserted with its own key');
  assert.strictEqual(morphContext.document.activeElement, oldInputA, 'keyed inventory reconciliation must preserve focus inside surviving entities');

  const overviewCard = (id, metric) => keyed('section', `overview-card:${id}`, [keyed('span', `overview-metric:${id}`, [fixture.text(metric)])], { class:'overview-card' });
  const oldOverviewA = overviewCard('a', '12%');
  const oldOverviewC = overviewCard('c', '32%');
  const liveOverviewGrid = fixture.element('div', { class:'overview-grid' }, [oldOverviewA, oldOverviewC]);
  const desiredOverviewGrid = fixture.element('div', { class:'overview-grid' }, [
    overviewCard('a', '14%'),
    overviewCard('b', '24%'),
    overviewCard('c', '34%'),
  ]);
  morphContext.morphOverviewGrid(liveOverviewGrid, desiredOverviewGrid);
  assert.deepStrictEqual(liveOverviewGrid.childNodes.map(node => node.getAttribute('data-morph-key')), ['overview-card:a','overview-card:b','overview-card:c'], 'flat overview insertion must place a new middle card in desired order');
  assert.strictEqual(liveOverviewGrid.childNodes[0], oldOverviewA, 'inserting a dashboard card must preserve the preceding card identity');
  assert.strictEqual(liveOverviewGrid.childNodes[2], oldOverviewC, 'inserting a dashboard card must preserve the following card identity');
  const desiredReorderedOverviewGrid = fixture.element('div', { class:'overview-grid' }, [
    overviewCard('c', '36%'),
    overviewCard('a', '16%'),
  ]);
  morphContext.morphOverviewGrid(liveOverviewGrid, desiredReorderedOverviewGrid);
  assert.deepStrictEqual(liveOverviewGrid.childNodes.map(node => node.getAttribute('data-morph-key')), ['overview-card:c','overview-card:a'], 'flat overview removal and reorder must exactly follow desired card order');
  assert.strictEqual(liveOverviewGrid.childNodes[0], oldOverviewC, 'dashboard reorder must move rather than recreate card C');
  assert.strictEqual(liveOverviewGrid.childNodes[1], oldOverviewA, 'dashboard reorder must move rather than recreate card A');

  const inventoryDeclarationStart = html.indexOf('const LIVE_INVENTORY_ARRAY_KEYS');
  const inventoryMergeStart = html.indexOf('function mergeLiveInventory', inventoryDeclarationStart);
  assert.ok(inventoryDeclarationStart >= 0 && inventoryMergeStart > inventoryDeclarationStart, 'live inventory declarations must remain extractable');
  const inventoryContext = {};
  vm.createContext(inventoryContext);
  vm.runInContext([
    html.slice(inventoryDeclarationStart, inventoryMergeStart),
    extractFunction(html, 'historyItemKey'),
    extractFunction(html, 'mergeLiveInventory'),
  ].join('\n'), inventoryContext);
  const completeInventory = {
    instances:[{
      id:'storage-a',
      devicesComplete:true,
      devices:[
        { id:'disk-a', status:'online', temperature:31 },
        { id:'disk-b', status:'online', temperature:34 },
      ],
    }],
  };
  const partialInventory = {
    instances:[{
      id:'storage-a',
      devicesComplete:false,
      devices:[{ id:'disk-a', status:'online', temperature:32 }],
    }],
  };
  const retainedInventory = inventoryContext.mergeLiveInventory(completeInventory, partialInventory);
  assert.deepStrictEqual(Array.from(retainedInventory.instances[0].devices, device => device.id), ['disk-a','disk-b'], 'an incomplete device subset must retain the last-known missing device');
  assert.strictEqual(retainedInventory.instances[0].devices[0].temperature, 32, 'an incomplete subset must still apply fresh metrics for reported devices');
  const authoritativeInventory = inventoryContext.mergeLiveInventory(retainedInventory, {
    instances:[{
      id:'storage-a',
      devicesComplete:true,
      devices:[{ id:'disk-a', status:'online', temperature:33 }],
    }],
  });
  assert.deepStrictEqual(Array.from(authoritativeInventory.instances[0].devices, device => device.id), ['disk-a'], 'a complete authoritative inventory must remove a genuinely missing device');
  assert.strictEqual(authoritativeInventory.instances[0].devices[0].temperature, 33, 'the authoritative inventory must keep its newest device metrics');

  const branchCompleteInventory = {
    instances:[
      {
        id:'branch-a',
        devices:[
          { id:'a-disk-1', temperature:40 },
          { id:'a-disk-2', temperature:41 },
        ],
      },
      {
        id:'branch-b',
        devices:[
          { id:'b-disk-1', temperature:42 },
          { id:'b-disk-2', temperature:43 },
        ],
      },
    ],
  };
  const branchScopedMerge = inventoryContext.mergeLiveInventory(branchCompleteInventory, {
    instances:[
      {
        id:'branch-a',
        error:'collector timeout',
        devicesComplete:true,
        devices:[{ id:'a-disk-1', temperature:44 }],
      },
      {
        id:'branch-b',
        complete:true,
        devicesComplete:true,
        devices:[{ id:'b-disk-1', temperature:45 }],
      },
    ],
  });
  assert.deepStrictEqual(Array.from(branchScopedMerge.instances[0].devices, device => device.id), ['a-disk-1','a-disk-2'], 'an errored branch must retain its last-known missing nested inventory');
  assert.deepStrictEqual(Array.from(branchScopedMerge.instances[1].devices, device => device.id), ['b-disk-1'], 'an errored sibling must not prevent a complete branch from pruning removed nested inventory');
  const globallyRefreshingBranches = inventoryContext.mergeLiveInventory(branchCompleteInventory, {
    refreshing:true,
    instances:[
      { id:'branch-a', devicesComplete:true, devices:[{ id:'a-disk-1', temperature:46 }] },
      { id:'branch-b', devicesComplete:true, devices:[{ id:'b-disk-1', temperature:47 }] },
    ],
  });
  assert.deepStrictEqual(Array.from(globallyRefreshingBranches.instances[0].devices, device => device.id), ['a-disk-1','a-disk-2'], 'top-level refreshing must retain missing nested inventory in branch A');
  assert.deepStrictEqual(Array.from(globallyRefreshingBranches.instances[1].devices, device => device.id), ['b-disk-1','b-disk-2'], 'top-level refreshing must retain missing nested inventory in branch B');

  const partialOperationalLists = inventoryContext.mergeLiveInventory({
    pools:[{ id:'pool-a' },{ id:'pool-b' }],
    alerts:[{ id:'alert-a' },{ id:'alert-b' }],
    tasks:[{ id:'task-a' },{ id:'task-b' }],
  }, {
    partial:true,
    pools:[{ id:'pool-a' }],
    alerts:[{ id:'alert-a' }],
    tasks:[{ id:'task-a' }],
  });
  for (const [key, expected] of [['pools',['pool-a','pool-b']],['alerts',['alert-a','alert-b']],['tasks',['task-a','task-b']]]) {
    assert.deepStrictEqual(Array.from(partialOperationalLists[key], item => item.id), expected, `a partial ${key} snapshot must retain last-known missing items`);
  }

  const previousKubernetesInventory = {
    kubernetes:{
      pods:[{ name:'api', namespace:'production', kind:'Pod' }],
      services:[{ name:'api', namespace:'production', kind:'Service' }],
      deployments:[{ name:'api', namespace:'production', kind:'Deployment' }],
    },
  };
  const authoritativeEmptyKubernetes = inventoryContext.mergeLiveInventory(previousKubernetesInventory, {
    kubernetes:{ _empty:true, error:'No Kubernetes resources', pods:[], services:[], deployments:[] },
  });
  assert.deepStrictEqual(Array.from(authoritativeEmptyKubernetes.kubernetes.pods), [], 'an explicit empty Kubernetes snapshot without resourceError must prune stale pods');
  assert.deepStrictEqual(Array.from(authoritativeEmptyKubernetes.kubernetes.services), [], 'an explicit empty Kubernetes snapshot without resourceError must prune stale services');
  assert.deepStrictEqual(Array.from(authoritativeEmptyKubernetes.kubernetes.deployments), [], 'an explicit empty Kubernetes snapshot without resourceError must prune stale deployments');
  const failedEmptyKubernetes = inventoryContext.mergeLiveInventory(previousKubernetesInventory, {
    kubernetes:{ _empty:true, resourceError:'Kubernetes request failed', pods:[], services:[], deployments:[] },
  });
  assert.strictEqual(failedEmptyKubernetes.kubernetes.pods.length, 1, 'resourceError must keep an otherwise empty Kubernetes snapshot non-authoritative');

  const previousCloudflareInventory = {
    cloudflare:{
      online:true,
      zones:[{ id:'zone-a' }],
      tunnels:[{ id:'tunnel-a' }],
      domains:[{ id:'domain-a' }],
    },
  };
  const authoritativeOfflineCloudflare = inventoryContext.mergeLiveInventory(previousCloudflareInventory, {
    cloudflare:{
      _empty:true,
      online:false,
      partial:false,
      errors:[],
      error:'No Cloudflare resources',
      zones:[],
      tunnels:[],
      domains:[],
    },
  });
  assert.deepStrictEqual(Array.from(authoritativeOfflineCloudflare.cloudflare.zones), [], 'a clean offline Cloudflare snapshot must prune stale zones');
  assert.deepStrictEqual(Array.from(authoritativeOfflineCloudflare.cloudflare.tunnels), [], 'a clean offline Cloudflare snapshot must prune stale tunnels');
  assert.deepStrictEqual(Array.from(authoritativeOfflineCloudflare.cloudflare.domains), [], 'a clean offline Cloudflare snapshot must prune stale domains');
  const cloudflareCollectorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cloudflare.js'), 'utf8');
  assert.ok(cloudflareCollectorSource.includes('_empty: !online && errors.length === 0'), 'the Cloudflare collector must explicitly mark successful zero-resource snapshots as authoritative empty');

  const failedCiCdInventory = inventoryContext.mergeLiveInventory({
    cicd:{
      projects:[{
        name:'api-project',
        online:true,
        pipelines:[{ id:'pipeline-a', status:'success' }],
        jobs:[{ id:'job-a', status:'success' }],
      }],
    },
  }, {
    cicd:{
      online:false,
      projects:[{
        name:'api-project',
        online:false,
        partial:false,
        errors:[],
        error:'CI/CD endpoint unavailable',
        pipelines:[],
        jobs:[],
      }],
    },
  });
  assert.deepStrictEqual(Array.from(failedCiCdInventory.cicd.projects[0].pipelines, item => item.id), ['pipeline-a'], 'an offline CI/CD error without explicit _empty must retain last-known pipelines');
  assert.deepStrictEqual(Array.from(failedCiCdInventory.cicd.projects[0].jobs, item => item.id), ['job-a'], 'an offline CI/CD error without explicit _empty must retain last-known jobs');

  const topLevelCompleteInventory = {
    refreshing:false,
    instances:[
      {
        id:'storage-a',
        devices:[
          { id:'disk-a', status:'online', temperature:35 },
          { id:'disk-b', status:'online', temperature:36 },
        ],
      },
      {
        id:'storage-b',
        devices:[{ id:'disk-c', status:'online', temperature:37 }],
      },
    ],
  };
  const refreshingSubsetInventory = inventoryContext.mergeLiveInventory(topLevelCompleteInventory, {
    refreshing:true,
    instances:[{
      id:'storage-a',
      devices:[{ id:'disk-a', status:'online', temperature:38 }],
    }],
  });
  assert.deepStrictEqual(Array.from(refreshingSubsetInventory.instances, instance => instance.id), ['storage-a','storage-b'], 'a top-level refreshing subset must retain missing instances even without child completeness flags');
  assert.deepStrictEqual(Array.from(refreshingSubsetInventory.instances[0].devices, device => device.id), ['disk-a','disk-b'], 'top-level refreshing state must propagate to nested device subsets');
  assert.strictEqual(refreshingSubsetInventory.instances[0].devices[0].temperature, 38, 'a refreshing subset must still merge fresh nested metrics');
  const finalSubsetInventory = inventoryContext.mergeLiveInventory(refreshingSubsetInventory, {
    refreshing:false,
    instances:[{
      id:'storage-a',
      devices:[{ id:'disk-a', status:'online', temperature:39 }],
    }],
  });
  assert.deepStrictEqual(Array.from(finalSubsetInventory.instances, instance => instance.id), ['storage-a'], 'a final non-refreshing snapshot must authoritatively remove missing instances');
  assert.deepStrictEqual(Array.from(finalSubsetInventory.instances[0].devices, device => device.id), ['disk-a'], 'a final non-refreshing snapshot must authoritatively remove missing nested devices');
  assert.strictEqual(finalSubsetInventory.instances[0].devices[0].temperature, 39, 'the final authoritative snapshot must keep its newest nested metrics');

  const productionPodKey = inventoryContext.historyItemKey({ name:'api', namespace:'production', kind:'Pod' });
  const stagingPodKey = inventoryContext.historyItemKey({ name:'api', namespace:'staging', kind:'Pod' });
  assert.notStrictEqual(productionPodKey, stagingPodKey, 'Kubernetes resources with the same name in different namespaces must not share a history or inventory key');
  assert.strictEqual(productionPodKey, inventoryContext.historyItemKey({ name:'api', namespace:'production', kind:'Pod' }), 'the namespace-scoped Kubernetes history key must remain stable for the same resource');

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
  const prefetchEnd = html.indexOf('function toggleMenu()', prefetchStart);
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

  console.log('smoke ok — client helpers: formatting, localization, keyed live refresh, shell status, notification guards, scroll preservation');
}

module.exports = { run };
if (require.main === module) {
  try { run(); } catch (err) { console.error(err); process.exit(1); }
}
