#!/usr/bin/env node
// The only writer of ledger/<plan>.jsonl. Append-only. Every line: ts, commit, actor, kind, plan, data.
// Usage: node ledger.mjs append --plan <slug> --kind <kind> --actor <user|yolo|agent:x> [--data '<json>'] [--session id]
//        node ledger.mjs read --plan <slug> [--kind k]
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, headSha } from './common.mjs';

const KINDS = new Set([
  'route',
  'activation',
  'gap',
  'record',
  'decision',
  'seat-start',
  'seat-end',
  'finding',
  'delta',
  'assurance',
  'department',
  'round',
  'question',
  'answer',
  'merge',
  'deploy',
  'estop',
  // step 12: what a plan is held to when it is delivered
  'seal',
  // step 13: the decisions an artifact was written against, stamped when its wave is recorded
  'stamp',
]);
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const plan = opt('plan');
if (!plan) {
  console.error('ledger: --plan required');
  process.exit(1);
}
const file = join(ROOT, 'ledger', plan + '.jsonl');

if (cmd === 'append') {
  const kind = opt('kind');
  if (!KINDS.has(kind)) {
    console.error(`ledger: unknown kind ${kind}; allowed: ${[...KINDS].join(', ')}`);
    process.exit(1);
  }
  const actor = opt('actor');
  if (!actor) {
    console.error('ledger: --actor required (user | yolo | agent:<id>)');
    process.exit(1);
  }
  let data = {};
  try {
    data = JSON.parse(opt('data', '{}'));
  } catch {
    console.error('ledger: --data must be JSON');
    process.exit(1);
  }
  const line = {
    ts: new Date().toISOString(),
    commit: headSha().slice(0, 12),
    plan,
    kind,
    actor,
    session: opt('session', null),
    data,
  };
  mkdirSync(join(ROOT, 'ledger'), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + '\n');
  process.stdout.write(JSON.stringify(line) + '\n');
} else if (cmd === 'read') {
  if (!existsSync(file)) process.exit(0);
  const kind = opt('kind');
  for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    if (!kind || JSON.parse(l).kind === kind) process.stdout.write(l + '\n');
  }
} else {
  console.error('ledger: append | read');
  process.exit(1);
}
