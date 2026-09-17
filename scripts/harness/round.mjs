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
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson, writeJson, git, headSha } from './common.mjs';

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
  sh('git', ['add', 'intent']);
  const c = sh('git', [
    'commit',
    '-q',
    '-m',
    `chore(intent): plant ${PLAN} (${route.track}, ${route.rigor}, ${route.kind})`,
  ]);
  ledger('decision', {
    station: 'plant',
    route: { track: route.track, rigor: route.rigor, kind: route.kind, rungs: route.rungs },
    base,
    branch,
  });
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
      sh('git', ['add', 'intent']);
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
    const r = sh('claude', [
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
      context,
    ]);
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
    // the seat commits its own work; anything left over is committed here so the branch is always whole
    sh('git', ['add', '-A']);
    sh('git', [
      'commit',
      '-q',
      '-m',
      `chore(round): ${PLAN} round ${n} (${result.status}: ${result.rung || '-'})`,
    ]);
    ledger('round', {
      round: n,
      status: result.status,
      rung: result.rung,
      minutes,
      cost_usd: seat.cost_usd,
    });
    console.log(
      `go: round ${n} ${result.status} · ${result.rung || '-'} · ${minutes} min · $${seat.cost_usd ?? '?'} · ${result.summary}`,
    );
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

const commands = { plant, go, estop, clear };
if (commands[cmd]) commands[cmd]();
else fail(`usage: round.mjs plant|go|estop|clear --plan <slug> (app ${APP})`, 2);
