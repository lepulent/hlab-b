// Drift (Mycelium FR-7, FR-22, FR-33, FR-34; ported from src/lib/master/drift.ts). PURE.
//
// STAMP AT WRITE, COMPARE AT READ: A LOOKUP, NEVER A JUDGEMENT.
//
//   at write : the artifact is stamped with every live decision it could have been written against
//   at read  : any of those now changed or withdrawn ⇒ STALE
//
// A decision taken after a document was written does not reach into it. The obvious way to find the
// documents it contradicts is to ask their author, and that is the failure the two-witness rule exists
// to prevent: a seat asked whether its own document is current is the checker checking itself. So
// nothing here calls a model and nothing here reads a file — the caller passes the stamps and the
// state, and the comparison is arithmetic.
//
// What a decision is, in the lab: an **answer** the Master or the owner gave to a question, and a
// **criterion** of the canon (a capability's contract). Both are things a document is written against
// and both can change underneath it.
//
// ABSENT ⇒ NOT STALE. An artifact written before stamping existed carries no stamp and reads as fine,
// never as "unknown". The alternative marks everything on the day this ships, and a Master shown
// everything is shown nothing.
//
// WITHDRAWN ⇒ STALE — the one place this diverges from Mycelium, on purpose. There a stamped id that
// resolves to nothing means the record was deleted or the project reset, so it cannot be compared. Here
// a criterion that is no longer in the canon was *removed by a landing*, with a reason and a migration
// (step 12), which is supersession itself. The lab records removals; it does not lose them.
//
// IT DETECTS. IT DOES NOT REPAIR. Nothing here hands a seat a targeted diff; repairing a drifted
// document still costs a re-run by the agent that owns it.

import { createHash } from 'node:crypto';

export const DRIFT_DIGEST_CAP = 10; // how many drifted artifacts the digest carries
export const DRIFT_DECISIONS_PER_NODE = 3; // how many superseded decisions one line names
const EXCERPT = 90;

export const hash = (text) =>
  createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex')
    .slice(0, 12);

// ---------------------------------------------------------------- what binds now
// answers: [{ file, answer }] — a question answered; criteria: [{ id, text }] — a canon criterion and
// the sentence that is its contract. An id is stable; the hash is what changes when the world does.
export function liveDecisions({ answers = [], criteria = [] } = {}) {
  const rows = [];
  for (const a of answers)
    if (a?.file && a.answer != null)
      rows.push({ id: `answer:${a.file}`, text: String(a.answer), hash: hash(a.answer) });
  for (const c of criteria)
    if (c?.id) rows.push({ id: `canon:${c.id}`, text: String(c.text ?? ''), hash: hash(c.text) });
  const seen = new Map();
  // a question answered twice binds by its latest answer: the later row wins, and the stamp that
  // carried the earlier hash is what goes stale
  for (const r of rows) seen.set(r.id, r);
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// The stamp: every live decision at the moment the write landed, as {id, hash}. Machine-written from
// state the orchestrator already holds, so a seat's claim about its own currency never reaches it.
export function stampAtWrite(live) {
  return live.map((d) => ({ id: d.id, hash: d.hash })).sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- the comparison
// stamp: what the artifact was written against; live: what binds now. Returns the stamped decisions
// that no longer hold, in stamp order.
export function supersededFor(stamp, live) {
  const now = new Map(live.map((d) => [d.id, d]));
  const out = [];
  for (const s of stamp || []) {
    if (!s?.id) continue;
    const cur = now.get(s.id);
    if (!cur) out.push({ id: s.id, why: 'withdrawn', text: '' });
    else if (cur.hash !== s.hash) out.push({ id: s.id, why: 'changed', text: cur.text });
  }
  return out;
}

// stamps: [{ artifact, path, wave, decisions: [{id, hash}] }], newest write per artifact last.
// One entry per drifted artifact, most contradicted first, then by artifact — a digest whose order
// depends on read order is a digest whose truncation is a coin toss.
export function driftEntries(stamps, live) {
  const latest = new Map();
  for (const s of stamps || []) if (s?.artifact) latest.set(s.artifact, s);
  const out = [];
  for (const s of latest.values()) {
    if (!Array.isArray(s.decisions) || !s.decisions.length) continue; // absent ⇒ not stale
    const superseded = supersededFor(s.decisions, live);
    if (!superseded.length) continue;
    out.push({
      artifact: s.artifact,
      path: s.path || '',
      wave: s.wave ?? null,
      superseded,
    });
  }
  return out.sort(
    (a, b) =>
      b.superseded.length - a.superseded.length || String(a.artifact).localeCompare(b.artifact),
  );
}

export function staleArtifacts(entries) {
  return entries.map((e) => e.artifact);
}

// ---------------------------------------------------------------- the digest
const excerpt = (t, cap) => (t.length <= cap ? t : `${t.slice(0, cap - 1).trimEnd()}…`);

export function driftDigestLines(entries) {
  return entries.slice(0, DRIFT_DIGEST_CAP).map((e) => {
    const shown = e.superseded.slice(0, DRIFT_DECISIONS_PER_NODE);
    const parts = [
      `[drift:${e.artifact}] DRIFT — ${e.path || e.artifact} was written against ${
        e.superseded.length === 1 ? 'a decision' : `${e.superseded.length} decisions`
      } that no longer hold`,
      ...shown.map((d) =>
        d.why === 'withdrawn'
          ? `${d.id}: withdrawn from the canon`
          : `${d.id}: now "${excerpt(d.text, EXCERPT)}"`,
      ),
    ];
    const rest = e.superseded.length - shown.length;
    if (rest > 0) parts.push(`+${rest} more on this artifact`);
    return parts.join(' · ');
  });
}

export const DRIFT_HEADER =
  'DRIFT — artifacts that contradict a decision that holds now. Repair these BEFORE you grow: a stale document outranks a missing one, because it will be read and believed.';

export function driftDigest(entries) {
  if (!entries.length) return '(nothing has drifted)';
  const lines = driftDigestLines(entries);
  const cut = entries.length - lines.length;
  return cut > 0
    ? [
        ...lines,
        `(+${cut} more drifted artifacts not shown — this digest carries ${DRIFT_DIGEST_CAP})`,
      ].join('\n')
    : lines.join('\n');
}

// ---------------------------------------------------------------- the door
// Drift outranks growth, as a rule and not merely as an ordering: while an artifact of this plan stands
// stale, a gap that produces anything else is refused, and so is closing the plan. The Master may still
// ask (clarify) — being unable to grow is not being unable to speak.
export function driftRefusals({ outcome, artifacts = [], entries = [] }) {
  if (!entries.length) return [];
  const stale = staleArtifacts(entries);
  const names = stale.join(', ');
  if (outcome === 'no-move')
    return [
      `${names} ${stale.length === 1 ? 'is' : 'are'} stale: repair before closing the plan, a stale document outranks a missing one`,
    ];
  if (outcome !== 'move') return [];
  return artifacts.some((a) => stale.includes(a))
    ? []
    : [
        `${names} ${stale.length === 1 ? 'is' : 'are'} stale and drift outranks growth: this gap must produce ${stale.length === 1 ? 'it' : 'one of them'} before anything else`,
      ];
}
