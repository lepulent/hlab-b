#!/usr/bin/env node
// Step 17: run an adapter against the contract's cases (adapter-contract.mjs) and say, per case, whether
// it holds. Usage: node scripts/harness/conformance.mjs [--adapter settings|mod] [--hooks <dir>]
//
// mod       the mod (mod/harness-guard), staged as a seat would get it, its register() driven by a
//           stand-in for the engine: tool.call with `next` beneath, and the .catch semantics the engine
//           documents (a hook that threw before calling next is answered by its handler). The engine's
//           own run of the same mod is the live proof (adapter-live.mjs); this is the contract, case by case.
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
import { setTimeout } from 'node:timers';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, DEPARTMENTS, bind, conform } from './adapter-contract.mjs';
import { guardCommand } from './common.mjs';

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
      writeFileSync(
        join(root, 'canon', 'departments.json'),
        c.fault === 'null-policy' ? 'null' : JSON.stringify(DEPARTMENTS),
      );
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
    // a guard runs as the seat's settings give it to Claude Code (common.mjs guardCommand); a guard that
    // cannot load is a module whose import fails before a line of it runs
    const broken = join(root, 'broken-guard.mjs');
    if (c.fault === 'unloadable')
      writeFileSync(broken, "import { nothing } from './not-there.mjs';\nnothing();\n");
    const run = (hook, args = []) =>
      hook === 'footprint.mjs'
        ? spawnSync('node', [join(hooksDir, hook), ...args], {
            input: stdin,
            env,
            encoding: 'utf8',
          })
        : spawnSync(
            'bash',
            ['-c', guardCommand(c.fault === 'unloadable' ? broken : join(hooksDir, hook), args)],
            {
              input: stdin,
              env,
              encoding: 'utf8',
            },
          );
    const guards = [...(c.reach ? [['room-reach.mjs', c.reach]] : []), ['veto.mjs', []]];
    let observed = { verdict: 'allow' };
    for (const [hook, args] of guards) {
      const r = run(hook, args);
      // the engine's rule: exit 2 denies; any other exit, 0 or a crash, lets the call run
      if (r.status === 2) {
        observed = { verdict: 'deny', message: r.stderr };
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
      by: denied ? (denied.department ? 'veto' : denied.denied) : undefined,
      lines,
    };
  };
}

// the engine's tool.call dispatch, as its types document it, over one plugin's hooks
async function dispatchToolCall(hooks, $, e) {
  const h = hooks.find((x) => x.event === 'tool.call');
  let called = false;
  const next = async () => {
    called = true;
    return { result: 'ran' };
  };
  try {
    return await h.hook($, e, next);
  } catch (error) {
    if (!h.handler) return next(e); // a hook that fails with no handler is skipped
    const n = async (x) => next(x);
    Object.defineProperty(n, 'called', { get: () => called });
    n.error = { kind: 'threw', error };
    return h.handler($, e, n);
  }
}
export function modAdapter(modDir = null) {
  return async (c, root) => {
    const { stageMod, admitStaged } = await import('./mod-stage.mjs');
    // the installed mod in an app; in the lab the bundle's, with the seat policy laid beside it
    const appMod = join(HERE, 'mod', 'harness-guard');
    const labMod = join(HERE, '..', '..', 'mod', 'harness-guard');
    const src = modDir || (existsSync(appMod) ? appMod : labMod);
    mkdirSync(join(root, 'scripts', 'harness', 'mod'), { recursive: true });
    const { cpSync } = await import('node:fs');
    cpSync(src, join(root, 'scripts', 'harness', 'mod', 'harness-guard'), { recursive: true });
    const policy = join(
      root,
      'scripts',
      'harness',
      'mod',
      'harness-guard',
      'hooks',
      'seat-policy.mjs',
    );
    if (!existsSync(policy)) cpSync(join(HERE, 'seat-policy.mjs'), policy);
    const staged = stageMod({
      root,
      departments: c.fault === 'null-policy' ? null : DEPARTMENTS,
      reach: c.reach || null,
      forceThrow: c.fault === 'throw',
    });
    if (c.fault === 'no-policy') rmSync(join(staged.dir, 'hooks', 'seat.json'));
    if (c.fault === 'unloadable')
      writeFileSync(
        join(staged.dir, 'hooks', 'seat-policy.mjs'),
        "export { nothing } from './not-there.mjs';\n",
      );
    // what conduct does before it spawns a seat: a stage the engine would not load is refused
    const admitted = admitStaged(staged.dir);
    if (!admitted.ok) {
      staged.cleanup();
      return { verdict: 'deny', message: admitted.reason, lines: [] };
    }
    try {
      const mod = await import(
        `${join(staged.dir, 'hooks', 'register.mjs')}?case=${Math.random()}`
      );
      const hooks = [];
      mod.register((event, hook) => {
        const reg = { event, hook };
        hooks.push(reg);
        return { catch: (handler) => (reg.handler = handler) };
      });
      const session = `conf-${Math.random().toString(36).slice(2, 10)}`;
      const $ = {
        plugin: { root: staged.dir, name: 'harness-guard' },
        session: { id: async () => session, cwd: async () => c.cwd || root },
        fs: {
          read: async (p) => readFileSync(p, 'utf8'),
          write: async (p, t) => {
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, t);
          },
        },
      };
      const e = { tool: c.call.tool ?? undefined, tool_use_id: 'toolu_conf', ...c.call.input };
      const out = await dispatchToolCall(hooks, $, e);
      // the ran call's witness is written after next resolves; let the chain settle
      await new Promise((r) => setTimeout(r, 20));
      const f = join(root, '.harness', 'footprint', `${session}.jsonl`);
      const lines = existsSync(f)
        ? readFileSync(f, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
      const denied = lines.find((l) => l.denied);
      return {
        verdict: out?.deny ? 'deny' : 'allow',
        message: out?.deny,
        by: denied ? (denied.department ? 'veto' : denied.denied) : undefined,
        lines,
      };
    } finally {
      staged.cleanup();
    }
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
  const adapters = {
    settings: () => settingsAdapter(arg('hooks', defaultHooks())),
    mod: () => modAdapter(arg('mod', null)),
  };
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
