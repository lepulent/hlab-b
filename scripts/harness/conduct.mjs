#!/usr/bin/env node
// One conducted plan (H-32, H-33 steps 1 to 5). The Master decides, this script spawns, in a loop:
//   1. the Master is a tool-less claude -p call that returns {decision, activations[{agent, task}],
//      reason, wave_reason, rejected}, given the intent, the roster and a capped digest of earlier waves;
//   2. the decision is validated against the roster (a wave holds at most conduct.max_wave agents with
//      disjoint owned paths) and recorded as an `activation` ledger line;
//   3. every activated agent runs as its own claude -p session at the same time; from wave 2 on, each
//      gets the relay: the digest and the documents to build on, at their commits;
//   4. what each session did, wrote and read is taken from its transcript and from git, never from what
//      it says; each agent's owned files are committed under its own name;
//   5. each question an agent raised becomes a file, the decider gives its verdict, and the Master
//      answers only what the decider allowed; a floor trigger stops the plan with needs-input.md;
//   6. the loop ends when the Master decides no-move (goal closed), at a floor stop, at a refusal, or at
//      conduct.max_waves. Checks over the whole plan decide pass or fail.
// Usage: node scripts/harness/conduct.mjs --plan <slug> [--expect <agent[+agent]|no-move>]
//        [--expect-question none|answered|needs-input] [--expect-agents a,b]
//        [--expect-ending goal-closed|needs-input]
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
  rosterById,
  parsePorcelain,
  outsideJurisdiction,
  transcriptDir,
  toolUses,
  authoringCalls,
  authoredPaths,
  overlapSeconds,
} from './activation.mjs';
import { validateGap, castGap, gapKey, gapOptions, doctypeIds, overwrites } from './gap.mjs';
import { buildDigest, toolPaths, relayConsumed } from './relay.mjs';
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
// every agent that should have run at some wave, and how the plan should end
const EXPECT_RAN = arg('expect-agents', null)?.split(',').sort() ?? null;
const EXPECT_END = arg('expect-ending', null);
const H = join(ROOT, '.harness');
mkdirSync(H, { recursive: true });
const harness = readJson(join(ROOT, 'harness.json'), {});
const MODEL = harness.yolo?.model || null;
// sessions at once; the laptop's limit (H-18: parallelism 2)
const MAX_WAVE = harness.conduct?.max_wave || 2;
// Master decisions per plan, and the size of what one wave relays to the next (H-33 step 5)
const MAX_WAVES = harness.conduct?.max_waves || 4;
const DIGEST_CHARS = harness.conduct?.digest_chars || 4000;
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
const catalogue = readJson(join(ROOT, '.claude', 'roster', 'catalogue.json'));
if (!catalogue?.doctypes?.length) fail('no .claude/roster/catalogue.json (install the bundle)', 2);
const conductorPrompt = join(ROOT, '.claude', 'seats', 'conductor.md');
if (!existsSync(conductorPrompt)) fail('no .claude/seats/conductor.md (install the bundle)', 2);
handoff(`${PLAN} conduct starts`);
if (productDirty() || porcelain().length)
  fail('the tree is not clean; a conducted step starts from a whole branch', 2);

// ---------------------------------------------------------------- the loop: decide, run, relay, until the Master closes
const intent = readFileSync(intentFile, 'utf8');
const byId = rosterById(roster);
// the Master sees what can be produced, never who produces it (H-35: casting is derived)
const catalogueView = () =>
  catalogue.doctypes.map((d) => {
    const path = d.path.replaceAll('{plan}', PLAN);
    return {
      id: d.id,
      title: d.title,
      purpose: d.purpose,
      path,
      exists: existsSync(join(ROOT, path)),
    };
  });
const decisionSchema = JSON.stringify({
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['move', 'no-move', 'clarify'] },
    reason: { type: 'string' },
    wave_reason: { type: 'string' },
    gap: {
      type: 'object',
      properties: {
        statement: { type: 'string' },
        premises: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              cites: { type: 'array', items: { type: 'string' } },
            },
            required: ['text', 'cites'],
          },
        },
        blocks: { type: 'array', items: { type: 'string' } },
        artifacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              artifact: { type: 'string', enum: doctypeIds(catalogue) },
              task: { type: 'string' },
            },
            required: ['artifact', 'task'],
          },
        },
        rejected: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              artifact: { type: 'string', enum: gapOptions(catalogue) },
              why: { type: 'string' },
            },
            required: ['artifact', 'why'],
          },
        },
        also_available: { type: 'array', items: { type: 'string', enum: doctypeIds(catalogue) } },
      },
      required: ['statement', 'premises', 'blocks', 'artifacts', 'rejected', 'also_available'],
    },
    clarify: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        alternatives: { type: 'array', items: { type: 'string' } },
      },
      required: ['question', 'alternatives'],
    },
  },
  required: ['outcome', 'reason', 'wave_reason', 'gap'],
});
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
const askingFile = join(ROOT, '.claude', 'roster', 'asking.md');
const answerer = join(ROOT, '.claude', 'seats', 'answerer.md');
const qdir = join(dir, 'questions');

const decisions = []; // one per Master call: { n, act, valid, row, digest }
const waves = []; // the relay's input: { n, activations: [...], questions: [...] }
const agents = []; // every agent session of every wave, with its witnesses
const qResults = [];
const answerRows = [];
let ending = null; // goal-closed | needs-input | refused | wave-cap

// what a premise may cite: the intent, an artifact of the catalogue, an earlier gap or question, a canon
// capability or criterion, or a file that exists in the repository
const gaps = []; // every gap declared on this plan: { id, n, statement, artifacts, status }
function citable(id) {
  const x = String(id || '').trim();
  if (x === 'INTENT') return true;
  if (doctypeIds(catalogue).includes(x)) return true;
  if (/^G-\d+$/.test(x)) return gaps.some((g) => g.id === x);
  if (/^Q-\d+$/.test(x)) return existsSync(join(qdir, `${x}.md`));
  if (/^CAP-\d+(\.\d+)?$/.test(x))
    return existsSync(join(ROOT, 'canon', 'capabilities', `${x.split('.')[0]}.md`));
  if (x.includes('..') || x.startsWith('/')) return false;
  return existsSync(join(ROOT, x));
}
const citableView = () =>
  [
    'INTENT',
    ...doctypeIds(catalogue),
    ...gaps.map((g) => g.id),
    ...(existsSync(qdir)
      ? readdirSync(qdir)
          .filter((f) => /^Q-\d+\.md$/.test(f))
          .map((f) => f.slice(0, -3))
      : []),
  ].join(', ');

// 1. the Master declares the next gap from the intent, the catalogue and a capped digest of what earlier
// waves did; the door refuses a vacuous or impossible gap and returns it for exactly one correction
async function master(n, attempt, refusals) {
  const digest = buildDigest(waves, DIGEST_CHARS);
  const session = randomUUID();
  ledger('seat-start', { seat: 'master', session, station: 'conduct', wave: n, attempt });
  const r = await seat({
    session,
    prompt: [
      readFileSync(conductorPrompt, 'utf8'),
      `\n\n--- PLAN ---\n${PLAN} on ${branch}, track ${route.track}, rigor ${route.rigor}; at most ${MAX_WAVE} agent(s) at once; this is decision ${n} of at most ${MAX_WAVES}`,
      `\n\n--- INTENT ---\n${intent}`,
      `\n\n--- CATALOGUE (what can be produced) ---\n${JSON.stringify(catalogueView(), null, 2)}`,
      `\n\n--- IDS A PREMISE MAY CITE ---\n${citableView()}, or the path of any file in the repository`,
      `\n\n--- SO FAR ---\n${digest.text || 'Nothing has been done on this plan yet.'}`,
      refusals
        ? `\n\n--- REFUSED ---\nYour previous decision was refused by the door for these reasons. Correct it once:\n${refusals.map((x) => `- ${x}`).join('\n')}`
        : '',
    ].join(''),
    budget: harness.budgets?.usd_per_master_call || 0.5,
    schema: decisionSchema,
    tools: [],
  });
  const mRow = row('master', 'conduct', session, r, {
    wave: n,
    attempt,
    changed: porcelain().filter((p) => !p.startsWith('ledger/')),
  });
  ledger('seat-end', mRow);
  stat({ tool: 'claude -p', ...mRow });
  const dec = r.out?.structured_output ?? null;
  if (!r.ok || !dec) {
    ledger('decision', {
      station: 'conduct',
      wave: n,
      decision: 'master-failed',
      stderr: r.stderr?.slice(-400),
    });
    handoff(`${PLAN} master seat failed`);
    fail(`master seat failed: ${String(r.out?.result || r.stderr).slice(0, 300)}`);
  }
  const valid = validateGap(dec, catalogue, { maxWave: MAX_WAVE, exists: citable });
  ledger(
    'activation',
    {
      wave: n,
      attempt,
      outcome: dec.outcome,
      chose: gapKey(dec),
      reason: dec.reason,
      wave_reason: dec.wave_reason ?? null,
      gap: dec.gap ?? null,
      clarify: dec.clarify ?? null,
      max_wave: MAX_WAVE,
      valid: valid.ok,
      refusals: valid.refusals,
      digest: { chars: digest.chars, truncated: digest.truncated },
      master_session: mRow.session,
    },
    'agent:master',
  );
  handoff(`${PLAN} wave ${n} decision ${attempt} recorded`);
  return { n, attempt, dec, valid, row: mRow, digest };
}
async function decide(n) {
  let d = await master(n, 1, null);
  decisions.push(d);
  if (!d.valid.ok) {
    d = await master(n, 2, d.valid.refusals);
    d.corrected = true;
    decisions.push(d);
  }
  if (d.valid.ok && d.dec.outcome === 'move') {
    d.gapId = `G-${gaps.length + 1}`;
    gaps.push({
      id: d.gapId,
      n,
      statement: d.dec.gap.statement,
      artifacts: d.dec.gap.artifacts.map((a) => a.artifact),
      status: 'declared',
    });
    ledger('gap', { id: d.gapId, status: 'declared', wave: n, ...d.dec.gap }, 'agent:master');
  }
  return d;
}

// 2. the script spawns the wave; each agent after wave 1 gets the relay: what exists and what was decided
async function runWave(n, d) {
  const relay = buildDigest(waves, DIGEST_CHARS);
  // artifact → workflow → agent, by the catalogue; the Master never named these agents
  const casts = castGap(d.dec, catalogue, PLAN);
  const existing = casts.flatMap((c) => c.owned).filter((p) => existsSync(join(ROOT, p)));
  const rewrites = overwrites(casts, existing);
  const gap = gaps.find((g) => g.id === d.gapId);
  gap.status = 'linked';
  ledger('gap', {
    id: gap.id,
    status: 'linked',
    wave: n,
    cast: casts.map((c) => ({ artifacts: c.artifacts, workflows: c.workflows, agent: c.agent })),
    overwrites: rewrites,
  });
  const wave = casts.map((c) => ({
    agent: c.agent,
    artifacts: c.artifacts,
    task: c.tasks.join('\n'),
    n,
    def: byId.get(c.agent),
    owned: c.owned,
    relayed: relay.sources.map((s) => s.path),
  }));
  for (const a of wave)
    if (!a.def) fail(`catalogue casts to "${a.agent}", which is not in the roster`, 2);
  for (const a of wave) {
    const promptFile = join(ROOT, '.claude', 'roster', a.def.prompt);
    if (!existsSync(promptFile)) fail(`no ${promptFile}`, 2);
    a.session = randomUUID();
    a.prompt = [
      readFileSync(promptFile, 'utf8'),
      `\n\n--- OWNS ---\n${a.owned.join('\n')}`,
      `\n\n--- TASK (from the Master) ---\n${a.task}`,
      `\n\n--- INTENT ---\n${intent}`,
      relay.sources.length
        ? `\n\n--- RELAY (what earlier waves of this plan produced and decided) ---\n${relay.text}\n\nDocuments to build on, open them before you write:\n${relay.sources.map((s) => `- ${s.path} (by ${s.agent}${s.commit ? `, ${s.commit.slice(0, 7)}` : ''})`).join('\n')}`
        : '',
      existsSync(askingFile) ? `\n\n${readFileSync(askingFile, 'utf8')}` : '',
    ].join('');
    ledger('seat-start', {
      seat: a.agent,
      session: a.session,
      station: 'conduct',
      wave: n,
      owns: a.owned,
    });
  }
  if (relay.sources.length)
    ledger('decision', {
      station: 'relay',
      wave: n,
      to: wave.map((a) => a.agent),
      chars: relay.chars,
      truncated: relay.truncated,
      sources: relay.sources,
    });
  handoff(`${PLAN} wave ${n}: ${wave.map((a) => a.agent).join(' + ')} start`);
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

  // witnesses: git sees the wave's changes together; each transcript says which session wrote and read what
  const changed = porcelain().filter((p) => !p.startsWith('ledger/'));
  const outsideWave = outsideJurisdiction(
    changed,
    wave.flatMap((a) => a.owned),
  );
  wave.forEach((a, i) => {
    const r = results[i];
    const t = transcript(a.session);
    a.result = r;
    a.outsideWave = outsideWave;
    a.authored = authoredPaths(t, ROOT);
    a.read = toolPaths(t, ROOT, ['Read']);
    a.relay = relayConsumed(a.relayed, a.owned, a.read);
    a.written = a.owned.filter(
      (p) => existsSync(join(ROOT, p)) && readFileSync(join(ROOT, p), 'utf8').trim(),
    );
    a.asked = r.out?.structured_output?.questions || [];
    a.row = row(a.agent, 'conduct', a.session, r, {
      wave: n,
      authored: a.authored,
      outside: outsideJurisdiction(a.authored, a.owned),
      relay: a.relay,
      summary: String(r.out?.structured_output?.summary || r.out?.result || '').slice(0, 600),
      questions: a.asked.length,
    });
    ledger('seat-end', a.row);
    stat({ tool: 'claude -p', ...a.row });
  });
  for (const a of wave) {
    if (!a.written.length || a.row.outside.length || outsideWave.length) continue;
    const c = commitAs(
      `seat:${a.agent}`,
      a.written,
      `docs(intent): ${PLAN} ${a.written.join(', ')} by seat:${a.agent} (wave ${n})`,
    );
    if (ok(c)) a.commit = git(['rev-parse', 'HEAD']);
  }
  handoff(`${PLAN} wave ${n} witnessed`);
  agents.push(...wave);
  // a gap closes when every artifact it named was written by its cast agent and committed
  gap.status = wave.every((a) => a.commit && a.written.length === a.owned.length)
    ? 'closed'
    : 'linked';
  gap.agents = wave.map((a) => a.agent);
  ledger('gap', {
    id: gap.id,
    status: gap.status,
    wave: n,
    written: wave.flatMap((a) => a.written),
    commits: wave.map((a) => a.commit || null),
  });
  handoff(`${PLAN} ${gap.id} ${gap.status}`);
  const record = {
    n,
    gap: { id: gap.id, statement: gap.statement },
    overlap: overlapSeconds(results.map((r) => ({ start: r.start, end: r.end }))),
    activations: wave.map((a) => ({
      agent: a.agent,
      artifacts: a.artifacts,
      task: a.task,
      written: a.written,
      commit: a.commit || null,
      summary: a.row.summary,
    })),
    questions: [],
  };
  waves.push(record);
  return { wave, record };
}

// 3. questions: decider first, the Master only if allowed; returns true when the floor stops the plan
async function questions(n, wave, record) {
  const asked = wave.flatMap((a) => a.asked.map((q) => ({ a, q })));
  if (!asked.length) return false;
  mkdirSync(qdir, { recursive: true });
  let k = readdirSync(qdir).filter((f) => /^Q-\d+\.md$/.test(f)).length;
  const mine = [];
  for (const { a, q } of asked) {
    const v = validateQuestion(q);
    const file = v.ok ? `Q-${++k}.md` : null;
    if (file)
      writeFileSync(
        join(qdir, file),
        renderQuestion(q, { asked_by: `seat:${a.agent}`, phase: `conduct wave ${n}` }),
      );
    ledger(
      'question',
      { wave: n, file, valid: v.ok, refusals: v.refusals, ...q, agent_session: a.row.session },
      `agent:${a.agent}`,
    );
    mine.push({ n, file, agent: a.agent, valid: v.ok, refusals: v.refusals, q, a });
  }
  qResults.push(...mine);
  for (const a of wave) {
    const files = mine
      .filter((r) => r.a === a && r.file)
      .map((r) => `intent/${PLAN}/questions/${r.file}`);
    if (files.length)
      commitAs(
        `seat:${a.agent}`,
        files,
        `docs(intent): ${PLAN} ${files.map((f) => f.split('/').pop()).join(', ')} raised by seat:${a.agent}`,
      );
  }
  handoff(`${PLAN} wave ${n} questions raised`);

  // the decider is the rule; it writes its verdict on each open question file
  const d = sh('node', [join(ROOT, 'scripts', 'harness', 'decider.mjs'), '--plan', PLAN]);
  let verdicts = null;
  try {
    verdicts = JSON.parse(d.stdout);
  } catch {
    /* no verdicts is a failed decider, recorded below */
  }
  const files = mine.filter((r) => r.file).map((r) => `intent/${PLAN}/questions/${r.file}`);
  for (const r of mine.filter((x) => x.file)) {
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
        wave: n,
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
  handoff(`${PLAN} wave ${n} decider verdicts`);

  if (verdicts?.stop) {
    // a floor trigger is a human-MUST: the Master is not asked, the plan stops here
    const s = verdicts.stop;
    writeFileSync(
      join(dir, 'needs-input.md'),
      `# Needs input\n\n${PLAN} stopped at wave ${n}: ${s.reason}\n\nQuestion: intent/${PLAN}/questions/${s.file}\n\nAlternatives:\n${(s.alternatives || []).map((x) => `- ${x}`).join('\n') || '- (none listed)'}\n\nAnswer by setting \`status: answered\` and \`answer: ...\` on the question file and commit.\n`,
    );
    ledger(
      'question',
      { wave: n, stop: s, needs_input: `intent/${PLAN}/needs-input.md` },
      'script:decider',
    );
    commitAs(
      'script:decider',
      [`intent/${PLAN}/needs-input.md`],
      `chore(intent): ${PLAN} needs input (${s.file})`,
    );
    handoff(`${PLAN} needs input`);
    record.questions = mine
      .filter((r) => r.file)
      .map((r) => ({ file: r.file, agent: r.agent, question: r.q.question, verdict: r.verdict }));
    return true;
  }
  for (const r of mine.filter((x) => x.verdict === 'allow')) {
    const qPath = join(qdir, r.file);
    const alts = r.q.alternatives;
    const document = r.a.owned
      .filter((p) => existsSync(join(ROOT, p)))
      .map((p) => `### ${p}\n${readFileSync(join(ROOT, p), 'utf8')}`)
      .join('\n\n');
    const session = randomUUID();
    ledger('seat-start', { seat: 'master', session, station: 'answer', wave: n, file: r.file });
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
      wave: n,
      file: r.file,
      changed: porcelain().filter((p) => !p.startsWith('ledger/')),
    });
    ledger('seat-end', aRow);
    stat({ tool: 'claude -p', ...aRow });
    ledger(
      'answer',
      {
        wave: n,
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
  record.questions = mine
    .filter((r) => r.file)
    .map((r) => ({
      file: r.file,
      agent: r.agent,
      question: r.q.question,
      verdict: r.verdict,
      answer: r.answered ? r.answer : null,
    }));
  return false;
}

for (let n = 1; ; n++) {
  if (n > MAX_WAVES) {
    ending = 'wave-cap';
    break;
  }
  const d = await decide(n);
  if (!d.valid.ok) {
    ending = 'refused';
    break;
  }
  if (d.dec.outcome === 'no-move') {
    ending = 'goal-closed';
    break;
  }
  if (d.dec.outcome === 'clarify') {
    // the Master cannot read the intent one way; the owner is asked, the plan stops here
    const c = d.dec.clarify;
    writeFileSync(
      join(dir, 'needs-input.md'),
      `# Needs input\n\n${PLAN}: the Master asks for clarification before anything is produced.\n\n${c.question}\n\n${c.alternatives.map((x) => `- ${x}`).join('\n')}\n\nWhy: ${d.dec.reason}\n`,
    );
    commitAs(
      'seat:master',
      [`intent/${PLAN}/needs-input.md`],
      `chore(intent): ${PLAN} the Master asks for clarification`,
    );
    handoff(`${PLAN} clarify`);
    ending = 'clarify';
    break;
  }
  const { wave, record } = await runWave(n, d);
  if (await questions(n, wave, record)) {
    ending = 'needs-input';
    break;
  }
}

// ---------------------------------------------------------------- checks over the whole plan
// the decision that stands for each wave: the correction when there was one
const final = [...new Map(decisions.map((d) => [d.n, d])).values()];
const sequence = final.map((d) => gapKey(d.dec));
const chose = sequence[0];
const outcome = questionOutcome(qResults.filter((r) => r.file));
const masterCalls = [...decisions.map((d) => d.row), ...answerRows];
const agentCost = agents.reduce((s, a) => s + (a.row.cost_usd || 0), 0);
const masterCost = decisions.reduce((s, d) => s + (d.row.cost_usd || 0), 0);
const answerCost = answerRows.reduce((s, r) => s + (r.cost_usd || 0), 0);
const ranAgents = [...new Set(agents.map((a) => a.agent))].sort();
const relayWaves = agents.filter((a) => a.relay.needed);
const multi = waves.filter((w) => w.activations.length > 1);
const expectedEnding = EXPECT_END || (EXPECT_Q === 'needs-input' ? 'needs-input' : 'goal-closed');
const checks = {
  'sessions-distinct': {
    ok: (() => {
      const all = [...decisions.map((d) => d.row.session), ...agents.map((a) => a.row.session)];
      return new Set(all).size === all.length && all.every((s) => !!transcript(s));
    })(),
    msg: `${decisions.length} Master decision session(s), ${agents.length} agent session(s), ${answerRows.length} answer session(s); every transcript on disk`,
  },
  'master-authored-nothing': {
    ok: masterCalls.every((r) => authoringCalls(r.tools) === 0 && !r.changed.length),
    msg: masterCalls
      .map((r) => `${r.station}${r.file ? ` ${r.file}` : ` w${r.wave}`} ${JSON.stringify(r.tools)}`)
      .join(', '),
  },
  door: {
    ok: final.every((d) => d.valid.ok),
    msg: final
      .map((d) => {
        const first = decisions.find((x) => x.n === d.n && x.attempt === 1);
        const fix = d.corrected
          ? ` (corrected once; refused first for: ${first.valid.refusals.join('; ')})`
          : '';
        return d.valid.ok
          ? `w${d.n} ${d.dec.outcome} ${gapKey(d.dec)}${d.gapId ? ` ${d.gapId}` : ''}: "${d.dec.gap?.statement || d.dec.reason}"${fix}`
          : `w${d.n} refused after correction: ${d.valid.refusals.join('; ')}`;
      })
      .join(' · '),
  },
  ...(agents.length
    ? {
        'casting-derived': {
          // every agent session was cast from the catalogue by the artifacts of a gap, never named
          ok: agents.every(
            (a) =>
              a.artifacts.length &&
              a.artifacts.every(
                (id) => catalogue.doctypes.find((x) => x.id === id)?.produced_by === a.agent,
              ),
          ),
          msg: agents.map((a) => `w${a.n} ${a.artifacts.join('+')} → ${a.agent}`).join(' · '),
        },
        'gaps-closed': {
          ok: gaps.every((g) => g.status === 'closed'),
          msg: gaps.map((g) => `${g.id} ${g.status} (${g.artifacts.join('+')})`).join(' · '),
        },
      }
    : {}),
  ...(EXPECT
    ? {
        'chose-expected': {
          ok: chose === EXPECT,
          msg: `expected ${EXPECT} first, the Master chose ${chose}`,
        },
      }
    : {}),
  ...(EXPECT_RAN
    ? {
        'agents-expected': {
          ok: EXPECT_RAN.every((id) => ranAgents.includes(id)),
          msg: `expected ${EXPECT_RAN.join(', ')} to run; ran ${ranAgents.join(', ') || 'none'}`,
        },
      }
    : {}),
  ...(agents.length
    ? {
        'agents-in-jurisdiction': {
          ok: agents.every(
            (a) =>
              a.result.ok &&
              a.written.length === a.owned.length &&
              !a.row.outside.length &&
              !a.outsideWave.length,
          ),
          msg: agents
            .map(
              (a) =>
                `w${a.n} ${a.agent} wrote ${a.written.join(', ') || 'nothing'}, authored ${a.authored.join(', ') || 'nothing'}${a.row.outside.length ? ` (outside: ${a.row.outside.join(', ')})` : ''}${a.outsideWave.length ? ` (tree outside the wave: ${a.outsideWave.join(', ')})` : ''}`,
            )
            .join(' · '),
        },
      }
    : {}),
  ...(multi.length
    ? {
        'ran-in-parallel': {
          ok: multi.every((w) => w.overlap > 0),
          msg: multi.map((w) => `w${w.n} overlap ${w.overlap}s`).join(', '),
        },
      }
    : {}),
  ...(relayWaves.length
    ? {
        'relay-consumed': {
          ok: relayWaves.every((a) => a.relay.ok),
          msg: relayWaves
            .map(
              (a) =>
                `w${a.n} ${a.agent} was relayed ${a.relay.upstream.join(', ')}; opened ${a.relay.opened.join(', ') || 'none'}`,
            )
            .join(' · '),
        },
      }
    : {}),
  'plan-ended': {
    ok: ending === expectedEnding,
    msg: `expected ${expectedEnding}, ended ${ending} after ${decisions.length} decision(s): ${sequence.join(' → ')}`,
  },
  ...(EXPECT_Q || qResults.length
    ? {
        'question-raised': {
          ok:
            EXPECT_Q === 'none'
              ? !qResults.length
              : qResults.length > 0 && qResults.every((r) => r.valid),
          msg: qResults.length
            ? qResults
                .map((r) =>
                  r.valid
                    ? `w${r.n} ${r.file} by ${r.agent} (${r.q.kind}, stakes ${r.q.stakes}, triggers ${JSON.stringify(r.q.triggers)})`
                    : `w${r.n} ${r.agent} refused: ${r.refusals.join('; ')}`,
                )
                .join(' · ')
            : 'no question raised',
        },
        'question-outcome': {
          ok: EXPECT_Q ? outcome === EXPECT_Q : outcome !== 'parked',
          msg: `${EXPECT_Q ? `expected ${EXPECT_Q}, ` : ''}got ${outcome}; ${qResults
            .filter((r) => r.file)
            .map((r) => `${r.file} ${r.verdict}${r.answered ? ` → "${r.answer}"` : ''}`)
            .join(' · ')}`,
        },
        ...(answerRows.length
          ? {
              'answers-valid': {
                ok: qResults
                  .filter((r) => r.verdict === 'allow' && r.n)
                  .every((r) =>
                    // an allowed question in the wave that stopped is never answered, by design
                    ending === 'needs-input' && r.n === waves.length ? true : r.answered,
                  ),
                msg: `${answerRows.length} answer(s) recorded`,
              },
            }
          : {}),
      }
    : {}),
  'cost-per-session': {
    ok: [...masterCalls, ...agents.map((a) => a.row)].every((r) => typeof r.cost_usd === 'number'),
    msg: `Master decisions $${masterCost.toFixed(3)} + answers $${answerCost.toFixed(3)}, agents $${agentCost.toFixed(3)}; Master share of agent spend ${agentCost ? Math.round(((masterCost + answerCost) / agentCost) * 100) : 0}%`,
  },
};
const pass = Object.values(checks).every((c) => c.ok);
writeJson(join(H, `conduct-${PLAN}.json`), {
  plan: PLAN,
  expect: EXPECT,
  expect_question: EXPECT_Q,
  expect_ending: expectedEnding,
  ending,
  sequence,
  chose,
  pass,
  checks,
  decisions: decisions.map((d) => ({
    n: d.n,
    attempt: d.attempt,
    outcome: d.dec.outcome,
    chose: gapKey(d.dec),
    gap_id: d.gapId ?? null,
    gap: d.dec.gap ?? null,
    clarify: d.dec.clarify ?? null,
    reason: d.dec.reason,
    wave_reason: d.dec.wave_reason ?? null,
    valid: d.valid.ok,
    refusals: d.valid.refusals,
    digest_chars: d.digest.chars,
    digest_truncated: d.digest.truncated,
    master: d.row,
  })),
  waves,
  agents: agents.map((a) => ({ ...a.row, commit: a.commit ?? null })),
  outcome,
  questions: qResults.map((r) => ({
    wave: r.n,
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
ledger('decision', {
  station: 'conduct',
  decision: pass ? 'pass' : 'fail',
  ending,
  sequence,
  expect: EXPECT,
  checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok])),
});
handoff(`${PLAN} conduct ${pass ? 'passed' : 'failed'}`);
for (const [k, v] of Object.entries(checks))
  console.log(`${v.ok ? 'pass' : 'FAIL'}  ${k.padEnd(24)} ${v.msg}`);
console.log(`conduct: ${pass ? 'PASSED' : 'FAILED'} · ${sequence.join(' → ')} · ended ${ending}`);
process.exit(pass ? 0 : 1);
