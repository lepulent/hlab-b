#!/usr/bin/env node
// The mechanical rubric (docs/04): pass or fail per row, never argued, graded by this script after a plan
// has run. Rows are a registry like the canon checks: implemented or pending, and pending is never green.
// Inputs: canon-check --json, the plan's ledger, .harness records, git. Output: JSON to stdout and to
// ../runs/<app>/<plan>/rubric.json when the lab's runs folder exists.
// Usage: node rubric.mjs --plan <slug> [--json]
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, readJson, writeJson, git } from './common.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PLAN = arg('plan');
if (!PLAN) {
  console.error('rubric: --plan required');
  process.exit(2);
}
const harness = readJson(join(ROOT, 'harness.json'), {});
const APP = harness.app?.name || 'app';
const H = join(ROOT, '.harness');
const ledgerFile = join(ROOT, 'ledger', `${PLAN}.jsonl`);
const L = existsSync(ledgerFile)
  ? readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const of = (kind) => L.filter((l) => l.kind === kind);
const stats = existsSync(join(H, 'stats.jsonl'))
  ? readFileSync(join(H, 'stats.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];

let canon = null;
try {
  canon = JSON.parse(
    execFileSync('node', [join(ROOT, 'scripts', 'harness', 'canon-check.mjs'), '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
  );
} catch (e) {
  try {
    canon = JSON.parse(String(e.stdout));
  } catch {
    canon = null;
  }
}
const canonRow = (id) => canon?.results?.find((r) => r.id === id);
const fromCanon = (id) => {
  const r = canonRow(id);
  return r
    ? { ok: r.result === 'pass', msg: r.msg, unmeasured: r.result === 'unmeasured' }
    : { ok: false, msg: 'canon check did not run', unmeasured: true };
};

const REGISTRY = [
  ['pointers-resolve', 'implemented', () => fromCanon('pointers-resolve')],
  ['generated-empty-diff', 'implemented', () => fromCanon('regenerate-empty-diff')],
  ['criteria-bound-passed', 'implemented', () => fromCanon('criteria-bound-passed')],
  ['layer-direction', 'implemented', () => fromCanon('layer-direction')],
  ['tags-present', 'implemented', () => fromCanon('tags-present')],
  ['harness-in-sync', 'implemented', () => fromCanon('harness-in-sync')],
  [
    'decisions-attributed',
    'implemented',
    () => {
      const bad = of('decision').filter((d) => !d.actor || !d.data);
      return {
        ok: !bad.length,
        msg: `${of('decision').length} decision(s), ${bad.length} without actor or data`,
      };
    },
  ],
  [
    'seats-terminated',
    'implemented',
    () => {
      const starts = of('seat-start').length;
      const ends = of('seat-end').length;
      return {
        ok: ends >= starts,
        msg: `${starts} seat start(s), ${ends} seat end(s)`,
      };
    },
  ],
  [
    'stats-complete',
    'implemented',
    () => {
      const ends = of('seat-end').filter((e) => e.data?.seat || e.data?.station);
      const missing = ends.filter(
        (e) =>
          !stats.some(
            (s) =>
              s.station &&
              (s.round === e.data.round || s.station === e.data.station) &&
              s.minutes !== undefined &&
              s.cost_usd !== undefined,
          ),
      );
      return {
        ok: !missing.length,
        msg: `${ends.length} seat end(s), ${missing.length} without a stats row (minutes, cost)`,
      };
    },
  ],
  [
    'assurance-never-decreased',
    'implemented',
    () => {
      const RANK = { draft: 0, prototype: 1, mvp: 2, production: 3 };
      const seen = {};
      const drops = [];
      for (const a of of('assurance')) {
        const n = a.data?.node;
        const v = RANK[a.data?.assurance] ?? 0;
        if (seen[n] !== undefined && v < seen[n]) drops.push(n);
        seen[n] = v;
      }
      return {
        ok: !drops.length,
        msg: drops.length
          ? `decreased: ${drops.join(', ')}`
          : `${Object.keys(seen).length} node(s) never decreased`,
      };
    },
  ],
  [
    'spike-never-merged',
    'implemented',
    () => {
      const merges = of('merge').filter(
        (m) => /^spike\//.test(String(m.data?.branch || '')) || String(m.data?.kind) === 'spike',
      );
      const sealOnSpike =
        existsSync(join(ROOT, 'records', PLAN, 'SEAL.md')) &&
        git(['branch', '--list', `spike/${PLAN}`]) !== '';
      return {
        ok: !merges.length && !sealOnSpike,
        msg: merges.length ? 'a spike merged' : 'no spike merged',
      };
    },
  ],
  [
    'merges-by-script-with-seal-and-statuses',
    'implemented',
    () => {
      const merges = of('merge');
      const bad = merges.filter((m) => m.actor !== 'script:merge' || !m.data?.rigor);
      return {
        ok: !bad.length,
        msg: `${merges.length} merge(s), ${bad.length} not by the merge script or without a sealed rigor`,
      };
    },
  ],
  [
    'deploys-verified',
    'implemented',
    () => {
      const deploys = of('deploy').filter(
        (d) => d.data?.action === 'deploy' && d.data?.status === 'SUCCEEDED',
      );
      const qa = of('finding').filter((f) => f.data?.station === 'qa');
      const unverified = deploys.filter(
        (d) => !qa.some((q) => q.data.stage === d.data.stage && q.ts > d.ts),
      );
      return {
        ok: !unverified.length,
        msg: `${deploys.length} deploy(s), ${unverified.length} without a qa finding after it`,
      };
    },
  ],
  [
    'no-station-waited-on-human',
    'implemented',
    () => {
      const waits = of('question').filter((q) => q.data?.stop);
      const floor = waits.filter((q) => /floor trigger/.test(String(q.data.stop?.reason)));
      return {
        ok: waits.length === floor.length,
        msg: `${waits.length} stop(s), ${floor.length} on a floor trigger (allowed), ${waits.length - floor.length} otherwise (finding)`,
      };
    },
  ],
  [
    'breaker-never-tripped-twice',
    'implemented',
    () => {
      const estops = of('estop');
      return {
        ok: !estops.length,
        msg: estops.length
          ? `${estops.length} estop line(s): ${estops.map((e) => e.data?.reason).join('; ')}`
          : 'no estop',
      };
    },
  ],
  [
    'budgets-respected',
    'implemented',
    () => {
      const perSeat = harness.budgets?.usd_per_seat || 3;
      const over = stats.filter((s) => s.station && (s.cost_usd || 0) > perSeat);
      const round = stats.filter((s) => s.station).reduce((a, s) => a + (s.cost_usd || 0), 0);
      return {
        ok: !over.length,
        msg: `${over.length} seat(s) over $${perSeat}; plan total $${round.toFixed(2)}`,
      };
    },
  ],
  [
    'departments-have-signal',
    'pending',
    () => ({ ok: false, msg: 'department trigger not built' }),
  ],
  [
    'determinism-scan-run',
    'pending',
    () => ({ ok: false, msg: 'needs stream-json transcripts of the seats' }),
  ],
  [
    'manifest-matches-live',
    'implemented',
    () => {
      const m = readJson(join(ROOT, 'canon', 'generated', 'infra-manifest.json'), {
        resources: [],
      });
      const bad = (m.resources || []).filter((r) =>
        ['mismatch', 'missing'].includes(r.verification_status),
      );
      return {
        ok: !bad.length,
        msg: bad.length
          ? `${bad.map((r) => r.name + ':' + r.verification_status).join(', ')}`
          : `${(m.resources || []).length} declared resource(s) verified or declared`,
      };
    },
  ],
];

const results = REGISTRY.map(([id, status, fn]) => {
  if (status === 'pending') return { id, result: 'pending', msg: fn().msg };
  try {
    const r = fn();
    return { id, result: r.unmeasured ? 'unmeasured' : r.ok ? 'pass' : 'fail', msg: r.msg };
  } catch (e) {
    return { id, result: 'unmeasured', msg: String(e.message) };
  }
});
const summary = {
  app: APP,
  plan: PLAN,
  commit: git(['rev-parse', 'HEAD']),
  gradedAt: new Date().toISOString(),
  passed: results.filter((r) => r.result === 'pass').length,
  failed: results.filter((r) => r.result === 'fail').length,
  pending: results.filter((r) => r.result === 'pending').length,
  unmeasured: results.filter((r) => r.result === 'unmeasured').length,
  ledgerLines: L.length,
};
const out = { summary, results };
const runsDir = join(ROOT, '..', 'runs', APP, PLAN);
if (existsSync(join(ROOT, '..', 'runs'))) {
  mkdirSync(runsDir, { recursive: true });
  writeJson(join(runsDir, 'rubric.json'), out);
}
if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  for (const r of results) console.log(`${r.result.padEnd(10)} ${r.id.padEnd(40)} ${r.msg}`);
  console.log(
    `\n${summary.passed} passed · ${summary.failed} failed · ${summary.pending} pending (never green) · ${summary.unmeasured} unmeasured · ${L.length} ledger lines`,
  );
}
process.exit(summary.failed ? 1 : 0);
