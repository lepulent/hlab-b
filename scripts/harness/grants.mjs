#!/usr/bin/env node
// Step 15 (FR-25, D-4; docs/17-step15-authority.md §4.1, §4.5): a grant is ISSUED by the owner, SCOPED,
// EXPIRING and RECORDED — a ledger line, so it stays auditable after it ends (Mycelium
// src/lib/master/grants.ts). Expiry is evaluated at read: a grant past its time, its uses or its dollars,
// or revoked, is simply absent from the fold; no sweeper can miss one.
//
// Defect 6 was never a seat: the session orchestrating the lab delivered on chat authority, and the same
// session could type this command. So the command refuses to run from an agent session or without a
// terminal, and records the facts it was issued under; the fold never counts a grant whose facts show an
// agent. On one laptop this is tamper-evident, not tamper-proof: a line forged by hand is visible in git
// and is still read as flagged if its facts are missing.
//
// Usage (the owner, in a terminal, on the plan branch):
//   npm run harness:grant -- --plan <slug> --kind spend [--usd <n>] [--uses <n>] [--until <iso>] [--acts a,b]
//   npm run harness:grant -- --plan <slug> --kind budget --usd <n>
//   npm run harness:revoke -- --plan <slug> --id GR-<n>
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { ROOT, git, commitOnly } from './common.mjs';
import { parseLedger } from './resume.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { rule } from './authority.mjs';

export const GRANT_KINDS = ['spend', 'budget'];
// What marks a Claude Code session or anything it spawned: any CLAUDE* variable (CLAUDECODE,
// CLAUDE_CODE_*, CLAUDE_PID, ...), and a `claude` process among the command's ancestors. The variables can
// be unset by whoever runs the command; the ancestry cannot be shed by a child (Ludwig 2026-10-02: `env -u
// ... script -q /dev/null npm run harness:grant` passed the variable check alone).
export const CLAUDE_PROCESS =
  /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code|Claude\.app|claude-agent-sdk/i;
export const agentEnv = (env = process.env) => Object.keys(env).filter((k) => /^CLAUDE/.test(k));

// the process chain from this command up to init: [{ pid, comm }]
export function ancestry(pid = process.pid) {
  const chain = [];
  for (let p = pid, i = 0; p > 1 && i < 64; i++) {
    // args, not comm: an SDK or desktop session runs as `node .../cli.js` or a Claude helper, which a
    // match on the command name misses (Ludwig 2026-10-02)
    const r = spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(p)], { encoding: 'utf8' });
    const m = String(r.stdout || '')
      .trim()
      .match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    chain.push({ pid: p, comm: m[2].split(/\s/)[0].split('/').pop(), args: m[2].slice(0, 200) });
    p = Number(m[1]);
  }
  return chain;
}

export function provenance(
  env = process.env,
  { tty = !!process.stdin.isTTY, ppid = process.ppid, chain = ancestry() } = {},
) {
  return {
    tty,
    agent_env: agentEnv(env),
    ppid,
    ancestry: chain.map((x) => x.comm),
    claude_ancestor: chain.some((x) => CLAUDE_PROCESS.test(x.args ?? x.comm)),
    git_user: git(['config', 'user.name']) || null,
  };
}

// why a grant's own record says an agent issued it, or null when it reads as the owner's
export function agentIssued(line) {
  const p = line?.data?.provenance;
  if (line?.actor !== 'owner') return `written by ${line?.actor || 'nobody'}, not the owner`;
  if (!p) return 'carries no provenance (written by hand, not by harness:grant)';
  if (!p.tty) return 'issued without a terminal';
  if ((p.agent_env || []).length) return `issued from an agent session (${p.agent_env.join(', ')})`;
  if (p.claude_ancestor) return 'issued from under a claude process';
  if (!Array.isArray(p.ancestry)) return 'carries no process ancestry';
  if (p.ppid === 1) return 'issued by an orphaned process (ppid 1)';
  return null;
}

// the grants in force, read from the ledger now. Uses and dollars are counted from `ruling` lines that
// the grant allowed (step 15 §5.3), so a grant spent is a fact of the record, never a counter kept aside.
export function foldGrants(lines, { now = new Date() } = {}) {
  const live = [];
  const ended = [];
  const flagged = [];
  const revoked = new Set(
    lines.filter((l) => l?.kind === 'grant-revoked' && l.data?.id).map((l) => l.data.id),
  );
  const rulings = lines.filter((l) => l?.kind === 'ruling' && l.data?.verdict === 'allow');
  for (const l of lines) {
    if (l?.kind !== 'grant') continue;
    const g = { ...l.data };
    const why = agentIssued(l);
    if (why) {
      flagged.push({ ...g, why });
      continue;
    }
    const used = rulings.filter((r) => r.data.grant === g.id);
    const usd = used.reduce((a, r) => a + (Number(r.data.usd) || 0), 0);
    const end = revoked.has(g.id)
      ? 'revoked'
      : g.until && new Date(g.until) <= now
        ? `expired at ${g.until}`
        : g.uses != null && used.length >= g.uses
          ? `used ${used.length} of ${g.uses}`
          : g.kind === 'spend' && g.usd != null && usd >= g.usd
            ? `spent $${usd.toFixed(4)} of $${g.usd}`
            : null;
    if (end) ended.push({ ...g, why: end });
    else live.push({ ...g, used: used.length, usd_spent: usd });
  }
  return { live, ended, flagged };
}

// The authority a billed act asks before it runs: the grants in force are folded from the ledger at that
// moment, the act is ruled (authority.mjs), and the ruling is written whatever it says, so every billed
// act has a ruling line before its first effect and a grant's uses and dollars are counted from them.
// `lines` and `write` are injected (conduct passes its ledger), so this is testable without a plan. The
// dollars a grant spends are counted from the ruling's usd, the pre-call input-token estimate jev.mjs
// computes, not the call's reported cost. It is NOT an upper bound: the first live call (hlab-a t8a,
// 2026-10-05) was estimated $0.0000729 and cost $0.0000851. A dollar-bound grant can overrun by that
// margin; a use-bound grant cannot.
export function authorizer({ lines, write, floor = null, now = () => new Date() }) {
  return async ({ act, usd = 0, row = null }) => {
    const { live } = foldGrants(lines(), { now: now() });
    const r = rule({ act, floor, grants: live });
    write({ ...r, usd: r.verdict === 'allow' ? usd : 0, row });
    return r;
  };
}

// The audit over a plan's ledger (docs/17 §5.4), decidable from its lines alone:
//   authority-ruled  every billed act that ran (a live jev reading) has an allowing ruling before it
//   grant-held       every allowing ruling on a billed act names a grant that was live, and issued by the
//                    owner, at that line: the fold is re-read over the ledger up to the ruling itself
export function authorityAudit(lines) {
  const ruled = [];
  const unruled = [];
  const unheld = [];
  const allows = [];
  lines.forEach((l, i) => {
    const d = l?.data || {};
    if (l?.kind === 'ruling' && d.verdict === 'allow' && d.act === 'jev.call') allows.push(i);
    if (l?.kind === 'jev' && d.source === 'live') {
      // a live reading consumes the earliest allowing ruling not yet consumed before it
      const k = allows.findIndex((a) => a < i);
      if (k < 0) unruled.push(`${d.row}${d.file ? ` ${d.file}` : ''} (line ${i + 1})`);
      else ruled.push(allows.splice(k, 1)[0]);
    }
  });
  for (const i of lines.flatMap((l, i) =>
    l?.kind === 'ruling' && l.data?.verdict === 'allow' && l.data?.act === 'jev.call' ? [i] : [],
  )) {
    const g = lines[i].data.grant;
    const before = foldGrants(lines.slice(0, i), { now: new Date(lines[i].ts || Date.now()) });
    if (!g || !before.live.some((x) => x.id === g)) {
      const flagged = before.flagged.find((x) => x.id === g);
      unheld.push(
        `line ${i + 1} ${g || 'no grant'}${flagged ? ` (${flagged.why})` : ' (not live then)'}`,
      );
    }
  }
  return {
    ruled: { ok: !unruled.length, count: ruled.length, unruled },
    held: { ok: !unheld.length, unheld },
  };
}

// Would the next step cross the plan budget? (FR-27, docs/17 §4.4) base: harness.budgets.usd_per_plan;
// spent: the plan's priced seats; need: the caps of what the step would start. Live budget grants raise
// the limit. After a pause with no grant issued since, the paused step's need stands, so a re-run pauses
// again before buying a decision.
export function budgetCheck(lines, { base, spent, need, now = new Date() }) {
  const raised = foldGrants(lines, { now })
    .live.filter((g) => g.kind === 'budget')
    .reduce((a, g) => a + (g.usd || 0), 0);
  const limit = base + raised;
  const last = lines.findLastIndex(
    (l) => l?.kind === 'ruling' && l.data?.act === 'budget.cross' && l.data?.verdict === 'escalate',
  );
  const grantedSince = lines.some((l, i) => i > last && l?.kind === 'grant' && !agentIssued(l));
  const standing = last >= 0 && !grantedSince ? lines[last].data.need || 0 : 0;
  const want = Math.max(need, standing);
  return { pause: spent + want > limit, spent, limit, need: want };
}

// ---------------------------------------------------------------- the command
function main(argv) {
  const cmd = argv[0];
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const refuse = (why) => {
    console.error(`grant: refused — ${why}`);
    return 2;
  };
  const plan = opt('plan');
  if (!['grant', 'revoke'].includes(cmd) || !plan)
    return refuse('usage: grants.mjs grant|revoke --plan <slug> ...');
  // provenance first: an agent session never reaches the ledger
  const prov = provenance();
  if (prov.agent_env.length)
    return refuse(
      `this is an agent session (${prov.agent_env.join(', ')}); a grant is the owner's act, typed in their own terminal`,
    );
  if (!prov.tty) return refuse('no terminal on stdin; a grant is typed by the owner, not piped');
  if (prov.claude_ancestor)
    return refuse(
      `a claude process is among this command's ancestors (${prov.ancestry.join(' < ')})`,
    );
  if (prov.ppid === 1) return refuse('an orphaned process (ppid 1) cannot issue a grant');
  const branch = git(['branch', '--show-current']);
  if (branch !== `plan/${plan}`) return refuse(`on ${branch || 'no branch'}, not plan/${plan}`);
  // the plan's ledger has one writer at a time: the grant takes conduct's lock for its append, so a
  // conduct starting meanwhile is refused rather than racing it
  const lockFile = join(ROOT, '.harness', `conduct-${plan}.lock`);
  mkdirSync(join(ROOT, '.harness'), { recursive: true });
  const held = acquireLock(lockFile);
  if (!held.ok) return refuse(`plan ${plan} is being conducted by pid ${held.holder?.pid}`);
  try {
    return write(plan, cmd, opt, prov, refuse);
  } finally {
    releaseLock(lockFile);
  }
}

function write(plan, cmd, opt, prov, refuse) {
  const file = join(ROOT, 'ledger', `${plan}.jsonl`);
  const lines = existsSync(file) ? parseLedger(readFileSync(file, 'utf8')) : [];
  let kind;
  let data;
  if (cmd === 'grant') {
    const k = opt('kind');
    if (!GRANT_KINDS.includes(k)) return refuse(`--kind must be one of ${GRANT_KINDS.join(', ')}`);
    const num = (x) => (x == null ? null : Number(x));
    const usd = num(opt('usd'));
    const uses = num(opt('uses'));
    if (k === 'budget' && !(usd > 0)) return refuse('a budget grant needs --usd > 0');
    if ([usd, uses].some((x) => x != null && !(x > 0)))
      return refuse('--usd and --uses must be > 0');
    const until = opt('until') || null;
    if (until && Number.isNaN(Date.parse(until))) return refuse('--until must be an ISO time');
    kind = 'grant';
    data = {
      id: `GR-${lines.filter((l) => l.kind === 'grant').length + 1}`,
      kind: k,
      usd,
      uses,
      until,
      acts: (opt('acts') || '').split(',').filter(Boolean),
      provenance: prov,
    };
  } else {
    const id = opt('id');
    if (!lines.some((l) => l.kind === 'grant' && l.data?.id === id))
      return refuse(`no grant ${id} on plan ${plan}`);
    kind = 'grant-revoked';
    data = { id, provenance: prov };
  }
  const here = fileURLToPath(new URL('.', import.meta.url));
  const r = spawnSync(
    'node',
    [
      join(here, 'ledger.mjs'),
      'append',
      '--plan',
      plan,
      '--kind',
      kind,
      '--actor',
      'owner',
      '--data',
      JSON.stringify(data),
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (r.status !== 0) return refuse(`the ledger refused the line: ${r.stderr.trim()}`);
  const c = commitOnly(['ledger'], `chore(ledger): ${plan} ${kind} ${data.id}`);
  if (c.status !== 0) return refuse(`written but not committed: ${(c.stderr || '').trim()}`);
  console.log(
    `${kind} ${data.id} on ${plan}: ${JSON.stringify({ ...data, provenance: undefined })}`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exit(main(process.argv.slice(2)));
