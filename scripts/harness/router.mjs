#!/usr/bin/env node
// Route pre-pass: proposes a track and rungs from the intent text, harness.json and the canon. Never decides.
// Usage: node router.mjs --intent intent/<slug>/INTENT.md --plan <slug> [--rigor prototype|mvp|production]
// Output: JSON proposal to stdout; appends a `route` ledger line with actor "script:router" (the Master ratifies with its own line).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, readJson, parseFrontmatter } from './common.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const intentPath = opt('intent');
const plan = opt('plan');
if (!intentPath || !plan) {
  console.error('router: --intent and --plan required');
  process.exit(1);
}
const harness = readJson(join(ROOT, 'harness.json'), {});
const intent = readFileSync(join(ROOT, intentPath), 'utf8');
const { data: fm, body } = parseFrontmatter(intent);
const text = (body || intent).toLowerCase();

const matched = {};
for (const [track, signals] of Object.entries(harness.tracks || {})) {
  matched[track] = signals.filter((s) => text.includes(s.toLowerCase()));
}
const status = harness.app?.status || 'prototyping';
let track = 'vertical';
if (matched.enterprise?.length) track = 'enterprise';
else if (matched.method?.length) track = 'method';
// A brownfield app at alpha or above never routes vertical: there is a canon to respect.
const hasCanon =
  existsSync(join(ROOT, 'canon', 'capabilities')) &&
  readJson(join(ROOT, 'canon', 'quality.json'), { assurance: {} }).assurance &&
  Object.keys(readJson(join(ROOT, 'canon', 'quality.json'), { assurance: {} }).assurance).length >
    0;
if (track === 'vertical' && ['alpha', 'beta', 'production'].includes(status)) track = 'method';

// Floor: rigor may not be below the assurance of any shard the intent names.
const requested = opt('rigor', fm.rigor || (status === 'prototyping' ? 'prototype' : 'mvp'));
const order = ['prototype', 'mvp', 'production'];
const quality = readJson(join(ROOT, 'canon', 'quality.json'), {
  assurance: {},
});
const touched = Object.keys(quality.assurance || {}).filter((cap) =>
  text.includes(cap.toLowerCase()),
);
let floor = 'prototype';
for (const cap of touched)
  if (order.indexOf(quality.assurance[cap]) > order.indexOf(floor)) floor = quality.assurance[cap];
const rigor = order.indexOf(requested) >= order.indexOf(floor) ? requested : floor;

const RUNGS = {
  vertical: ['tech-spec', 'ux-if-screen', 'build', 'test'],
  method: ['brief', 'prd', 'ux', 'architecture', 'epics', 'stories', 'build', 'test', 'qa'],
  enterprise: [
    'brief',
    'prd',
    'ux',
    'architecture',
    'security',
    'privacy',
    'platform',
    'tea-test-design',
    'epics',
    'stories',
    'build',
    'test',
    'qa',
  ],
};
const kind = fm.kind || 'feature';
const proposal = {
  plan,
  kind,
  appStatus: status,
  track,
  matchedSignals: matched,
  requestedRigor: requested,
  floor,
  rigor,
  touchedShards: touched,
  rungs:
    kind === 'spike'
      ? ['explore', 'distil']
      : kind === 'bug'
        ? ['failing-test', 'build', 'test']
        : RUNGS[track],
  seal: kind === 'spike' ? 'none' : 'required',
  hasCanon,
};
process.stdout.write(JSON.stringify(proposal, null, 2) + '\n');
try {
  execFileSync(
    'node',
    [
      join(ROOT, 'scripts', 'harness', 'ledger.mjs'),
      'append',
      '--plan',
      plan,
      '--kind',
      'route',
      '--actor',
      'script:router',
      '--data',
      JSON.stringify(proposal),
    ],
    { cwd: ROOT, stdio: 'ignore' },
  );
} catch {
  /* ledger is optional at plant time */
}
