// Shared helpers for the harness scripts. Node stdlib only. Deterministic.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { globToRegex } from './seat-policy.mjs';

export const ROOT = process.env.HARNESS_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();

export function walk(
  dir,
  {
    skip = [
      'node_modules',
      '.git',
      'dist',
      '.sst',
      '_bmad',
      '.claude',
      '.harness',
      'playwright-report',
      'test-results',
    ],
  } = {},
) {
  const out = [];
  const rec = (d) => {
    for (const name of readdirSync(d)) {
      if (skip.includes(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) rec(dir);
  return out;
}

// Minimal YAML-subset frontmatter: `key: value`, `key: [a, b]`, `key: null`, numbers, quoted strings.
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let list = null; // a block list belongs to the key above it; both YAML list forms read the same
  for (const line of m[1].split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && list) {
      data[list].push(parseScalar(item[1].trim()));
      continue;
    }
    const mm = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    list = null;
    const v = mm[2].trim();
    if (v === '') {
      list = mm[1];
      data[list] = [];
      continue;
    }
    data[mm[1]] = parseScalar(v);
  }
  // a key with no value and no items is empty, not an empty list
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && !v.length) data[k] = null;
  return { data, body: text.slice(m[0].length) };
}
function parseScalar(v) {
  if (v === '' || v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']'))
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  return v.replace(/^['"]|['"]$/g, '');
}

export function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}
export function git(args, cwd = ROOT) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
// The environment a model process the harness spawns gets: an allowlist, so no ANTHROPIC_*, Bedrock,
// Vertex or AWS credential inherited from the operator's shell can turn a CLI-login run into a billed one
// (NFR-5..7). Seats have had it since step 4; the review lenses inherited the whole environment.
export const MODEL_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
];
export function modelEnv(env = process.env, extra = {}) {
  return {
    ...Object.fromEntries(MODEL_ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])),
    ...extra,
  };
}

// What in the user settings a `--setting-sources user` model process loads that would bill it: an
// apiKeyHelper, or a credential in its env block. The allowlisted environment cannot see these; so a
// model process the harness starts is preceded by this read, and refused on any finding, rather than
// "on the CLI login" being an assumption about today's settings (Ludwig 2026-10-02, on 82faaab).
export const BILLED_ENV =
  /^(ANTHROPIC_|AWS_|CLAUDE_CODE_USE_(BEDROCK|VERTEX)$|GOOGLE_APPLICATION_CREDENTIALS$)/;
export function billedSettings(home = process.env.HOME || '') {
  const out = [];
  for (const f of ['settings.json', 'settings.local.json']) {
    const file = join(home, '.claude', f);
    if (!existsSync(file)) continue;
    let s;
    try {
      s = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      out.push(`~/.claude/${f} does not parse, so what it would bill cannot be read`);
      continue;
    }
    if (s.apiKeyHelper) out.push(`~/.claude/${f} sets apiKeyHelper`);
    for (const k of Object.keys(s.env || {}))
      if (BILLED_ENV.test(k)) out.push(`~/.claude/${f} env sets ${k}`);
  }
  return out;
}

// Everything that would make a model run billed: the settings above, and the login itself — a Console
// login bills whatever the settings say. `claude auth status` is read under the same allowlisted
// environment a seat gets; anything but a claude.ai subscription login is a finding (Ludwig 2026-10-02).
export function billingFindings(home = process.env.HOME || '') {
  const out = billedSettings(home);
  const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', env: modelEnv() });
  let st = null;
  try {
    st = JSON.parse(r.stdout);
  } catch {
    // not JSON: the login cannot be read
  }
  if (!st)
    out.push('`claude auth status` could not be read, so the login cannot be shown unbilled');
  else if (st.authMethod !== 'claude.ai' || st.apiProvider !== 'firstParty')
    out.push(`the CLI login is ${st.authMethod}/${st.apiProvider}, not a claude.ai subscription`);
  return out;
}

// A commit carries exactly the paths it names. A bare `git commit` takes the whole index, so the work of a
// seat whose own commit was refused by the app's hook stayed staged and was swept into the next
// "chore(ledger)" commit, where HEAD then counted it delivered (hlab-b t7b2 w4, s12b w3, s11b w3, s10 w2;
// hlab-a t5a w3, s12a w3, s11b w3, s11 w3). A refused commit unstages its paths, so nothing it added is
// left for a later commit to carry. → the spawnSync result of the commit.
export function commitOnly(paths, msg, { cwd = ROOT, who = null } = {}) {
  const run = (args) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  run(['add', '--', ...paths]);
  const id = who ? ['-c', `user.name=${who}`, '-c', 'user.email=seat@harness.local'] : [];
  const r = run([...id, 'commit', '-q', '-m', msg, '--', ...paths]);
  if (r.status !== 0) run(['reset', '-q', '--', ...paths]);
  return r;
}

// The harness writes its own bookkeeping into the tracked tree: ledger lines, regenerated canon,
// .harness records. That churn says nothing about whether the working tree matches the code at HEAD,
// and it must never be mistaken for uncommitted product work — nor handed to a tool that refuses a
// dirty tree. One definition of each, used by every precondition in the harness.
export const BOOKKEEPING = ['ledger', 'canon/generated', 'canon/index', '.harness'];
const exclude = BOOKKEEPING.map((p) => `:!${p}`);
export function productDirty(cwd = ROOT) {
  return git(['status', '--porcelain', '--', '.', ...exclude], cwd) !== '';
}
export function bookkeepingDirty(cwd = ROOT) {
  return git(['status', '--porcelain', '--', ...BOOKKEEPING], cwd) !== '';
}
// The app and the harness installed in it are two lineages (PLAN §1b): the tests bind to the product,
// never to the scripts that run them, so a harness sync cannot change what a test proves. Neither can
// the canon, which describes the code rather than being it — whether it still matches is what the other
// canon rows ask. These are the paths a proof about the product may ignore.
export const NOT_PRODUCT = [
  ...BOOKKEEPING,
  'canon',
  'CLAUDE.md',
  'records',
  'intent',
  'scripts/harness',
  'scripts/quality',
  '.claude',
  'harness.json',
];

export function headSha() {
  return git(['rev-parse', 'HEAD']) || 'no-git';
}
export function blobSha(relPath) {
  return git(['hash-object', relPath]).slice(0, 7);
}
export function rel(p) {
  return relative(ROOT, p).split('\\').join('/');
}
export function readJson(p, fallback = null) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
export function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
export function readStdinJson() {
  try {
    const t = readFileSync(0, 'utf8');
    return t.trim() ? JSON.parse(t.replace(/^\uFEFF/, '')) : {};
  } catch {
    return {};
  }
}
// globToRegex moved to seat-policy.mjs, which a mod carries and so may import nothing
export { globToRegex };

export function layerOf(relPath, layerMap) {
  for (const [layer, globs] of Object.entries(layerMap.layers || {})) {
    for (const g of globs) if (globToRegex(g).test(relPath)) return layer;
  }
  return null;
}
