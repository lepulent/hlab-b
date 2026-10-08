// Step 18: stage the mod adapter for one seat. The installed copy (scripts/harness/mod/harness-guard,
// kept equal to the bundle by harness-in-sync) is copied into a fresh 0700 folder outside the app, so it
// lies outside every path a seat is cast to write, with the seat's own config beside its module:
// hooks/seat.json { root, departments, reach, forceThrow, route }. Returns the folder and each file's hash, so
// the record can name exactly what a seat was given.
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export const MOD_NAME = 'harness-guard';
// what the guard may call on `$` (the mod-reach check): files and the session's own facts, never a
// model, a network, a process or an agent
export const MOD_CALLS_ALLOWED = ['fs.read', 'fs.write', 'session.cwd', 'session.id'];

const hashes = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else
        out[relative(dir, p)] = createHash('sha256')
          .update(readFileSync(p))
          .digest('hex')
          .slice(0, 16);
    }
  };
  walk(dir);
  return out;
};

export function stageMod({ root, departments, reach = null, forceThrow = false, route = null }) {
  const from = join(root, 'scripts', 'harness', 'mod', MOD_NAME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-mod-')));
  const dir = join(base, MOD_NAME);
  cpSync(from, dir, { recursive: true });
  writeFileSync(
    join(dir, 'hooks', 'seat.json'),
    JSON.stringify({ root, departments, reach, forceThrow, route }),
  );
  return { dir, files: hashes(dir), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// mods-admitted: every non-builtin plugin the session's init names is the guard itself, carries no hooks
// at all (a skills-only plugin), or was refused by the guard (its witness says so)
export function modsAdmitted(initPlugins, { guardDir = null, refused = [] } = {}) {
  const rows = (initPlugins || [])
    .filter((p) => p.path && p.path !== 'builtin')
    .map((p) => {
      const hooks = (() => {
        try {
          return statSync(join(p.path, 'hooks', 'hooks.json')).isFile();
        } catch {
          return false;
        }
      })();
      const guard = !!guardDir && p.path === guardDir;
      const isRefused = refused.includes(p.path);
      return {
        name: p.name,
        path: p.path,
        hooks,
        guard,
        refused: isRefused,
        ok: guard || !hooks || isRefused,
      };
    });
  return { ok: rows.every((r) => r.ok) && (!guardDir || rows.some((r) => r.guard)), rows };
}
