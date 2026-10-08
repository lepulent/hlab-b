#!/usr/bin/env node
// Step 17: run an adapter against the contract's cases (adapter-contract.mjs) and say, per case, whether
// it holds. Usage: node scripts/harness/conformance.mjs [--adapter settings|mod] [--hooks <dir>]
//
// settings  the settings hooks as Claude Code runs them: each PreToolUse guard (room-reach.mjs with the
//           seat's folders, veto.mjs) gets the call on stdin with CLAUDE_PROJECT_DIR at a scratch root;
//           exit 2 is a deny and its stderr the seat's message; a call no guard denied goes to
//           footprint.mjs (PostToolUse). The footprint file is read back as the witness.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, DEPARTMENTS, bind, conform } from './adapter-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// the hooks beside these scripts: <app>/.claude/hooks installed, or bundle/claude/hooks in the lab
const defaultHooks = () =>
  [join(HERE, '..', '..', '.claude', 'hooks'), join(HERE, '..', '..', 'claude', 'hooks')].find(
    (d) => existsSync(join(d, 'veto.mjs')),
  );

export function settingsAdapter(hooksDir = defaultHooks()) {
  return (c, root) => {
    mkdirSync(join(root, 'canon'), { recursive: true });
    if (c.fault !== 'no-policy')
      writeFileSync(join(root, 'canon', 'departments.json'), JSON.stringify(DEPARTMENTS));
    const session = `conf-${Math.random().toString(36).slice(2, 10)}`;
    const stdin = JSON.stringify({
      session_id: session,
      tool_name: c.call.tool ?? undefined,
      tool_input: c.call.input,
      cwd: c.cwd || root,
    });
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_PROJECT_DIR: root,
      ...(c.fault === 'throw' ? { HARNESS_FORCE_GUARD_THROW: '1' } : {}),
    };
    const run = (hook, args = []) =>
      spawnSync('node', [join(hooksDir, hook), ...args], { input: stdin, env, encoding: 'utf8' });
    const guards = [...(c.reach ? [['room-reach.mjs', c.reach]] : []), ['veto.mjs', []]];
    let observed = { verdict: 'allow' };
    for (const [hook, args] of guards) {
      const r = run(hook, args);
      if (r.status === 2) {
        observed = { verdict: 'deny', message: r.stderr };
        break;
      }
      if (r.status !== 0) {
        observed = { verdict: 'error', message: r.stderr };
        break;
      }
    }
    if (observed.verdict === 'allow') run('footprint.mjs');
    const f = join(root, '.harness', 'footprint', `${session}.jsonl`);
    const lines = existsSync(f)
      ? readFileSync(f, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const denied = lines.find((l) => l.denied);
    return {
      ...observed,
      by: denied ? (/^V-/.test(denied.denied) ? 'veto' : denied.denied) : undefined,
      lines,
    };
  };
}

export async function runConformance(adapter) {
  const rows = [];
  for (const raw of CASES) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-conformance-')));
    try {
      const c = bind(raw, root);
      rows.push(conform(c, await adapter(c, root)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
  const which = arg('adapter', 'settings');
  const adapters = { settings: () => settingsAdapter(arg('hooks', defaultHooks())) };
  if (!adapters[which]) {
    console.error(`conformance: no adapter "${which}"; known: ${Object.keys(adapters).join(', ')}`);
    process.exit(2);
  }
  const rows = await runConformance(adapters[which]());
  for (const r of rows)
    console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}${r.ok ? '' : `: ${r.why.join('; ')}`}`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(
    `conformance: ${which} adapter ${bad ? `FAILED ${bad} of ${rows.length}` : `holds all ${rows.length} case(s)`}`,
  );
  process.exit(bad ? 1 : 0);
}
