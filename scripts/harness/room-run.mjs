#!/usr/bin/env node
// Rooms, step 16a: convene a room from a spec, stage each seat's read-only workspace, run one sitting of
// read-only seats in parallel, and judge it from facts: the tripwire (each workspace left as staged),
// reach (no footprint target outside the seat's own workspace and the shared one), and containment
// (each seat's planted canary seen by it and by no other seat). Everything is a `room` line in
// ledger/room-<id>.jsonl. Turns and minutes are 16b; runRound and the choosers are 16c.
//
// Usage: node scripts/harness/room-run.mjs --spec <room.json> [--force-tripwire <seat>] [--expect-terminal t]
//   --force-tripwire  a lab lever: the orchestrator writes into that seat's workspace during its turn,
//                     to prove the tripwire ends the seat and the room blocked
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { ROOT, billingFindings, commitOnly, git, modelEnv, readJson } from './common.mjs';
import { transcriptDir } from './activation.mjs';
import {
  ROOM_ACTIONS,
  ROOM_DENIED,
  canaryContainment,
  estimateRoomUsd,
  foldRoom,
  reachHeld,
  stagedManifest,
  tripwire,
  validateRoomParams,
} from './room.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const fail = (msg, code = 1) => {
  console.error(`room: ${msg}`);
  process.exit(code);
};
const specFile = arg('spec');
if (!specFile) fail('--spec required', 2);
const spec = readJson(resolve(specFile));
if (!spec) fail(`no room spec at ${specFile}`, 2);
const specDir = dirname(resolve(specFile));
const FORCE_TRIPWIRE = arg('force-tripwire');
const EXPECT_TERMINAL = arg('expect-terminal');
const DEADLINE_S = Number(arg('deadline', '300'));
const ID = spec.id;
if (!/^[a-z0-9][\w-]*$/.test(String(ID || ''))) fail('the spec has no plain id', 2);
const LEDGER = `room-${ID}`;
const ledgerFile = join(ROOT, 'ledger', `${LEDGER}.jsonl`);
if (existsSync(ledgerFile)) fail(`ledger/${LEDGER}.jsonl exists: a room id is used once`, 2);

const sh = (file, args) =>
  new Promise((res) => {
    const c = spawn(file, args, { cwd: ROOT });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (status) => res({ status, stdout: out, stderr: err }));
  });
const ledger = async (data, actor = 'script:room') => {
  const r = await sh('node', [
    join(ROOT, 'scripts', 'harness', 'ledger.mjs'),
    'append',
    '--plan',
    LEDGER,
    '--kind',
    'room',
    '--actor',
    actor,
    '--data',
    JSON.stringify({ room: ID, ...data }),
  ]);
  if (r.status !== 0)
    fail(`the ledger refused a room line: ${(r.stderr || r.stdout).slice(0, 300)}`);
};
const hashFile = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
// a workspace's state: relative path → content hash, so a write of anything is a diff
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else out[relative(dir, p)] = hashFile(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
};

// 1. the record refuses what a room cannot be, and the price is checked before anything is spent
const params = {
  trigger: spec.trigger || 'owner',
  action: spec.action,
  question: spec.question,
  termination: spec.termination,
  addressing: spec.addressing || 'direct',
  budgetUsd: spec.budgetUsd,
  seats: (spec.seats || []).map((s) => ({ id: s.id })),
};
const valid = validateRoomParams(params);
if (!valid.ok) fail(`refused: ${valid.refusals.join('; ')}`, 2);
const estimate = estimateRoomUsd(params);
if (!estimate.within)
  fail(`refused: over budget, ${estimate.arithmetic} > $${params.budgetUsd}`, 2);
{
  const billed = billingFindings();
  if (billed.length)
    fail(`seats would be billed, not run on the CLI login: ${billed.join('; ')}`, 2);
}
await ledger({
  event: 'convened',
  params,
  estimateUsd: estimate.usd,
  arithmetic: estimate.arithmetic,
});

// 2. the workspace: an orchestrator folder no seat can reach, a shared folder, and one private folder
// per seat, each holding only what that seat was given
const WS = realpathSync(mkdtempSync(join(tmpdir(), `myc-room-${ID}-`)));
const ORCH = join(WS, '.orchestrator');
const SHARED = join(WS, 'shared');
mkdirSync(ORCH, { mode: 0o700 });
mkdirSync(SHARED, { mode: 0o700 });
const stageInto = (dir, files) =>
  (files || []).map((f) => {
    const src = resolve(specDir, f.from);
    if (!existsSync(src)) fail(`staged file ${f.from} does not exist`, 2);
    const dst = join(dir, f.path);
    if (!dst.startsWith(`${dir}/`)) fail(`staged path ${f.path} leaves its workspace`, 2);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    return { path: f.path, from: f.from, sha256: hashFile(dst) };
  });
const sharedFiles = stageInto(SHARED, spec.shared);
const seats = spec.seats.map((s, i) => {
  const dir = join(WS, String(i + 1), 'private');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    ...s,
    ordinal: i + 1,
    dir,
    session: randomUUID(),
    staged: stageInto(dir, s.evidence),
  };
});
writeFileSync(
  join(ORCH, 'manifest.json'),
  JSON.stringify({ room: ID, shared: sharedFiles, seats: seats.map((s) => s.staged) }, null, 2),
);
await ledger({
  event: 'sitting',
  sitting: 1,
  cast: seats.map((s) => s.id),
  shared: stagedManifest('shared', sharedFiles).files,
  staged: seats.map((s) => stagedManifest(s.id, s.staged)),
});

// 3. a read-only seat: only the room's tools, a deny at the call for every writing tool (depth, not the
// guard), the footprint hook as witness, no MCP, cwd its own folder plus the shared one
const tools = ROOM_ACTIONS[params.action];
const SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: ROOM_DENIED.join('|'),
        hooks: [{ type: 'command', command: 'echo "room seats are read-only" >&2; exit 2' }],
      },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            // the hook's project dir is the seat's cwd, so the witness would write into the workspace
            // it watches (the first trial tripped on its own footprint): it is pointed at the app
            command: `CLAUDE_PROJECT_DIR=${JSON.stringify(ROOT)} node ${JSON.stringify(join(ROOT, '.claude', 'hooks', 'footprint.mjs'))}`,
          },
        ],
      },
    ],
  },
});
const ENV = modelEnv(process.env, { CLAUDE_PROJECT_DIR: ROOT });
const prompt = (s) =>
  [
    `You sit in a room of ${seats.length} seat(s). You can read your own folder (the current directory) and the shared folder ${SHARED}. Read the brief there first.`,
    `Question: ${params.question.text}`,
    ...(params.question.checklist || []).map((c) => `- ${c}`),
    'Answer from the files you can read. For every claim, name the file it comes from and quote the line. If the files do not settle it, say so.',
    s.role ? `Your seat: ${s.role}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
const runSeat = (s) => {
  const start = Date.now();
  const child = spawn(
    'claude',
    [
      '-p',
      '--output-format',
      'json',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--settings',
      SETTINGS,
      '--session-id',
      s.session,
      '--max-budget-usd',
      String(Math.max(0.05, params.budgetUsd / seats.length)),
      '--add-dir',
      SHARED,
      '--allowedTools',
      tools.join(','),
      '--tools',
      tools.join(','),
    ],
    { cwd: s.dir, stdio: ['pipe', 'pipe', 'pipe'], env: ENV, detached: true },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, DEADLINE_S * 1000);
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.end(prompt(s));
  return new Promise((res) =>
    child.on('close', (code) => {
      clearTimeout(timer);
      let out = null;
      try {
        out = JSON.parse(stdout);
      } catch {
        /* unparsable output is an abstention */
      }
      res({
        ok: !timedOut && code === 0 && !!out && !out.is_error,
        timedOut,
        out,
        minutes: Math.round((Date.now() - start) / 6000) / 10,
      });
    }),
  );
};

const before = Object.fromEntries(
  seats.map((s) => [s.id, { ...snapshot(s.dir), ...prefixed(snapshot(SHARED)) }]),
);
function prefixed(snap) {
  return Object.fromEntries(Object.entries(snap).map(([k, v]) => [`shared/${k}`, v]));
}
const deadlineAt = new Date(Date.now() + DEADLINE_S * 1000).toISOString();
await ledger({
  event: 'round',
  round: 1,
  phase: 'opened',
  speakers: seats.map((s) => s.id),
  deadlineAt,
  ...(FORCE_TRIPWIRE ? { lever: `force-tripwire ${FORCE_TRIPWIRE}` } : {}),
});
const running = seats.map(runSeat);
if (FORCE_TRIPWIRE) {
  const s = seats.find((x) => x.id === FORCE_TRIPWIRE);
  if (!s) fail(`--force-tripwire names no seat: ${FORCE_TRIPWIRE}`, 2);
  writeFileSync(join(s.dir, 'planted-by-lever.md'), 'written into the workspace during the turn\n');
}
const results = await Promise.all(running);

// 4. judged from facts: the tripwire first, then reach, then containment
const footprintOf = (session) => {
  const f = join(ROOT, '.harness', 'footprint', `${session}.jsonl`);
  return existsSync(f)
    ? readFileSync(f, 'utf8')
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
};
const streamOf = (s) => {
  const f = join(transcriptDir(process.env.HOME || '', s.dir), `${s.session}.jsonl`);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};
const outcomes = seats.map((s, i) => {
  const r = results[i];
  const after = { ...snapshot(s.dir), ...prefixed(snapshot(SHARED)) };
  const trip = tripwire(before[s.id], after);
  const footprint = footprintOf(s.session);
  const reach = reachHeld(footprint, [s.dir, SHARED]);
  const read = footprint.filter((f) => f.tool === 'Read').map((f) => f.target);
  const terminal = !trip.held
    ? { terminal: 'blocked', reason: `tripwire: ${trip.diff.join(', ')}` }
    : !reach.held
      ? { terminal: 'blocked', reason: `reach: ${reach.outside.join(', ')}` }
      : !r.ok
        ? {
            terminal: 'abandoned',
            reason: r.timedOut ? `deadline of ${DEADLINE_S}s passed` : 'session failed',
          }
        : { terminal: 'complete', reason: `read ${read.length} file(s)` };
  return {
    seat: s.id,
    session: r.out?.session_id || s.session,
    ok: r.ok,
    minutes: r.minutes,
    cost_usd: r.out?.total_cost_usd ?? null,
    tripwire: trip.diff,
    reach: reach.outside,
    read: read.map((p) => (p.startsWith(WS) ? relative(WS, p) : p)),
    answer: String(r.out?.result || '').slice(0, 1200),
    ...terminal,
  };
});
const canaries = Object.fromEntries(seats.filter((s) => s.canary).map((s) => [s.id, s.canary]));
const containment = canaryContainment(
  canaries,
  Object.fromEntries(seats.map((s) => [s.id, streamOf(s)])),
);
const tripped = outcomes.find((o) => o.tripwire.length);
await ledger({
  event: 'round',
  round: 1,
  phase: 'closed',
  outcomes,
  containment: containment.rows,
  costUsd: outcomes.reduce((t, o) => t + (o.cost_usd || 0), 0),
  ...(tripped ? { halt: { cause: 'tripwire', resumable: false } } : {}),
});
const ending = tripped
  ? { terminal: 'blocked', reason: `tripwire on ${tripped.seat}: ${tripped.tripwire.join(', ')}` }
  : outcomes.some((o) => o.terminal === 'blocked')
    ? { terminal: 'blocked', reason: outcomes.find((o) => o.terminal === 'blocked').reason }
    : outcomes.every((o) => o.terminal === 'abandoned')
      ? { terminal: 'abandoned', reason: 'every seat abstained' }
      : { terminal: 'complete', reason: `${outcomes.filter((o) => o.ok).length} seat(s) answered` };
await ledger({ event: 'ended', ...ending });
rmSync(WS, { recursive: true, force: true });

// 5. checks, each from the ledger and the witnesses
const lines = readFileSync(ledgerFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const room = foldRoom(lines);
const checks = {
  'room-recorded': {
    ok: room.status === 'ended' && room.sittings.length === 1 && room.rounds[0]?.phase === 'closed',
    msg: `${room.status} ${room.terminal} (${room.reason}); ${room.sittings.length} sitting, ${room.rounds.length} round`,
  },
  'workspaces-staged': {
    ok: seats.every((s) => s.staged.length > 0),
    msg: seats.map((s) => `${s.id}: ${s.staged.map((f) => f.path).join(', ')}`).join(' · '),
  },
  'tripwire-held': {
    ok: FORCE_TRIPWIRE
      ? outcomes.find((o) => o.seat === FORCE_TRIPWIRE)?.terminal === 'blocked' &&
        room.terminal === 'blocked'
      : outcomes.every((o) => !o.tripwire.length),
    msg: outcomes.map((o) => `${o.seat} diff ${JSON.stringify(o.tripwire)}`).join(' · '),
  },
  'reach-held': {
    ok: outcomes.every((o) => !o.reach.length),
    msg: outcomes.map((o) => `${o.seat} read ${o.read.join(', ') || 'nothing'}`).join(' · '),
  },
  'evidence-contained': {
    ok: !Object.keys(canaries).length || containment.held,
    msg: containment.rows
      .map((r) => `${r.owner}'s canary seen by ${r.seenBy.join(', ') || 'nobody'}`)
      .join(' · '),
  },
  'room-ended': {
    ok: !EXPECT_TERMINAL || room.terminal === EXPECT_TERMINAL,
    msg: `${EXPECT_TERMINAL ? `expected ${EXPECT_TERMINAL}; ` : ''}ended ${room.terminal}`,
  },
};
const pass = Object.values(checks).every((c) => c.ok);
await ledger({
  event: 'checks',
  pass,
  checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok])),
});
const c = commitOnly([`ledger/${LEDGER}.jsonl`], `chore(ledger): room ${ID} ${room.terminal}`);
if (c.status !== 0)
  console.log(`room: the ledger commit was refused: ${String(c.stderr || c.stdout).slice(-200)}`);
// a ledger commit on main is pushed, as conduct's last one is (03197b9): left local, the next plan is
// planted on a base origin never received
else if (git(['rev-parse', '--abbrev-ref', 'HEAD']) === 'main') {
  const p = spawnSync('git', ['push', '-q', 'origin', 'main'], {
    cwd: ROOT,
    env: { ...process.env, ALLOW_MAIN_PUSH: '1' },
  });
  if (p.status !== 0)
    console.log(`room: push of main failed: ${String(p.stderr || p.stdout).slice(-200)}`);
}
for (const o of outcomes)
  console.log(
    `seat  ${o.seat.padEnd(16)} ${o.terminal} (${o.reason}) $${(o.cost_usd || 0).toFixed(3)}\n      ${o.answer.replace(/\s+/g, ' ').slice(0, 300)}`,
  );
for (const [k, v] of Object.entries(checks))
  console.log(`${v.ok ? 'pass' : 'FAIL'}  ${k.padEnd(20)} ${v.msg}`);
console.log(`room: ${pass ? 'PASSED' : 'FAILED'} · ${room.terminal}`);
process.exit(pass ? 0 : 1);
