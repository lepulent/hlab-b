#!/usr/bin/env node
// One conducted activation (H-32, H-33 step 1). The Master decides, this script spawns:
//   1. the Master is a tool-less claude -p call that returns {decision, agent, task, reason, rejected};
//   2. the decision is validated against the roster and recorded as an `activation` ledger line;
//   3. the chosen agent runs as its own claude -p session, with its own prompt, tools and budget;
//   4. what each session did is read from its transcript and from git, never from what it says;
//   5. the agent's owned files are committed under its own name;
//   6. (step 3) each question the agent raised becomes a file, the decider gives its verdict, and the
//      Master answers only what the decider allowed; a floor trigger stops the step with needs-input.md.
// Checks decide pass or fail.
// Usage: node scripts/harness/conduct.mjs --plan <slug> [--expect <agent|no-move>]
//        [--expect-question none|answered|needs-input]
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
// a test oracle for the lab: the agent the intent should lead to (or no-move); never shown to the Master
const EXPECT = arg('expect', null);
// the same kind of oracle for what the agent's questions should come to
const EXPECT_Q = arg('expect-question', null);
const H = join(ROOT, '.harness');
mkdirSync(H, { recursive: true });
const harness = readJson(join(ROOT, 'harness.json'), {});
const MODEL = harness.yolo?.model || null;
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

// one headless session; tools last because --tools is variadic
function seat({ session, prompt, budget, schema, tools, permissionMode }) {
  const t = Date.now();
  const r = sh(
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
    { input: prompt },
  );
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    /* unparsable output is a failed seat */
  }
  return {
    ok: ok(r) && !!out && !out.is_error,
    out,
    stderr: r.stderr,
    minutes: Math.round((Date.now() - t) / 6000) / 10,
  };
}

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
    agent: { type: 'string' },
    task: { type: 'string' },
    reason: { type: 'string' },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        properties: { option: { type: 'string' }, why: { type: 'string' } },
        required: ['option', 'why'],
      },
    },
  },
  required: ['decision', 'reason', 'rejected'],
});
const masterSession = randomUUID();
ledger('seat-start', { seat: 'master', session: masterSession, station: 'conduct' });
const master = seat({
  session: masterSession,
  prompt: [
    readFileSync(conductorPrompt, 'utf8'),
    `\n\n--- PLAN ---\n${PLAN} on ${branch}, track ${route.track}, rigor ${route.rigor}`,
    `\n\n--- INTENT ---\n${intent}`,
    `\n\n--- ROSTER ---\n${JSON.stringify(rosterView, null, 2)}`,
  ].join(''),
  budget: harness.budgets?.usd_per_master_call || 0.5,
  schema,
  tools: [],
});
const masterTools = toolUses(transcript(masterSession));
const masterChanged = porcelain().filter((p) => !p.startsWith('ledger/'));
const act = master.out?.structured_output ?? null;
const masterRow = {
  seat: 'master',
  station: 'conduct',
  session: master.out?.session_id || masterSession,
  ok: master.ok,
  minutes: master.minutes,
  cost_usd: master.out?.total_cost_usd ?? null,
  turns: master.out?.num_turns ?? null,
  tokens: master.out?.usage ?? null,
  tools: masterTools,
  changed: masterChanged,
};
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
const valid = validateActivation(act, roster);
const agentDef = rosterById(roster).get(act.agent);
const owned = agentDef ? resolveOwns(agentDef.owns, PLAN) : [];
ledger(
  'activation',
  {
    wave: 1,
    decision: act.decision,
    agent: act.agent ?? null,
    task: act.task ?? null,
    reason: act.reason,
    rejected: act.rejected || [],
    owns: owned,
    valid: valid.ok,
    refusals: valid.refusals,
    master_session: masterRow.session,
  },
  'agent:master',
);
handoff(`${PLAN} activation recorded`);
const chose = act.decision === 'no-move' ? 'no-move' : act.agent;
const masterChecks = () => ({
  'master-authored-nothing': {
    ok: authoringCalls(masterTools) === 0 && !masterChanged.length,
    msg: `master tool calls ${JSON.stringify(masterTools)}, files changed during its call: ${masterChanged.length}`,
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
  console.log(
    `conduct: ${pass ? 'PASSED' : 'FAILED'} · chose ${chose}${extra.agentCommit ? ` · commit ${extra.agentCommit.slice(0, 7)}` : ''}`,
  );
  process.exit(pass ? 0 : 1);
}
if (!valid.ok) finish(masterChecks());
if (act.decision === 'no-move') finish(masterChecks());

// ---------------------------------------------------------------- 3. the script spawns the agent
const agentPromptFile = join(ROOT, '.claude', 'roster', agentDef.prompt);
if (!existsSync(agentPromptFile)) fail(`no ${agentPromptFile}`, 2);
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
const agentSession = randomUUID();
ledger('seat-start', { seat: act.agent, session: agentSession, station: 'conduct', owns: owned });
handoff(`${PLAN} ${act.agent} starts`);
const agent = seat({
  session: agentSession,
  prompt: [
    readFileSync(agentPromptFile, 'utf8'),
    `\n\n--- OWNS ---\n${owned.join('\n')}`,
    `\n\n--- TASK (from the Master) ---\n${act.task}`,
    `\n\n--- INTENT ---\n${intent}`,
    existsSync(askingFile) ? `\n\n${readFileSync(askingFile, 'utf8')}` : '',
  ].join(''),
  budget: agentDef.budget_usd || 1,
  schema: agentSchema,
  tools: agentDef.tools || ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  permissionMode: 'acceptEdits',
});

// ---------------------------------------------------------------- 4. witnesses: transcript and git
const agentTools = toolUses(transcript(agentSession));
const changed = porcelain().filter((p) => !p.startsWith('ledger/'));
const outside = outsideJurisdiction(changed, owned);
const written = owned.filter(
  (p) => existsSync(join(ROOT, p)) && readFileSync(join(ROOT, p), 'utf8').trim(),
);
const agentRow = {
  seat: act.agent,
  station: 'conduct',
  session: agent.out?.session_id || agentSession,
  ok: agent.ok,
  minutes: agent.minutes,
  cost_usd: agent.out?.total_cost_usd ?? null,
  turns: agent.out?.num_turns ?? null,
  tokens: agent.out?.usage ?? null,
  tools: agentTools,
  changed,
  outside,
  summary: String(agent.out?.structured_output?.summary || agent.out?.result || '').slice(0, 600),
  questions: (agent.out?.structured_output?.questions || []).length,
};
ledger('seat-end', agentRow);
stat({ tool: 'claude -p', ...agentRow });

// ---------------------------------------------------------------- 5. commit what the agent owns, under its name
let agentCommit = null;
if (written.length && !outside.length) {
  sh('git', ['add', '--', ...written]);
  const c = sh('git', [
    '-c',
    `user.name=seat:${act.agent}`,
    '-c',
    'user.email=seat@harness.local',
    'commit',
    '-q',
    '-m',
    `docs(intent): ${PLAN} ${written.join(', ')} by seat:${act.agent}`,
  ]);
  if (ok(c)) agentCommit = git(['rev-parse', 'HEAD']);
}

// ---------------------------------------------------------------- 6. questions: decider first, the Master only if allowed
const asked = agent.out?.structured_output?.questions || [];
const qdir = join(dir, 'questions');
const qResults = [];
const answerRows = [];
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
if (asked.length) {
  mkdirSync(qdir, { recursive: true });
  let n = readdirSync(qdir).filter((f) => /^Q-\d+\.md$/.test(f)).length;
  for (const q of asked) {
    const v = validateQuestion(q);
    const file = v.ok ? `Q-${++n}.md` : null;
    if (file)
      writeFileSync(
        join(qdir, file),
        renderQuestion(q, { asked_by: `seat:${act.agent}`, phase: 'conduct' }),
      );
    ledger(
      'question',
      { file, valid: v.ok, refusals: v.refusals, ...q, agent_session: agentRow.session },
      `agent:${act.agent}`,
    );
    qResults.push({ file, valid: v.ok, refusals: v.refusals, question: q.question, q });
  }
  const files = qResults.filter((r) => r.file).map((r) => `intent/${PLAN}/questions/${r.file}`);
  if (files.length)
    commitAs(
      `seat:${act.agent}`,
      files,
      `docs(intent): ${PLAN} ${qResults
        .map((r) => r.file)
        .filter(Boolean)
        .join(', ')} raised by seat:${act.agent}`,
    );
  handoff(`${PLAN} questions raised`);

  // the decider is the rule; it writes its verdict on each open question file
  const d = sh('node', [join(ROOT, 'scripts', 'harness', 'decider.mjs'), '--plan', PLAN]);
  let verdicts = null;
  try {
    verdicts = JSON.parse(d.stdout);
  } catch {
    /* no verdicts is a failed decider, recorded below */
  }
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
      `# Needs input\n\n${PLAN} stopped: ${s.reason}\n\nQuestion: intent/${PLAN}/questions/${s.file}\n\nAlternatives:\n${(s.alternatives || []).map((a) => `- ${a}`).join('\n') || '- (none listed)'}\n\nAnswer by setting \`status: answered\` and \`answer: ...\` on the question file and commit.\n`,
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
    const document = owned
      .filter((p) => existsSync(join(ROOT, p)))
      .map((p) => `### ${p}\n${readFileSync(join(ROOT, p), 'utf8')}`)
      .join('\n\n');
    for (const r of qResults.filter((x) => x.verdict === 'allow')) {
      const qPath = join(qdir, r.file);
      const alts = r.q.alternatives;
      const session = randomUUID();
      ledger('seat-start', { seat: 'master', session, station: 'answer', file: r.file });
      const m = seat({
        session,
        prompt: [
          readFileSync(answerer, 'utf8'),
          `\n\n--- PLAN ---\n${PLAN} on ${branch}, track ${route.track}, rigor ${route.rigor}`,
          `\n\n--- INTENT ---\n${intent}`,
          `\n\n--- QUESTION (intent/${PLAN}/questions/${r.file}, raised by ${act.agent}) ---\n${readFileSync(qPath, 'utf8')}`,
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
      const tools = toolUses(transcript(session));
      const touched = porcelain().filter((p) => !p.startsWith('ledger/'));
      const ans = m.out?.structured_output ?? null;
      const va = validateAnswer(ans, r.q);
      const row = {
        seat: 'master',
        station: 'answer',
        file: r.file,
        session: m.out?.session_id || session,
        ok: m.ok,
        minutes: m.minutes,
        cost_usd: m.out?.total_cost_usd ?? null,
        turns: m.out?.num_turns ?? null,
        tokens: m.out?.usage ?? null,
        tools,
        changed: touched,
      };
      ledger('seat-end', row);
      stat({ tool: 'claude -p', ...row });
      ledger(
        'answer',
        {
          file: r.file,
          answer: ans?.answer ?? null,
          reason: ans?.reason ?? null,
          rejected: ans?.rejected || [],
          valid: m.ok && va.ok,
          refusals: va.refusals,
          master_session: row.session,
        },
        'agent:master',
      );
      answerRows.push(row);
      r.answered = m.ok && va.ok && authoringCalls(tools) === 0 && !touched.length;
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
                    ? `${r.file} (${r.q.kind}, stakes ${r.q.stakes}, triggers ${JSON.stringify(r.q.triggers)})`
                    : `refused: ${r.refusals.join('; ')}`,
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

const checks = {
  'two-sessions': {
    ok:
      masterRow.session !== agentRow.session &&
      !!transcript(masterSession) &&
      !!transcript(agentSession),
    msg: `master ${masterRow.session.slice(0, 8)}, agent ${agentRow.session.slice(0, 8)}, both transcripts on disk`,
  },
  ...masterChecks(),
  'agent-in-jurisdiction': {
    ok: agent.ok && written.length === owned.length && !outside.length,
    msg: `owns ${owned.join(', ')}; wrote ${written.join(', ') || 'nothing'}; outside: ${outside.join(', ') || 'none'}`,
  },
  ...qChecks,
  'cost-per-session': {
    ok: [masterRow, agentRow, ...answerRows].every((r) => typeof r.cost_usd === 'number'),
    msg: `master $${masterRow.cost_usd}, ${act.agent} $${agentRow.cost_usd}${answerRows.map((r) => `, answer ${r.file} $${r.cost_usd}`).join('')}`,
  },
};
finish(checks, {
  agent: agentRow,
  agentCommit,
  outcome,
  questions: qResults.map(({ q, ...r }) => ({ ...r, alternatives: q.alternatives })),
  answers: answerRows,
});
