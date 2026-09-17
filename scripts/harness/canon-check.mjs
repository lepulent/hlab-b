#!/usr/bin/env node
// The canon checks, as a registry: a check is implemented or pending, and a pending check is never green.
// Exit 0 pass, 1 fail, 2 could-not-measure. JSON report to stdout (--json) or a table.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, readJson, walk, rel, layerOf, blobSha, sha, git } from './common.mjs';

const REGISTRY = [
  {
    id: 'regenerate-empty-diff',
    status: 'implemented',
    describes: 'canon-graph and pointer index regenerate to the committed bytes',
  },
  {
    id: 'pointers-resolve',
    status: 'implemented',
    describes:
      'every pointer names a file that exists, a symbol present in it, and a blob that matches when given',
  },
  {
    id: 'edges-resolve',
    status: 'implemented',
    describes: 'every canon edge targets a node id or a symbol node',
  },
  {
    id: 'layer-map-complete',
    status: 'implemented',
    describes: 'every source file under src, api, tests maps to a layer',
  },
  {
    id: 'layer-direction',
    status: 'pending',
    describes: 'imports follow the declared layer direction (needs the system graph IMPORTS edges)',
  },
  {
    id: 'criteria-bound',
    status: 'implemented',
    describes: 'every criterion CAP-n.k has at least one binding',
  },
  {
    id: 'criteria-bound-passed',
    status: 'pending',
    describes:
      'every binding passed in a test run at HEAD (needs the vitest and Playwright JSON reporters joined)',
  },
  {
    id: 'generated-not-hand-edited',
    status: 'implemented',
    describes:
      'canon/generated files match their generator output (same as regenerate-empty-diff, kept as its own row for the guard hook)',
  },
  {
    id: 'main-nodes-have-valid-from',
    status: 'pending',
    describes:
      'every canon node on main carries a valid_from that is an ancestor of HEAD (needs the return path)',
  },
  {
    id: 'spike-has-no-seal',
    status: 'implemented',
    describes: 'a branch named spike/* carries no intent/**/SEAL.md',
  },
  {
    id: 'tags-present',
    status: 'pending',
    describes:
      'every resource in the infra manifest carries the tag taxonomy (needs the manifest generator)',
  },
];

const results = [];
const fail = (id, msg, detail) => results.push({ id, result: 'fail', msg, detail });
const pass = (id, msg) => results.push({ id, result: 'pass', msg });

// regenerate-empty-diff + generated-not-hand-edited
try {
  const before = ['canon/generated/canon-graph.json', 'canon/index/pointers.json'].map((f) =>
    existsSync(join(ROOT, f))
      ? sha(readFileSync(join(ROOT, f), 'utf8').replace(/"generatedAt": "[^"]*"/, ''))
      : null,
  );
  execFileSync('node', [join(ROOT, 'scripts', 'harness', 'canon-graph.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const after = ['canon/generated/canon-graph.json', 'canon/index/pointers.json'].map((f) =>
    sha(readFileSync(join(ROOT, f), 'utf8').replace(/"generatedAt": "[^"]*"/, '')),
  );
  const same = before.every((b, i) => b === null || b === after[i]);
  (same ? pass : fail)(
    'regenerate-empty-diff',
    same
      ? 'generated files unchanged by regeneration'
      : 'generated files differ from the committed ones; commit the regenerated output',
  );
  (same ? pass : fail)(
    'generated-not-hand-edited',
    same ? 'no hand edits detected' : 'a generated file was edited by hand or is stale',
  );
} catch (e) {
  results.push({ id: 'regenerate-empty-diff', result: 'unmeasured', msg: String(e.message) });
}

// pointers-resolve
const idx = readJson(join(ROOT, 'canon', 'index', 'pointers.json'), { byFile: {} });
let bad = [];
for (const [file, ptrs] of Object.entries(idx.byFile)) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) {
    bad.push(`${file}: missing`);
    continue;
  }
  const text = readFileSync(abs, 'utf8');
  for (const p of ptrs) {
    if (!p.symbol.startsWith('L') && !text.includes(p.symbol))
      bad.push(`${file}#${p.symbol}: symbol not found`);
    if (p.blob && blobSha(file) !== p.blob)
      bad.push(`${file}#${p.symbol}: blob ${p.blob} != ${blobSha(file)}`);
  }
}
(bad.length ? fail : pass)(
  'pointers-resolve',
  bad.length ? `${bad.length} unresolved pointer(s)` : `${idx.count ?? 0} pointers resolve`,
  bad,
);

// edges-resolve
const g = readJson(join(ROOT, 'canon', 'generated', 'canon-graph.json'), { nodes: [], edges: [] });
const ids = new Set(g.nodes.map((n) => n.id));
const dangling = g.edges
  .filter((e) => !ids.has(e.target) || !ids.has(e.source))
  .map((e) => `${e.source} -${e.type}-> ${e.target}`);
(dangling.length ? fail : pass)(
  'edges-resolve',
  dangling.length ? `${dangling.length} dangling edge(s)` : `${g.edges.length} edges resolve`,
  dangling,
);

// layer-map-complete
const lm = readJson(join(ROOT, 'canon', 'layer-map.json'), { layers: {} });
const unmapped = [];
for (const dir of ['src', 'api', 'tests'])
  for (const p of walk(join(ROOT, dir))) {
    const r = rel(p);
    if (/\.(m?[jt]sx?)$/.test(r) && !layerOf(r, lm)) unmapped.push(r);
  }
(unmapped.length ? fail : pass)(
  'layer-map-complete',
  unmapped.length ? `${unmapped.length} unmapped file(s)` : 'every source file has a layer',
  unmapped,
);

// criteria-bound
const crits = g.nodes.filter((n) => n.kind === 'criterion');
const bound = new Set(g.edges.filter((e) => e.type === 'tests').map((e) => e.target));
const unbound = crits.filter((c) => !bound.has(c.id)).map((c) => c.id);
(unbound.length ? fail : pass)(
  'criteria-bound',
  unbound.length
    ? `${unbound.length} criteria without a binding`
    : `${crits.length} criteria bound`,
  unbound,
);

// spike-has-no-seal
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch.startsWith('spike/')) {
  const seals = walk(join(ROOT, 'intent')).filter((p) => p.endsWith('SEAL.md'));
  (seals.length ? fail : pass)(
    'spike-has-no-seal',
    seals.length ? 'a spike branch carries a seal' : 'spike carries no seal',
  );
} else pass('spike-has-no-seal', `not a spike branch (${branch})`);

for (const r of REGISTRY)
  if (r.status === 'pending') results.push({ id: r.id, result: 'pending', msg: r.describes });
const summary = {
  implemented: REGISTRY.filter((r) => r.status === 'implemented').length,
  pending: REGISTRY.filter((r) => r.status === 'pending').length,
  passed: results.filter((r) => r.result === 'pass').length,
  failed: results.filter((r) => r.result === 'fail').length,
  unmeasured: results.filter((r) => r.result === 'unmeasured').length,
};
if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, results }, null, 2));
else {
  for (const r of results)
    console.log(
      `${r.result.padEnd(10)} ${r.id.padEnd(28)} ${r.msg}${
        r.detail?.length
          ? '\n' +
            r.detail
              .slice(0, 10)
              .map((d) => '           · ' + d)
              .join('\n')
          : ''
      }`,
    );
  console.log(
    `\n${summary.passed} passed · ${summary.failed} failed · ${summary.pending} pending (never green) · ${summary.unmeasured} unmeasured`,
  );
}
process.exit(summary.failed ? 1 : summary.unmeasured ? 2 : 0);
