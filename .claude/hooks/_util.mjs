// Shared by the harness hooks. Every hook fails open: any error exits 0 with no output.
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
export function input() {
  try {
    const t = readFileSync(0, 'utf8');
    return t.trim() ? JSON.parse(t.replace(/^\uFEFF/, '')) : {};
  } catch {
    return {};
  }
}
export function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}
export function relOf(p) {
  if (!p) return null;
  const r = p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
  return r.split('\\').join('/');
}
export function readJson(p, d = null) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
}
export function stat(row) {
  try {
    mkdirSync(join(ROOT, '.harness'), { recursive: true });
    appendFileSync(
      join(ROOT, '.harness', 'stats.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n',
    );
  } catch {
    /* fail open */
  }
}
export function touchedFiles(data) {
  const f = data.tool_input?.file_path || data.tool_input?.notebook_path;
  if (f) return [relOf(f)];
  if (data.tool_name === 'Bash' && typeof data.tool_input?.command === 'string') {
    const m =
      data.tool_input.command.match(
        /(?:>>?|tee|sed -i[^ ]*|cp [^ ]+|mv [^ ]+)\s+["']?([\w./-]+)/g,
      ) || [];
    return m.map((s) => relOf(s.replace(/^.*\s/, '').replace(/["']/g, ''))).filter(Boolean);
  }
  return [];
}
export function sessionTouched(session) {
  const p = join(ROOT, '.harness', `touched-${session}.json`);
  return { path: p, list: existsSync(p) ? readJson(p, []) : [] };
}
