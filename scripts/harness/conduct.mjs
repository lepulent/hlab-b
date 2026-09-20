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
//      conduct.max_waves waves of work (a closing no-move after the last wave is allowed). Checks over the whole plan decide pass or fail.
// Usage: node scripts/harness/conduct.mjs --plan <slug> [--expect <artifact[+artifact]|no-move|clarify>]
//        [--expect-question none|answered|needs-input] [--expect-agents a,b]
//        [--expect-ending goal-closed|needs-input|clarify] [--no-deliver]
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
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
  transcriptUsage,
  owns,
  overlapSeconds,
} from './activation.mjs';
import { validateGap, castGap, gapKey, gapOptions, doctypeIds, overwrites } from './gap.mjs';
import { ladderKey, intentKindFor, coverage, coverageView } from './ladder.mjs';
import {
  TERMINALS,
  parsePorcelainOps,
  footprintWrites,
  terminalFor,
  corroborate,
  buildRecord,
  supersede,
} from './record.mjs';
import { deriveTriggers, vetoHeld } from './department.mjs';
import { rebuild, parseLedger } from './resume.mjs';
import {
  liveDecisions,
  stampAtWrite,
  driftEntries,
  staleArtifacts,
  driftDigest,
  driftRefusals,
  DRIFT_HEADER,
} from './drift.mjs';
import { parseNode } from './canon-delta.mjs';
import { stageOf, lawFor, stageView } from './stage.mjs';
import { evaluate as evaluateConstitution, constitutionView } from './constitution.mjs';
import {
  artifactMaturity,
  rollup,
  verifyClosure,
  elicitedCount,
  consumedArtifacts,
  authoredByArtifact,
  MACHINE_CAP,
} from './maturity.mjs';
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
// the app's stage: the dial the ladder is read at and the tier a constitution violation must reach
// before it stops a seal (H-36, H-37)
const { stage: STAGE, refusal: STAGE_REFUSAL } = stageOf(harness);
if (STAGE_REFUSAL) {
  console.error(`conduct: ${STAGE_REFUSAL}`);
  process.exit(1);
}
const MODEL = harness.yolo?.model || null;
// sessions at once; the laptop's limit (H-18: parallelism 2)
const MAX_WAVE = harness.conduct?.max_wave || 2;
// Master decisions per plan, and the size of what one wave relays to the next (H-33 step 5)
// a lab lever, like --force-deadline: stop the plan after this many waves of work, to prove a resume
const MAX_WAVES = Number(arg('max-waves', 0)) || harness.conduct?.max_waves || 6;
const DIGEST_CHARS = harness.conduct?.digest_chars || 4000;
// per-child deadlines (NFR-5; Mycelium's 180 s and 420 s): past it the seat is killed and recorded
// abandoned
const MASTER_DEADLINE = harness.conduct?.master_deadline_s || 180;
const AGENT_DEADLINE = harness.conduct?.agent_deadline_s || 420;
const FORCE_DEADLINE = Number(arg('force-deadline', 0)) || null;
const EXPECT_TERM = arg('expect-terminal', null);
// the department whose veto the plan should run into (the guarded action must be attempted)
const EXPECT_VETO = arg('expect-veto', null);
// a documents-only run drops the implementation rung; by default a plan owes the code it specified
const WANT_CODE = !argv.includes('--no-code');
// delivery runs only for a plan that makes code: a documents-only plan has no contract to land
const WANT_DELIVER = WANT_CODE && !argv.includes('--no-deliver');
const sh = (file, args, opts = {}) =>
  spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const ok = (r) => r.status === 0;
const fail = (msg, code = 1) => {
  console.error(`conduct: ${msg}`);
  process.exit(code);
};
// The ledger is the evidence of record, so a line it refuses is not a small failure to shrug at: it is
// evidence that was supposed to exist and does not. `stamp` and `seal` were written for two whole steps
// against a registry that did not list them, and every one of those lines was dropped without a word.
// A refused line now stops the run at the point of loss, where the cause is still on screen.
const ledger = (kind, data, actor = 'script:conduct') => {
  const r = sh('node', [
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
  if (r.status !== 0)
    fail(
      `the ledger refused a "${kind}" line: ${String(r.stderr || r.stdout)
        .trim()
        .slice(0, 300)}`,
    );
  return r;
};
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

// Seat hygiene (NFR-5..7, 14.1): the child gets an allowlisted environment (no ANTHROPIC_* or anything
// else inherited by accident), strict MCP, and the footprint hook through an absolute --settings, since
// project settings are not loaded; a deadline kills a hung seat, which is then recorded as abandoned.
const SEAT_ENV = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR']
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
SEAT_ENV.CLAUDE_PROJECT_DIR = ROOT;
const SEAT_SETTINGS = JSON.stringify({
  hooks: {
    // the department veto at the call (FR-17): denies with the department's reason, before the tool runs
    PreToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node ${JSON.stringify(join(ROOT, '.claude', 'hooks', 'veto.mjs'))}`,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node ${JSON.stringify(join(ROOT, '.claude', 'hooks', 'footprint.mjs'))}`,
          },
        ],
      },
    ],
  },
});
const footprintOf = (session) => {
  const f = join(ROOT, '.harness', 'footprint', `${session}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

// one headless session, asynchronous so a wave's sessions run at the same time; tools last because
// --tools is variadic
function seat({ session, prompt, budget, schema, tools, permissionMode, deadlineS }) {
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
      '--settings',
      SEAT_SETTINGS,
      '--session-id',
      session,
      '--max-budget-usd',
      String(budget),
      ...(MODEL ? ['--model', MODEL] : []),
      // an allowance may be a pattern (Bash(npm run -s test)); --tools takes the tool names
      ...(tools.length ? ['--allowedTools', tools.join(',')] : []),
      '--tools',
      [...new Set(tools.map((t) => t.split('(')[0]))].join(','),
    ],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: SEAT_ENV },
  );
  let timedOut = false;
  const timer = deadlineS
    ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, deadlineS * 1000)
    : null;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(prompt);
  return new Promise((resolve) =>
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      let out = null;
      try {
        out = JSON.parse(stdout);
      } catch {
        /* unparsable output is a failed seat */
      }
      const end = Date.now();
      resolve({
        ok: !timedOut && code === 0 && !!out && !out.is_error,
        timedOut,
        deadlineS: deadlineS || null,
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
  // the token series, always from the transcript; USD only when the seat lived to report it
  transcript_tokens: transcriptUsage(transcript(session)),
  timed_out: !!r.timedOut,
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
const departments = readJson(join(ROOT, 'canon', 'departments.json'), { departments: [] });
if (!catalogue?.doctypes?.length) fail('no .claude/roster/catalogue.json (install the bundle)', 2);
const conductorPrompt = join(ROOT, '.claude', 'seats', 'conductor.md');
if (!existsSync(conductorPrompt)) fail('no .claude/seats/conductor.md (install the bundle)', 2);
handoff(`${PLAN} conduct starts`);
if (productDirty() || porcelain().length)
  fail('the tree is not clean; a conducted step starts from a whole branch', 2);

// ---------------------------------------------------------------- the loop: decide, run, relay, until the Master closes
const intent = readFileSync(intentFile, 'utf8');
const byId = rosterById(roster);
// the ladder this plan owes before its seal: rigor × intent kind (13.2, 13.3); an app that already landed
// a plan (records/<plan>) is brownfield
const landedPlans = existsSync(join(ROOT, 'records'))
  ? readdirSync(join(ROOT, 'records'), { withFileTypes: true }).filter((e) => e.isDirectory())
      .length
  : 0;
const intentKind = intentKindFor({ landedPlans });
const LADDER = ladderKey(route.rigor, intentKind);
// the artifacts that exist now, by catalogue path, non-empty
// what the plan changed under a code artifact's paths, against the base it was planted from
const gates = {};
// ---------------------------------------------------------------- drift (FR-7, FR-22, FR-33, FR-34)
// What binds now: every answer this plan has given, and every criterion the canon carries. Both are
// read from state, never from a seat's word about its own work.
const ledgerLines = () =>
  existsSync(ledgerFile) ? parseLedger(readFileSync(ledgerFile, 'utf8')) : [];
const canonCriteria = () => {
  const dir = join(ROOT, 'canon', 'capabilities');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.md$/.test(f) && f !== 'README.md')
    .flatMap((f) => parseNode(readFileSync(join(dir, f), 'utf8')).criteria)
    .map((c) => ({ id: c.id, text: c.sentence }));
};
const worldNow = (lines = ledgerLines()) =>
  liveDecisions({
    answers: lines
      .filter((l) => l?.kind === 'answer' && l.data?.file && l.data?.valid)
      .map((l) => ({ file: l.data.file, answer: l.data.answer })),
    criteria: canonCriteria(),
  });
const stampsSoFar = (lines = ledgerLines()) =>
  lines.filter((l) => l?.kind === 'stamp' && l.data?.artifact).map((l) => l.data);
const driftSeen = []; // every artifact that stood stale at a decision, with the wave it was seen at
const driftNow = () => {
  const lines = ledgerLines();
  return driftEntries(stampsSoFar(lines), worldNow(lines));
};
// The constitution, evaluated rather than quoted (H-37). Pure inputs read fresh each time: the rules,
// the stage, and whatever evidence a check needs. A violation that only blocks below the stage's tier
// is flagged and carried as debt; one at or above it stops the seal.
const constitutionNow = () => {
  const f = join(ROOT, 'canon', 'constitution.md');
  if (!existsSync(f)) return null;
  return evaluateConstitution({
    text: readFileSync(f, 'utf8'),
    stage: STAGE,
    evidence: {
      manifest: readJson(join(ROOT, 'canon', 'generated', 'infra-manifest.json'), null),
      requiredTags: harness.infra?.required_tags || [],
    },
  });
};

const changedUnder = (d) =>
  parsePorcelain(
    sh('git', ['diff', '--name-only', `${route.base}..HEAD`]).stdout.replace(/^/gm, '   '),
  )
    .concat(porcelain())
    .filter((p) => owns([artifactPath(d)], p));
// A plan's documents live under intent/<plan>/ until the landing seals them into records/<plan>/, and
// an artifact does not stop existing because it was sealed: the path follows it (hlab-a s12a read its
// own tech spec back as "planted" the moment the plan landed).
const artifactPath = (d) => {
  const p = d.path.replaceAll('{plan}', PLAN);
  if (p.includes('*') || existsSync(join(ROOT, p))) return p;
  const sealed = p.replace(new RegExp(`^intent/${PLAN}/`), `records/${PLAN}/`);
  return existsSync(join(ROOT, sealed)) ? sealed : p;
};
// An artifact whose path is a pattern (`src/**`, `canon/capabilities/**`) has no file until this plan
// writes one, and what stood there before belongs to an earlier plan: its files are the ones this plan
// changed. A plain path is the file at that path.
const artifactFiles = (d) => {
  const path = artifactPath(d);
  if (path.includes('*')) return changedUnder(d);
  return existsSync(join(ROOT, path)) ? [path] : [];
};
const artifactText = (d) =>
  artifactFiles(d)
    .map((p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : ''))
    .join('\n\n')
    .trim() || null;
// A code artifact exists as files, but it covers its rung only when the app's own gate passed on it:
// files that fail the checks are work in progress, not a covered rung. hlab-a s12a wave 5 closed a plan
// whose implementation had failed the gate twice, because coverage asked whether files had changed.
const present = () =>
  catalogue.doctypes
    .filter((d) =>
      d.kind === 'code' ? changedUnder(d).length > 0 && gates[d.id]?.ok : !!artifactText(d),
    )
    .map((d) => d.id);
const producible = new Set(doctypeIds(catalogue));
// each artifact's maturity from facts (D3): cast by a gap, drafted, and answers taken in by a rewrite;
// no human rung exists in the lab yet, so a conducted artifact stops at the machine cap
const maturityNow = (consumed = new Set()) => {
  const out = {};
  for (const d of catalogue.doctypes) {
    const path = artifactPath(d);
    const text = d.kind === 'code' ? null : artifactText(d);
    const lastWave = Math.max(
      0,
      ...agents
        .filter((a) => a.artifacts.includes(d.id) && a.written.some((w) => owns([path], w)))
        .map((a) => a.n),
    );
    const qs = qResults
      .filter((q) => q.file && q.a.artifacts.includes(d.id))
      .map((q) => ({ wave: q.n, answered: !!q.answered }));
    out[d.id] = {
      ...artifactMaturity({
        cast: gaps.some((g) => g.artifacts.includes(d.id)),
        text,
        elicited: elicitedCount(qs, lastWave),
        code: d.kind === 'code',
        files: d.kind === 'code' ? changedUnder(d).length : 0,
        checked: !!gates[d.id]?.ok,
        consumed: consumed.has(d.id),
      }),
      tier: d.tier || 'contract',
    };
  }
  return out;
};

const maturityView = (m) =>
  `${
    Object.entries(m)
      .filter(([, v]) => v.rung !== 'absent')
      .map(([id, v]) => `${id} ${v.value} (${v.rung})`)
      .join(', ') || 'nothing produced yet'
  }; plan ${rollup(Object.values(m).filter((v) => v.rung !== 'absent'))}. Maturity never gates; ${MACHINE_CAP} is the most a document only machines have touched can reach.`;
const ladderNow = () => {
  const cov = coverage(LADDER, present(), { code: WANT_CODE, stage: STAGE });
  const slots = new Map(cov.slots.map((x) => [x.id, x]));
  const mustProduce = cov.stepsToSeal.flatMap((id) =>
    slots.get(id).docTypes.filter((t) => producible.has(t)),
  );
  return { ...cov, mustProduce };
};
// the Master sees what can be produced, never who produces it (H-35: casting is derived)
const catalogueView = () => {
  const now = new Set(present());
  return catalogue.doctypes.map((d) => ({
    id: d.id,
    title: d.title,
    purpose: d.purpose,
    path: artifactPath(d),
    exists: now.has(d.id),
  }));
};
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
// A plan that already has waves behind it (an interrupted run, resumed on its branch) is read back from
// its ledger, so the Master sees the same history it would have seen had nothing stopped (NFR-1, NFR-2:
// the digest is a fold over recorded state, and the Master is re-read, never resumed).
const ledgerFile = join(ROOT, 'ledger', `${PLAN}.jsonl`);
const prior = existsSync(ledgerFile)
  ? rebuild(parseLedger(readFileSync(ledgerFile, 'utf8')))
  : { waves: [], gaps: [], questions: [], gates: {}, lastWave: 0, agents: [] };
// artifact id → { ok, tail }: the quality gate a code artifact must pass. Seeded from the ledger so a
// resumed plan remembers a gate that already passed, and does not re-judge it as never run.
Object.assign(gates, prior.gates);
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
waves.push(...prior.waves);
gaps.push(...prior.gaps);
if (prior.lastWave)
  ledger('decision', {
    station: 'conduct',
    decision: 'resumed',
    from_wave: prior.lastWave,
    gaps: prior.gaps.map((g) => `${g.id} ${g.status}`),
    agents: prior.agents,
  });

// what a premise may cite: the intent, an artifact of the catalogue, an earlier gap or question, a canon
// capability or criterion, or a file that exists in the repository
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
  const ladder = ladderNow();
  // drift is composed into the prompt from reads the run already holds, never fetched by a tool the
  // Master has to think to call: a finding that surfaces only when asked for is one it will never see
  const drift = driftNow();
  const consti = constitutionNow();
  for (const a of staleArtifacts(drift))
    if (!driftSeen.some((x) => x.artifact === a && x.wave === n))
      driftSeen.push({ artifact: a, wave: n });
  const session = randomUUID();
  ledger('seat-start', { seat: 'master', session, station: 'conduct', wave: n, attempt });
  const r = await seat({
    session,
    prompt: [
      readFileSync(conductorPrompt, 'utf8'),
      `\n\n--- PLAN ---\n${PLAN} on ${branch}, track ${route.track}, rigor ${route.rigor}; at most ${MAX_WAVE} agent(s) at once; decision ${n}; ${n <= MAX_WAVES ? `${MAX_WAVES - n + 1} wave(s) of work left, including this one` : 'no waves of work are left: decide no-move or clarify'}`,
      `\n\n--- INTENT ---\n${intent}`,
      `\n\n--- LADDER (what this plan owes before its seal; ${intentKind}, rigor ${route.rigor}) ---\n${coverageView(ladder)}`,
      `\n\n--- MATURITY ---\n${maturityView(maturityNow())}`,
      `\n\n--- CATALOGUE (what can be produced) ---\n${JSON.stringify(catalogueView(), null, 2)}`,
      `\n\n--- IDS A PREMISE MAY CITE ---\n${citableView()}, or the path of any file in the repository`,
      drift.length ? `\n\n--- ${DRIFT_HEADER} ---\n${driftDigest(drift)}` : '',
      consti && (consti.blocking.length || consti.flagged.length)
        ? `\n\n--- CONSTITUTION ---\n${stageView(STAGE)}\n${constitutionView(consti)}`
        : '',
      `\n\n--- SO FAR ---\n${digest.text || 'Nothing has been done on this plan yet.'}`,
      refusals
        ? `\n\n--- REFUSED ---\nYour previous decision was refused by the door for these reasons. Correct it once:\n${refusals.map((x) => `- ${x}`).join('\n')}`
        : '',
    ].join(''),
    budget: harness.budgets?.usd_per_master_call || 0.5,
    deadlineS: MASTER_DEADLINE,
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
      decision: r.timedOut ? 'master-abstained' : 'master-failed',
      deadline_s: r.timedOut ? MASTER_DEADLINE : null,
      stderr: r.stderr?.slice(-400),
    });
    handoff(`${PLAN} master seat failed`);
    fail(`master seat failed: ${String(r.out?.result || r.stderr).slice(0, 300)}`);
  }
  const valid = validateGap(dec, catalogue, {
    maxWave: MAX_WAVE,
    exists: citable,
    mustProduce: ladder.mustProduce,
  });
  const stale = driftRefusals({
    outcome: dec.outcome,
    artifacts: (dec.gap?.artifacts || []).map((a) => a.artifact || a),
    entries: drift,
  });
  if (stale.length) {
    valid.ok = false;
    valid.refusals = [...(valid.refusals || []), ...stale];
  }
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
      ladder: {
        key: ladder.key,
        steps_to_seal: ladder.stepsToSeal,
        must_produce: ladder.mustProduce,
      },
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
  const maturityBefore = maturityNow();
  const existedBefore = Object.entries(maturityBefore)
    .filter(([, v]) => v.rung !== 'absent' && v.rung !== 'planted')
    .map(([id]) => id);
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
    // A seat's shell allowlist is a fact in the roster, and a seat that is not told it infers the rule
    // from the first denial: two dev seats in a row (hlab-a s12a w3, w4) were refused `npm run check`,
    // concluded no command could be run, and delivered code they had never tested although the gate's
    // three commands were theirs to run. The allowlist is derived here, never written into a prompt file.
    const mayRun = (a.def.tools || []).filter((t) => /^Bash\(/.test(t)).map((t) => t.slice(5, -1));
    a.prompt = [
      readFileSync(promptFile, 'utf8'),
      `\n\n--- OWNS ---\n${a.owned.join('\n')}`,
      `\n\n--- MAY RUN (exactly these commands; every other shell command is denied, and a denial says nothing about these) ---\n${
        mayRun.length ? mayRun.map((c) => `- ${c}`).join('\n') : 'nothing: this seat has no shell'
      }`,
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
        // a lab lever to prove abandonment: --force-deadline applies to the first wave only
        deadlineS: n === 1 && FORCE_DEADLINE ? FORCE_DEADLINE : AGENT_DEADLINE,
      }),
    ),
  );

  // witnesses: the hook's footprint and git's state diff (neither written by a model), and each
  // transcript as a third; git sees the wave's changes together, the hook and the transcript per session
  const mutations = parsePorcelainOps(
    sh('git', ['status', '--porcelain', '--untracked-files=all']).stdout,
  ).filter((m) => !m.target.startsWith('ledger/'));
  const changed = mutations.map((m) => m.target);
  const outsideWave = outsideJurisdiction(
    changed,
    wave.flatMap((a) => a.owned),
  );
  // a code artifact is only delivered when the app's own checks pass on it; the gate is run by this
  // script, never by the seat that wrote the code
  for (const a of wave)
    for (const id of a.artifacts) {
      const d = catalogue.doctypes.find((x) => x.id === id);
      if (d?.kind !== 'code' || !d.gate) continue;
      const run = () => {
        // no login shell: the gate must run in the same environment the harness does, or it tests the
        // code against a different node than the one the app's dependencies were installed for
        const g = sh('bash', ['-c', d.gate], { timeout: 600000 });
        return {
          ok: g.status === 0,
          tail: (String(g.stdout || '') + String(g.stderr || '')).slice(-600),
        };
      };
      let g = run();
      let flaky = false;
      // a failing gate is run once more before it is believed: the same triage the pipeline does, after
      // a transient test-runner error failed a seat whose tests passed on the next run (hlab-a s11)
      if (!g.ok) {
        const again = run();
        flaky = again.ok;
        g = again.ok ? { ...again, flaky: true, first: g.tail } : g;
      }
      gates[id] = g;
      ledger('decision', {
        station: 'gate',
        wave: n,
        artifact: id,
        command: d.gate,
        ok: g.ok,
        flaky,
        tail: g.tail.slice(-400),
      });
    }
  wave.forEach((a, i) => {
    const r = results[i];
    const t = transcript(a.session);
    a.result = r;
    a.outsideWave = outsideWave;
    a.authored = authoredPaths(t, ROOT);
    a.read = toolPaths(t, ROOT, ['Read']);
    a.relay = relayConsumed(a.relayed, a.owned, a.read);
    a.written = a.owned.flatMap((o) =>
      o.includes('*')
        ? changed.filter((p) => owns([o], p))
        : existsSync(join(ROOT, o)) && readFileSync(join(ROOT, o), 'utf8').trim()
          ? [o]
          : [],
    );
    // an owned entry is delivered when a file it names, or a file under its glob, was written
    a.undelivered = a.owned.filter((o) =>
      o.includes('*') ? !a.written.some((p) => owns([o], p)) : !a.written.includes(o),
    );
    a.asked = r.out?.structured_output?.questions || [];
    a.footprint = footprintOf(a.session);
    a.veto = vetoHeld(a.footprint);
    for (const d of a.veto.denied)
      ledger(
        'department',
        {
          department: d.department,
          veto: d.denied,
          reason: d.reason,
          tool: d.tool,
          target: d.target,
          seat: a.agent,
          session: a.session,
          wave: n,
        },
        `script:veto`,
      );
    a.mutations = mutations.filter((m) => owns(a.owned, m.target));
    const failedGate = a.artifacts.find((id) => gates[id] && !gates[id].ok);
    Object.assign(
      a,
      failedGate
        ? {
            terminal: 'abandoned',
            // the tail travels with the reason: the digest relays the reason, so the Master and the seat
            // cast next read what failed instead of "the gate failed" (hlab-a s12a w4 changed nothing)
            reason: `the quality gate failed for ${failedGate}: ${String(
              gates[failedGate].tail || '',
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(-400)}`,
          }
        : terminalFor({
            ok: r.ok,
            timedOut: r.timedOut,
            deadlineS: r.deadlineS,
            error: String(r.out?.result || r.stderr || '').slice(0, 200),
            denied: a.veto.denied.map((d) => `${d.department} ${d.denied}: ${d.reason}`),
            owned: a.undelivered,
            written: a.written,
          }),
    );
    a.row = row(a.agent, 'conduct', a.session, r, {
      wave: n,
      artifacts: a.artifacts,
      authored: a.authored,
      outside: outsideJurisdiction(a.authored, a.owned),
      relay: a.relay,
      summary: String(r.out?.structured_output?.summary || r.out?.result || '').slice(0, 600),
      questions: a.asked.length,
      terminal: a.terminal,
      reason: a.reason,
      footprint_calls: a.footprint.length,
    });
    ledger('seat-end', a.row);
    stat({ tool: 'claude -p', ...a.row });
  });
  const unchanged = wave.flatMap((a) =>
    footprintWrites(a.footprint).filter((p) => !changed.includes(p) && existsSync(join(ROOT, p))),
  );
  const witnesses = corroborate(wave, mutations, { unchanged });
  // an abandoned seat's partial work is kept as evidence, committed under its name and marked so
  for (const a of wave) {
    if (!a.written.length || a.row.outside.length || outsideWave.length) continue;
    const c = commitAs(
      `seat:${a.agent}`,
      a.written,
      `docs(intent): ${PLAN} ${a.written.join(', ')} by seat:${a.agent} (wave ${n}${a.terminal === 'complete' ? '' : `, ${a.terminal}: ${a.reason}`})`,
    );
    if (ok(c)) a.commit = git(['rev-parse', 'HEAD']);
  }
  handoff(`${PLAN} wave ${n} witnessed`);
  agents.push(...wave);
  // a gap closes when every seat cast for it completed and its artifacts are committed; a closing gap
  // supersedes any earlier open gap that named the same artifacts
  // FR-23: every claimed artifact changed by its cast seat, and a linked artifact matured (or, for a pure
  // rewrite, the reconciliation recorded)
  const maturityAfter = maturityNow();
  const val = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.value]));
  gap.closure = verifyClosure({
    claimed: wave.flatMap((a) =>
      a.artifacts.map((id, i) => ({ artifact: id, path: a.owned[i], agent: a.agent })),
    ),
    mutationsBySeat: Object.fromEntries(wave.map((a) => [a.agent, a.mutations])),
    before: val(maturityBefore),
    after: val(maturityAfter),
    existed: existedBefore,
  });
  gap.maturity = Object.fromEntries(
    gap.artifacts.map((id) => [id, [maturityBefore[id].value, maturityAfter[id].value]]),
  );
  gap.status =
    wave.every((a) => a.terminal === 'complete' && a.commit) && gap.closure.ok
      ? 'closed'
      : 'linked';
  gap.agents = wave.map((a) => a.agent);
  ledger('gap', {
    id: gap.id,
    status: gap.status,
    wave: n,
    written: wave.flatMap((a) => a.written),
    commits: wave.map((a) => a.commit || null),
    terminals: wave.map((a) => ({ agent: a.agent, terminal: a.terminal, reason: a.reason })),
    closure: gap.closure,
    maturity: gap.maturity,
  });
  if (gap.status === 'closed')
    for (const id of supersede(gaps, gap)) {
      gaps.find((g) => g.id === id).status = 'superseded';
      ledger('gap', { id, status: 'superseded', by: gap.id, wave: n });
    }
  handoff(`${PLAN} ${gap.id} ${gap.status}`);
  const record = {
    n,
    gap: { id: gap.id, statement: gap.statement },
    overlap: overlapSeconds(results.map((r) => ({ start: r.start, end: r.end }))),
    witnesses,
    activations: wave.map((a) => ({
      agent: a.agent,
      artifacts: a.artifacts,
      task: a.task,
      written: a.written,
      commit: a.commit || null,
      summary: a.row.summary,
      terminal: a.terminal,
      reason: a.reason,
    })),
    questions: [],
  };
  waves.push(record);
  return { wave, record };
}

// 4. the ActivationRecord, once the questions are settled: a seat whose own question stopped the plan
// ended escalated; every field but resultProse is written by this script (FR-16)
function recordWave(n, wave, record, stop) {
  for (const a of wave) {
    const mine = qResults.filter((q) => q.n === n && q.a === a && q.file);
    if (stop && a.terminal === 'complete' && mine.some((q) => q.file === stop.file))
      Object.assign(a, { terminal: 'escalated', reason: `question ${stop.file} stopped the plan` });
    a.record = buildRecord({
      gapId: record.gap.id,
      artifacts: a.artifacts,
      agent: a.agent,
      session: a.row.session,
      footprint: a.footprint,
      mutations: a.mutations,
      decisionsTouched: mine.map((q) => q.file),
      terminal: a.terminal,
      reason: a.reason,
      resultProse: a.row.summary,
    });
    ledger('record', a.record);
    const act = record.activations.find((x) => x.agent === a.agent);
    Object.assign(act, { terminal: a.terminal, reason: a.reason });
  }
  // the stamp (FR-22): every artifact this wave delivered is marked with the decisions that held when
  // it was written — this wave's answers included, since they were given before the wave was recorded.
  // Machine-written from state the run holds; no seat is asked whether its document is current.
  const live = worldNow();
  const stamp = stampAtWrite(live);
  for (const a of wave) {
    if (a.terminal !== 'complete') continue;
    for (const id of a.artifacts) {
      const d = catalogue.doctypes.find((x) => x.id === id);
      ledger('stamp', {
        artifact: id,
        path: d ? artifactPath(d) : '',
        wave: n,
        decisions: stamp,
        by: a.agent,
      });
    }
  }
  handoff(`${PLAN} wave ${n} records`);
}

// 3. questions: decider first, the Master only if allowed; returns true when the floor stops the plan
async function questions(n, wave, record) {
  const asked = wave.flatMap((a) => a.asked.map((q) => ({ a, q })));
  if (!asked.length) return false;
  mkdirSync(qdir, { recursive: true });
  let k = readdirSync(qdir).filter((f) => /^Q-\d+\.md$/.test(f)).length;
  const mine = [];
  for (const { a, q: raw } of asked) {
    // a trigger that cannot be true in this app is dropped before the decider reads it, and recorded
    const { kept, dropped } = deriveTriggers(raw.triggers, departments);
    const q = { ...raw, triggers: kept };
    if (dropped.length) q.dropped_triggers = dropped;
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
      deadlineS: MASTER_DEADLINE,
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

for (let n = prior.lastWave + 1; ; n++) {
  const d = await decide(n);
  if (!d.valid.ok) {
    ending = 'refused';
    break;
  }
  // the cap bounds waves of work, not the decision that closes them: after the last wave the Master is
  // asked once more, and only no-move or clarify may follow
  if (n > MAX_WAVES && d.dec.outcome === 'move') {
    ending = 'wave-cap';
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
  const stopped = await questions(n, wave, record);
  recordWave(n, wave, record, stopped ? qResults.find((q) => q.n === n && q.stopsRound) : null);
  if (stopped) {
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
const ranAgents = [...new Set([...prior.agents, ...agents.map((a) => a.agent)])].sort();
const relayWaves = agents.filter((a) => a.relay.needed && a.terminal === 'complete');
const multi = waves.filter((w) => !w.prior && w.activations.length > 1);
const endLadder = ladderNow();
const expectedEnding = EXPECT_END || (EXPECT_Q === 'needs-input' ? 'needs-input' : 'goal-closed');
const checks = {
  'sessions-distinct': {
    ok: (() => {
      const all = [...decisions.map((d) => d.row.session), ...agents.map((a) => a.row.session)];
      return new Set(all).size === all.length && all.every((s) => !!transcript(s));
    })(),
    msg: `${prior.lastWave ? `resumed after wave ${prior.lastWave} (${prior.waves.length} wave(s), agents ${prior.agents.join(', ')} read back from the ledger); ` : ''}${decisions.length} Master decision session(s), ${agents.length} agent session(s), ${answerRows.length} answer session(s); every transcript on disk`,
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
          ok: gaps.every((g) => ['closed', 'superseded'].includes(g.status)),
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
          // a seat is judged on delivery only when it says it delivered; an owned entry may be a glob,
          // so delivery is "nothing left undelivered", never a file count
          ok: agents.every(
            (a) =>
              !a.row.outside.length &&
              !a.outsideWave.length &&
              (a.terminal !== 'complete' || !a.undelivered.length),
          ),
          msg: agents
            .map(
              (a) =>
                `w${a.n} ${a.agent} wrote ${a.written.join(', ') || 'nothing'}, authored ${a.authored.join(', ') || 'nothing'}${a.row.outside.length ? ` (outside: ${a.row.outside.join(', ')})` : ''}${a.outsideWave.length ? ` (tree outside the wave: ${a.outsideWave.join(', ')})` : ''}`,
            )
            .join(' · '),
        },
        ...(agents.some((a) => a.veto.denied.length) || EXPECT_VETO
          ? {
              'veto-held': {
                // the guarded action was attempted, denied with its reason, and never reached another way
                ok:
                  agents.every((a) => a.veto.ok) &&
                  (!EXPECT_VETO ||
                    agents.some((a) => a.veto.denied.some((d) => d.department === EXPECT_VETO))),
                msg: `${EXPECT_VETO ? `expected a ${EXPECT_VETO} veto; ` : ''}${
                  agents
                    .filter((a) => a.veto.denied.length)
                    .map(
                      (a) =>
                        `w${a.n} ${a.agent} denied ${a.veto.denied.map((d) => `${d.tool} ${d.target} (${d.department} ${d.denied})`).join(', ')}${a.veto.breaches.length ? `; BREACHED: ${a.veto.breaches.join('; ')}` : '; held'}`,
                    )
                    .join(' · ') || 'no call was denied'
                }`,
              },
            }
          : {}),
        'closure-verified': {
          // no gap closed without its artifacts changed by the cast seat and, unless a reconciliation,
          // a linked artifact maturing
          ok: gaps.every(
            (g) => g.prior || g.status === 'superseded' || (g.status === 'closed' && g.closure?.ok),
          ),
          msg: gaps
            .filter((g) => !g.prior)
            .map(
              (g) =>
                `${g.id} ${g.status}: ${Object.entries(g.maturity || {})
                  .map(([id, [b, a]]) => `${id} ${b}→${a}`)
                  .join(
                    ', ',
                  )}${g.closure?.reconciliation ? ' (reconciliation)' : ''}${g.closure?.refusals?.length ? ` refused: ${g.closure.refusals.join('; ')}` : ''}`,
            )
            .join(' · '),
        },
        'machine-cap-held': {
          ok: Object.values(maturityNow()).every((v) => v.value <= MACHINE_CAP),
          msg: maturityView(maturityNow()),
        },
        'witnesses-agree': {
          // the hook's footprint, git's state diff and the transcript name the same writes
          ok: waves.every((w) => w.prior || w.witnesses?.ok),
          msg: waves
            .filter((w) => !w.prior)
            .map((w) =>
              w.witnesses?.ok
                ? `w${w.n} hook, git and transcript agree (${w.activations.map((x) => x.agent).join(', ')})`
                : `w${w.n} ${(w.witnesses?.disagreements || ['no witness']).join('; ')}`,
            )
            .join(' · '),
        },
        'terminals-read': {
          ok:
            agents.every((a) => TERMINALS.includes(a.terminal) && a.reason && a.record) &&
            (!EXPECT_TERM || agents.some((a) => a.n === 1 && a.terminal === EXPECT_TERM)),
          msg: `${EXPECT_TERM ? `expected ${EXPECT_TERM} in wave 1; ` : ''}${agents.map((a) => `w${a.n} ${a.agent} ${a.terminal} (${a.reason})`).join(' · ')}`,
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
  'ladder-covered': {
    // the plan closes when a script says the ladder is covered, never on the Master's word alone; a
    // required rung nothing in the catalogue can produce is a roster gap, named here
    ok: ending !== 'goal-closed' || endLadder.covered,
    msg: `${LADDER} (${intentKind}); required still missing: ${endLadder.stepsToSeal.join(', ') || 'none'}${endLadder.stepsToSeal.length && !endLadder.mustProduce.length ? ' (no catalogue artifact produces it)' : ''}; present ${present().join(', ') || 'none'}`,
  },
  'constitution-evaluated': {
    // the constitution is run, not quoted. A violation whose tier blocks at this stage stops the plan
    // closing; below it the violation is real, recorded as debt, and the plan proceeds carrying it
    ok: (() => {
      const c = constitutionNow();
      return !c || ending !== 'goal-closed' || c.ok;
    })(),
    msg: (() => {
      const c = constitutionNow();
      if (!c) return 'no constitution in this app';
      return `${STAGE} (${lawFor(STAGE).stakes}): ${c.blocking.length} blocking, ${c.flagged.length} flagged as debt, ${c.unenforced.length} unenforced of ${c.verdicts.length} rule(s)${
        c.blocking.length
          ? `; BLOCKS: ${c.blocking.map((v) => `${v.id} ${v.detail}`).join('; ')}`
          : ''
      }${c.flagged.length ? `; debt: ${c.flagged.map((v) => `${v.id} (${v.tier})`).join(', ')}` : ''}${
        c.stale.length ? `; stale: ${c.stale.join('; ')}` : ''
      }`;
    })(),
  },
  'drift-repaired': {
    // drift outranks growth, so a plan may not close while an artifact of it contradicts a decision
    // that holds now; when nothing ever drifted this passes and says so
    ok: ending !== 'goal-closed' || !driftNow().length,
    msg: driftSeen.length
      ? `${driftSeen.map((d) => `${d.artifact} stale at decision ${d.wave}`).join(', ')}; now ${
          staleArtifacts(driftNow()).join(', ') || 'nothing is stale'
        }`
      : 'nothing drifted on this plan',
  },
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
    // two series (NFR-16): every session is metered in tokens from its transcript; USD comes from the
    // seat's own report, which a killed seat never makes, so its USD is recorded as unknown, not zero
    ok: [...masterCalls, ...agents.map((a) => a.row)].every(
      (r) => r.transcript_tokens?.messages > 0 && (typeof r.cost_usd === 'number' || r.timed_out),
    ),
    msg: `Master decisions $${masterCost.toFixed(3)} + answers $${answerCost.toFixed(3)}, agents $${agentCost.toFixed(3)}${
      agents.some((a) => a.row.cost_usd == null)
        ? ` (+ ${agents
            .filter((a) => a.row.cost_usd == null)
            .map(
              (a) =>
                `${a.agent} w${a.n}: ${a.row.transcript_tokens.output} output tokens, USD unknown`,
            )
            .join(', ')})`
        : ''
    }; Master share of agent spend ${agentCost ? Math.round(((masterCost + answerCost) / agentCost) * 100) : 0}%`,
  },
};
// ---------------------------------------------------------------- delivery (H-1, step 12)
// A closed plan with a covered ladder is not finished: its contract and its code still have to reach
// main through the pipeline, which is where canon lands. The Master does not decide this and no seat
// runs it — the ladder being covered is the condition, and a script does the rest.
let delivery = null;
let maturityAfter = null;
if (WANT_DELIVER && ending === 'goal-closed' && endLadder.covered) {
  console.log('\nconduct: the plan is closed and its ladder covered; delivering');
  handoff(`${PLAN} conduct closed, delivering`);
  const r = spawnSync('node', [join(ROOT, 'scripts', 'harness', 'deliver.mjs'), '--plan', PLAN], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  delivery = readJson(join(H, `deliver-${PLAN}.json`), null);
  const land = readJson(join(H, 'land.json'), null);
  // the top rung becomes reachable here and nowhere else: the plan landed, so its code is on main and
  // its documents are sealed; a document a later seat actually opened is now consumed (D3 1.00)
  // every path any seat of this plan opened, from the ledger: a document read in a wave this run only
  // rebuilt (a resume) was still read, and consumption is a fact about the plan, not about the session
  const lines = existsSync(ledgerFile) ? parseLedger(readFileSync(ledgerFile, 'utf8')) : [];
  const openedPaths = [
    ...new Set([
      ...agents.flatMap((a) => a.read || []),
      ...lines
        .filter((l) => l?.kind === 'record')
        .flatMap((l) => (l.data?.toolFootprint || []).filter((t) => t.tool === 'Read'))
        .map((t) => t.target)
        .filter(Boolean),
    ]),
  ];
  const wrote = authoredByArtifact(lines);
  const consumed = new Set(
    consumedArtifacts({
      landed: !!delivery?.ok,
      artifacts: catalogue.doctypes.map((d) => ({
        id: d.id,
        code: d.kind === 'code',
        // both names of the artifact: the one a seat wrote it under, and the one the landing sealed it to
        paths: [
          ...new Set([
            ...agents.filter((a) => a.artifacts.includes(d.id)).flatMap((a) => a.written),
            ...(wrote[d.id] || []),
            d.path.replaceAll('{plan}', PLAN),
            artifactPath(d),
          ]),
        ],
      })),
      openedPaths,
    }),
  );
  maturityAfter = maturityNow(consumed);
  checks['documents-consumed'] = {
    ok: !delivery?.ok || consumed.size > 0,
    msg: `${[...consumed].join(', ') || 'nothing'} consumed by the landing; ${maturityView(maturityAfter)}`,
  };
  checks['plan-delivered'] = {
    ok: r.status === 0 && !!delivery?.ok,
    msg: delivery
      ? `${(delivery.stations || []).map((x) => `${x.station} ${x.ok ? 'ok' : 'FAILED'} ${x.minutes}min`).join(', ')}${
          delivery.ok && land
            ? `; merged at ${String(land.mergeSha).slice(0, 7)}, ${(land.deltas || []).length} delta(s): ${(
                land.deltas || []
              )
                .map(
                  (d) =>
                    `${d.altitude || '?'} ${d.op} ${d.node || (d.files ? `${d.files} file(s)` : d.file || '')}${d.version ? ` → ${d.version}` : ''}`,
                )
                .join(', ')}`
            : ''
        }`
      : `deliver.mjs exited ${r.status} before writing its record`,
  };
} else if (WANT_DELIVER && ending === 'goal-closed') {
  checks['plan-delivered'] = {
    ok: false,
    msg: `the plan closed with ${endLadder.stepsToSeal.join(', ')} still missing, so nothing was delivered`,
  };
}

const pass = Object.values(checks).every((c) => c.ok);
writeJson(join(H, `conduct-${PLAN}.json`), {
  plan: PLAN,
  expect: EXPECT,
  expect_question: EXPECT_Q,
  expect_ending: expectedEnding,
  ending,
  sequence,
  chose,
  ladder: { key: LADDER, intent_kind: intentKind, landed_plans: landedPlans, end: endLadder },
  drift: { seen: driftSeen, now: driftNow() },
  delivery,
  resumed: prior.lastWave ? { from_wave: prior.lastWave, agents: prior.agents } : null,
  maturity: maturityAfter || maturityNow(),
  maturity_before_delivery: maturityAfter ? maturityNow() : null,
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
  agents: agents.map((a) => ({ ...a.row, commit: a.commit ?? null, record: a.record ?? null })),
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
