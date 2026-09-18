#!/usr/bin/env node
// One conducted wave (H-32, H-33 steps 1 to 4). The Master decides, this script spawns:
//   1. the Master is a tool-less claude -p call that returns {decision, activations[{agent, task}],
//      reason, rejected};
//   2. the decision is validated against the roster (a wave holds at most conduct.max_wave agents with
//      disjoint owned paths) and recorded as an `activation` ledger line;
//   3. every activated agent runs as its own claude -p session at the same time, with its own prompt,
//      tools and budget;
//   4. what each session did is read from its transcript and from git, never from what it says;
//   5. each agent's owned files are committed under its own name;
//   6. each question an agent raised becomes a file, the decider gives its verdict, and the Master
//      answers only what the decider allowed; a floor trigger stops the step with needs-input.md.
// Checks decide pass or fail.
// Usage: node scripts/harness/conduct.mjs --plan <slug> [--expect <agent[+agent]|no-move>]
//        [--expect-question none|answered|needs-input]
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  ROOT,
  readJson,
  writeJson,
  git,
  productDirty,
  bookkeepingDirty,
  BOOKKEEPING,
} from './common.mjs';
import {
  resolveOwns,
  rosterById,
  validateActivation,
  parsePorcelain,
  outsideJurisdiction,
  transcriptDir,
  toolUses,
  authoringCalls,
  authoredPaths,
  overlapSeconds,
  chosenKey,
  rejectionOptions,
} from './activation.mjs';
import {
  KINDS,
  TRIGGERS,
  validateQuestion,
  renderQuestion,
  validateAnswer,
  questionOutcome,
  setFields,
} from './question.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PLAN = arg('plan');
// a test oracle for the lab: the agents the intent should lead to, joined by "+" in any order, or
// no-move; never shown to the Master
const EXPECT = arg('expect', null)?.split('+').sort().join('+') ?? null;
// the same kind of oracle for what the agent's questions should come to
const EXPECT_Q = arg('expect-question', null);
const H = join(ROOT, '.harness');
mkdirSync(H, { recursive: true });
const harness = readJson(join(ROOT, 'harness.json'), {});
const MODEL = harness.yolo?.model || null;
// sessions at once; the laptop's limit (H-18: parallelism 2)
const MAX_WAVE = harness.conduct?.max_wave || 2;
const sh = (file, args, opts = {}) =>
  spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const ok = (r) => r.status === 0;
const fail = (msg, code = 1) => {
  console.error(`conduct: ${msg}`);
  process.exit(code);
};
const ledger = (kind, data, actor = 'script:conduct') =>
  sh('node', [
    join(ROOT, 'scripts', 'harness', 'ledger.mjs'),
    'append',
    '--plan',
    PLAN,
    '--kind',
    kind,
    '--actor',
    actor,
    '--data',
    JSON.stringify(data),
  ]);
const stat = (row) =>
  writeFileSync(
    join(H, 'stats.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n',
    { flag: 'a' },
  );
// raw stdout: common.mjs git() trims, and a trimmed first porcelain line loses its status column
const porcelain = () =>
  parsePorcelain(sh('git', ['status', '--porcelain', '--untracked-files=all']).stdout);
const handoff = (label) => {
  if (!bookkeepingDirty()) return;
  sh('git', ['add', ...BOOKKEEPING.filter((p) => p !== '.harness')]);
  sh('git', ['commit', '-q', '-m', `chore(ledger): ${label}`]);
};
const transcript = (session) => {
  const f = join(transcriptDir(process.env.HOME || '', ROOT), `${session}.jsonl`);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};

// one headless session, asynchronous so a wave's sessions run at the same time; tools last because
// --tools is variadic
function seat({ session, prompt, budget, schema, tools, permissionMode }) {
  const start = Date.now();
  const child = spawn(
    'claude',
    [
      '-p',
      '--output-format',
      'json',
      ...(schema ? ['--json-schema', schema] : []),
      ...(permissionMode ? ['--permission-mode', permissionMode] : []),
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--session-id',
      session,
      '--max-budget-usd',
      String(budget),
      ...(MODEL ? ['--model', MODEL] : []),
      ...(tools.length ? ['--allowedTools', tools.join(',')] : []),
      '--tools',
      tools.join(','),
    ],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(prompt);
  return new Promise((resolve) =>
    child.on('close', (code) => {
      let out = null;
      try {
        out = JSON.parse(stdout);
      } catch {
        /* unparsable output is a failed seat */
      }
      const end = Date.now();
      resolve({
        ok: code === 0 && !!out && !out.is_error,
        out,
        stderr,
        start,
        end,
        minutes: Math.round((end - start) / 6000) / 10,
      });
    }),
  );
}
const row = (name, station, session, r, extra = {}) => ({
  seat: name,
  station,
  session: r.out?.session_id || session,
  ok: r.ok,
  started: new Date(r.start).toISOString(),
  ended: new Date(r.end).toISOString(),
  minutes: r.minutes,
  cost_usd: r.out?.total_cost_usd ?? null,
  turns: r.out?.num_turns ?? null,
  tokens: r.out?.usage ?? null,
  tools: toolUses(transcript(session)),
  ...extra,
});
const commitAs = (who, paths, msg) => {
  sh('git', ['add', '--', ...paths]);
  return sh('git', [
    '-c',
    `user.name=${who}`,
    '-c',
    'user.email=seat@harness.local',
    'commit',
    '-q',
    '-m',
    msg,
  ]);
};

// ---------------------------------------------------------------- preconditions
if (!PLAN) fail('--plan required', 2);
const dir = join(ROOT, 'intent', PLAN);
const intentFile = join(dir, 'INTENT.md');
if (!existsSync(intentFile)) fail(`no ${intentFile}`, 2);
const route = readJson(join(dir, 'ROUTE.json'));
if (!route) fail('not planted (no ROUTE.json); run harness:plant first', 2);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== route.branch) fail(`on ${branch}, plan lives on ${route.branch}`, 2);
const roster = readJson(join(ROOT, '.claude', 'roster', 'roster.json'));
if (!roster?.agents?.length) fail('no .claude/roster/roster.json (install the bundle)', 2);
const conductorPrompt = join(ROOT, '.claude', 'seats', 'conductor.md');
if (!existsSync(conductorPrompt)) fail('no .claude/seats/conductor.md (install the bundle)', 2);
handoff(`${PLAN} conduct starts`);
if (productDirty() || porcelain().length)
  fail('the tree is not clean; a conducted step starts from a whole branch', 2);

// ---------------------------------------------------------------- 1. the Master decides
const intent = readFileSync(intentFile, 'utf8');
const rosterView = roster.agents.map((a) => ({
  id: a.id,
  purpose: a.purpose,
  owns: resolveOwns(a.owns, PLAN),
}));
const schema = JSON.stringify({
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['activate', 'no-move'] },
    activations: {
      type: 'array',
      maxItems: MAX_WAVE,
      items: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: roster.agents.map((a) => a.id) },
          task: { type: 'string' },
        },
        required: ['agent', 'task'],
      },
    },
    reason: { type: 'string' },
    wave_reason: { type: 'string' },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          option: { type: 'string', enum: rejectionOptions(roster) },
          why: { type: 'string' },
        },
        required: ['option', 'why'],
      },
    },
  },
  required: ['decision', 'activations', 'reason', 'wave_reason', 'rejected'],
});
const masterSession = randomUUID();
ledger('seat-start', { seat: 'master', session: masterSession, station: 'conduct' });
const master = await seat({
  session: masterSession,
  prompt: [
    readFileSync(conductorPrompt, 'utf8'),
    `\n\n--- PLAN ---\n${PLAN} on ${branch}, track ${route.track}, rigor ${route.rigor}; at most ${MAX_WAVE} agent(s) at once`,
    `\n\n--- INTENT ---\n${intent}`,
    `\n\n--- ROSTER ---\n${JSON.stringify(rosterView, null, 2)}`,
  ].join(''),
  budget: harness.budgets?.usd_per_master_call || 0.5,
  schema,
  tools: [],
});
const masterRow = row('master', 'conduct', masterSession, master, {
  changed: porcelain().filter((p) => !p.startsWith('ledger/')),
});
const act = master.out?.structured_output ?? null;
ledger('seat-end', masterRow);
stat({ tool: 'claude -p', ...masterRow });
if (!master.ok || !act) {
  ledger('decision', {
    station: 'conduct',
    decision: 'master-failed',
    stderr: master.stderr?.slice(-400),
  });
  handoff(`${PLAN} master seat failed`);
  fail(`master seat failed: ${String(master.out?.result || master.stderr).slice(0, 300)}`);
}

// ---------------------------------------------------------------- 2. the decision is validated and recorded
const valid = validateActivation(act, roster, { plan: PLAN, maxWave: MAX_WAVE });
const byId = rosterById(roster);
const wave = (act.decision === 'activate' ? act.activations || [] : []).map((a) => ({
  ...a,
  def: byId.get(a.agent),
  owned: resolveOwns(byId.get(a.agent)?.owns, PLAN),
}));
ledger(
  'activation',
  {
    wave: 1,
    decision: act.decision,
    activations: wave.map((a) => ({ agent: a.agent, task: a.task, owns: a.owned })),
    reason: act.reason,
    wave_reason: act.wave_reason ?? null,
    rejected: act.rejected || [],
    max_wave: MAX_WAVE,
    valid: valid.ok,
    refusals: valid.refusals,
    master_session: masterRow.session,
  },
  'agent:master',
);
handoff(`${PLAN} activation recorded`);
const chose = chosenKey(act);
const masterChecks = () => ({
  'master-authored-nothing': {
    ok: authoringCalls(masterRow.tools) === 0 && !masterRow.changed.length,
    msg: `master tool calls ${JSON.stringify(masterRow.tools)}, files changed during its call: ${masterRow.changed.length}`,
  },
  'activation-recorded': {
    ok: valid.ok,
    msg: valid.ok
      ? `agent:master chose ${chose} because "${act.reason}"; rejected ${(act.rejected || []).length} option(s)`
      : `refused: ${valid.refusals.join('; ')}`,
  },
  ...(EXPECT
    ? {
        'chose-expected': {
          ok: chose === EXPECT,
          msg: `expected ${EXPECT}, the Master chose ${chose}`,
        },
      }
    : {}),
});
// every ending writes the same record, ledger line and summary: a refusal or a no-move is a verdict,
// never a silent exit
function finish(checks, extra = {}) {
  const pass = Object.values(checks).every((c) => c.ok);
  writeJson(join(H, `conduct-${PLAN}.json`), {
    plan: PLAN,
    expect: EXPECT,
    expect_question: EXPECT_Q,
    decision: act.decision,
    chose,
    pass,
    checks,
    master: masterRow,
    ...extra,
  });
  ledger('decision', {
    station: 'conduct',
    decision: pass ? 'pass' : 'fail',
    chose,
    expect: EXPECT,
    checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok])),
  });
  handoff(`${PLAN} conduct ${pass ? 'passed' : 'failed'}`);
  for (const [k, v] of Object.entries(checks))
    console.log(`${v.ok ? 'pass' : 'FAIL'}  ${k.padEnd(24)} ${v.msg}`);
  console.log(`conduct: ${pass ? 'PASSED' : 'FAILED'} · chose ${chose}`);
  process.exit(pass ? 0 : 1);
}
if (!valid.ok || act.decision === 'no-move') finish(masterChecks());

// ---------------------------------------------------------------- 3. the script spawns the wave
const askingFile = join(ROOT, '.claude', 'roster', 'asking.md');
const agentSchema = JSON.stringify({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    questions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          why: { type: 'string' },
          alternatives: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
          recommend: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          stakes: { type: 'number', minimum: 0, maximum: 1 },
          triggers: { type: 'array', items: { type: 'string', enum: TRIGGERS } },
        },
        required: ['question', 'why', 'alternatives', 'recommend', 'kind', 'stakes', 'triggers'],
      },
    },
  },
  required: ['summary', 'questions'],
});
for (const a of wave) {
  const promptFile = join(ROOT, '.claude', 'roster', a.def.prompt);
  if (!existsSync(promptFile)) fail(`no ${promptFile}`, 2);
  a.session = randomUUID();
  a.prompt = [
    readFileSync(promptFile, 'utf8'),
    `\n\n--- OWNS ---\n${a.owned.join('\n')}`,
    `\n\n--- TASK (from the Master) ---\n${a.task}`,
    `\n\n--- INTENT ---\n${intent}`,
    existsSync(askingFile) ? `\n\n${readFileSync(askingFile, 'utf8')}` : '',
  ].join('');
  ledger('seat-start', { seat: a.agent, session: a.session, station: 'conduct', owns: a.owned });
}
handoff(`${PLAN} ${wave.map((a) => a.agent).join(' + ')} start`);
const results = await Promise.all(
  wave.map((a) =>
    seat({
      session: a.session,
      prompt: a.prompt,
      budget: a.def.budget_usd || 1,
      schema: agentSchema,
      tools: a.def.tools || ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'acceptEdits',
    }),
  ),
);

// ---------------------------------------------------------------- 4. witnesses: transcripts and git
// git sees the wave's changes together; each transcript says which session wrote what
const changed = porcelain().filter((p) => !p.startsWith('ledger/'));
const waveOwned = wave.flatMap((a) => a.owned);
const outsideWave = outsideJurisdiction(changed, waveOwned);
wave.forEach((a, i) => {
  const r = results[i];
  a.result = r;
  a.authored = authoredPaths(transcript(a.session), ROOT);
  a.written = a.owned.filter(
    (p) => existsSync(join(ROOT, p)) && readFileSync(join(ROOT, p), 'utf8').trim(),
  );
  a.asked = r.out?.structured_output?.questions || [];
  a.row = row(a.agent, 'conduct', a.session, r, {
    authored: a.authored,
    outside: outsideJurisdiction(a.authored, a.owned),
    summary: String(r.out?.structured_output?.summary || r.out?.result || '').slice(0, 600),
    questions: a.asked.length,
  });
  ledger('seat-end', a.row);
  stat({ tool: 'claude -p', ...a.row });
});

// ---------------------------------------------------------------- 5. commit what each agent owns, under its name
for (const a of wave)
  if (a.written.length && !a.row.outside.length && !outsideWave.length) {
    const c = commitAs(
      `seat:${a.agent}`,
      a.written,
      `docs(intent): ${PLAN} ${a.written.join(', ')} by seat:${a.agent}`,
    );
    if (ok(c)) a.commit = git(['rev-parse', 'HEAD']);
  }

// ---------------------------------------------------------------- 6. questions: decider first, the Master only if allowed
const qdir = join(dir, 'questions');
const qResults = [];
const answerRows = [];
const asked = wave.flatMap((a) => a.asked.map((q) => ({ a, q })));
if (asked.length) {
  mkdirSync(qdir, { recursive: true });
  let n = readdirSync(qdir).filter((f) => /^Q-\d+\.md$/.test(f)).length;
  for (const { a, q } of asked) {
    const v = validateQuestion(q);
    const file = v.ok ? `Q-${++n}.md` : null;
    if (file)
      writeFileSync(
        join(qdir, file),
        renderQuestion(q, { asked_by: `seat:${a.agent}`, phase: 'conduct' }),
      );
    ledger(
      'question',
      { file, valid: v.ok, refusals: v.refusals, ...q, agent_session: a.row.session },
      `agent:${a.agent}`,
    );
    qResults.push({ file, agent: a.agent, valid: v.ok, refusals: v.refusals, q, a });
  }
  for (const a of wave) {
    const files = qResults
      .filter((r) => r.a === a && r.file)
      .map((r) => `intent/${PLAN}/questions/${r.file}`);
    if (files.length)
      commitAs(
        `seat:${a.agent}`,
        files,
        `docs(intent): ${PLAN} ${files.map((f) => f.split('/').pop()).join(', ')} raised by seat:${a.agent}`,
      );
  }
  handoff(`${PLAN} questions raised`);

  // the decider is the rule; it writes its verdict on each open question file
  const d = sh('node', [join(ROOT, 'scripts', 'harness', 'decider.mjs'), '--plan', PLAN]);
  let verdicts = null;
  try {
    verdicts = JSON.parse(d.stdout);
  } catch {
    /* no verdicts is a failed decider, recorded below */
  }
  const files = qResults.filter((r) => r.file).map((r) => `intent/${PLAN}/questions/${r.file}`);
  for (const r of qResults.filter((x) => x.file)) {
    const vq = verdicts?.questions?.find((x) => x.file === r.file) || {};
    Object.assign(r, {
      verdict: vq.verdict ?? null,
      reason: vq.reason ?? null,
      fired: vq.fired ?? [],
      stopsRound: !!vq.stopsRound,
    });
    ledger(
      'decision',
      {
        station: 'decider',
        file: r.file,
        verdict: r.verdict,
        reason: r.reason,
        fired: r.fired,
        stops: r.stopsRound,
        mode: verdicts?.mode ?? null,
      },
      'script:decider',
    );
  }
  if (files.length)
    commitAs(
      'script:decider',
      files,
      `chore(intent): ${PLAN} decider verdicts on ${files.length} question(s)`,
    );
  handoff(`${PLAN} decider verdicts`);

  if (verdicts?.stop) {
    // a floor trigger is a human-MUST: the Master is not asked, the step ends here
    const s = verdicts.stop;
    writeFileSync(
      join(dir, 'needs-input.md'),
      `# Needs input\n\n${PLAN} stopped: ${s.reason}\n\nQuestion: intent/${PLAN}/questions/${s.file}\n\nAlternatives:\n${(s.alternatives || []).map((x) => `- ${x}`).join('\n') || '- (none listed)'}\n\nAnswer by setting \`status: answered\` and \`answer: ...\` on the question file and commit.\n`,
    );
    ledger('question', { stop: s, needs_input: `intent/${PLAN}/needs-input.md` }, 'script:decider');
    commitAs(
      'script:decider',
      [`intent/${PLAN}/needs-input.md`],
      `chore(intent): ${PLAN} needs input (${s.file})`,
    );
    handoff(`${PLAN} needs input`);
  } else {
    const answerer = join(ROOT, '.claude', 'seats', 'answerer.md');
    for (const r of qResults.filter((x) => x.verdict === 'allow')) {
      const qPath = join(qdir, r.file);
      const alts = r.q.alternatives;
      const document = r.a.owned
        .filter((p) => existsSync(join(ROOT, p)))
        .map((p) => `### ${p}\n${readFileSync(join(ROOT, p), 'utf8')}`)
        .join('\n\n');
      const session = randomUUID();
      ledger('seat-start', { seat: 'master', session, station: 'answer', file: r.file });
      const m = await seat({
        session,
        prompt: [
          readFileSync(answerer, 'utf8'),
          `\n\n--- PLAN ---\n${PLAN} on ${branch}, track ${route.track}, rigor ${route.rigor}`,
          `\n\n--- INTENT ---\n${intent}`,
          `\n\n--- QUESTION (intent/${PLAN}/questions/${r.file}, raised by ${r.agent}) ---\n${readFileSync(qPath, 'utf8')}`,
          `\n\n--- DOCUMENT ---\n${document}`,
        ].join(''),
        budget: harness.budgets?.usd_per_master_call || 0.5,
        schema: JSON.stringify({
          type: 'object',
          properties: {
            answer: { type: 'string', enum: alts },
            reason: { type: 'string' },
            rejected: {
              type: 'array',
              items: {
                type: 'object',
                properties: { option: { type: 'string', enum: alts }, why: { type: 'string' } },
                required: ['option', 'why'],
              },
            },
          },
          required: ['answer', 'reason', 'rejected'],
        }),
        tools: [],
      });
      const ans = m.out?.structured_output ?? null;
      const va = validateAnswer(ans, r.q);
      const aRow = row('master', 'answer', session, m, {
        file: r.file,
        changed: porcelain().filter((p) => !p.startsWith('ledger/')),
      });
      ledger('seat-end', aRow);
      stat({ tool: 'claude -p', ...aRow });
      ledger(
        'answer',
        {
          file: r.file,
          answer: ans?.answer ?? null,
          reason: ans?.reason ?? null,
          rejected: ans?.rejected || [],
          valid: m.ok && va.ok,
          refusals: va.refusals,
          master_session: aRow.session,
        },
        'agent:master',
      );
      answerRows.push(aRow);
      r.answered = m.ok && va.ok && authoringCalls(aRow.tools) === 0 && !aRow.changed.length;
      r.answer = ans?.answer ?? null;
      r.answerRefusals = va.refusals;
      if (r.answered) {
        const text = setFields(readFileSync(qPath, 'utf8'), {
          status: 'answered',
          answer: ans.answer,
          answered_by: 'agent:master',
        });
        writeFileSync(
          qPath,
          `${text.trimEnd()}\n\n## Answer (agent:master)\n\n${ans.answer}\n\n${ans.reason}\n\nRejected:\n${ans.rejected.map((x) => `- ${x.option}: ${x.why}`).join('\n')}\n`,
        );
        commitAs(
          'seat:master',
          [`intent/${PLAN}/questions/${r.file}`],
          `docs(intent): ${PLAN} ${r.file} answered by agent:master`,
        );
      }
      handoff(`${PLAN} ${r.file} answer recorded`);
    }
  }
}
const outcome = questionOutcome(qResults.filter((r) => r.file));
const qChecks =
  EXPECT_Q || asked.length
    ? {
        'question-raised': {
          ok:
            EXPECT_Q === 'none'
              ? !asked.length
              : asked.length > 0 && qResults.every((r) => r.valid),
          msg: asked.length
            ? qResults
                .map((r) =>
                  r.valid
                    ? `${r.file} by ${r.agent} (${r.q.kind}, stakes ${r.q.stakes}, triggers ${JSON.stringify(r.q.triggers)})`
                    : `${r.agent} refused: ${r.refusals.join('; ')}`,
                )
                .join(' · ')
            : 'no question raised',
        },
        ...(asked.length
          ? {
              'decider-verdict-recorded': {
                ok: qResults
                  .filter((r) => r.file)
                  .every(
                    (r) =>
                      r.verdict &&
                      /decided_by: script:decider/.test(readFileSync(join(qdir, r.file), 'utf8')),
                  ),
                msg: qResults
                  .filter((r) => r.file)
                  .map((r) => `${r.file} ${r.verdict}: ${r.reason}`)
                  .join(' · '),
              },
            }
          : {}),
        'question-outcome': {
          ok: EXPECT_Q ? outcome === EXPECT_Q : outcome !== 'parked',
          msg: `${EXPECT_Q ? `expected ${EXPECT_Q}, ` : ''}got ${outcome}`,
        },
        ...(outcome === 'needs-input'
          ? {
              'master-did-not-answer': {
                ok:
                  !answerRows.length &&
                  existsSync(join(dir, 'needs-input.md')) &&
                  qResults.every((r) => !r.answered),
                msg: `answer seats run: ${answerRows.length}; needs-input.md written`,
              },
            }
          : {}),
        ...(answerRows.length
          ? {
              'answers-valid': {
                ok: qResults.filter((r) => r.verdict === 'allow').every((r) => r.answered),
                msg: qResults
                  .filter((r) => r.verdict === 'allow')
                  .map((r) =>
                    r.answered
                      ? `${r.file} → "${r.answer}"`
                      : `${r.file} refused: ${(r.answerRefusals || []).join('; ') || 'seat failed or authored'}`,
                  )
                  .join(' · '),
              },
            }
          : {}),
      }
    : {};

const sessions = [masterRow.session, ...wave.map((a) => a.row.session)];
const overlap = overlapSeconds(results.map((r) => ({ start: r.start, end: r.end })));
const checks = {
  'sessions-distinct': {
    ok:
      new Set(sessions).size === sessions.length &&
      [masterSession, ...wave.map((a) => a.session)].every((s) => !!transcript(s)),
    msg: `master ${masterRow.session.slice(0, 8)}, ${wave.map((a) => `${a.agent} ${a.row.session.slice(0, 8)}`).join(', ')}; every transcript on disk`,
  },
  ...masterChecks(),
  'agents-in-jurisdiction': {
    ok:
      !outsideWave.length &&
      wave.every(
        (a) => a.result.ok && a.written.length === a.owned.length && !a.row.outside.length,
      ),
    msg: `${wave.map((a) => `${a.agent} owns ${a.owned.join(', ')}, wrote ${a.written.join(', ') || 'nothing'}, its transcript authored ${a.authored.join(', ') || 'nothing'}${a.row.outside.length ? ` (outside: ${a.row.outside.join(', ')})` : ''}`).join(' · ')}; tree changes outside the wave: ${outsideWave.join(', ') || 'none'}`,
  },
  ...(wave.length > 1
    ? {
        'ran-in-parallel': {
          ok: overlap > 0,
          msg: `${wave.map((a) => `${a.agent} ${a.row.started.slice(11, 19)}–${a.row.ended.slice(11, 19)}`).join(', ')}; overlap ${overlap}s`,
        },
      }
    : {}),
  ...qChecks,
  'cost-per-session': {
    ok: [masterRow, ...wave.map((a) => a.row), ...answerRows].every(
      (r) => typeof r.cost_usd === 'number',
    ),
    msg: `master $${masterRow.cost_usd}${wave.map((a) => `, ${a.agent} $${a.row.cost_usd}`).join('')}${answerRows.map((r) => `, answer ${r.file} $${r.cost_usd}`).join('')}`,
  },
};
finish(checks, {
  agents: wave.map((a) => ({ ...a.row, commit: a.commit ?? null })),
  overlap_seconds: overlap,
  outcome,
  questions: qResults.map((r) => ({
    file: r.file,
    agent: r.agent,
    valid: r.valid,
    refusals: r.refusals,
    question: r.q.question,
    alternatives: r.q.alternatives,
    verdict: r.verdict ?? null,
    reason: r.reason ?? null,
    fired: r.fired ?? [],
    stopsRound: !!r.stopsRound,
    answered: !!r.answered,
    answer: r.answer ?? null,
  })),
  answers: answerRows,
});
