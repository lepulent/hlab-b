#!/usr/bin/env node
// The decider (docs/08): a script run over every question before the Master answers. Mycelium's rule,
// ported to files: a question is a human-MUST when any floor trigger fires (irreversible, constitutional,
// crossDeptConflict, authorityGap, reserved, external) or stakes reach the threshold. Yolo raises the
// stakes threshold (full → 1.0) and never lowers the floor. Under H-20 a fired trigger listed in
// yolo.stop_on ends the round: the verdict is written on the question file and needs-input.md is produced by round.mjs.
//
// Question file: intent/<plan>/questions/Q-<n>.md with frontmatter
//   kind: decision|requirement|risk|ops|secret|scope|other   stakes: 0..1   triggers: [external, ...]
//   status: open|answered|parked   asked_by: seat|master   phase: ...   alternatives: [a, b]
// Usage: node decider.mjs --plan <slug> [--json]      → writes `verdict:` and `decided_by:` on each open question
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson, parseFrontmatter } from './common.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PLAN = arg('plan');
if (!PLAN) {
  console.error('decider: --plan required');
  process.exit(2);
}
const harness = readJson(join(ROOT, 'harness.json'), {});
const yolo = harness.yolo || {};
const MODE = yolo.mode || 'manual';
const FLOOR = [
  'irreversible',
  'constitutional',
  'crossDeptConflict',
  'authorityGap',
  'reserved',
  'external',
];
const threshold =
  MODE === 'full' ? 1.0 : MODE === 'critical-only' ? 0.9 : (yolo.stakes_threshold ?? 0.7);
const stopOn = new Set(yolo.stop_on || []);

export function decide(q) {
  const fired = FLOOR.filter((t) => (q.triggers || []).includes(t));
  const stakes = Number(q.stakes ?? 0);
  if (yolo.locked)
    return { verdict: 'escalate', reason: 'department hold (yolo.locked)', fired, stakes };
  if (fired.length)
    return { verdict: 'escalate', reason: `floor trigger ${fired.join(', ')}`, fired, stakes };
  if (stakes >= threshold)
    return { verdict: 'escalate', reason: `stakes ${stakes} ≥ ${threshold}`, fired, stakes };
  if (MODE === 'manual')
    return {
      verdict: 'propose',
      reason: 'yolo manual: the Master proposes, the human answers',
      fired,
      stakes,
    };
  return {
    verdict: 'allow',
    reason: `yolo ${MODE}: the Master answers and records it`,
    fired,
    stakes,
  };
}

const dir = join(ROOT, 'intent', PLAN, 'questions');
const out = { plan: PLAN, mode: MODE, threshold, questions: [], stop: null };
if (existsSync(dir)) {
  for (const f of readdirSync(dir)
    .filter((x) => /^Q-\d+\.md$/.test(x))
    .sort()) {
    const p = join(dir, f);
    const text = readFileSync(p, 'utf8');
    const { data } = parseFrontmatter(text);
    if (data.status && data.status !== 'open') {
      out.questions.push({ file: f, status: data.status, verdict: data.verdict ?? null });
      continue;
    }
    const d = decide(data);
    const stopsRound =
      d.verdict === 'escalate' &&
      (d.fired.some((t) => stopOn.has(t)) ||
        (!d.fired.length && stopOn.has('threshold')) ||
        yolo.locked);
    // write the verdict on the file (frontmatter lines added or replaced)
    let fm = text;
    for (const [k, v] of Object.entries({
      verdict: d.verdict,
      decided_by: 'script:decider',
      decided_reason: d.reason,
    })) {
      const re = new RegExp(`^${k}:.*$`, 'm');
      fm = re.test(fm.split('\n---')[0])
        ? fm.replace(re, `${k}: ${v}`)
        : fm.replace(/^---\n/, `---\n${k}: ${v}\n`);
    }
    if (fm !== text) writeFileSync(p, fm);
    out.questions.push({ file: f, status: 'open', kind: data.kind || 'other', ...d, stopsRound });
    if (stopsRound && !out.stop)
      out.stop = { file: f, reason: d.reason, alternatives: data.alternatives || [] };
  }
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exit(out.stop ? 1 : 0);
