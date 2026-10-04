// J5 starts here, and not with a row (docs/14 §7, the boundary rule: "a decision the system's own records
// already settle → a predicate in code; neither model"). The Master's closed fields are outcome and
// artifacts. Most of that is settled by the ladder the Master is shown: while a rung that blocks the seal
// is missing, the plan moves to the missing blocking rungs of the earliest phase; when none is missing,
// it closes. What the ladder does NOT settle is whether a rung that does not block the seal (recommended,
// optional, conditional) is worth a wave — that is the judgement J5 hands to a row, and this module names
// it (`optional`) so the row is asked exactly there and nowhere else.
//
// cov is ladder.mjs coverage(): { slots: [{ phase, id, docTypes, covered }], stepsToSeal }.
import { LADDERS } from './ladder.mjs';

const missing = (s) => !(s.covered || []).length;

export function recordsDecision(cov, { wavesLeft = 1, stale = [], producible = null } = {}) {
  const slots = cov?.slots || [];
  // a rung blocks only where the catalogue can produce it: the door's mustProduce (conduct.mjs ladderNow)
  // drops a blocking rung no artifact fills, and lets the plan close past it
  const canMake = (s) => !producible || (s.docTypes || [s.id]).some((t) => producible.has(t));
  const blocking = new Set(
    (cov?.stepsToSeal || []).filter((id) => {
      const s = slots.find((x) => x.id === id);
      return !s || canMake(s);
    }),
  );
  const optional = slots
    .filter((s) => missing(s) && !(cov?.stepsToSeal || []).includes(s.id))
    .map((s) => ({
      id: s.id,
      requirement: s.requirement ?? null,
      docTypes: s.docTypes || [s.id],
      producible: canMake(s),
    }));
  const repair = [...new Set(stale)].sort();
  const need = slots.filter((s) => blocking.has(s.id));
  // phases are ordered in the ladder; the earliest phase with a blocking gap is the frontier
  const frontier = need
    .filter((s) => s.phase === need[0]?.phase)
    .flatMap((s) => s.docTypes || [s.id])
    .sort();
  // drift outranks growth (drift.mjs DRIFT_HEADER, "Repair these BEFORE you grow"). The door
  // (driftRefusals) accepts any move that produces at least one stale artifact, growth alongside it
  // allowed, so the records settle "repair one of these", not "repair all of them" (Ludwig 2026-10-01,
  // hlab-a s13c w4 mislabelled by the stricter rule)
  if (wavesLeft <= 0) {
    // the door refuses closing while drift or a producible blocking rung stands (drift.mjs driftRefusals,
    // gap.mjs mustProduce), whatever the wave count; only a move (ending wave-cap) or a clarify is
    // accepted then, so the records cannot say no-move there
    if (repair.length)
      return {
        outcome: 'move',
        artifacts: repair,
        anyOf: true,
        optional,
        why: 'no waves left; drift stands',
      };
    if (need.length)
      return {
        outcome: 'move',
        artifacts: frontier,
        optional,
        why: 'no waves left; a blocking rung stands',
      };
    return { outcome: 'no-move', artifacts: [], optional, why: 'no waves left' };
  }
  if (repair.length)
    return { outcome: 'move', artifacts: repair, anyOf: true, optional, why: 'drift' };
  if (need.length)
    return {
      outcome: 'move',
      artifacts: frontier,
      optional,
      why: `blocking rungs missing in ${need[0].phase}`,
    };
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
  // a drift repair agrees when it repairs at least one stale artifact, as the door accepts it
  const full =
    outcome &&
    (pred.outcome !== 'move' ||
      (pred.anyOf
        ? arts.some((a) => pred.artifacts.includes(a))
        : arts.join('+') === pred.artifacts.join('+')));
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

// Each gap status line of a ledger, resolved to the artifacts of the gap it is about. A gap id alone is
// not a key: two orchestrators on one plan reuse ids (hlab-b t5b: line 36 `G-2 closed wave 1` is the
// technical_spec gap of one run, declared at line 12, while the latest G-2 before it, line 22, is the
// other run's dev_plan+capability gap). A declaration and its linked and closed lines carry the wave of
// their own run, so the key is (id, wave); an id with no declaration at that wave falls back to its latest
// declaration. A superseded line credits nothing of its own: the gap that superseded it closed, and that
// close already credited the artifacts it covered (record.mjs supersede) — Ludwig 2026-10-02.
export function gapOutcomes(lines, upTo = lines.length) {
  const byKey = new Map(); // `${id}@${wave}` → artifacts
  const latest = new Map(); // id → artifacts of its latest declaration
  const out = [];
  lines.slice(0, upTo).forEach((l, i) => {
    const d = l?.data || {};
    if (l?.kind !== 'gap' || !d.id) return;
    if (d.status === 'declared') {
      const arts = (d.artifacts || []).map((a) => a.artifact || a);
      byKey.set(`${d.id}@${d.wave}`, arts);
      latest.set(d.id, arts);
      return;
    }
    if (d.status !== 'closed' && d.status !== 'linked') return;
    out.push({
      i,
      id: d.id,
      delivered: d.status === 'closed',
      artifacts: byKey.get(`${d.id}@${d.wave}`) || latest.get(d.id) || [],
    });
  });
  return out;
}

// What a plan's ledger says had been attempted and not delivered before a decision: each artifact's LAST
// outcome in ledger order up to the decision's own line (`upTo`, an index into lines). An artifact counts
// when its last outcome was a gap left linked (a seat abandoned or its closure failed) or a failed gate;
// a later close of the same artifact clears it. Ledger order, not wave labels: two orchestrators on one
// plan interleave their waves (hlab-b t5b; Ludwig 2026-10-01, point 3).
export function retriedBefore(lines, upTo = lines.length) {
  const last = new Map(); // artifact → delivered?, as last seen
  const events = [
    ...gapOutcomes(lines, upTo),
    ...lines
      .slice(0, upTo)
      .flatMap((l, i) =>
        l?.kind === 'decision' && l.data?.station === 'gate' && l.data.artifact && !l.data.ok
          ? [{ i, delivered: false, artifacts: [l.data.artifact] }]
          : [],
      ),
  ].sort((x, y) => x.i - y.i);
  for (const e of events) for (const a of e.artifacts) last.set(a, e.delivered);
  return [...last]
    .filter(([, ok]) => !ok)
    .map(([a]) => a)
    .sort();
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
  // the view prints a slot's id, not the doc types that fill it (ux ← ux_spec); they are read back from
  // the ladder the view names, so a slot is matched to the catalogue as the live ladder matches it. This
  // is TODAY's LADDERS table, a reconstruction the replay's header otherwise refuses: it holds only while
  // no slot's doc types have changed since the prompt was shown (true on 2026-10-02: since f9971ce
  // ladder.mjs has only added slots; ux ← ux_spec is the one slot whose doc types differ from its id). Change a slot's docTypes and this must
  // read the table at the prompt's bundle commit instead.
  const key = (text.match(/Ladder ([\w-]+)/) || [])[1];
  const defined = new Map(
    (LADDERS[key] || []).flatMap((p) => p.slots.map((s) => [`${p.phase}/${s.id}`, s.docTypes])),
  );
  const slots = [
    ...text.matchAll(/^- ([\w-]+) \/ ([\w-]+) \(([\w-]+)\): (missing|covered by ([^\n]*))$/gm),
  ].map((x) => ({
    phase: x[1],
    id: x[2],
    requirement: x[3],
    docTypes: defined.get(`${x[1]}/${x[2]}`) || [x[2]],
    covered: x[5] ? x[5].split(', ') : [],
  }));
  const stale = [...new Set([...text.matchAll(/\[drift:([\w-]+)\]/g)].map((x) => x[1]))];
  const wavesLeft = text.includes('no waves of work are left') ? 0 : 1;
  return { cov: { key: key || null, slots, stepsToSeal }, stale, wavesLeft };
}
