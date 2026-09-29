// One orchestrator per plan. Two `conduct` processes on one plan each cast the same seats for the same
// gaps: on 2026-09-28 t5a ran waves 1–3 twice (w3 three times) and t5b waves 1–2 twice, $2.11 of T5's
// $8.53, and the second spec-writer on t5a asked Q-4, the question Q-1 had already asked, which the
// Master answered the other way and then spent Q-6 reconciling. Nothing refused the second process; a
// trap in docs/13 told the operator not to start one. The lock is published with an atomic link, so of
// two processes starting together exactly one wins, and a lock whose holder is dead is taken over. One
// race is left open: two processes that both find the SAME dead holder at the same instant can both
// take over. It needs a crashed orchestrator and two restarts within milliseconds of each other.
import { writeFileSync, linkSync, readFileSync, unlinkSync } from 'node:fs';

// a pid is alive when signal 0 reaches it; EPERM means it exists under another user, which is alive too
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const readLock = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // absent, or torn by a crash mid-write: either way it holds nothing
  }
};

// → { ok: true, tookOver: holder|null } or { ok: false, holder }
export function acquireLock(file, { pid = process.pid, now = new Date(), alive = pidAlive } = {}) {
  let stale = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // written whole under a private name, then published with link(), which fails if the lock exists:
    // the lock is never seen half-written, so an unreadable lock is a crash, not a winner mid-write
    const tmp = `${file}.${pid}`;
    writeFileSync(tmp, JSON.stringify({ pid, started: now.toISOString() }));
    try {
      linkSync(tmp, file);
      return { ok: true, tookOver: stale };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      unlinkSync(tmp);
    }
    stale = readLock(file);
    if (stale && alive(stale.pid)) return { ok: false, holder: stale };
    try {
      unlinkSync(file);
    } catch {
      /* another process removed it first; the next link decides */
    }
  }
  return { ok: false, holder: readLock(file) };
}

// released only by its holder: a process that lost the race must not delete the winner's lock
export function releaseLock(file, pid = process.pid) {
  if (readLock(file)?.pid === pid)
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
}
