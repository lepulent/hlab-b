#!/usr/bin/env node
// Runs the unit suite (and with --e2e the Playwright suite) with JSON reporters and joins them into
// .harness/test-results.json, stamped with the commit they ran at. The canon check reads that file;
// nothing else does. Exit code: 1 when any test failed, 0 otherwise (the file is written either way).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, headSha, git, readJson, writeJson } from './common.mjs';

const e2e = process.argv.includes('--e2e');
const unit = !process.argv.includes('--e2e-only');
const OUT = join(ROOT, '.harness');
const tests = [];
const runners = {};

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env, CI: process.env.CI ?? '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status ?? 1;
}

if (unit) {
  const file = join(OUT, 'vitest.json');
  rmSync(file, { force: true });
  const status = run('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${file}`]);
  const j = readJson(file);
  if (!j) runners.vitest = { ran: false, status };
  else {
    for (const suite of j.testResults || [])
      for (const a of suite.assertionResults || [])
        tests.push({
          runner: 'vitest',
          file: suite.name.replace(ROOT + '/', ''),
          title: a.fullName,
          status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped',
        });
    runners.vitest = {
      ran: true,
      status,
      passed: j.numPassedTests,
      failed: j.numFailedTests,
      skipped: (j.numPendingTests || 0) + (j.numTodoTests || 0),
    };
  }
}

if (e2e || process.argv.includes('--e2e-only')) {
  const file = join(OUT, 'playwright.json');
  rmSync(file, { force: true });
  const status = run('npx', ['playwright', 'test', '--reporter=json'], {
    PLAYWRIGHT_JSON_OUTPUT_NAME: file,
  });
  const j = readJson(file);
  if (!j) runners.playwright = { ran: false, status };
  else {
    let passed = 0,
      failed = 0,
      skipped = 0;
    const visit = (suite, titles) => {
      const path = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles;
      for (const spec of suite.specs || []) {
        for (const t of spec.tests || []) {
          const st =
            t.status === 'skipped' ? 'skipped' : t.status === 'unexpected' ? 'failed' : 'passed';
          if (st === 'passed') passed++;
          else if (st === 'failed') failed++;
          else skipped++;
          tests.push({
            runner: 'playwright',
            file: `tests/e2e/${spec.file}`,
            title: [...path, spec.title].join(' '),
            project: t.projectName,
            status: st,
            flaky: t.status === 'flaky' || undefined,
          });
        }
      }
      for (const s of suite.suites || []) visit(s, path);
    };
    for (const s of j.suites || []) visit(s, []);
    runners.playwright = { ran: true, status, passed, failed, skipped };
  }
}

const dirty = git(['status', '--porcelain', '--', ':!.harness']) !== '';
const result = {
  commit: headSha(),
  dirty,
  ranAt: new Date().toISOString(),
  runners,
  tests,
};
writeJson(join(OUT, 'test-results.json'), result);
const failed = tests.filter((t) => t.status === 'failed').length;
const notRan = Object.values(runners).filter((r) => !r.ran).length;
console.log(
  `test-results: ${tests.length} tests · ${failed} failed · ${Object.keys(runners).join('+') || 'nothing ran'} · commit ${result.commit.slice(0, 7)}${dirty ? ' (dirty)' : ''}`,
);
if (
  existsSync(join(OUT, 'test-results.json')) &&
  readFileSync(join(OUT, 'test-results.json'), 'utf8').length === 0
)
  process.exit(2);
process.exit(failed || notRan ? 1 : 0);
