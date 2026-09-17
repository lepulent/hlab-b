#!/usr/bin/env node
// Stations 3–7 of the pipeline (docs/07), deterministic backbone. Scripts decide; a seat only judges
// where a row below says so. Every step writes a JSON record under .harness/ and a ledger line.
//
//   ci      [--plan s]           station 3: check, test:report --e2e, canon:check, seal, ratchet → 3 commit statuses
//   review  [--plan s]           station 4: context-free lenses (claude -p, JSON) over the PR diff → verdict by threshold
//   merge   --plan s             station 5: preconditions (seal, statuses, review, mergeable) → gh pr merge --squash
//   qa      --plan s [--stage]   station 6b: smoke + Playwright journeys against the deployed URL, screenshots as evidence
//   land    --plan s             station 7: valid_from stamps, assurance ratchet, regenerate, intent → records, commit on main
//   run     --plan s             ci → review → merge → deploy → qa → land
//
// Circuit breaker: two failures for the same reason on one plan write an estop line and refuse further runs.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson, writeJson, git, headSha, parseFrontmatter } from './common.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 && argv[i + 1] ? argv[i + 1] : def;
};
const harness = readJson(join(ROOT, 'harness.json'), {});
const APP = harness.app?.name || 'app';
const PIPE = harness.pipeline || {};
const RANK = { draft: 0, prototype: 1, mvp: 2, production: 3 };
const H = join(ROOT, '.harness');
mkdirSync(H, { recursive: true });
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const PLAN = arg('plan', branch.replace(/^(plan|spike|fix)\//, ''));
const t0 = Date.now();
const minutes = () => Math.round((Date.now() - t0) / 6000) / 10;

const sh = (file, args, opts = {}) =>
  spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const ok = (r) => r.status === 0;
const script = (name, ...args) => sh('node', [join(ROOT, 'scripts', 'harness', name), ...args]);
const ledger = (kind, data, actor = 'script:pipeline') =>
  script(
    'ledger.mjs',
    'append',
    '--plan',
    PLAN,
    '--kind',
    kind,
    '--actor',
    actor,
    '--data',
    JSON.stringify(data),
  );
const status = (context, state, description) =>
  script(
    'statuses.mjs',
    'post',
    '--context',
    context,
    '--state',
    state,
    '--description',
    description,
  );
const fail = (msg, code = 1) => {
  console.error(`pipeline ${cmd}: ${msg}`);
  process.exit(code);
};

// circuit breaker: .harness/breaker.json { [plan]: { [reason]: count } }
function trip(reason) {
  const f = join(H, 'breaker.json');
  const b = readJson(f, {});
  b[PLAN] ||= {};
  b[PLAN][reason] = (b[PLAN][reason] || 0) + 1;
  writeJson(f, b);
  if (b[PLAN][reason] >= 2) {
    ledger('estop', { reason, count: b[PLAN][reason], station: cmd });
    writeFileSync(join(H, 'estop'), `${PLAN}: ${reason} failed twice at ${cmd}\n`);
    fail(
      `breaker tripped: "${reason}" failed twice; estop written, this plan needs a new intent`,
      3,
    );
  }
}
function breakerOpen() {
  if (existsSync(join(H, 'estop')))
    fail(`estop present: ${readFileSync(join(H, 'estop'), 'utf8').trim()}`, 3);
}

// the seal: intent/<plan>/SEAL.md with frontmatter plan, rigor, base, track, touches
function readSeal() {
  const f = join(ROOT, 'intent', PLAN, 'SEAL.md');
  if (!existsSync(f)) return { ok: false, reason: 'no seal file', file: f };
  const { data } = parseFrontmatter(readFileSync(f, 'utf8'));
  if (!RANK[data.rigor])
    return { ok: false, reason: `seal rigor "${data.rigor}" is not prototype|mvp|production` };
  if (!data.base || !git(['rev-parse', '--verify', '--quiet', String(data.base)]))
    return { ok: false, reason: 'seal base is not a known commit' };
  return {
    ok: true,
    rigor: data.rigor,
    base: String(data.base),
    touches: data.touches || [],
    track: data.track || null,
    data,
  };
}

// the ratchet: a merge at rigor R may not lower the assurance of any touched node below what main holds
function ratchet(seal) {
  const q = readJson(join(ROOT, 'canon', 'quality.json'), { assurance: {} });
  const lowered = (seal.touches || []).filter(
    (n) => (RANK[q.assurance?.[n]] || 0) > RANK[seal.rigor],
  );
  return {
    ok: !lowered.length,
    lowered,
    floor: Math.max(0, ...(seal.touches || []).map((n) => RANK[q.assurance?.[n]] || 0)),
  };
}

// ---------------------------------------------------------------- station 3
function ci() {
  breakerOpen();
  const isSpike = branch.startsWith('spike/');
  const record = {
    plan: PLAN,
    branch,
    sha: headSha(),
    startedAt: new Date().toISOString(),
    steps: {},
  };
  const runStep = (name, file, args) => {
    let r = sh(file, args);
    let reran = false;
    if (!ok(r)) {
      // triage: one re-run at most; a pass on the second run is a flaky finding, a second failure is real
      reran = true;
      r = sh(file, args);
      ledger('finding', {
        station: 'ci',
        step: name,
        kind: ok(r) ? 'flaky' : 'real',
        tail: (r.stdout + r.stderr).split('\n').filter(Boolean).slice(-8),
      });
    }
    record.steps[name] = {
      ok: ok(r),
      reran,
      tail: (r.stdout + r.stderr).split('\n').filter(Boolean).slice(-5),
    };
    console.log(`ci: ${name} ${ok(r) ? 'ok' : 'FAILED'}${reran ? ' (re-run)' : ''}`);
    return ok(r);
  };
  const checkOk = runStep('check', 'npm', ['run', 'check', '--silent']);
  const testOk = runStep('test:report', 'node', [
    join(ROOT, 'scripts', 'harness', 'test-run.mjs'),
    '--e2e',
  ]);
  const canonOk = runStep('canon:check', 'node', [
    join(ROOT, 'scripts', 'harness', 'canon-check.mjs'),
  ]);
  const seal = isSpike ? { ok: false, reason: 'spike branch, never merges' } : readSeal();
  const rat = seal.ok ? ratchet(seal) : { ok: false, lowered: [] };
  record.seal = seal;
  record.ratchet = rat;
  status(
    'canon-check',
    checkOk && testOk && canonOk ? 'success' : 'failure',
    checkOk && testOk && canonOk
      ? 'check, tests at HEAD and canon check green'
      : 'see .harness/ci.json',
  );
  status(
    'seal',
    seal.ok ? 'success' : 'failure',
    seal.ok ? `sealed at ${seal.rigor}, base ${seal.base.slice(0, 7)}` : seal.reason,
  );
  status(
    'ratchet',
    rat.ok ? 'success' : 'failure',
    rat.ok
      ? `no touched node lowered (floor ${rat.floor})`
      : `would lower: ${rat.lowered.join(', ')}`,
  );
  record.ok = checkOk && testOk && canonOk && seal.ok && rat.ok;
  record.minutes = minutes();
  writeJson(join(H, 'ci.json'), record);
  ledger('seat-end', { station: 'ci', ok: record.ok, minutes: record.minutes, sha: record.sha });
  if (!record.ok)
    trip(
      `ci:${Object.entries(record.steps).find(([, s]) => !s.ok)?.[0] || (!seal.ok ? 'seal' : 'ratchet')}`,
    );
  console.log(`ci: ${record.ok ? 'GREEN' : 'RED'} in ${record.minutes} min`);
  process.exit(record.ok ? 0 : 1);
}

// ---------------------------------------------------------------- station 4
function review() {
  breakerOpen();
  const base = git(['merge-base', 'main', 'HEAD']) || 'main';
  const diff = git([
    'diff',
    `${base}..HEAD`,
    '--',
    '.',
    ':!canon/generated',
    ':!canon/index',
    ':!package-lock.json',
  ]);
  const sha = headSha();
  if (!diff.trim()) {
    writeJson(join(H, 'review.json'), {
      plan: PLAN,
      sha,
      findings: [],
      verdict: 'pass',
      note: 'empty diff',
    });
    console.log('review: empty diff, pass');
    return;
  }
  const lensDir = join(ROOT, '.claude', 'lenses');
  const lenses =
    PIPE.review?.lenses ||
    (existsSync(lensDir)
      ? readdirSync(lensDir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.replace(/\.md$/, ''))
      : []);
  const blockAt = RANKSEV[PIPE.review?.block_at || 'high'];
  const schema = JSON.stringify({
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            file: { type: 'string' },
            summary: { type: 'string' },
            why: { type: 'string' },
          },
          required: ['severity', 'file', 'summary'],
        },
      },
    },
    required: ['findings'],
  });
  const findings = [];
  const seats = [];
  for (const lens of lenses) {
    const prompt = `${readFileSync(join(lensDir, `${lens}.md`), 'utf8')}\n\n--- DIFF (${branch} vs ${base.slice(0, 7)}) ---\n${diff.slice(0, 120000)}`;
    const t = Date.now();
    const r = sh('claude', [
      '-p',
      '--bare',
      '--output-format',
      'json',
      '--json-schema',
      schema,
      '--allowedTools',
      '',
      '--max-budget-usd',
      String(PIPE.review?.budget_usd || 0.5),
      ...(PIPE.review?.model ? ['--model', PIPE.review.model] : []),
      prompt,
    ]);
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      /* unparsable */
    }
    const parsed =
      out?.structured_output ||
      (typeof out?.result === 'string' ? safeJson(out.result) : out?.result) ||
      null;
    const mine = (parsed?.findings || []).map((f) => ({ ...f, lens }));
    findings.push(...mine);
    if (out?.is_error)
      console.error(`review: lens ${lens} seat error: ${String(out.result).slice(0, 200)}`);
    const seat = {
      lens,
      ok: ok(r) && !!parsed && !out?.is_error,
      findings: mine.length,
      minutes: Math.round((Date.now() - t) / 6000) / 10,
      cost_usd: out?.total_cost_usd ?? null,
      tokens: out?.usage ?? null,
    };
    seats.push(seat);
    stat({
      session: `review:${lens}:${sha.slice(0, 7)}`,
      tool: 'claude -p',
      station: 'review',
      ...seat,
    });
    console.log(
      `review: lens ${lens} → ${mine.length} finding(s)${seat.ok ? '' : ' (seat failed)'} ${seat.minutes} min $${seat.cost_usd ?? '?'}`,
    );
  }
  const blocking = findings.filter((f) => RANKSEV[f.severity] >= blockAt);
  const verdict = seats.some((s) => !s.ok) ? 'unmeasured' : blocking.length ? 'block' : 'pass';
  writeJson(join(H, 'review.json'), {
    plan: PLAN,
    sha,
    lenses,
    block_at: PIPE.review?.block_at || 'high',
    findings,
    blocking: blocking.length,
    verdict,
    seats,
  });
  for (const f of findings) ledger('finding', { station: 'review', ...f });
  ledger('seat-end', { station: 'review', verdict, findings: findings.length, seats });
  console.log(`review: ${verdict} (${findings.length} findings, ${blocking.length} blocking)`);
  if (verdict !== 'pass') trip(`review:${verdict}`);
  process.exit(verdict === 'pass' ? 0 : 1);
}
const RANKSEV = { low: 1, medium: 2, high: 3, critical: 4 };
function safeJson(s) {
  try {
    return JSON.parse(s.replace(/^```json\s*|```$/g, ''));
  } catch {
    return null;
  }
}
function stat(row) {
  try {
    writeFileSync(
      join(H, 'stats.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n',
      { flag: 'a' },
    );
  } catch {
    /* advisory */
  }
}

// ---------------------------------------------------------------- station 5
function merge() {
  breakerOpen();
  const sha = headSha();
  const pr = safeJson(
    sh('gh', ['pr', 'view', '--json', 'number,mergeable,headRefOid,baseRefName,state,url'])
      .stdout || '',
  );
  const reasons = [];
  if (!pr || pr.state !== 'OPEN') reasons.push('no open PR for this branch');
  else {
    if (pr.headRefOid !== sha)
      reasons.push(`PR head ${pr.headRefOid.slice(0, 7)} is not HEAD ${sha.slice(0, 7)}`);
    if (pr.baseRefName !== 'main') reasons.push(`PR base is ${pr.baseRefName}, not main`);
    if (pr.mergeable === 'CONFLICTING') reasons.push('conflicts with main');
  }
  const seal = readSeal();
  if (!seal.ok) reasons.push(`seal: ${seal.reason}`);
  else {
    const rat = ratchet(seal);
    if (!rat.ok) reasons.push(`ratchet would lower ${rat.lowered.join(', ')}`);
  }
  const st = safeJson(script('statuses.mjs', 'read', '--sha', sha).stdout || '');
  if (!st?.ok)
    reasons.push(
      `statuses: missing ${st?.missing?.join(',') || '?'} failing ${st?.failing?.join(',') || '?'}`,
    );
  const rv = readJson(join(H, 'review.json'));
  if (!rv || rv.sha !== sha) reasons.push('no review for HEAD');
  else if (rv.verdict !== 'pass') reasons.push(`review verdict ${rv.verdict}`);
  const decision = {
    plan: PLAN,
    sha,
    pr: pr?.number ?? null,
    ok: !reasons.length,
    reasons,
    at: new Date().toISOString(),
  };
  writeJson(join(H, 'merge.json'), decision);
  if (reasons.length) {
    ledger('decision', { station: 'merge', decision: 'refuse', reasons }, 'script:merge');
    trip(`merge:${reasons[0].split(':')[0]}`);
    fail(`refused: ${reasons.join('; ')}`);
  }
  const r = sh('gh', ['pr', 'merge', String(pr.number), '--squash', '--delete-branch']);
  if (!ok(r)) {
    ledger(
      'decision',
      { station: 'merge', decision: 'merge-failed', tail: (r.stderr || r.stdout).slice(-400) },
      'script:merge',
    );
    trip('merge:gh');
    fail(`gh pr merge failed: ${(r.stderr || r.stdout).slice(-400)}`);
  }
  sh('git', ['checkout', '-q', 'main']);
  sh('git', ['pull', '-q', '--ff-only', 'origin', 'main']);
  const mergeSha = headSha();
  const tag = `plan/${PLAN}@${mergeSha.slice(0, 7)}`;
  sh('git', ['tag', '-f', tag]);
  sh('git', ['push', '-q', '-f', 'origin', tag]);
  writeJson(join(H, 'merge.json'), { ...decision, mergeSha, tag });
  ledger(
    'merge',
    { pr: pr.number, sha, mergeSha, tag, rigor: seal.rigor, track: seal.track },
    'script:merge',
  );
  console.log(`merge: PR #${pr.number} squashed as ${mergeSha.slice(0, 7)}, tag ${tag}`);
}

// ---------------------------------------------------------------- station 6b
function qa() {
  breakerOpen();
  const stage = arg('stage', 'dev');
  const last = readJson(join(H, 'deploy', stage, 'last.json'));
  if (!last?.url || last.status !== 'SUCCEEDED')
    fail(`no successful ${stage} deploy record (run harness:deploy first)`, 2);
  const url = last.url;
  const record = {
    plan: PLAN,
    stage,
    url,
    commit: last.commit,
    smoke: null,
    journeys: null,
    screenshots: [],
  };
  const curl = sh('curl', [
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    '20',
    url + '/',
  ]);
  record.smoke = { code: curl.stdout.trim(), ok: curl.stdout.trim() === '200' };
  console.log(`qa: smoke ${url} → ${record.smoke.code}`);
  const jsonOut = join(H, 'qa-playwright.json');
  rmSync(jsonOut, { force: true });
  const pw = sh('npx', ['playwright', 'test', '--reporter=json'], {
    env: {
      ...process.env,
      CI: '1',
      PLAYWRIGHT_BASE_URL: url,
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut,
      PLAYWRIGHT_SCREENSHOT: 'on',
    },
  });
  const j = readJson(jsonOut, null);
  const stats = j?.stats || {};
  record.journeys = {
    ran: !!j,
    ok: ok(pw),
    expected: stats.expected ?? null,
    unexpected: stats.unexpected ?? null,
    flaky: stats.flaky ?? null,
  };
  console.log(
    `qa: journeys ${record.journeys.ok ? 'ok' : 'FAILED'} (${stats.expected ?? '?'} passed, ${stats.unexpected ?? '?'} failed)`,
  );
  // evidence: every screenshot and trace under test-results → runs/<app>/<plan>/qa-<stage>/
  const evidence = join(ROOT, '..', 'runs', APP, PLAN, `qa-${stage}`);
  const tr = join(ROOT, 'test-results');
  if (existsSync(tr)) {
    mkdirSync(evidence, { recursive: true });
    for (const f of walkFiles(tr)) {
      if (!/\.(png|zip|webm)$/.test(f)) continue;
      const dest = join(evidence, f.slice(tr.length + 1).replace(/\//g, '__'));
      cpSync(f, dest);
      record.screenshots.push(dest.slice(join(ROOT, '..').length + 1));
    }
  }
  record.ok = record.smoke.ok && record.journeys.ok;
  writeJson(join(H, 'qa.json'), record);
  writeJson(join(evidence, 'qa.json'), record);
  ledger('finding', {
    station: 'qa',
    stage,
    url,
    ok: record.ok,
    smoke: record.smoke.code,
    journeys: record.journeys,
    screenshots: record.screenshots.length,
  });
  if (!record.ok) {
    // a failed journey opens a bug intent; nothing in QA writes code
    const bug = join(ROOT, 'intent', `bug-${PLAN}-${stage}`);
    mkdirSync(bug, { recursive: true });
    writeFileSync(
      join(bug, 'INTENT.md'),
      `---\nkind: bug\nfrom: ${PLAN}\nstage: ${stage}\n---\n# QA failed on ${stage}\n\nsmoke ${record.smoke.code}; journeys ${JSON.stringify(record.journeys)}; evidence under runs/${APP}/${PLAN}/qa-${stage}/\n`,
    );
    trip(`qa:${stage}`);
  }
  console.log(`qa: ${record.ok ? 'GREEN' : 'RED'}, ${record.screenshots.length} evidence file(s)`);
  process.exit(record.ok ? 0 : 1);
}
function walkFiles(d) {
  const out = [];
  for (const n of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, n.name);
    if (n.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- station 7
function land() {
  if (branch !== 'main') fail('land runs on main after the merge', 2);
  const m = readJson(join(H, 'merge.json'));
  const mergeSha = m?.mergeSha || headSha();
  const seal = readSeal();
  if (!seal.ok) fail(`seal: ${seal.reason}`, 2);
  // 1. observed, not asserted
  const r1 = sh('git', ['merge-base', '--is-ancestor', seal.base, 'HEAD']);
  if (!ok(r1)) fail(`seal base ${seal.base.slice(0, 7)} is not an ancestor of main`);
  // 2. deltas = canon files changed between the seal base and the merge
  const changed = git(['diff', '--name-only', `${seal.base}..${mergeSha}`, '--', 'canon/'])
    .split('\n')
    .filter((f) => f.endsWith('.md') && !/^canon\/(generated|index)\//.test(f));
  const deltas = [];
  const q = readJson(join(ROOT, 'canon', 'quality.json'), {
    assurance: {},
    bindings: {},
    debt: [],
  });
  q.assurance ||= {};
  for (const f of changed) {
    const p = join(ROOT, f);
    if (!existsSync(p)) {
      deltas.push({ file: f, op: 'REMOVED' });
      continue;
    }
    const text = readFileSync(p, 'utf8');
    const { data } = parseFrontmatter(text);
    if (!data.id || ['map', 'constitution'].includes(data.kind)) continue;
    const existedAtBase =
      git(['cat-file', '-e', `${seal.base}:${f}`]) !== '' ||
      ok(sh('git', ['cat-file', '-e', `${seal.base}:${f}`]));
    // 3. valid_from = the merge SHA on every changed node
    const stamped = text.replace(/^valid_from:.*$/m, `valid_from: ${mergeSha}`);
    writeFileSync(
      p,
      stamped === text && !/^valid_from:/m.test(text)
        ? text.replace(/^---\n/, `---\nvalid_from: ${mergeSha}\n`)
        : stamped,
    );
    // 4. assurance ratchets up to the plan's rigor, never down
    const before = q.assurance[data.id] || 'draft';
    if (RANK[seal.rigor] > (RANK[before] || 0)) q.assurance[data.id] = seal.rigor;
    deltas.push({
      file: f,
      node: data.id,
      op: existedAtBase ? 'MODIFIED' : 'ADDED',
      assurance: { before, after: q.assurance[data.id] || before },
    });
  }
  for (const n of seal.touches || []) {
    const before = q.assurance[n] || 'draft';
    if (RANK[seal.rigor] > (RANK[before] || 0)) q.assurance[n] = seal.rigor;
  }
  writeJson(join(ROOT, 'canon', 'quality.json'), q);
  // 6. regenerate, re-check
  sh('npm', ['run', '--silent', 'graph:system']);
  script('infra-manifest.mjs');
  script('canon-graph.mjs', '--map');
  const chk = script('canon-check.mjs');
  if (!ok(chk)) {
    ledger('decision', {
      station: 'land',
      decision: 'blocked',
      reason: 'canon check failed after landing',
      tail: chk.stdout.split('\n').slice(-6),
    });
    sh('git', ['checkout', '--', 'canon']);
    fail(
      `canon check failed after landing; landing reverted, code stays merged:\n${chk.stdout.split('\n').slice(-6).join('\n')}`,
    );
  }
  // 7. intent → records
  const from = join(ROOT, 'intent', PLAN);
  const to = join(ROOT, 'records', PLAN);
  if (existsSync(from)) {
    mkdirSync(dirname(to), { recursive: true });
    sh('git', ['mv', '-k', from, to]);
    if (existsSync(from)) {
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true, force: true });
    }
  }
  // 8. departments that appeared: signals from departments.json against the new graph (names only for now)
  const deps = readJson(join(ROOT, 'canon', 'departments.json'), { departments: [] });
  for (const d of deltas) ledger('delta', d);
  for (const [node, a] of Object.entries(q.assurance)) ledger('assurance', { node, assurance: a });
  ledger('round', {
    station: 'land',
    plan: PLAN,
    mergeSha,
    deltas: deltas.length,
    departments: deps.departments?.map((x) => x.name) || [],
  });
  sh('git', ['add', '-A']);
  const c = sh('git', [
    'commit',
    '-q',
    '-m',
    `chore(canon): land ${PLAN} from ${mergeSha.slice(0, 7)}\n\n${deltas.map((d) => `- ${d.op} ${d.node || d.file}`).join('\n') || '- no canon deltas'}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`,
  ]);
  const p = sh('git', ['push', '-q', 'origin', 'main'], {
    env: { ...process.env, ALLOW_MAIN_PUSH: '1' },
  });
  writeJson(join(H, 'land.json'), {
    plan: PLAN,
    mergeSha,
    landSha: headSha(),
    deltas,
    committed: ok(c),
    pushed: ok(p),
  });
  console.log(
    `land: ${deltas.length} delta(s), intent → records, ${ok(c) ? 'committed' : 'nothing to commit'}${ok(p) ? ', pushed' : ', push failed'}`,
  );
  if (!ok(p)) process.exit(1);
}

// ---------------------------------------------------------------- run
function run() {
  const stage = arg('stage', 'dev');
  const step = (name, args) => {
    console.log(`\n== ${name}`);
    const r = spawnSync('node', [join(ROOT, 'scripts', 'harness', 'pipeline.mjs'), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (r.status !== 0) fail(`${name} failed (${r.status})`, r.status || 1);
  };
  step('ci', ['ci', '--plan', PLAN]);
  step('review', ['review', '--plan', PLAN]);
  step('merge', ['merge', '--plan', PLAN]);
  console.log('\n== deploy');
  const d = spawnSync(
    'node',
    [join(ROOT, 'scripts', 'harness', 'deploy.mjs'), '--stage', stage, '--plan', PLAN],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (d.status !== 0) {
    trip(`deploy:${stage}`);
    fail('deploy failed');
  }
  step('qa', ['qa', '--plan', PLAN, '--stage', stage]);
  step('land', ['land', '--plan', PLAN]);
  console.log(`\npipeline: ${PLAN} shipped, verified and landed in ${minutes()} min`);
}

const stations = { ci, review, merge, qa, land, run };
if (stations[cmd]) stations[cmd]();
else fail('usage: pipeline.mjs ci|review|merge|qa|land|run [--plan s] [--stage s]', 2);
