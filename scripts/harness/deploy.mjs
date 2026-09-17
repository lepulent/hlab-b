#!/usr/bin/env node
// Starts the cloud runner for this app: a git archive of one commit goes to S3, CodeBuild runs
// `sst deploy` (or `sst remove`) with the bundle's buildspec, logs stream back, the state export
// comes back as an artifact and the infra manifest is regenerated from it. No deploy runs here (H-8).
// Usage: node scripts/harness/deploy.mjs --stage dev [--action deploy|remove] [--commit HEAD] [--plan ops] [--no-wait]
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, readJson, writeJson, git } from './common.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const harness = readJson(join(ROOT, 'harness.json'), {});
const APP = harness.app?.name || 'app';
const STAGE = arg('stage', 'dev');
const ACTION = arg('action', 'deploy');
const PLAN = arg('plan', 'ops');
const COMMIT = git(['rev-parse', arg('commit', 'HEAD')]);
const WAIT = !process.argv.includes('--no-wait');
const PROFILE = process.env.AWS_PROFILE || harness.infra?.profile || 'FuturatorClaude';
const REGION = harness.infra?.region || 'eu-central-1';
const BUILDSPEC = join(ROOT, '..', 'bundle', 'runner', 'buildspec.yml');
const OUT = join(ROOT, '.harness', 'deploy', STAGE);

if (!(harness.infra?.stages || ['dev', 'staging']).includes(STAGE)) {
  console.error(`deploy: stage ${STAGE} is not in harness.json infra.stages`);
  process.exit(2);
}
if (!existsSync(BUILDSPEC)) {
  console.error(`deploy: buildspec not found at ${BUILDSPEC}`);
  process.exit(2);
}
const aws = (args, opts = {}) =>
  execFileSync('aws', ['--profile', PROFILE, '--region', REGION, '--output', 'json', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
const awsJson = (args) => JSON.parse(aws(args) || 'null');

const account = awsJson(['sts', 'get-caller-identity']).Account;
const bucket = `mycelium-harness-runner-${account}`;
const key = `sources/${APP}/${COMMIT}.zip`;
mkdirSync(OUT, { recursive: true });

// 1. source = the exact commit, nothing from the working tree
const zip = join(ROOT, '.harness', `source-${COMMIT.slice(0, 7)}.zip`);
rmSync(zip, { force: true });
execFileSync('git', ['archive', '--format=zip', '-o', zip, COMMIT], { cwd: ROOT });
aws(['s3', 'cp', zip, `s3://${bucket}/${key}`], { stdio: 'ignore' });
rmSync(zip, { force: true });

// 2. start the build with the bundle's buildspec and the four inputs
const started = awsJson([
  'codebuild',
  'start-build',
  '--project-name',
  `${APP}-deploy`,
  '--source-type-override',
  'S3',
  '--source-location-override',
  `${bucket}/${key}`,
  '--buildspec-override',
  readFileSync(BUILDSPEC, 'utf8'),
  '--environment-variables-override',
  JSON.stringify([
    { name: 'APP', value: APP, type: 'PLAINTEXT' },
    { name: 'STAGE', value: STAGE, type: 'PLAINTEXT' },
    { name: 'COMMIT', value: COMMIT, type: 'PLAINTEXT' },
    { name: 'ACTION', value: ACTION, type: 'PLAINTEXT' },
  ]),
]);
const buildId = started.build.id;
const t0 = Date.now();
console.log(
  `runner: ${ACTION} ${APP} stage=${STAGE} commit=${COMMIT.slice(0, 7)} build=${buildId}`,
);
if (!WAIT) {
  writeJson(join(OUT, 'build.json'), { buildId, commit: COMMIT, stage: STAGE, action: ACTION });
  process.exit(0);
}

// 3. poll and stream logs
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let build;
let nextToken = null;
let logStream = null;
for (;;) {
  build = awsJson(['codebuild', 'batch-get-builds', '--ids', buildId]).builds[0];
  const g = build.logs?.groupName;
  const s = build.logs?.streamName;
  if (g && s) {
    logStream = { g, s };
    try {
      const args = [
        'logs',
        'get-log-events',
        '--log-group-name',
        g,
        '--log-stream-name',
        s,
        '--start-from-head',
      ];
      if (nextToken) args.push('--next-token', nextToken);
      const ev = awsJson(args);
      for (const e of ev.events || [])
        process.stdout.write(`  | ${e.message.replace(/\n$/, '')}\n`);
      if (ev.nextForwardToken && ev.nextForwardToken !== nextToken) nextToken = ev.nextForwardToken;
    } catch {
      /* stream not ready yet */
    }
  }
  if (build.buildComplete) break;
  sleep(10_000);
}
const minutes = Math.round((Date.now() - t0) / 6000) / 10;
const status = build.buildStatus;
console.log(`runner: ${status} in ${minutes} min (phase ${build.currentPhase})`);

// 4. artifacts back: state export, outputs, deploy.json
const loc = build.artifacts?.location || '';
const m = /^arn:aws:s3:::(.+)$/.exec(loc);
let outputs = {};
let deployInfo = {};
if (m) {
  try {
    aws(['s3', 'cp', '--recursive', `s3://${m[1]}/`, OUT], { stdio: 'ignore' });
    outputs = readJson(join(OUT, 'outputs.json'), {});
    deployInfo = readJson(join(OUT, 'deploy.json'), {});
  } catch {
    /* no artifacts on early failure */
  }
}
const url = outputs.url || outputs.Web || null;
const record = {
  app: APP,
  stage: STAGE,
  action: ACTION,
  commit: COMMIT,
  buildId,
  status,
  minutes,
  url,
  outputs,
  logGroup: logStream?.g || null,
  logStream: logStream?.s || null,
  succeeding: deployInfo.succeeding ?? null,
  finishedAt: new Date().toISOString(),
};
writeJson(join(OUT, 'last.json'), record);

// 5. manifest from state (deploy only), ledger line
if (status === 'SUCCEEDED' && ACTION === 'deploy' && existsSync(join(OUT, 'state.json'))) {
  try {
    execFileSync(
      'node',
      [join(ROOT, 'scripts', 'harness', 'infra-manifest.mjs'), '--state', join(OUT, 'state.json')],
      { cwd: ROOT, stdio: 'inherit' },
    );
  } catch {
    console.error('deploy: manifest regeneration failed (state export unreadable)');
  }
}
try {
  execFileSync(
    'node',
    [
      join(ROOT, 'scripts', 'harness', 'ledger.mjs'),
      'append',
      '--plan',
      PLAN,
      '--kind',
      'deploy',
      '--actor',
      'script:deploy',
      '--data',
      JSON.stringify({
        stage: STAGE,
        action: ACTION,
        commit: COMMIT,
        buildId,
        status,
        minutes,
        url,
      }),
    ],
    { cwd: ROOT, stdio: 'ignore' },
  );
} catch {
  /* ledger is advisory here */
}
if (url) console.log(`runner: url ${url}`);
process.exit(status === 'SUCCEEDED' ? 0 : 1);
