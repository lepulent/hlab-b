#!/usr/bin/env node
// J5.0 (docs/14 §5, §9): how much of the Master's decision do the records already settle? Every Master
// decision this app has recorded is replayed against master-predicate.mjs, on the ladder the Master was
// actually SHOWN — read back from its own prompt in its transcript, not reconstructed, because the ladder
// changed shape over the steps (the contract phase arrived at step 12) and a reconstruction scores the
// Master against a ladder it never saw.
//
// The decisions come from the app's ledgers, read through git from every plan branch and from main, and
// the decision itself from its activation line; the transcript gives the prompt. The first version read
// only conduct records copied into runs/ and silently dropped 19 of the newest decisions (Ludwig
// 2026-09-30); every decision the ledgers name and the replay cannot read is counted under `skipped`.
//
// No model is called; this costs nothing and is rerun at will. It writes runs/<app>/master-replay.json:
// one point per decision the door accepted (every valid activation line), its category, and — for the J5 row — every
// rung that did not block the seal, whether the Master spent THIS wave on it, and whether the plan ever
// built it (the row's question is timeless: "does the plan need it").
//
// With --row <id> (J5.2) the JEV row is asked, in shadow, at every rung that did not block the seal, on the
// state parsed from the same prompt: the intent, the rigor and the catalogue entry the Master was shown.
// The split is declared before any call (T5 review): hlab-a is where criteria may be tuned, hlab-b is
// held out, and only hlab-b's number is evidence once hlab-a has been looked at.
//
// Usage: node scripts/harness/master-replay.mjs [--row gap.artifact.needed [--max-calls N]] [--json]
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, readJson, writeJson } from './common.mjs';
import { transcriptDir } from './activation.mjs';
import {
  recordsDecision,
  compareToRecords,
  parseLadderView,
  retriedBefore,
  gapOutcomes,
} from './master-predicate.mjs';
import { parseLedger } from './resume.mjs';
import { pidAlive } from './lock.mjs';
import { getRow } from './jev-registry.mjs';
import { askRow, jevLine, makeBudget } from './jev.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROW = arg('row', null);
const MAX_CALLS = Number(arg('max-calls', 0)) || 250;

const harness = readJson(join(ROOT, 'harness.json'), {});
const APP = harness.app?.name || 'app';
const RUNS = join(ROOT, '..', 'runs', APP);
const TRANSCRIPTS = transcriptDir(process.env.HOME || '', ROOT);

const transcriptLines = (session) => {
  const f = join(TRANSCRIPTS, `${session}.jsonl`);
  if (!existsSync(f)) return null;
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
};
// the first user message of a session is the prompt the seat was given
function promptOf(lines) {
  const j = lines.find((x) => x.type === 'user');
  const c = j?.message?.content;
  return j ? (typeof c === 'string' ? c : (c || []).map((x) => x.text || '').join('')) : null;
}
// the sections of a Master prompt a row may read: what it was shown, verbatim
const section = (prompt, name) => {
  const i = prompt.indexOf(`--- ${name}`);
  if (i < 0) return '';
  const body = prompt.slice(prompt.indexOf('\n', i) + 1);
  const end = body.search(/\n\n--- [A-Z]/);
  return (end < 0 ? body : body.slice(0, end)).trim();
};
// null when the prompt carries no catalogue that parses: the caller counts it, because treating it as
// "everything is producible" would silently restore the unproducible rungs (Ludwig 2026-10-02)
const catalogueOf = (prompt) => {
  try {
    const c = JSON.parse(section(prompt, 'CATALOGUE'));
    return Array.isArray(c) && c.length ? c : null;
  } catch {
    return null;
  }
};

// every plan ledger the app holds, through git: its plan branches, and main for delivered plans
const gitOut = (args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 28,
    });
  } catch {
    return null;
  }
};
const plans = [
  ...new Set([
    ...(gitOut(['for-each-ref', '--format=%(refname:short)', 'refs/heads/plan/']) || '')
      .split('\n')
      .filter(Boolean)
      .map((b) => b.replace(/^plan\//, '')),
    ...(gitOut(['ls-tree', '--name-only', 'main', 'ledger/']) || '')
      .split('\n')
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/^ledger\//, '').replace(/\.jsonl$/, '')),
  ]),
].sort();

const points = [];
// what was replayed, so a figure can be traced to the ledgers it came from (Ludwig 2026-10-02: the plan
// set grows between runs); a plan whose orchestrator is alive is not over, and is left out by name
const scope = [];
const inProgress = (plan) => {
  try {
    const lock = JSON.parse(readFileSync(join(ROOT, '.harness', `conduct-${plan}.lock`), 'utf8'));
    return pidAlive(lock.pid);
  } catch {
    return false;
  }
};
const skipped = {
  plans_in_progress: [],
  ledger_unreadable: 0,
  plans_without_master_seats: 0,
  no_activation: 0,
  refused_attempt: 0,
  no_transcript: 0,
  no_ladder_in_prompt: 0,
};
let masterSeats = 0;
// decisions whose prompt carried no readable catalogue: their rungs are all taken as producible
let catalogueUnread = 0;
for (const plan of plans) {
  if (inProgress(plan)) {
    skipped.plans_in_progress.push(plan);
    continue;
  }
  const ref = [`plan/${plan}`, 'main'].find(
    (r) => gitOut(['cat-file', '-e', `${r}:ledger/${plan}.jsonl`]) !== null,
  );
  const text = ref ? gitOut(['show', `${ref}:ledger/${plan}.jsonl`]) : null;
  if (!text) {
    skipped.ledger_unreadable++;
    continue;
  }
  scope.push({ plan, ref, commit: (gitOut(['rev-parse', '--short=12', ref]) || '').trim() });
  const lines = parseLedger(text);
  // one point per decision the door accepted: every activation line with valid true, keyed by its Master
  // session. "The last attempt per wave" lost every re-run of a wave (15 accepted decisions across both
  // apps, Ludwig 2026-10-01) and never counted a refused attempt.
  const activation = new Map();
  lines.forEach((l, i) => {
    if (l?.kind === 'activation' && l.data?.master_session)
      activation.set(l.data.master_session, { d: l.data, i });
  });
  const seats = lines
    .map((l) => l?.data || {})
    .filter(
      (d, i) =>
        lines[i]?.kind === 'seat-end' &&
        d.seat === 'master' &&
        d.station === 'conduct' &&
        !!d.session,
    );
  if (!seats.length) {
    skipped.plans_without_master_seats++;
    continue;
  }
  masterSeats += seats.length;
  const planPoints = [];
  for (const seat of seats) {
    const act = activation.get(seat.session);
    if (!act) {
      skipped.no_activation++;
      continue;
    }
    if (!act.d.valid) {
      skipped.refused_attempt++;
      continue;
    }
    const tl = transcriptLines(seat.session);
    if (!tl) {
      skipped.no_transcript++;
      continue;
    }
    const prompt = promptOf(tl);
    const view = parseLadderView(prompt);
    if (!view) {
      skipped.no_ladder_in_prompt++;
      continue;
    }
    const n = act.d.wave;
    // the decision is the one the ledger recorded as accepted, not a transcript's last output
    const outcome = act.d.outcome;
    const chosen = new Set(
      outcome === 'move' ? (act.d.gap?.artifacts || []).map((a) => a.artifact || a) : [],
    );
    // what the catalogue the Master was shown can produce: a rung nothing fills is neither blocking at
    // the door nor a wave the Master could have spent (ux ← ux_spec has no producer; Ludwig 2026-10-01)
    const shownCatalogue = catalogueOf(prompt);
    if (!shownCatalogue) catalogueUnread++;
    const shown = (shownCatalogue || []).map((c) => c.id);
    const pred = recordsDecision(view.cov, {
      wavesLeft: view.wavesLeft,
      stale: view.stale,
      producible: shown.length ? new Set(shown) : null,
    });
    const dec = { outcome, artifacts: [...chosen] };
    const cmp = compareToRecords(pred, dec, view.cov, { retried: retriedBefore(lines, act.i) });
    planPoints.push({
      plan,
      n,
      _i: act.i,
      attempt: act.d.attempt ?? 1,
      session: seat.session,
      master: { outcome, artifacts: [...chosen].sort() },
      records: { outcome: pred.outcome, artifacts: pred.artifacts, why: pred.why },
      ...cmp,
      optional: pred.optional.map((o) => ({
        ...o,
        chosen: o.docTypes.some((t) => chosen.has(t)),
      })),
      // what a row needs to be asked about this decision, kept off the report
      _ctx: {
        intent: section(prompt, 'INTENT'),
        rigor: (section(prompt, 'PLAN').match(/rigor (\w+)/) || [])[1] || null,
        catalogue: shownCatalogue || [],
        has: view.cov.slots.filter((x) => x.covered.length).map((x) => x.id),
        owes: view.cov.stepsToSeal,
      },
    });
  }
  // the row's label is timeless ("does the plan need it"), so each case also records whether the plan
  // chose the rung at this decision or a later one, and whether a gap that produced it ever CLOSED after
  // this decision: chosen is not built (Ludwig 2026-10-01, point 4)
  // the gap a close belongs to is resolved as retriedBefore resolves it: by id and its run's wave
  const closes = gapOutcomes(lines).filter((e) => e.delivered);
  for (const p of planPoints)
    for (const o of p.optional) {
      o.chosen_later = planPoints.some(
        (q) => q._i >= p._i && o.docTypes.some((t) => q.master.artifacts.includes(t)),
      );
      o.built = closes.some((c) => c.i > p._i && o.docTypes.some((t) => c.artifacts.includes(t)));
    }
  points.push(...planPoints);
}

// every Master seat the ledgers name is a point or a counted skip; anything else is a replay bug
const accounted =
  points.length +
  skipped.no_activation +
  skipped.refused_attempt +
  skipped.no_transcript +
  skipped.no_ladder_in_prompt;
if (accounted !== masterSeats)
  throw new Error(
    `master-replay: ${masterSeats} Master conduct seats in the ledgers, ${accounted} points and skips`,
  );

// ---------------------------------------------------------------- J5.2: the row, in shadow
const readings = [];
let stoppedEarly = null;
if (ROW) {
  const row = getRow(ROW);
  const jev = harness.jev || {};
  const budget = makeBudget(jev.budget_usd_per_plan ?? null);
  let failures = 0;
  outer: for (const p of points)
    for (const o of p.optional.filter((x) => x.producible)) {
      if (readings.length >= MAX_CALLS) {
        stoppedEarly = `the ${MAX_CALLS}-call cap was reached`;
        break outer;
      }
      const entry =
        p._ctx.catalogue.find((c) => o.docTypes.includes(c.id)) ||
        p._ctx.catalogue.find((c) => String(c.id).startsWith(o.id)) ||
        {};
      const r = await askRow(
        row,
        {
          rung: {
            id: o.id,
            requirement: o.requirement,
            title: entry.title,
            purpose: entry.purpose,
          },
          rigor: p._ctx.rigor,
          intent: p._ctx.intent,
          has: p._ctx.has,
          owes: p._ctx.owes,
        },
        { model: jev.model || 'jev-1.13.0', budget, mock: arg('mock', process.env.JEV_MOCK) },
      );
      failures = r.unmeasured ? failures + 1 : 0;
      readings.push({
        plan: p.plan,
        n: p.n,
        rung: o.id,
        label: o.chosen,
        chosen_later: o.chosen_later,
        built: o.built,
        ruled: r.ruling?.answer ?? null,
        p: r.ruling?.probabilities?.true ?? null,
        agreed: r.unmeasured ? null : r.ruling?.answer === o.chosen,
        line: jevLine(r, {
          agreesWith: `master:chosen=${o.chosen}`,
          agreed: r.unmeasured ? null : r.ruling?.answer === o.chosen,
        }),
      });
      if (failures >= 3) {
        stoppedEarly = '3 consecutive calls failed; the run stopped rather than spend more';
        break outer;
      }
    }
}
for (const p of points) {
  delete p._ctx;
  delete p._i;
}

const count = (xs, p) => xs.filter(p).length;
const categories = {};
for (const p of points) categories[p.category] = (categories[p.category] || 0) + 1;
const allOptional = points.flatMap((p) => p.optional.map((o) => ({ ...o, plan: p.plan })));
const optionalCases = allOptional.filter((o) => o.producible);
// a plan-rung is one rung of one plan, however many decisions saw it missing: 139 cases were 33 rungs
const byPlanRung = new Map();
for (const o of optionalCases) {
  const k = `${o.plan}/${o.id}`;
  const r = byPlanRung.get(k) || { chosen: false, built: false };
  byPlanRung.set(k, { chosen: r.chosen || o.chosen, built: r.built || o.built });
}
const planRungs = [...byPlanRung.values()];
const summary = {
  app: APP,
  decisions: points.length,
  master_seats: masterSeats,
  skipped,
  plans: new Set(points.map((p) => p.plan)).size,
  scope,
  outcome_agrees: count(points, (p) => p.outcome),
  full_agrees: count(points, (p) => p.full),
  moved_where_records_close: count(points, (p) => p.movedWhereRecordsClose),
  categories,
  // the free baseline the J5 row must beat: "never spend a wave on a rung that does not block"
  optional_rungs: {
    cases: optionalCases.length,
    unproducible_excluded: allOptional.length - optionalCases.length,
    decisions_without_catalogue: catalogueUnread,
    chosen: count(optionalCases, (o) => o.chosen),
    baseline_never: count(optionalCases, (o) => !o.chosen),
    chosen_later: count(optionalCases, (o) => o.chosen_later),
    built: count(optionalCases, (o) => o.built),
    plan_rungs: planRungs.length,
    plan_rungs_chosen: count(planRungs, (r) => r.chosen),
    plan_rungs_built: count(planRungs, (r) => r.built),
  },
  replayed_at: new Date().toISOString(),
};
const measured = readings.filter((r) => r.agreed !== null);
const rowSummary = ROW
  ? {
      row: ROW,
      transport: arg('mock', process.env.JEV_MOCK)
        ? `mock:${arg('mock', process.env.JEV_MOCK)}`
        : 'live',
      asked: readings.length,
      measured: measured.length,
      stopped_early: stoppedEarly,
      agreed: count(measured, (r) => r.agreed),
      baseline_never: count(measured, (r) => !r.label),
      // the cases that matter: where the Master DID spend the wave, did the row see the need?
      chosen_cases: count(measured, (r) => r.label),
      chosen_found: count(measured, (r) => r.label && r.ruled === true),
      said_needed: count(measured, (r) => r.ruled === true),
      usd: Number(readings.reduce((a, r) => a + (r.line.usd || 0), 0).toFixed(6)),
    }
  : null;
if (existsSync(join(ROOT, '..', 'runs'))) {
  if (ROW)
    writeJson(
      join(RUNS, `master-replay-${ROW}${rowSummary.transport === 'live' ? '' : '-mock'}.json`),
      { summary: rowSummary, readings },
    );
  else writeJson(join(RUNS, 'master-replay.json'), { summary, points });
}

if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, points }, null, 2));
else {
  const s = summary;
  console.log(
    `master-replay ${APP}: ${s.decisions} decisions in ${s.plans} plans (skipped ${JSON.stringify(s.skipped)})\n` +
      `  records settle the outcome ${s.outcome_agrees}/${s.decisions}, the whole decision ${s.full_agrees}/${s.decisions}; the Master moved where they close ${s.moved_where_records_close}\n` +
      `  where they part: ${Object.entries(s.categories)
        .filter(([k]) => k !== 'agree')
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')}\n` +
      `  rungs that do not block: ${s.optional_rungs.cases} cases (${s.optional_rungs.unproducible_excluded} unproducible left out) on ${s.optional_rungs.plan_rungs} plan-rungs; the Master spent a wave on ${s.optional_rungs.chosen} cases, ${s.optional_rungs.plan_rungs_chosen} plan-rungs; "never" is right ${s.optional_rungs.baseline_never}/${s.optional_rungs.cases}; built by a closed gap ${s.optional_rungs.plan_rungs_built}/${s.optional_rungs.plan_rungs} plan-rungs`,
  );
  if (rowSummary) {
    const r = rowSummary;
    console.log(
      `  ${r.row} via ${r.transport}: ${r.measured}/${r.asked} measured${r.stopped_early ? ` (stopped: ${r.stopped_early})` : ''} · agreed ${r.agreed}/${r.measured} vs "never" ${r.baseline_never}/${r.measured} · of the ${r.chosen_cases} rungs the Master built it said needed ${r.chosen_found} · said needed ${r.said_needed} in all · $${r.usd}`,
    );
  }
}
