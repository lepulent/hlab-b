#!/usr/bin/env node
// Step 15's proof path (docs/17 §5.6): one JEV call, ruled like conduct's, on a plan's own ledger. A live
// call is the lab's one billed act and, until now, the only way to make one was a seat question in a
// conducted plan, which no T-run has reliably produced; the replays pass no authority. This asks
// `question.answer` once on the plan's intent and a fixed question, through the same authorizer, and
// writes the `ruling` and `jev` lines, so authority-ruled and grant-held can be read off the ledger.
// It proves the authority, not the row: the question is fixed and the reading is not graded.
//
// Usage (on plan/<slug>, no conduct running): npm run harness:jev-probe -- --plan <slug> [--mock <spec>]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { ROOT, readJson, git, commitOnly } from './common.mjs';
import { parseLedger } from './resume.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { getRow } from './jev-registry.mjs';
import { askRow, jevLine } from './jev.mjs';
import { authorizer, authorityAudit, readStanding } from './grants.mjs';

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const PLAN = opt('plan');
const die = (msg) => {
  console.error(`jev-probe: ${msg}`);
  process.exit(2);
};
if (!PLAN) die('--plan required');
if (git(['branch', '--show-current']) !== `plan/${PLAN}`) die(`not on plan/${PLAN}`);
const harness = readJson(join(ROOT, 'harness.json'), {});
const file = join(ROOT, 'ledger', `${PLAN}.jsonl`);
const lines = () => (existsSync(file) ? parseLedger(readFileSync(file, 'utf8')) : []);
const here = fileURLToPath(new URL('.', import.meta.url));
const ledger = (kind, data) => {
  const r = spawnSync(
    'node',
    [
      join(here, 'ledger.mjs'),
      'append',
      '--plan',
      PLAN,
      '--kind',
      kind,
      '--actor',
      'script:jev-probe',
      '--data',
      JSON.stringify(data),
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (r.status !== 0) die(`the ledger refused a ${kind} line: ${r.stderr.trim()}`);
};

const lock = join(ROOT, '.harness', `conduct-${PLAN}.lock`);
const held = acquireLock(lock);
if (!held.ok) die(`plan ${PLAN} is being conducted by pid ${held.holder?.pid}`);
let exit = 0;
try {
  const intent = existsSync(join(ROOT, 'intent', PLAN, 'INTENT.md'))
    ? readFileSync(join(ROOT, 'intent', PLAN, 'INTENT.md'), 'utf8')
    : '';
  const r = await askRow(
    getRow('question.answer'),
    {
      plan: PLAN,
      intent,
      question:
        'Should the first version keep this feature behind a setting, or show it to everyone?',
      why: 'step 15 authority probe: a fixed question, so the call is ruled; the reading is not graded',
      alternatives: ['behind a setting', 'shown to everyone'],
      decided: [],
    },
    {
      model: harness.jev?.model || 'jev-1.13.0',
      mock: opt('mock'),
      authorize: authorizer({
        lines,
        plan: PLAN,
        standing: () => readStanding(),
        write: (d) => ledger('ruling', d),
        floor: harness.yolo?.floor ?? null,
      }),
    },
  );
  ledger('jev', { ...jevLine(r, { agreesWith: 'probe:none' }), probe: true });
  const a = authorityAudit(lines(), { standing: readStanding(), plan: PLAN });
  console.log(
    `jev-probe ${PLAN}: ${r.unmeasured ? `not measured — ${r.reason}` : `read via ${r.source}, $${r.usd}`} · authority-ruled ${a.ruled.ok ? 'green' : 'RED'} · grant-held ${a.held.ok ? 'green' : 'RED'}`,
  );
  if (!a.ruled.ok || !a.held.ok) exit = 1;
} finally {
  const c = commitOnly(['ledger'], `chore(ledger): ${PLAN} jev probe`);
  if (c.status !== 0) console.error(`jev-probe: ledger not committed: ${(c.stderr || '').trim()}`);
  releaseLock(lock);
}
process.exit(exit);
