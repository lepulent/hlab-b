#!/usr/bin/env node
// The canon checks, as a registry: a check is implemented or pending, and a pending check is never green.
// Exit 0 pass, 1 fail, 2 could-not-measure. JSON report to stdout (--json) or a table.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ROOT,
  readJson,
  walk,
  rel,
  layerOf,
  blobSha,
  sha,
  git,
  NOT_PRODUCT,
  headSha,
  parseFrontmatter,
} from './common.mjs';

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
    status: 'implemented',
    describes:
      'every IMPORTS edge of the system graph crosses layers only along a declared direction pair (tests and harness may import anything)',
  },
  {
    id: 'criteria-bound',
    status: 'implemented',
    describes: 'every criterion CAP-n.k has at least one binding',
  },
  {
    id: 'criteria-bound-passed',
    status: 'implemented',
    describes:
      'every binding id appears in the title of at least one test that passed in .harness/test-results.json at HEAD (npm run test:report)',
  },
  {
    id: 'generated-not-hand-edited',
    status: 'implemented',
    describes:
      'canon/generated files match their generator output (same as regenerate-empty-diff, kept as its own row for the guard hook)',
  },
  {
    id: 'main-nodes-have-valid-from',
    status: 'implemented',
    describes:
      'every canon node in the main tree (kinds other than map and constitution) carries a valid_from that is an ancestor of main',
  },
  {
    id: 'spike-has-no-seal',
    status: 'implemented',
    describes: 'a branch named spike/* carries no intent/**/SEAL.md',
  },
  {
    id: 'harness-in-sync',
    status: 'implemented',
    describes:
      'the harness files installed in this app equal the bundle they claim (install-bundle.sh --check); the harness is edited only in the bundle',
  },
  {
    id: 'tags-present',
    status: 'implemented',
    describes:
      'every resource in canon/generated/infra-manifest.json carries every required tag (harness.json infra.required_tags)',
  },
];

const results = [];
const fail = (id, msg, detail) => results.push({ id, result: 'fail', msg, detail });
const pass = (id, msg) => results.push({ id, result: 'pass', msg });

// regenerate-empty-diff + generated-not-hand-edited
try {
  const GEN = [
    'canon/generated/canon-graph.json',
    'canon/index/pointers.json',
    'canon/generated/infra-manifest.json',
  ];
  const strip = (t) => t.replace(/"generatedAt": "[^"]*"/, '');
  const before = GEN.map((f) =>
    existsSync(join(ROOT, f)) ? sha(strip(readFileSync(join(ROOT, f), 'utf8'))) : null,
  );
  for (const gen of ['canon-graph.mjs', 'infra-manifest.mjs'])
    execFileSync('node', [join(ROOT, 'scripts', 'harness', gen)], {
      cwd: ROOT,
      stdio: 'ignore',
    });
  const after = GEN.map((f) => sha(strip(readFileSync(join(ROOT, f), 'utf8'))));
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
  results.push({
    id: 'regenerate-empty-diff',
    result: 'unmeasured',
    msg: String(e.message),
  });
}

// pointers-resolve
const idx = readJson(join(ROOT, 'canon', 'index', 'pointers.json'), {
  byFile: {},
});
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
const g = readJson(join(ROOT, 'canon', 'generated', 'canon-graph.json'), {
  nodes: [],
  edges: [],
});
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

// layer-direction
const sys = readJson(join(ROOT, 'canon', 'generated', 'system-graph.json'));
if (!sys)
  results.push({
    id: 'layer-direction',
    result: 'unmeasured',
    msg: 'no system graph (npm run graph:system)',
  });
else {
  const allowed = new Set((lm.direction || []).map(([a, b]) => `${a}>${b}`));
  const free = new Set(['tests', 'harness']);
  const fileOf = new Map(sys.nodes.filter((n) => n.kind === 'file').map((n) => [n.id, n.file]));
  const violations = [];
  let crossings = 0;
  for (const e of sys.edges) {
    if (e.type !== 'IMPORTS') continue;
    const a = fileOf.get(e.source);
    const b = fileOf.get(e.target);
    if (!a || !b) continue;
    const la = layerOf(a, lm);
    const lb = layerOf(b, lm);
    if (!la || !lb || la === lb || free.has(la)) continue;
    crossings++;
    if (!allowed.has(`${la}>${lb}`)) violations.push(`${a} (${la}) → ${b} (${lb})`);
  }
  (violations.length ? fail : pass)(
    'layer-direction',
    violations.length
      ? `${violations.length} import(s) against the declared direction`
      : `${crossings} cross-layer import(s) all along declared pairs`,
    violations,
  );
}

// criteria-bound-passed
{
  const bindings = [...new Set(g.edges.filter((e) => e.type === 'tests').map((e) => e.source))];
  if (!bindings.length) pass('criteria-bound-passed', 'no bindings yet (vacuous)');
  else {
    const tr = readJson(join(ROOT, '.harness', 'test-results.json'));
    const head = headSha();
    if (!tr)
      results.push({
        id: 'criteria-bound-passed',
        result: 'unmeasured',
        msg: 'no .harness/test-results.json (npm run test:report -- --e2e)',
      });
    else if (!resultsDescribe(tr, head) || tr.dirty)
      results.push({
        id: 'criteria-bound-passed',
        result: 'unmeasured',
        msg: `test results are from ${String(tr.commit).slice(0, 7)}${tr.dirty ? ' (dirty tree)' : ''}, HEAD is ${head.slice(0, 7)}; rerun npm run test:report`,
      });
    else {
      const problems = [];
      for (const b of bindings) {
        const hits = tr.tests.filter((t) => t.title.includes(b));
        if (!hits.length) problems.push(`${b}: no test cites it`);
        else if (hits.some((t) => t.status === 'failed'))
          problems.push(
            `${b}: failed in ${hits
              .filter((t) => t.status === 'failed')
              .map((t) => t.file)
              .join(', ')}`,
          );
        else if (hits.every((t) => t.status === 'skipped'))
          problems.push(`${b}: only skipped tests cite it`);
      }
      (problems.length ? fail : pass)(
        'criteria-bound-passed',
        problems.length
          ? `${problems.length} binding(s) not proven at HEAD`
          : `${bindings.length} binding(s) passed at ${head.slice(0, 7)}`,
        problems,
      );
    }
  }
}

// Results describe HEAD when the code is the same at both, whatever the history between them: a squash
// merge rewrites the plan branch into a new commit that is nobody's descendant, a landing commit stamps
// canon, moves intent to records and appends to the ledger, and a harness sync reaches main on its own
// lineage. Re-proving identical product code against a different sha would only say the same twice. Bindings are read from the canon at HEAD either
// way, so a criterion added since the run is still caught by the rows below.
function resultsDescribe(tr, head) {
  if (!tr.commit) return false;
  if (tr.commit === head) return true;
  if (!git(['rev-parse', '--verify', '--quiet', `${tr.commit}^{commit}`])) return false;
  return (
    git([
      'diff',
      '--name-only',
      tr.commit,
      head,
      '--',
      '.',
      ...NOT_PRODUCT.map((p) => `:!${p}`),
    ]) === ''
  );
}

// main-nodes-have-valid-from
{
  const mainRef = [process.env.HARNESS_MAIN_REF, 'main', 'origin/main']
    .filter(Boolean)
    .find((r) => git(['rev-parse', '--verify', '--quiet', r]));
  if (!mainRef)
    results.push({
      id: 'main-nodes-have-valid-from',
      result: 'unmeasured',
      msg: 'no main ref',
    });
  else {
    const files = git(['ls-tree', '-r', '--name-only', mainRef, '--', 'canon/'])
      .split('\n')
      .filter((f) => f.endsWith('.md') && !/^canon\/(generated|index)\//.test(f));
    const problems = [];
    let counted = 0;
    for (const f of files) {
      const { data } = parseFrontmatter(git(['show', `${mainRef}:${f}`]));
      if (!data.id || ['map', 'constitution'].includes(data.kind)) continue;
      counted++;
      if (!data.valid_from) {
        problems.push(`${data.id} (${f}): valid_from missing`);
        continue;
      }
      const ancestor = (() => {
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', String(data.valid_from), mainRef], {
            cwd: ROOT,
            stdio: 'ignore',
          });
          return true;
        } catch {
          return false;
        }
      })();
      if (!ancestor)
        problems.push(
          `${data.id} (${f}): valid_from ${data.valid_from} is not an ancestor of ${mainRef}`,
        );
    }
    (problems.length ? fail : pass)(
      'main-nodes-have-valid-from',
      problems.length
        ? `${problems.length} node(s) on ${mainRef} without a valid valid_from`
        : counted
          ? `${counted} node(s) on ${mainRef} stamped`
          : `no canon nodes on ${mainRef} yet (vacuous)`,
      problems,
    );
  }
}

// tags-present
{
  const manifest = readJson(join(ROOT, 'canon', 'generated', 'infra-manifest.json'));
  const harness = readJson(join(ROOT, 'harness.json'), {});
  const required = harness.infra?.required_tags || [
    'App',
    'Owner',
    'Capability',
    'CostCenter',
    'Service',
    'Environment',
    'DataClassification',
    'ManagedBy',
  ];
  if (!manifest)
    results.push({
      id: 'tags-present',
      result: 'unmeasured',
      msg: 'no infra manifest (npm run canon:manifest)',
    });
  else {
    const problems = [];
    const rows = [
      ...(manifest.resources || []),
      ...Object.entries(manifest.deployments || {}).flatMap(([stage, d]) =>
        (d.resources || []).map((r) => ({ ...r, name: `${stage}:${r.name}` })),
      ),
    ].filter((r) => r.taggable !== false);
    for (const r of rows) {
      const missing = required.filter(
        (k) => !r.tags || r.tags[k] === undefined || r.tags[k] === '',
      );
      if (missing.length) problems.push(`${r.type} ${r.name}: missing ${missing.join(', ')}`);
    }
    (problems.length ? fail : pass)(
      'tags-present',
      problems.length
        ? `${problems.length} resource(s) missing required tags`
        : `${rows.length} taggable resource(s) carry ${required.length} required tags (${manifest.source})`,
      problems,
    );
  }
}

// harness-in-sync
{
  const installer = join(ROOT, '..', 'bundle', 'install-bundle.sh');
  if (!existsSync(installer))
    results.push({
      id: 'harness-in-sync',
      result: 'unmeasured',
      msg: 'no ../bundle next to this app',
    });
  else {
    const probe = (() => {
      try {
        return {
          synced: true,
          out: execFileSync('bash', [installer, ROOT, '--check'], { cwd: ROOT, encoding: 'utf8' }),
        };
      } catch (e) {
        return { synced: false, out: String(e.stdout || e.message) };
      }
    })();
    const { synced, out } = probe;
    const lines = out.split('\n').filter(Boolean);
    (synced ? pass : fail)(
      'harness-in-sync',
      synced
        ? lines.at(-1)
        : `${lines.length} harness file(s) differ from the bundle; run the installer, never edit them here`,
      synced ? [] : lines,
    );
  }
}

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
