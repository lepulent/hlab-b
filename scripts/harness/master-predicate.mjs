// J5 starts here, and not with a row (docs/14 §7, the boundary rule: "a decision the system's own records
// already settle → a predicate in code; neither model"). The Master's closed fields are outcome and
// artifacts. Most of that is settled by the ladder the Master is shown: while a rung that blocks the seal
// is missing, the plan moves to the missing blocking rungs of the earliest phase; when none is missing,
// it closes. What the ladder does NOT settle is whether a rung that does not block the seal (recommended,
// optional, conditional) is worth a wave — that is the judgement J5 hands to a row, and this module names
// it (`optional`) so the row is asked exactly there and nowhere else.
//
// cov is ladder.mjs coverage(): { slots: [{ phase, id, docTypes, covered }], stepsToSeal }.

const missing = (s) => !(s.covered || []).length;

export function recordsDecision(cov, { wavesLeft = 1, stale = [] } = {}) {
  const slots = cov?.slots || [];
  const blocking = new Set(cov?.stepsToSeal || []);
  const optional = slots
    .filter((s) => missing(s) && !blocking.has(s.id))
    .map((s) => ({ id: s.id, requirement: s.requirement ?? null, docTypes: s.docTypes || [s.id] }));
  if (wavesLeft <= 0) return { outcome: 'no-move', artifacts: [], optional, why: 'no waves left' };
  // drift outranks growth (drift.mjs DRIFT_HEADER, "Repair these BEFORE you grow", and the door's
  // driftRefusals): a stale artifact is repaired before any missing rung, blocking or not (hlab-b s13d w2
  // was scored against a predicate that grew first)
  if (stale.length)
    return { outcome: 'move', artifacts: [...new Set(stale)].sort(), optional, why: 'drift' };
  const need = slots.filter((s) => blocking.has(s.id));
  if (need.length) {
    // phases are ordered in the ladder; the earliest phase with a blocking gap is the frontier
    const frontier = need.filter((s) => s.phase === need[0].phase);
    return {
      outcome: 'move',
      artifacts: frontier.flatMap((s) => s.docTypes || [s.id]).sort(),
      optional,
      why: `blocking rungs missing in ${need[0].phase}`,
    };
  }
  return { outcome: 'no-move', artifacts: [], optional, why: 'ladder covered' };
}

// Where the Master and the records part, by kind — named from the facts, never from the plan:
//   clarify          the Master asked; the records never can (whether an intent reads two ways is not in
//                    the ladder)
//   closed-early     it closed where the records move
//   covered-rung     it re-made a rung the ladder counts covered, whose last attempt had succeeded
//   retry            it re-made a covered rung whose last attempt was abandoned or failed its gate: the
//                    ladder counts the partial work, the Master did not (hlab-a s11b w4/w5, hlab-b s11c w5)
//   optional-rung    it spent a wave on a rung that does not block the seal (the J5 row's atom)
//   beyond-frontier  it ran blocking rungs of a later phase alongside the frontier, in parallel (J6's atom)
// `outcome` is false also when the Master moved where the records close; that is counted, not hidden in
// the artifact kinds (Ludwig 2026-09-30: 29/120 unsaid).
export function compareToRecords(pred, dec, cov, { retried = [] } = {}) {
  const arts = [...new Set((dec?.artifacts || []).map((a) => a.artifact || a))].sort();
  const outcome = pred.outcome === dec?.outcome;
  const full = outcome && (pred.outcome !== 'move' || arts.join('+') === pred.artifacts.join('+'));
  const movedWhereRecordsClose = dec?.outcome === 'move' && pred.outcome === 'no-move';
  if (full) return { outcome, full, movedWhereRecordsClose, category: 'agree' };
  if (dec?.outcome === 'clarify')
    return { outcome, full, movedWhereRecordsClose, category: 'clarify' };
  if (dec?.outcome !== 'move')
    return { outcome, full, movedWhereRecordsClose, category: 'closed-early' };
  // the Master names catalogue artifacts; a slot names the doc types that fill it (ux ← ux_spec)
  const slotOf = (a) =>
    (cov?.slots || []).find((s) => s.id === a || (s.docTypes || []).includes(a));
  const blocking = new Set(cov?.stepsToSeal || []);
  const kind = (a) => {
    const s = slotOf(a);
    if (!s) return 'other';
    if (!missing(s)) return retried.includes(a) ? 'retry' : 'covered';
    return blocking.has(s.id) ? 'blocking' : 'optional';
  };
  const kinds = new Set(arts.map(kind));
  const category = kinds.has('covered')
    ? 'covered-rung'
    : kinds.has('retry')
      ? 'retry'
      : kinds.has('optional')
        ? 'optional-rung'
        : kinds.has('blocking')
          ? 'beyond-frontier'
          : 'other';
  return { outcome, full, movedWhereRecordsClose, category };
}

// What a plan's ledger says had been attempted and not delivered before wave n: artifacts of a gap whose
// last status was linked (a seat abandoned or its closure failed), and code whose last gate failed.
export function retriedBefore(lines, n) {
  const arts = new Map(); // gap id → artifacts, from the Master's declaration
  const status = new Map(); // gap id → last status before n
  const gate = new Map(); // artifact → last gate verdict before n
  for (const l of lines) {
    const d = l?.data || {};
    if (d.wave != null && d.wave >= n) continue;
    if (l.kind === 'gap' && d.id) {
      if (d.status === 'declared')
        arts.set(
          d.id,
          (d.artifacts || []).map((a) => a.artifact || a),
        );
      if (d.status) status.set(d.id, d.status);
    }
    if (l.kind === 'decision' && d.station === 'gate' && d.artifact) gate.set(d.artifact, !!d.ok);
  }
  const out = new Set();
  for (const [id, st] of status)
    if (st === 'linked') for (const a of arts.get(id) || []) out.add(a);
  for (const [a, ok] of gate) if (!ok) out.add(a);
  return [...out].sort();
}

// The LADDER block of a Master prompt, back into a coverage shape, for replaying decisions made before
// the ledger carried the whole coverage. Two wordings have been used ("Required before the seal" until
// step 14, "Blocking the seal" since); a prompt with neither returns null and is not a decision point.
export function parseLadderView(prompt) {
  const text = String(prompt || '');
  const m = text.match(
    /(?:Blocking the seal|Required before the seal) and still missing: ([^\n]*?)\.\n/,
  );
  if (!m) return null;
  const stepsToSeal = m[1] === 'none' ? [] : m[1].split(', ');
  const slots = [
    ...text.matchAll(/^- ([\w-]+) \/ ([\w-]+) \(([\w-]+)\): (missing|covered by ([^\n]*))$/gm),
  ].map((x) => ({
    phase: x[1],
    id: x[2],
    requirement: x[3],
    docTypes: [x[2]],
    covered: x[5] ? x[5].split(', ') : [],
  }));
  const stale = [...new Set([...text.matchAll(/\[drift:([\w-]+)\]/g)].map((x) => x[1]))];
  const wavesLeft = text.includes('no waves of work are left') ? 0 : 1;
  return { cov: { slots, stepsToSeal }, stale, wavesLeft };
}
