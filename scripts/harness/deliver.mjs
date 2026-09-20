#!/usr/bin/env node
// Delivery (lab H-1: a plan reaches main through the pipeline, and canon lands at the merge). The
// conducted plan ends when the Master closes it; what follows is not a judgement any seat makes, so it
// is a script: the seal is derived from what the plan actually changed, the branch is pushed and its PR
// opened, and the stations run in order. Nothing here decides quality — ci, review and merge do, each
// with its own record.
//
//   deliver.mjs --plan <slug> [--stations ci,review,merge,land] [--dry-run]
//
// Deploy and qa are not in the default list: this lab deploys nothing from the laptop (CLAUDE.md rule 6).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson, writeJson, git, headSha, parseFrontmatter } from './common.mjs';
import { altitudeOf } from './canon-delta.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const PLAN = arg(
  'plan',
  git(['rev-parse', '--abbrev-ref', 'HEAD']).replace(/^(plan|spike|fix)\//, ''),
);
const DRY = argv.includes('--dry-run');
const harness = readJson(join(ROOT, 'harness.json'), {});
const STATIONS = (
  arg('stations', '') || (harness.pipeline?.stations || ['ci', 'review', 'merge', 'land']).join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const H = join(ROOT, '.harness');
mkdirSync(H, { recursive: true });
const dir = join(ROOT, 'intent', PLAN);
const sh = (file, args, opts = {}) =>
  spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const ok = (r) => r.status === 0;
const fail = (msg, code = 1) => {
  console.error(`deliver: ${msg}`);
  process.exit(code);
};
const ledger = (kind, data, actor = 'script:deliver') =>
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

// ---------------------------------------------------------------- the seal, derived
// Mycelium's seal states what the plan is held to. Every field of it is a fact about the branch: the
// rigor it was routed at, the commit it grew from, and the canon nodes it changed — read from the tree,
// never typed by a seat, so a seal can neither overclaim nor forget what it touched.
export function deriveSeal({ plan, route, base, changed, read }) {
  const nodes = [];
  for (const f of changed) {
    if (!f.endsWith('.md') || !f.startsWith('canon/') || /^canon\/(generated|index)\//.test(f))
      continue;
    const text = read(f);
    if (text == null) continue;
    const { data } = parseFrontmatter(text);
    if (!data.id || data.kind === 'map') continue;
    const criteria = [...text.matchAll(/^### (\S+)/gm)].map((m) => m[1]);
    nodes.push({ id: data.id, kind: data.kind, file: f, criteria });
  }
  const touches = [...new Set(nodes.flatMap((n) => [n.id, ...n.criteria]))];
  const altitudes = [...new Set(changed.map(altitudeOf).filter(Boolean))];
  const body = [
    '# Seal',
    '',
    `${plan} is sealed at rigor ${route.rigor} on track ${route.track}, from ${String(base).slice(0, 7)}.`,
    '',
    nodes.length
      ? `Contract: ${nodes.map((n) => `${n.id} (${n.criteria.length} criteria)`).join(', ')}.`
      : 'Contract: this plan changes no canon node.',
    `Altitudes moved: ${altitudes.join(', ') || 'none'}.`,
    '',
    'Derived by scripts/harness/deliver.mjs from what the branch changed; no seat wrote it.',
    '',
  ].join('\n');
  const front = [
    '---',
    `plan: ${plan}`,
    `rigor: ${route.rigor}`,
    `base: ${base}`,
    `track: ${route.track}`,
    touches.length ? `touches:\n${touches.map((t) => `  - ${t}`).join('\n')}` : 'touches: []',
    '---',
    '',
  ].join('\n');
  return { text: front + body, touches, nodes, altitudes };
}

if (process.argv[1] && process.argv[1].endsWith('deliver.mjs')) main();

function main() {
  const route = readJson(join(dir, 'ROUTE.json'));
  if (!route) fail(`no intent/${PLAN}/ROUTE.json; this plan was never planted`, 2);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== route.branch) fail(`on ${branch}, the plan lives on ${route.branch}`, 2);
  const base = route.base || git(['merge-base', 'main', 'HEAD']);
  const changed = git(['diff', '--name-only', `${base}..HEAD`])
    .split('\n')
    .filter(Boolean);
  const seal = deriveSeal({
    plan: PLAN,
    route,
    base,
    changed,
    read: (f) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8') : null),
  });
  if (!seal.touches.length)
    fail(
      'the branch changed no canon node, so there is nothing to seal; a plan lands its contract',
      2,
    );
  const sealFile = join(dir, 'SEAL.md');
  const before = existsSync(sealFile) ? readFileSync(sealFile, 'utf8') : null;
  console.log(
    `deliver: sealing ${PLAN} at ${route.rigor}, ${seal.nodes.length} node(s), touches ${seal.touches.join(', ')}`,
  );
  if (DRY) {
    console.log(seal.text);
    return;
  }
  if (before !== seal.text) {
    writeFileSync(sealFile, seal.text);
    sh('git', ['add', '--', `intent/${PLAN}/SEAL.md`]);
    const c = sh('git', [
      '-c',
      'user.name=script:deliver',
      '-c',
      'user.email=seat@harness.local',
      'commit',
      '-q',
      '-m',
      `chore(seal): ${PLAN} sealed at ${route.rigor} over ${seal.nodes.map((n) => n.id).join(', ') || 'no node'}`,
    ]);
    if (!ok(c) && sh('git', ['diff', '--cached', '--quiet']).status !== 0)
      fail(`could not commit the seal: ${(c.stderr || c.stdout).slice(-300)}`);
  }
  ledger('seal', {
    plan: PLAN,
    rigor: route.rigor,
    base,
    touches: seal.touches,
    altitudes: seal.altitudes,
    nodes: seal.nodes.map((n) => n.id),
  });

  // the branch and its PR: the merge station needs both, and both are idempotent
  const push = sh('git', ['push', '-q', '-u', 'origin', branch]);
  if (!ok(push)) fail(`push failed: ${(push.stderr || push.stdout).slice(-300)}`);
  const existing = safeJson(sh('gh', ['pr', 'view', '--json', 'number,state']).stdout || '');
  if (!existing || existing.state !== 'OPEN') {
    const pr = sh('gh', [
      'pr',
      'create',
      '--title',
      `${branch}: ${route.kind} at ${route.rigor}`,
      '--body',
      seal.text,
    ]);
    if (!ok(pr)) fail(`gh pr create failed: ${(pr.stderr || pr.stdout).slice(-300)}`);
    console.log(`deliver: PR opened ${pr.stdout.trim()}`);
  }

  // the stations, in order, each its own process and its own record
  const record = {
    plan: PLAN,
    base,
    sha: headSha(),
    stations: [],
    startedAt: new Date().toISOString(),
  };
  for (const station of STATIONS) {
    const t = Date.now();
    console.log(`\n== ${station}`);
    const r = spawnSync(
      'node',
      [join(ROOT, 'scripts', 'harness', 'pipeline.mjs'), station, '--plan', PLAN],
      { cwd: ROOT, stdio: 'inherit' },
    );
    const row = {
      station,
      ok: r.status === 0,
      status: r.status,
      minutes: Math.round((Date.now() - t) / 6000) / 10,
    };
    record.stations.push(row);
    if (!row.ok) {
      record.ok = false;
      record.stoppedAt = station;
      writeJson(join(H, `deliver-${PLAN}.json`), record);
      ledger('round', {
        station: 'deliver',
        plan: PLAN,
        ok: false,
        stoppedAt: station,
        stations: record.stations,
      });
      fail(`${station} failed (${r.status}); the plan stays on its branch`, r.status || 1);
    }
  }
  record.ok = true;
  record.landSha = headSha();
  writeJson(join(H, `deliver-${PLAN}.json`), record);
  const land = readJson(join(H, 'land.json'), {});
  ledger('round', {
    station: 'deliver',
    plan: PLAN,
    ok: true,
    stations: record.stations,
    mergeSha: land.mergeSha || null,
    deltas: (land.deltas || []).length,
  });
  console.log(
    `\ndeliver: ${PLAN} merged and landed (${(land.deltas || []).length} delta(s)) in ${record.stations.reduce((s, x) => s + x.minutes, 0).toFixed(1)} min`,
  );
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
