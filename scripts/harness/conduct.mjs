#!/usr/bin/env node
// One conducted activation (H-32, H-33 step 1). The Master decides, this script spawns:
//   1. the Master is a tool-less claude -p call that returns {decision, agent, task, reason, rejected};
//   2. the decision is validated against the roster and recorded as an `activation` ledger line;
//   3. the chosen agent runs as its own claude -p session, with its own prompt, tools and budget;
//   4. what each session did is read from its transcript and from git, never from what it says;
//   5. the agent's owned files are committed under its own name, and five checks decide pass or fail.
// Usage: node scripts/harness/conduct.mjs --plan <slug>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PLAN = arg('plan');
// a test oracle for the lab: the agent the intent should lead to (or no-move); never shown to the Master
const EXPECT = arg('expect', null);
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
  ].join(''),
  budget: agentDef.budget_usd || 1,
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
  result: String(agent.out?.result || '').slice(0, 600),
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
  'cost-per-session': {
    ok: typeof masterRow.cost_usd === 'number' && typeof agentRow.cost_usd === 'number',
    msg: `master $${masterRow.cost_usd}, ${act.agent} $${agentRow.cost_usd}`,
  },
};
finish(checks, { agent: agentRow, agentCommit });
