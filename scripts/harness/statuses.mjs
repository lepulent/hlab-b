#!/usr/bin/env node
// Commit statuses on GitHub through `gh api`, the only status channel of the pipeline (H-21, H-30).
// The CI seat posts them; the merge script reads them and refuses to merge unless every required one
// is green. Works on free private repos, where rulesets and branch protection are not available.
// Usage: node statuses.mjs post --context seal|ratchet|canon-check --state success|failure|pending|error [--description ".."] [--sha HEAD] [--url ..]
//        node statuses.mjs read [--sha HEAD] [--required seal,ratchet,canon-check]   → JSON {sha, ok, statuses:{ctx:{state,description}}, missing:[]}
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, git, readJson } from './common.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const cmd = process.argv[2];
const sha = git(['rev-parse', arg('sha', 'HEAD')]);
const remote = git(['remote', 'get-url', 'origin']);
const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(remote);
if (!m) {
  console.error('statuses: origin is not a github remote');
  process.exit(2);
}
const repo = `${m[1]}/${m[2]}`;
const harness = readJson(join(ROOT, 'harness.json'), {});
const REQUIRED = (
  arg('required') ||
  harness.pipeline?.required_statuses?.join(',') ||
  'seal,ratchet,canon-check'
).split(',');

const gh = (args, input) =>
  execFileSync('gh', args, { encoding: 'utf8', input, cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

if (cmd === 'post') {
  const context = arg('context');
  const state = arg('state');
  if (!context || !state) {
    console.error('statuses post: --context and --state are required');
    process.exit(2);
  }
  const body = {
    state,
    context: `harness/${context}`,
    description: (arg('description', '') || '').slice(0, 140),
    ...(arg('url') ? { target_url: arg('url') } : {}),
  };
  gh(['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '--input', '-'], JSON.stringify(body));
  console.log(`status harness/${context}=${state} on ${sha.slice(0, 7)}`);
} else if (cmd === 'read') {
  const out = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/status`]));
  const statuses = {};
  for (const s of out.statuses || []) {
    const ctx = s.context.replace(/^harness\//, '');
    if (!statuses[ctx]) statuses[ctx] = { state: s.state, description: s.description };
  }
  const missing = REQUIRED.filter((r) => !statuses[r]);
  const failing = REQUIRED.filter((r) => statuses[r] && statuses[r].state !== 'success');
  const ok = !missing.length && !failing.length;
  console.log(JSON.stringify({ sha, ok, required: REQUIRED, statuses, missing, failing }, null, 2));
  process.exit(ok ? 0 : 1);
} else {
  console.error('usage: statuses.mjs post|read ...');
  process.exit(2);
}
