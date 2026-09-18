// Shared helpers for the harness scripts. Node stdlib only. Deterministic.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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
export function globToRegex(glob) {
  // tokens first so the expansions of ** and * never feed each other
  const t = glob
    .replace(/\*\*\//g, '\u{1F}A')
    .replace(/\*\*/g, '\u{1F}B')
    .replace(/\*/g, '\u{1F}C');
  const esc = t.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  const re = esc
    .split('\u{1F}A')
    .join('(?:.*/)?')
    .split('\u{1F}B')
    .join('.*')
    .split('\u{1F}C')
    .join('[^/]*');
  return new RegExp('^' + re + '$');
}

export function layerOf(relPath, layerMap) {
  for (const [layer, globs] of Object.entries(layerMap.layers || {})) {
    for (const g of globs) if (globToRegex(g).test(relPath)) return layer;
  }
  return null;
}
