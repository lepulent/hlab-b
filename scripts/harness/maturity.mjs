// Artifact maturity (Mycelium D3, ported from src/lib/bmad/maturity.ts) and closure verification (FR-23).
// Maturity is computed from facts, the highest rung that holds wins, and it never gates anything: it is
// how far a document has grown, shown to the Master and recorded. Closure is the gate: a gap closes only
// when every artifact it claimed was actually changed by its cast seat and a linked artifact matured.
// No I/O here.

export const PLANTED = 0.1; // the artifact was cast; nothing written yet
export const DRAFTED = 0.3; // every section carries a body
export const ELICITED_STEP = 0.05; // per question raised on it and answered
export const MACHINE_CAP = 0.6; // the ceiling for anything only a machine has touched
export const REVIEWED = 0.75; // a human reviewed or edited it
export const VALIDATED = 0.9; // a human-attested checklist passed
export const CONSUMED = 1; // a committed or sealed document downstream cites it

const round2 = (x) => Math.round(x * 100) / 100;

// the `##` sections of a markdown document, each with whether it has a body
export function sections(md) {
  const text = String(md || '');
  const parts = text.split(/^## /m).slice(1);
  return parts.map((p) => {
    const [title, ...body] = p.split('\n');
    return { title: title.trim(), hasBody: body.join('\n').trim().length > 0 };
  });
}

// drafted: the document exists with content, and every section it declares has a body
export function isDrafted(md) {
  if (!String(md || '').trim()) return false;
  return sections(md).every((s) => s.hasBody);
}

// the rung an artifact stands on; the human rungs and consumption win over the process ladder, and a
// machine-only artifact never climbs past the cap
export function artifactMaturity({
  cast = false,
  text = null,
  elicited = 0,
  reviewed = false,
  validated = false,
  consumed = false,
  code = false,
  files = 0,
  checked = false,
}) {
  if (code) {
    if (consumed) return { value: CONSUMED, rung: 'consumed' };
    if (!files) return cast ? { value: PLANTED, rung: 'planted' } : { value: 0, rung: 'absent' };
    // the gate is run by a machine, so it buys the ceiling and never a human rung
    return checked ? { value: MACHINE_CAP, rung: 'checked' } : { value: DRAFTED, rung: 'drafted' };
  }
  if (consumed) return { value: CONSUMED, rung: 'consumed' };
  if (validated) return { value: VALIDATED, rung: 'validated' };
  if (reviewed) return { value: REVIEWED, rung: 'reviewed' };
  if (text != null && isDrafted(text)) {
    const value = round2(Math.min(DRAFTED + elicited * ELICITED_STEP, MACHINE_CAP));
    return { value, rung: elicited ? 'elicited' : 'drafted' };
  }
  if (cast || text != null) return { value: PLANTED, rung: 'planted' };
  return { value: 0, rung: 'absent' };
}

// Mycelium's container rollup: a weighted mean of its members by tier (contract 1, record 0.75,
// grounding 0.5); display only, it never gates
export const TIER_WEIGHT = { contract: 1, record: 0.75, grounding: 0.5 };
export function rollup(members) {
  const w = members.reduce((s, m) => s + (TIER_WEIGHT[m.tier] ?? 1), 0);
  if (!w) return 0;
  return round2(members.reduce((s, m) => s + m.value * (TIER_WEIGHT[m.tier] ?? 1), 0) / w);
}

// FR-23: closure is refused when a claimed artifact shows no mutation by the seat cast for it, or when
// no linked artifact matured over the wave. A gap that only rewrites artifacts which already existed is a
// reconciliation, not growth: it must show the change, and its maturity is recorded but not required to
// rise until drift (FR-33, 34) gives a repair its own proof.
export function verifyClosure({ claimed, mutationsBySeat, before, after, existed = [] }) {
  const refusals = [];
  for (const c of claimed)
    if (!(mutationsBySeat[c.agent] || []).some((m) => m.target === c.path))
      refusals.push(`${c.artifact} (${c.path}) shows no change by ${c.agent}`);
  const matured = claimed.filter((c) => (after[c.artifact] ?? 0) > (before[c.artifact] ?? 0));
  const reconciliation = claimed.every((c) => existed.includes(c.artifact));
  if (!matured.length && !reconciliation) refusals.push('no linked artifact matured over the wave');
  return {
    ok: !refusals.length,
    refusals,
    matured: matured.map((c) => c.artifact),
    reconciliation,
  };
}

// answered questions count as elicitation only once the document was rewritten after the answer: an
// answer the document has not taken in has not grown it
export function elicitedCount(questions, lastWrittenWave) {
  return questions.filter((q) => q.answered && lastWrittenWave > q.wave).length;
}
