#!/usr/bin/env node
// The round protocol (docs/03, docs/08): plant, go, estop. The human writes an intent and later reads a
// report; everything between is this script, the Master seat (claude -p) and the pipeline.
//
//   plant --plan <slug> [--intent <file>]   intent/<slug>/INTENT.md must exist (or is copied from --intent);
//                                            router proposes the route → ROUTE.json; branch plan/<slug> (spike/<slug>) from main; commit
//   go    --plan <slug> [--rounds N]         up to yolo.rounds Master rounds on the branch; each round: decider over open questions
//                                            (a stop writes needs-input.md and ends), one headless Master session with JSON output,
//                                            stats line, ledger lines; when the Master reports sealed: push, PR, pipeline run
//   estop [--plan <slug>] [--reason ..]      writes .harness/estop and a ledger line; go refuses to start while it exists
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT,
  readJson,
  writeJson,
  git,
  headSha,
  BOOKKEEPING,
  productDirty,
  bookkeepingDirty,
} from './common.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 && argv[i + 1] ? argv[i + 1] : def;
};
const harness = readJson(join(ROOT, 'harness.json'), {});
const APP = harness.app?.name || 'app';
const PLAN = arg('plan');
const H = join(ROOT, '.harness');
mkdirSync(H, { recursive: true });
const sh = (file, args, opts = {}) =>
  spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const ok = (r) => r.status === 0;
const script = (name, ...args) => sh('node', [join(ROOT, 'scripts', 'harness', name), ...args]);
const ledger = (kind, data, actor = 'script:round') =>
  script(
    'ledger.mjs',
    'append',
    '--plan',
    PLAN,
    '--kind',
    kind,
    '--actor',
    actor,
    '--data',
    JSON.stringify(data),
  );
const fail = (msg, code = 1) => {
  console.error(`round ${cmd}: ${msg}`);
  process.exit(code);
};
const stat = (row) => {
  try {
    writeFileSync(
      join(H, 'stats.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n',
      { flag: 'a' },
    );
  } catch {
    /* advisory */
  }
};
// Before the tree is handed to anything that refuses a dirty one (bmad-loop, a push, the pipeline),
// the harness's own bookkeeping is committed. Ordering each write by hand is a per-call-site rule and
// it was already broken three times; this is the one place that holds the invariant.
function handoff(label) {
  if (!bookkeepingDirty()) return;
  sh('git', ['add', ...BOOKKEEPING.filter((p) => p !== '.harness')]);
  sh('git', ['commit', '-q', '-m', `chore(ledger): ${label}`]);
}

function safeJson(s) {
  try {
    return JSON.parse(String(s).replace(/^```json\s*|```$/g, ''));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- plant
function plant() {
  if (!PLAN) fail('--plan required', 2);
  const dir = join(ROOT, 'intent', PLAN);
  const intentFile = join(dir, 'INTENT.md');
  const src = arg('intent');
  if (src && !existsSync(intentFile)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, intentFile);
  }
  if (!existsSync(intentFile)) fail(`no ${intentFile}; write the intent first`, 2);
  if (git(['status', '--porcelain', '--', ':!intent', ':!.harness']) !== '')
    fail('working tree not clean; plant starts from main', 2);
  const route = safeJson(
    script('router.mjs', '--intent', `intent/${PLAN}/INTENT.md`, '--plan', PLAN).stdout,
  );
  if (!route) fail('router produced no proposal', 1);
  const branch = `${route.kind === 'spike' ? 'spike' : 'plan'}/${PLAN}`;
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') sh('git', ['checkout', '-q', 'main']);
  sh('git', ['pull', '-q', '--ff-only', 'origin', 'main']);
  const base = headSha();
  if (git(['rev-parse', '--verify', '--quiet', branch])) fail(`branch ${branch} already exists`, 2);
  sh('git', ['checkout', '-q', '-b', branch]);
  writeJson(join(dir, 'ROUTE.json'), {
    ...route,
    base,
    branch,
    plantedAt: new Date().toISOString(),
  });
  mkdirSync(join(dir, 'questions'), { recursive: true });
  writeFileSync(join(dir, 'questions', '.gitkeep'), '');
  // a station's ledger lines belong to that station's commit: written first, added with it
  ledger('decision', {
    station: 'plant',
    route: { track: route.track, rigor: route.rigor, kind: route.kind, rungs: route.rungs },
    base,
    branch,
  });
  sh('git', ['add', 'intent', 'ledger']);
  const c = sh('git', [
    'commit',
    '-q',
    '-m',
    `chore(intent): plant ${PLAN} (${route.track}, ${route.rigor}, ${route.kind})`,
  ]);
  console.log(
    `plant: ${branch} from ${base.slice(0, 7)} · track ${route.track} · rigor ${route.rigor} · rungs ${route.rungs.join(' → ')}${ok(c) ? '' : ' (nothing to commit)'}`,
  );
}

// ---------------------------------------------------------------- go
function go() {
  if (!PLAN) fail('--plan required', 2);
  if (existsSync(join(H, 'estop')))
    fail(`estop present: ${readFileSync(join(H, 'estop'), 'utf8').trim()}`, 3);
  const dir = join(ROOT, 'intent', PLAN);
  const route = readJson(join(dir, 'ROUTE.json'));
  if (!route) fail('not planted (no ROUTE.json)', 2);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== route.branch) fail(`on ${branch}, plan lives on ${route.branch}`, 2);
  const rounds = Number(arg('rounds', harness.yolo?.rounds || 1));
  const budgetUsd = Number(harness.budgets?.usd_per_seat || 3);
  const seatPrompt = join(ROOT, '.claude', 'seats', 'master.md');
  if (!existsSync(seatPrompt)) fail('no .claude/seats/master.md (install the bundle)', 2);
  const state = readJson(join(dir, 'STATE.json'), { rounds: 0, status: 'planted' });

  for (let i = 0; i < rounds; i++) {
    const n = state.rounds + 1;
    // 0. Loop escalations become questions before anything else is decided
    if (relayLoopAttention(dir, state)) writeJson(join(dir, 'STATE.json'), state);
    // 1. decider over open questions; a stop ends the run with needs-input.md
    const dec = script('decider.mjs', '--plan', PLAN);
    const verdicts = safeJson(dec.stdout) || { questions: [] };
    if (verdicts.stop) {
      const q = verdicts.stop;
      writeFileSync(
        join(dir, 'needs-input.md'),
        `# Needs input\n\nRound ${n} of ${PLAN} stopped: ${q.reason}\n\nQuestion: intent/${PLAN}/questions/${q.file}\n\nAlternatives:\n${(q.alternatives || []).map((a) => `- ${a}`).join('\n') || '- (none listed)'}\n\nAnswer by setting \`status: answered\` and \`answer: ...\` on the question file, commit, then run \`npm run harness:go -- --plan ${PLAN}\` again.\n`,
      );
      state.status = 'needs-input';
      writeJson(join(dir, 'STATE.json'), state);
      ledger('question', { round: n, stop: q });
      sh('git', ['add', 'intent', 'ledger']);
      sh('git', ['commit', '-q', '-m', `chore(intent): ${PLAN} needs input (${q.file})`]);
      console.log(`go: stopped at round ${n}, needs-input.md written (${q.reason})`);
      process.exit(4);
    }
    // 2. one Master session
    const context = [
      readFileSync(seatPrompt, 'utf8'),
      `\n\n--- ROUTE ---\n${JSON.stringify(route, null, 2)}`,
      `\n\n--- INTENT ---\n${readFileSync(join(dir, 'INTENT.md'), 'utf8')}`,
      existsSync(join(dir, 'SEAL.md'))
        ? `\n\n--- SEAL (already written) ---\n${readFileSync(join(dir, 'SEAL.md'), 'utf8')}`
        : '',
      blockingReview(),
      `\n\n--- ROUND ---\nThis is round ${n} of at most ${rounds}. Plan ${PLAN} on branch ${branch}. Decided questions: ${JSON.stringify(verdicts.questions)}.`,
    ].join('');
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['continue', 'sealed', 'done', 'blocked'] },
        rung: { type: 'string' },
        summary: { type: 'string' },
        questions_written: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
      },
      required: ['status', 'summary'],
    });
    const t = Date.now();
    ledger('seat-start', { round: n, seat: 'master', budgetUsd });
    const r = sh(
      'claude',
      [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        schema,
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Read,Write,Edit,MultiEdit,Glob,Grep,Bash(npm run *),Bash(node scripts/harness/*),Bash(npx playwright *),Bash(npx playwright-cli *),Bash(git add *),Bash(git commit *),Bash(git status*),Bash(git diff*),Bash(git log*)',
        '--max-budget-usd',
        String(budgetUsd),
        ...(harness.yolo?.model ? ['--model', harness.yolo.model] : []),
      ],
      { input: context },
    );
    const out = safeJson(r.stdout);
    const result = out?.structured_output || safeJson(out?.result) || null;
    const minutes = Math.round((Date.now() - t) / 6000) / 10;
    const seat = {
      round: n,
      seat: 'master',
      ok: ok(r) && !!result && !out?.is_error,
      status: result?.status ?? null,
      minutes,
      cost_usd: out?.total_cost_usd ?? null,
      turns: out?.num_turns ?? null,
      tokens: out?.usage ?? null,
    };
    stat({
      session: out?.session_id || `master:${PLAN}:${n}`,
      station: 'master',
      tool: 'claude -p',
      ...seat,
    });
    ledger('seat-end', seat);
    writeJson(join(H, `master-${PLAN}-${n}.json`), {
      seat,
      result,
      raw: out?.is_error ? out?.result : undefined,
    });
    if (!seat.ok) {
      console.error(
        `go: master seat failed in round ${n}: ${String(out?.result || r.stderr).slice(0, 300)}`,
      );
      state.status = 'seat-failed';
      writeJson(join(dir, 'STATE.json'), state);
      ledger('estop', { round: n, reason: 'master seat failed' });
      writeFileSync(join(H, 'estop'), `${PLAN}: master seat failed in round ${n}\n`);
      process.exit(1);
    }
    for (const d of result.decisions || [])
      ledger('decision', { round: n, text: d }, 'agent:master');
    state.rounds = n;
    state.status = result.status;
    state.last = { rung: result.rung, summary: result.summary, at: new Date().toISOString() };
    writeJson(join(dir, 'STATE.json'), state);
    ledger('round', {
      round: n,
      status: result.status,
      rung: result.rung,
      minutes,
      cost_usd: seat.cost_usd,
    });
    // the seat commits its own work; anything left over, the round line included, is committed here so
    // the branch is whole and the tree is clean for whatever runs next (the Loop refuses a dirty tree,
    // test-run marks results from one as unmeasurable)
    sh('git', ['add', '-A']);
    sh('git', [
      'commit',
      '-q',
      '-m',
      `chore(round): ${PLAN} round ${n} (${result.status}: ${result.rung || '-'})`,
    ]);
    console.log(
      `go: round ${n} ${result.status} · ${result.rung || '-'} · ${minutes} min · $${seat.cost_usd ?? '?'} · ${result.summary}`,
    );
    if (result.rung === 'build' && route.track !== 'vertical' && result.status === 'continue') {
      // H-28: stories are the Loop's job; run it now, then the next round reviews what it built
      const b = spawnSync(
        'node',
        [join(ROOT, 'scripts', 'harness', 'round.mjs'), 'build', '--plan', PLAN],
        { cwd: ROOT, stdio: 'inherit' },
      );
      if (b.status !== 0) process.exit(b.status || 4);
      Object.assign(state, readJson(join(dir, 'STATE.json'), state));
    }
    if (result.status === 'blocked') {
      writeFileSync(
        join(dir, 'needs-input.md'),
        `# Needs input\n\nThe Master reported blocked in round ${n}: ${result.summary}\n`,
      );
      process.exit(4);
    }
    if (result.status === 'sealed' || result.status === 'done') break;
  }
  if (!['sealed', 'done'].includes(state.status)) {
    console.log(`go: ${rounds} round(s) used, status ${state.status}; run go again or estop`);
    process.exit(0);
  }
  if (!existsSync(join(dir, 'SEAL.md')))
    fail('Master reported sealed but intent/<plan>/SEAL.md is missing', 1);
  // 3. deliver: push, PR, pipeline
  handoff(`${PLAN} sealed`);
  const push = sh('git', ['push', '-q', '-u', 'origin', branch]);
  if (!ok(push)) fail(`push failed: ${push.stderr.slice(-300)}`);
  const existing = safeJson(sh('gh', ['pr', 'view', '--json', 'number,state']).stdout || '');
  if (!existing || existing.state !== 'OPEN') {
    const body = readFileSync(join(dir, 'SEAL.md'), 'utf8');
    const pr = sh('gh', [
      'pr',
      'create',
      '--title',
      `${branch}: ${route.kind} at ${route.rigor}`,
      '--body',
      body,
    ]);
    if (!ok(pr)) fail(`gh pr create failed: ${pr.stderr.slice(-300)}`);
    console.log(`go: PR opened ${pr.stdout.trim()}`);
  }
  const pipe = spawnSync(
    'node',
    [join(ROOT, 'scripts', 'harness', 'pipeline.mjs'), 'run', '--plan', PLAN],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exit(pipe.status ?? 1);
}

// H-20: a station that blocks must hand its reason back into the run, not to a human. The review
// station writes .harness/review.json and exits; the next Master round reads the blocking findings
// from here. A passing review overwrites the file, so a fixed plan carries nothing forward.
function blockingReview() {
  const r = readJson(join(H, 'review.json'));
  if (!r || r.verdict === 'pass' || !Array.isArray(r.findings) || !r.findings.length) return '';
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };
  const at = rank[r.block_at] || 3;
  const blocking = r.findings.filter((f) => (rank[f.severity] || 0) >= at);
  const rest = r.findings.filter((f) => !blocking.includes(f));
  const row = (f) =>
    `- [${f.severity}] ${f.lens ? f.lens + ' · ' : ''}${f.file || '(no file)'}${f.line ? ':' + f.line : ''}\n  ${f.summary}\n  ${f.why || ''}`.trim();
  return [
    `\n\n--- REVIEW (${r.verdict}, blocked at ${r.sha ? String(r.sha).slice(0, 7) : '?'}) ---`,
    `The pipeline refused this plan at the review station. Answer every blocking finding in the code or`,
    ` in the canon before you seal again; if you believe one is wrong, write a question file saying why.`,
    `\n\nBLOCKING (${blocking.length}):\n${blocking.map(row).join('\n')}`,
    rest.length ? `\n\nOTHER (${rest.length}, not blocking):\n${rest.map(row).join('\n')}` : '',
  ].join('');
}

// ---------------------------------------------------------------- estop
function estop() {
  const reason = arg('reason', 'human estop');
  writeFileSync(join(H, 'estop'), `${PLAN || '*'}: ${reason}\n`);
  if (PLAN) ledger('estop', { reason }, 'user');
  console.log(
    `estop written for ${PLAN || 'all plans'}: ${reason} (remove .harness/estop to resume)`,
  );
}
function clear() {
  rmSync(join(H, 'estop'), { force: true });
  rmSync(join(H, 'breaker.json'), { force: true });
  console.log('estop and breaker cleared');
}

// ---------------------------------------------------------------- loop (H-28)
// BMAD Loop drives stories at the build rung on the method and enterprise tracks. Its CRITICAL
// escalations land as ATTENTION files in .bmad-loop/runs/<id>/; they are relayed into question files
// with the authorityGap trigger so the decider, not the Loop, stops the round.
function relayLoopAttention(dir, state) {
  const seen = new Set(state.loopAttentionSeen || []);
  const roots = ['runs', 'sweeps'].map((d) => join(ROOT, '.bmad-loop', d)).filter(existsSync);
  let n = 0;
  for (const root of roots)
    for (const run of readdirSync(root)) {
      const f = join(root, run, 'ATTENTION');
      if (!existsSync(f) || seen.has(`${run}`)) continue;
      const qdir = join(dir, 'questions');
      mkdirSync(qdir, { recursive: true });
      const idx = readdirSync(qdir).filter((x) => /^Q-\d+\.md$/.test(x)).length + 1;
      writeFileSync(
        join(qdir, `Q-${idx}.md`),
        `---\nkind: ops\nstakes: 0.5\ntriggers: [authorityGap]\nstatus: open\nasked_by: loop:${run}\nalternatives: [resolve with bmad-loop resolve, defer the story, estop]\n---\n# BMAD Loop escalation (${run})\n\n${readFileSync(f, 'utf8').trim()}\n`,
      );
      seen.add(run);
      n++;
    }
  state.loopAttentionSeen = [...seen];
  return n;
}
function build() {
  if (!PLAN) fail('--plan required', 2);
  const dir = join(ROOT, 'intent', PLAN);
  const state = readJson(join(dir, 'STATE.json'), { rounds: 0, status: 'planted' });
  const max = arg('max-stories', '3');
  handoff(`${PLAN} build rung planned`); // bmad-loop validate refuses a dirty tree too
  if (productDirty())
    fail(
      'uncommitted product changes on the branch; the build station starts from a whole branch',
      2,
    );
  const v = sh('bmad-loop', ['validate']);
  if (!ok(v))
    fail(`bmad-loop validate failed:\n${(v.stdout + v.stderr).split('\n').slice(-6).join('\n')}`);
  ledger('seat-start', { seat: 'loop', maxStories: Number(max) }, 'script:round');
  handoff(`${PLAN} build rung starts`); // bmad-loop run refuses a dirty tree
  const t = Date.now();
  const r = spawnSync('bmad-loop', ['run', '--max-stories', String(max)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const minutes = Math.round((Date.now() - t) / 6000) / 10;
  const relayed = relayLoopAttention(dir, state);
  writeJson(join(dir, 'STATE.json'), state);
  stat({
    session: `loop:${PLAN}:${state.rounds + 1}`,
    station: 'build',
    tool: 'bmad-loop',
    ok: r.status === 0,
    minutes,
    cost_usd: null,
    tokens: null,
  });
  ledger(
    'seat-end',
    { seat: 'loop', station: 'build', ok: r.status === 0, minutes, escalations: relayed },
    'script:round',
  );
  sh('git', ['add', '-A']);
  sh('git', [
    'commit',
    '-q',
    '-m',
    `chore(round): ${PLAN} build rung by bmad-loop (${r.status === 0 ? 'ok' : 'stopped'}, ${relayed} escalation(s))`,
  ]);
  console.log(
    `build: bmad-loop ${r.status === 0 ? 'finished' : 'stopped'} in ${minutes} min, ${relayed} escalation(s) relayed to questions`,
  );
  process.exit(r.status === 0 && !relayed ? 0 : 4);
}

// ---------------------------------------------------------------- observe
function observe() {
  if (!PLAN) fail('--plan required', 2);
  const seatPrompt = join(ROOT, '.claude', 'seats', 'observer.md');
  if (!existsSync(seatPrompt)) fail('no .claude/seats/observer.md (install the bundle)', 2);
  const rubric = script('rubric.mjs', '--plan', PLAN, '--json').stdout;
  const ledgerText = existsSync(join(ROOT, 'ledger', `${PLAN}.jsonl`))
    ? readFileSync(join(ROOT, 'ledger', `${PLAN}.jsonl`), 'utf8')
    : '(no ledger)';
  const log = git(['log', '--oneline', '-30']);
  const route =
    readJson(join(ROOT, 'records', PLAN, 'ROUTE.json')) ||
    readJson(join(ROOT, 'intent', PLAN, 'ROUTE.json'));
  const landed = readJson(join(H, 'land.json'));
  const diff = landed?.mergeSha
    ? git(['diff', '--stat', `${landed.mergeSha}~1..HEAD`, '--', 'canon'])
    : '(no landing yet)';
  const statsText = script('stats.mjs').stdout;
  const context = [
    readFileSync(seatPrompt, 'utf8'),
    `\n\n--- APP ---\n${APP} plan ${PLAN}`,
    `\n\n--- RUBRIC ---\n${rubric.slice(0, 20000)}`,
    `\n\n--- ROUTE ---\n${JSON.stringify(route)}`,
    `\n\n--- LEDGER ---\n${ledgerText.slice(0, 60000)}`,
    `\n\n--- GIT LOG ---\n${log}`,
    `\n\n--- CANON DIFF ---\n${diff}`,
    `\n\n--- STATS ---\n${statsText}`,
    `\n\n--- HARNESS ---\nbundle ${JSON.stringify(harness.bundle || null)}; lenses ${(harness.pipeline?.review?.lenses || []).join(', ')}`,
    `\n\n--- MASTER SEAT PROMPT (.claude/seats/master.md) ---\n${existsSync(join(ROOT, '.claude', 'seats', 'master.md')) ? readFileSync(join(ROOT, '.claude', 'seats', 'master.md'), 'utf8') : '(none)'}`,
  ].join('');
  const budgetUsd = Number(harness.budgets?.usd_per_seat || 3);
  const t = Date.now();
  const r = sh(
    'claude',
    [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--setting-sources',
      'user',
      '--max-budget-usd',
      String(budgetUsd),
      ...(harness.yolo?.model ? ['--model', harness.yolo.model] : []),
    ],
    { input: context },
  );
  const out = safeJson(r.stdout);
  const minutes = Math.round((Date.now() - t) / 6000) / 10;
  const okSeat = ok(r) && out && !out.is_error && typeof out.result === 'string';
  stat({
    session: out?.session_id || `observer:${PLAN}`,
    station: 'observer',
    tool: 'claude -p',
    ok: okSeat,
    minutes,
    cost_usd: out?.total_cost_usd ?? null,
    tokens: out?.usage ?? null,
  });
  if (!okSeat) fail(`observer seat failed: ${String(out?.result || r.stderr).slice(0, 300)}`);
  const runsDir = join(ROOT, '..', 'runs', APP, PLAN);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, 'observer.md'), out.result.trim() + '\n');
  console.log(
    `observe: report written to runs/${APP}/${PLAN}/observer.md (${minutes} min, $${out.total_cost_usd ?? '?'})`,
  );
}

const commands = { plant, go, build, estop, clear, observe };
if (commands[cmd]) commands[cmd]();
else fail(`usage: round.mjs plant|go|estop|clear --plan <slug> (app ${APP})`, 2);
