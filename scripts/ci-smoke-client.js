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

const BLOCKS = ['fmtChartValue'];

function extract(source, name) {
  const begin = `/* ci-extract:begin ${name} */`;
  const end = `/* ci-extract:end ${name} */`;
  const from = source.indexOf(begin);
  const to = source.indexOf(end);
  assert.ok(from !== -1, `missing ci-extract:begin marker for "${name}" in public/index.html`);
  assert.ok(to > from, `missing or misordered ci-extract:end marker for "${name}" in public/index.html`);
  return source.slice(from + begin.length, to);
}

function run() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(BLOCKS.map(name => extract(html, name)).join('\n'), ctx);
  const { fmtChartValue } = ctx;

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

  console.log('smoke ok — client helpers: fmtChartValue');
}

module.exports = { run };
if (require.main === module) {
  try { run(); } catch (err) { console.error(err); process.exit(1); }
}
