#!/usr/bin/env node
// Replay (docs/14 §3): a row run over decisions that have already been made, so its agreement with what
// was actually done is measured before it is allowed anywhere near a live plan. The evidence of record is
// `.harness/conduct-<plan>.json` and `ledger/<plan>.jsonl`; the Q files themselves are read back from
// `records/<plan>/questions/` or from the plan branch where they survive, and nothing here depends on
// them, because a plan that never landed has none.
//
// This writes no ledger line. A `jev` line belongs to the run that asked the row; appending one to a
// closed plan's ledger would put a judgment made today inside the evidence of a plan that ended weeks
// ago. The line each point *would* have written is in the report instead, under `line`.
//
// Usage: node scripts/harness/jev-replay.mjs --plan <slug> --row <id> [--at <n>] [--mock <path|echo>] [--json]
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson, writeJson, git, parseFrontmatter } from './common.mjs';
import { getRow } from './jev-registry.mjs';
import { askRow, jevLine, makeBudget, gradeShadow, freeBaselines, baselineText } from './jev.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PLAN = arg('plan');
const ROW = arg('row');
const AT = Number(arg('at', 0)) || null;
if (!PLAN || !ROW) {
  console.error('jev-replay: --plan <slug> --row <id> required');
  process.exit(2);
}
const harness = readJson(join(ROOT, 'harness.json'), {});
const APP = harness.app?.name || 'app';
const jev = harness.jev || {};
const row = getRow(ROW);

// ------------------------------------------------------------------ what the run left behind
// The conduct JSON is written into the app's .harness, which is gitignored, and copied into the lab's
// runs/ for the reports. Either is the same file; the app's own copy is the newer one when a plan ran
// twice, so it is read first.
function conductJson(plan) {
  const own = join(ROOT, '.harness', `conduct-${plan}.json`);
  if (existsSync(own)) return { source: '.harness', json: readJson(own) };
  const runs = join(ROOT, '..', 'runs', APP);
  if (existsSync(runs))
    for (const d of readdirSync(runs)) {
      const f = join(runs, d, `conduct-${plan}.json`);
      if (existsSync(f)) return { source: `runs/${APP}/${d}`, json: readJson(f) };
    }
  return { source: null, json: null };
}
const { source: conductSource, json: conduct } = conductJson(PLAN);
if (!conduct) {
  console.error(`jev-replay: no conduct-${PLAN}.json in .harness or ../runs/${APP}`);
  process.exit(2);
}
const ledgerFile = join(ROOT, 'ledger', `${PLAN}.jsonl`);
const ledger = existsSync(ledgerFile)
  ? readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  : [];
const ledgerOf = (kind, file) =>
  ledger.find((l) => l.kind === kind && l.data?.file === file && l.data?.valid !== false)?.data ??
  null;

// A path as it stood at the commit that recorded it; failing that, as it stands now; failing that,
// nothing. Which of the three is recorded per point, so a number is never read as better evidence than
// the text it was computed from.
const at = (commit, path) => (commit ? git(['show', `${commit}:${path}`]) : '');
function fileAt(commit, path) {
  const shown = at(commit, path);
  if (shown) return { text: shown, source: `commit ${String(commit).slice(0, 7)}` };
  const live = join(ROOT, path);
  if (existsSync(live)) return { text: readFileSync(live, 'utf8'), source: 'tree' };
  return { text: '', source: 'missing' };
}
// The intent moves: it is written under intent/<plan>/ while the plan runs and lands in records/<plan>/.
function intentText(plan) {
  for (const [source, p] of [
    ['records', join('records', plan, 'INTENT.md')],
    ['tree', join('intent', plan, 'INTENT.md')],
  ])
    if (existsSync(join(ROOT, p)))
      return { source, text: parseFrontmatter(readFileSync(join(ROOT, p), 'utf8')).body };
  const branch = git(['show', `plan/${plan}:intent/${plan}/INTENT.md`]);
  if (branch) return { source: `branch plan/${plan}`, text: parseFrontmatter(branch).body };
  return { source: 'missing', text: '' };
}
// The question file, for the `why` when the ledger of that plan was never written (the older plans have
// only a conduct JSON). The body under the frontmatter is the why the agent wrote.
function questionText(plan, file) {
  for (const [source, p] of [
    ['records', join('records', plan, 'questions', file)],
    ['tree', join('intent', plan, 'questions', file)],
  ])
    if (existsSync(join(ROOT, p)))
      return { source, body: parseFrontmatter(readFileSync(join(ROOT, p), 'utf8')).body };
  const branch = git(['show', `plan/${plan}:intent/${plan}/questions/${file}`]);
  if (branch) return { source: `branch plan/${plan}`, body: parseFrontmatter(branch).body };
  return { source: 'missing', body: '' };
}
// the why the agent gave, out of the richest source that has it
function whyOf(file) {
  const fromLedger = ledgerOf('question', file)?.why;
  if (fromLedger) return { text: fromLedger, source: 'ledger' };
  const q = questionText(PLAN, file);
  const body = q.body
    .split(/^##\s/m)[0]
    .replace(/^#\s.*$/m, '')
    .trim();
  return { text: body, source: q.source };
}
// what the asking agent recommended, for the free baseline: the ledger's question line, else the file's
// frontmatter wherever the file stands
function recommendOf(file) {
  const fromLedger = ledgerOf('question', file)?.recommend;
  if (fromLedger) return fromLedger;
  for (const p of [
    join('records', PLAN, 'questions', file),
    join('intent', PLAN, 'questions', file),
  ])
    if (existsSync(join(ROOT, p)))
      return parseFrontmatter(readFileSync(join(ROOT, p), 'utf8')).data?.recommend ?? null;
  const branch = git(['show', `plan/${PLAN}:intent/${PLAN}/questions/${file}`]);
  return branch ? (parseFrontmatter(branch).data?.recommend ?? null) : null;
}
// the document the question was asked about: what the asking seat wrote in that wave, at its commit
function documentOf(wave, agent) {
  const w = (conduct.waves || []).find((x) => x.n === wave);
  const a = w?.activations?.find((x) => x.agent === agent);
  if (!a) return { text: '', source: 'no activation recorded' };
  const parts = [];
  const sources = [];
  for (const p of a.written || []) {
    const f = fileAt(a.commit, p);
    if (f.text) parts.push(`### ${p}\n${f.text}`);
    sources.push(`${p} (${f.source})`);
  }
  return { text: parts.join('\n\n'), source: sources.join(', ') || 'wrote nothing' };
}

// ------------------------------------------------------------------ the decision points
// Every question this plan answered, in the order it answered them. An unanswered or invalid question is
// not a labelled case: there is nothing the row's ruling could be measured against.
const answered = (conduct.questions || [])
  .filter((q) => q.answered && q.answer && (q.alternatives || []).length >= 2)
  .map((q, i) => ({ ...q, seq: i + 1 }));
const points = AT ? answered.filter((q) => q.seq === AT) : answered;
if (!points.length) {
  console.error(
    `jev-replay: ${PLAN} has no answered question with alternatives${AT ? ` at --at ${AT}` : ''} (${answered.length} in the plan)`,
  );
  process.exit(2);
}
const intent = intentText(PLAN);
const budget = makeBudget(jev.budget_usd_per_plan ?? null);

// Caps, while this is still a prototype (owner, 2026-09-28). Not the vendor's ceiling — the direct API
// publishes no rate-limit header at all — but our own, so a loop cannot run away and a burst of the
// vendor's 503s cannot be mistaken for a prompt regression:
//
//   MAX_CALLS              at most this many decisions per run
//   STOP_AFTER_FAILURES    three consecutive failures ends the run, and the report SAYS it stopped
//
// Atlassinator paid for the second one twice: a tuning round lost ten calls to 503 and the drop looked
// like the prompt getting worse, and a live eval burned three calls on a missing key before stopping. A
// run that stopped early is never tuned on.
// Rebuild the table from the reports already on disk and make no call at all. A table is a projection
// of the recorded runs, so regenerating it must never cost anything.
const SUMMARISE_ONLY = argv.includes('--summarise-only');
const MAX_CALLS = Number(arg('max-calls', 0)) || 60;
const STOP_AFTER_FAILURES = 3;

// The order the alternatives are shown in is not neutral: an asking agent tends to write the one it
// prefers first, and the recorded answer is the first alternative in 24 of 38 cases — a trivial
// "always pick the first" baseline scores 0.632. So a row that reads option ORDER rather than option
// CONTENT would look almost as good as one that understands the question. `--alt-order reverse` shows
// the same options in the opposite order: agreement that survives it is agreement about content.
const ALT_ORDER = arg('alt-order', 'asis');
const reorder = (alts) => (ALT_ORDER === 'reverse' ? [...alts].reverse() : alts);

// `--criteria bare` asks the same question with each option described ONLY by the agent's own
// alternative text, dropping the row's shared not_for / examples / signals guards. Those guards are
// identical on every option — a question's alternatives are written fresh each time, so nothing
// option-specific can be written in advance — and Atlassinator measured bare option names scoring near
// random. This is the experiment that says whether the guards earn their tokens or only cost them.
// It does not change the registry row; the summary records which criteria answered.
const CRITERIA = arg('criteria', 'row');
const asked =
  CRITERIA === 'bare'
    ? {
        ...row,
        criteria: (ctx) => ({
          answer: {
            instructions: row.criteria(ctx).answer.instructions,
            criteria: Object.fromEntries(
              (ctx.alternatives || []).map((alt, i) => [`opt${i + 1}`, String(alt).trim()]),
            ),
          },
        }),
      }
    : row;

const results = [];
let consecutiveFailures = 0;
let stoppedEarly = null;
for (const q of points) {
  if (SUMMARISE_ONLY) break; // the table is a projection; rebuilding it costs nothing
  if (results.length >= MAX_CALLS) {
    stoppedEarly = `the ${MAX_CALLS}-call cap for this run was reached`;
    break;
  }
  const why = whyOf(q.file);
  const doc = documentOf(q.wave, q.agent);
  // what this plan had already settled when the question was asked, and nothing it settled after
  const decided = answered
    .filter((x) => x.seq < q.seq)
    .map((x) => ({ file: x.file, question: x.question, answer: x.answer }));
  const ctx = {
    app: APP,
    plan: PLAN,
    intent: intent.text,
    question: q.question,
    why: why.text,
    document: doc.text,
    decided,
    alternatives: reorder(q.alternatives),
  };
  const r = await askRow(asked, ctx, {
    model: jev.model || 'jev-1.13.0',
    enabled: jev.enabled !== false,
    budget,
    mock: arg('mock', process.env.JEV_MOCK),
  });
  if (r.unmeasured) {
    consecutiveFailures++;
    console.error(`jev-replay: ${q.file} unmeasured — ${r.reason}`);
  } else consecutiveFailures = 0;
  const recorded = q.answer;
  // every point here was answered and accepted (the filter above), so the recorded answer is a label
  const { agreed } = gradeShadow(r, { answer: recorded, answered: true });
  results.push({
    seq: q.seq,
    file: q.file,
    wave: q.wave,
    agent: q.agent,
    question: q.question,
    alternatives: q.alternatives,
    recommend: recommendOf(q.file),
    recorded,
    ruled: r.ruling?.answer ?? null,
    agreed,
    confidence: r.ruling?.confidence ?? null,
    close_call: r.ruling?.closeCall ?? null,
    band: r.ruling?.band ?? null,
    probabilities: r.ruling?.probabilities ?? {},
    state_chars: r.state ? JSON.stringify(r.state).length : 0,
    state_cut: r.cut ?? [],
    // docs/15 §6: the shape is load-bearing now, so a live replay keeps the bytes. Without them a
    // vendor field rename and a client bug look exactly the same on a later reading.
    raw: r.raw ?? null,
    sources: {
      intent: intent.source,
      why: why.source,
      document: doc.source,
      conduct: conductSource,
    },
    usd: r.usd,
    ms: r.ms,
    unmeasured: r.unmeasured || false,
    reason: r.reason ?? null,
    // the line this point would have written on a live run (docs/14 §2); no ledger is touched here
    line: jevLine(r, { agreesWith: `master:answer=${recorded}`, agreed }),
  });
  if (consecutiveFailures >= STOP_AFTER_FAILURES) {
    stoppedEarly = `${STOP_AFTER_FAILURES} consecutive calls failed; the run stopped rather than spend more`;
    console.error(`jev-replay: ${stoppedEarly}`);
    break;
  }
}

// ------------------------------------------------------------------ the numbers docs/14 §3 asks for
const measured = results.filter((r) => !r.unmeasured);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const confidences = measured.map((r) => r.confidence).filter((c) => c != null);
// The bands are proposed from the shadow data, never from the vendor's: for each candidate, how many
// decisions sit at or above it and how many of those the row got right. A band is worth having only if
// it is both high enough to be right and low enough to be reached.
const bands = [];
for (let t = 0.5; t <= 0.951; t += 0.05) {
  const over = measured.filter((r) => (r.confidence ?? -1) >= t);
  bands.push({
    threshold: Number(t.toFixed(2)),
    n: over.length,
    agreement: over.length
      ? Number((over.filter((r) => r.agreed).length / over.length).toFixed(3))
      : null,
  });
}
const summary = {
  app: APP,
  plan: PLAN,
  row: row.id,
  version: row.version,
  mode: row.mode,
  model: jev.model || 'jev-1.13.0',
  // what answered: a recorded-vector file, the flat `echo` stub, or the API. A mocked reading is a proof
  // that the pipe runs, never a calibration number, and the report says which it is on every row.
  transport: arg('mock', process.env.JEV_MOCK)
    ? `mock:${arg('mock', process.env.JEV_MOCK)}`
    : 'live',
  alt_order: ALT_ORDER,
  criteria_variant: CRITERIA,
  n: results.length,
  // a run that stopped early measured less than it looks like it did, and must never be tuned on
  stopped_early: stoppedEarly,
  points_available: points.length,
  measured: measured.length,
  unmeasured: results.length - measured.length,
  agreement_recorded: measured.length
    ? Number((measured.filter((r) => r.agreed).length / measured.length).toFixed(3))
    : null,
  // what the row must beat, on the same measured points: rule 1 counts it, a judge does not remember it
  baselines: freeBaselines(
    measured.map((r) => ({
      alternatives: r.alternatives,
      recommend: r.recommend,
      answer: r.recorded,
    })),
  ),
  // docs/14 §3: the observer's verdict and the human's answer are the better labels. Neither exists for
  // an answered question in this corpus — no run recorded a human overriding an answer — so the only
  // label here is the Master's own, and that is what the number above measures and all it measures.
  agreement_observer: null,
  agreement_human: null,
  close_calls: measured.filter((r) => r.close_call).length,
  mean_confidence: confidences.length ? Number(mean(confidences).toFixed(3)) : null,
  usd_total: Number(results.reduce((a, r) => a + (r.usd || 0), 0).toFixed(6)),
  usd_per_decision: results.length
    ? Number((results.reduce((a, r) => a + (r.usd || 0), 0) / results.length).toFixed(6))
    : null,
  ms_per_decision: Math.round(mean(results.map((r) => r.ms || 0)) ?? 0),
  budget: { limit: budget.limit, spent: Number(budget.spent.toFixed(6)) },
  bands,
  graded_at: new Date().toISOString(),
};

const runsRoot = join(ROOT, '..', 'runs');
// A run limited to one decision is a probe, not a reading: it goes to its own file and touches no table.
// The variant belongs in the NAME. Without it a second run of the same row on the same plan overwrites
// the first, which is how the reversed and bare-criteria runs silently replaced the as-is numbers in the
// table below — the same defect already recorded about `.harness/conduct-<plan>.json` being per-plan
// rather than per-run (runs/jev-shadow.md §2).
const variantTag = [ALT_ORDER === 'asis' ? null : ALT_ORDER, CRITERIA === 'row' ? null : CRITERIA]
  .filter(Boolean)
  .join('-');
const reportName = AT
  ? `jev-replay-${row.id}-at${AT}.json`
  : `jev-replay-${row.id}${variantTag ? `-${variantTag}` : ''}.json`;
if (existsSync(runsRoot)) {
  // a summarise-only run measured nothing, so it must not overwrite a report that did
  if (!SUMMARISE_ONLY) {
    mkdirSync(join(runsRoot, APP, PLAN), { recursive: true });
    writeJson(join(runsRoot, APP, PLAN, reportName), { summary, points: results });
  }
  if (!AT) writeShadowTable();
}

// docs/14 §3 asks for one summary row per (row, app). A plan is not the unit a row is judged on — the
// lab rule is two evidences per app, over everything that app has replayed — so a row is the aggregate
// over every per-plan report that app holds, at the same transport.
//
// The whole block is rebuilt from those reports, never patched: a table that edits its own previous
// output keeps whatever a changed column name left behind, and the stale row outlives the run that
// wrote it. Here the reports on disk are the only input, so deleting one deletes its row.
function writeShadowTable() {
  const f = join(runsRoot, 'jev-shadow.md');
  if (!existsSync(f)) return;
  const open = '<!-- jev-shadow:results -->';
  const close = '<!-- /jev-shadow:results -->';
  const text = readFileSync(f, 'utf8');
  const a = text.indexOf(open);
  const b = text.indexOf(close);
  if (a < 0 || b < 0) return;
  const groups = new Map();
  for (const app of readdirSync(runsRoot)) {
    const appDir = join(runsRoot, app);
    if (!statSync(appDir).isDirectory()) continue;
    for (const plan of readdirSync(appDir)) {
      const dir = join(appDir, plan);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        // a --at probe is not a reading and carries no row
        if (!/^jev-replay-.+\.json$/.test(name) || /-at\d+\.json$/.test(name)) continue;
        const r = readJson(join(dir, name));
        const s = r?.summary;
        if (!s) continue;
        const k = [
          s.row,
          s.version,
          s.mode,
          app,
          s.transport,
          s.alt_order ?? 'asis',
          s.criteria_variant ?? 'row',
        ].join('\u0000');
        const g = groups.get(k) ?? { s, app, plans: [], points: [] };
        g.plans.push(s.plan);
        g.points.push(...(r.points || []));
        groups.set(k, g);
      }
    }
  }
  const avg = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  const lines = [];
  for (const g of groups.values()) {
    const done = g.points.filter((p) => !p.unmeasured);
    const confs = done.map((p) => p.confidence).filter((c) => c != null);
    const cells = [
      g.s.row,
      g.s.version,
      g.s.mode,
      g.app,
      g.s.transport,
      [
        g.s.alt_order && g.s.alt_order !== 'asis' ? g.s.alt_order : null,
        g.s.criteria_variant && g.s.criteria_variant !== 'row' ? g.s.criteria_variant : null,
      ]
        .filter(Boolean)
        .join('+') || 'as written',
      g.plans.sort().join(' '),
      g.points.length,
      done.length ? (done.filter((p) => p.agreed).length / done.length).toFixed(3) : '–',
      // the free predicates on the same points; a row below them has learned nothing they did not
      (() => {
        const b = freeBaselines(
          done.map((p) => ({
            alternatives: p.alternatives,
            recommend: p.recommend,
            answer: p.recorded,
          })),
        );
        const r = (x) => (x.n ? (x.hits / x.n).toFixed(3) : '–');
        return `${r(b.first)} / ${r(b.recommended)}`;
      })(),
      // the band that decides whether the row can ever act: a threshold is worthless if the high
      // band is polluted, and accuracy overall says nothing about whether it is
      (() => {
        const hi = done.filter((p) => (p.confidence ?? -1) >= 0.95);
        return hi.length ? `${hi.filter((p) => p.agreed).length}/${hi.length}` : '0/0';
      })(),
      done.filter((p) => p.close_call).length,
      confs.length ? avg(confs).toFixed(3) : '–',
      `$${(avg(g.points.map((p) => p.usd || 0)) ?? 0).toFixed(6)}`,
      Math.round(avg(g.points.map((p) => p.ms || 0)) ?? 0),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  const head = [
    '| row | v | mode | app | transport | variant | plans | n | agreement (Master) | baseline first / recommended | agree at conf ≥0.95 | close calls | mean conf. | $/decision | ms/decision |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const body = lines.length ? lines.sort().join('\n') : '_no replay has been run_';
  writeFileSync(
    f,
    `${text.slice(0, a + open.length)}\n\n${head.join('\n')}\n${body}\n\n${text.slice(b)}`,
  );
}

if (argv.includes('--json')) console.log(JSON.stringify({ summary, points: results }, null, 2));
else {
  for (const r of results)
    console.log(
      `${r.agreed === null ? 'unmeasured' : r.agreed ? 'agree ' : 'DIFFER'}  ${r.file.padEnd(8)} w${r.wave} ${String(r.agent).padEnd(12)} conf ${r.confidence ?? '–'}  ruled: ${String(r.ruled ?? r.reason).slice(0, 70)}`,
    );
  console.log(
    `\n${summary.row} v${summary.version} (${summary.mode}) on ${APP}/${PLAN} via ${summary.transport}: ${summary.measured}/${summary.n} measured · agreement ${summary.agreement_recorded ?? '–'} · ${baselineText({ hits: measured.filter((r) => r.agreed).length, n: measured.length }, summary.baselines)} · ${summary.close_calls} close call(s) · $${summary.usd_total} · ${summary.ms_per_decision} ms/decision`,
  );
}
