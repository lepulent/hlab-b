// One orchestrator per plan. Two `conduct` processes on one plan each cast the same seats for the same
// gaps: on 2026-09-28 t5a ran waves 1–3 twice (w3 three times) and t5b waves 1–2 twice, $2.11 of T5's
// $8.53, and the second spec-writer on t5a asked Q-4, the question Q-1 had already asked, which the
// Master answered the other way and then spent Q-6 reconciling. Nothing refused the second process; a
// trap in docs/13 told the operator not to start one. The lock is published with an atomic link, so of
// two processes starting together exactly one wins, and a lock whose holder is dead is taken over by exactly one
// process: the takeover is claimed per dead lock (below), so two that find the same dead holder at
// once cannot both win, as they could while takeover was unlink-then-link (Ludwig 2026-09-30).
import {
  writeFileSync,
  linkSync,
  readFileSync,
  unlinkSync,
  renameSync,
  appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';

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

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null; // torn by a crash mid-write: it holds nothing
  }
};
const readLock = (file) => parse(readText(file));

// → { ok: true, tookOver: holder|null } or { ok: false, holder, orphans?, claimedBy? }
export function acquireLock(file, { pid = process.pid, now = new Date(), alive = pidAlive } = {}) {
  // written whole under a private name, then published with link(), which fails if the lock exists:
  // the lock is never seen half-written, so an unreadable lock is a crash, not a winner mid-write
  const tmp = `${file}.${pid}`;
  writeFileSync(tmp, JSON.stringify({ pid, started: now.toISOString() }));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, file);
        return { ok: true, tookOver: null };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const text = readText(file);
      if (text === null) continue; // released between the link and the read
      const stale = parse(text);
      if (stale && alive(stale.pid)) return { ok: false, holder: stale };
      // A dead orchestrator is not a dead plan: its seats run in their own process groups and keep
      // writing (t5a dev a61390e6 wrote src/ for 16 minutes after its orchestrator died, 7 of them
      // beside the resumed dev). The lock names them, and a takeover waits until none is alive. They are
      // named, not killed: a pid may have been reused by then, and killing it would hit something else.
      const orphans = (stale?.seats || []).filter((p) => alive(p));
      if (orphans.length) return { ok: false, holder: stale, orphans };
      // The takeover of THIS dead lock is claimed by an exclusive create named after its content, so of
      // two processes that read the same dead lock exactly one proceeds. The winner then checks the lock
      // still holds that content (nothing but a claimant can change a dead holder's lock) and replaces
      // it atomically. A loser re-reads: it finds the winner, alive, and is refused by name.
      const claim = `${file}.took.${createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
      // the claim is published whole with link(), like the lock: a claim is never seen without its pid
      const mine = `${claim}.${pid}`;
      writeFileSync(mine, String(pid));
      try {
        linkSync(mine, claim);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const by = Number(readText(claim));
        // unreadable: the claimant finished and removed it between our link and our read; re-read
        if (!by) continue;
        if (alive(by)) continue; // another process is taking it over now; read what it published
        // a claimant that died mid-takeover leaves a claim nobody else may break: named, not guessed
        return { ok: false, holder: stale, claimedBy: { pid: by, claim } };
      } finally {
        unlinkSync(mine);
      }
      try {
        if (readText(file) !== text) continue;
        renameSync(tmp, file);
        return { ok: true, tookOver: stale };
      } finally {
        unlinkSync(claim);
      }
    }
    return { ok: false, holder: readLock(file) };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* renamed into place */
    }
  }
}

// A refused orchestrator is evidence: it is written down beside the lock, outside the tree, and the
// next holder moves it into the plan's ledger (conduct), so a refusal outlives the process that met it.
export function recordRefusal(file, refusal) {
  appendFileSync(`${file}.refusals.jsonl`, `${JSON.stringify(refusal)}\n`);
}
// Taken in two steps so a refusal is never lost: the file is renamed to a private name first (an append
// that lands after the rename starts a new file, kept for the next take), and removed only by done(),
// once the caller has written every refusal down. A taking file a crash left behind is taken first.
export function takeRefusals(file) {
  const f = `${file}.refusals.jsonl`;
  const taking = `${f}.taking`;
  if (readText(taking) === null)
    try {
      renameSync(f, taking);
    } catch {
      return { refusals: [], done: () => {} };
    }
  const refusals = (readText(taking) || '').split('\n').filter(Boolean).map(parse).filter(Boolean);
  return {
    refusals,
    done: () => {
      try {
        unlinkSync(taking);
      } catch {
        /* already gone */
      }
    },
  };
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

// the holder records the pids of the seats it has running, so a successor can tell they outlived it;
// written whole and renamed over the lock, so a reader never sees half of it
export function setLockSeats(file, seats, pid = process.pid) {
  const l = readLock(file);
  if (l?.pid !== pid) return false;
  const tmp = `${file}.${pid}.seats`;
  writeFileSync(tmp, JSON.stringify({ ...l, seats: [...seats] }));
  renameSync(tmp, file);
  return true;
}
