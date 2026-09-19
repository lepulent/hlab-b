// Pure rules for a gap-first decision (H-35, Mycelium FR-1..11): the Master declares what is absent and
// which artifacts would close it; it never names an agent. The door refuses what the catalogue cannot
// produce and what carries no substance; a script casts each artifact to the agent that produces it.
// No I/O here: whether a cited id exists is asked through the `exists` function the caller passes.

const MIN_WORDS = {
  statement: 8,
  premise: 4,
  block: 2,
  task: 4,
  reason: 4,
  rejection: 3,
  wave: 4,
  question: 6,
};
const words = (s) =>
  String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
const norm = (s) =>
  String(s || '')
    .trim()
    .toLowerCase();

export const OUTCOMES = ['move', 'no-move', 'clarify'];

export function doctypeIds(catalogue) {
  return (catalogue?.doctypes || []).map((d) => d.id);
}

// the closed set a rejection or an also-available names: every artifact the catalogue can produce, and
// doing nothing
export function gapOptions(catalogue) {
  return [...doctypeIds(catalogue), 'no-move'];
}

// mustProduce: the artifacts the plan's ladder still requires before its seal that the catalogue can
// produce (ladder.mjs); a no-move while any remains is a premature close
export function validateGap(
  dec,
  catalogue,
  { maxWave = 1, exists = () => true, mustProduce = [] } = {},
) {
  const refusals = [];
  if (!dec || typeof dec !== 'object') return { ok: false, refusals: ['no decision object'] };
  const types = new Map((catalogue?.doctypes || []).map((d) => [d.id, d]));
  if (!OUTCOMES.includes(dec.outcome))
    refusals.push(`outcome "${dec.outcome}" is not move, no-move or clarify`);
  if (words(dec.reason) < MIN_WORDS.reason)
    refusals.push(`reason has fewer than ${MIN_WORDS.reason} words`);
  const gap = dec.gap || {};
  const chosen = (gap.artifacts || []).map((a) => a?.artifact);

  if (dec.outcome === 'move') {
    if (words(gap.statement) < MIN_WORDS.statement)
      refusals.push(`gap statement has fewer than ${MIN_WORDS.statement} words`);
    const premises = gap.premises || [];
    if (!premises.length) refusals.push('a gap needs at least one premise');
    for (const [i, p] of premises.entries()) {
      if (words(p?.text) < MIN_WORDS.premise)
        refusals.push(`premise ${i + 1} has fewer than ${MIN_WORDS.premise} words`);
      if (!(p?.cites || []).length) refusals.push(`premise ${i + 1} cites nothing`);
      for (const id of p?.cites || [])
        if (!exists(id)) refusals.push(`premise ${i + 1} cites "${id}", which does not exist`);
    }
    if (!(gap.blocks || []).length) refusals.push('a gap must say what it blocks');
    for (const b of gap.blocks || [])
      if (words(b) < MIN_WORDS.block) refusals.push(`"${b}" does not say what is blocked`);
    if (!chosen.length) refusals.push('a move names no artifact');
    const seen = new Set();
    for (const a of gap.artifacts || []) {
      // FR-8: the catalogue is the only source of what can be produced
      if (!types.has(a?.artifact)) refusals.push(`the catalogue cannot produce "${a?.artifact}"`);
      if (seen.has(a?.artifact)) refusals.push(`artifact "${a?.artifact}" is named twice`);
      seen.add(a?.artifact);
      if (words(a?.task) < MIN_WORDS.task)
        refusals.push(`task for "${a?.artifact}" has fewer than ${MIN_WORDS.task} words`);
    }
    const agents = new Set(chosen.map((id) => types.get(id)?.produced_by).filter(Boolean));
    if (agents.size > maxWave)
      refusals.push(`the gap needs ${agents.size} agents at once; the limit is ${maxWave}`);
    if (types.size > 1 && words(dec.wave_reason) < MIN_WORDS.wave)
      refusals.push(`wave_reason has fewer than ${MIN_WORDS.wave} words`);
  } else if (chosen.length) refusals.push(`${dec.outcome} names artifacts to produce`);
  if (dec.outcome === 'no-move' && mustProduce.length)
    refusals.push(`the ladder still requires ${mustProduce.join(', ')} before the seal`);

  if (dec.outcome === 'clarify') {
    if (words(dec.clarify?.question) < MIN_WORDS.question)
      refusals.push(`clarifying question has fewer than ${MIN_WORDS.question} words`);
    const alts = (dec.clarify?.alternatives || []).map(norm).filter(Boolean);
    if (alts.length < 2 || new Set(alts).size !== alts.length)
      refusals.push('a clarifying question needs two distinct alternatives');
  }

  // what else was possible: every artifact not chosen is rejected with a reason or kept for later,
  // never both chosen and set aside
  if (dec.outcome !== 'clarify') {
    const options = gapOptions(catalogue);
    const rejected = new Set();
    for (const r of gap.rejected || []) {
      if (!options.includes(r?.artifact))
        refusals.push(`rejected option "${r?.artifact}" is not an artifact or no-move`);
      if (words(r?.why) < MIN_WORDS.rejection)
        refusals.push(`rejection of "${r?.artifact}" has fewer than ${MIN_WORDS.rejection} words`);
      rejected.add(r?.artifact);
    }
    const later = new Set(gap.also_available || []);
    for (const id of later)
      if (!types.has(id)) refusals.push(`also-available "${id}" is not an artifact`);
    for (const id of chosen)
      if (rejected.has(id) || later.has(id))
        refusals.push(`artifact "${id}" is both chosen and set aside`);
    for (const id of types.keys())
      if (!chosen.includes(id) && !rejected.has(id) && !later.has(id))
        refusals.push(`artifact "${id}" was neither chosen, rejected nor kept for later`);
  }
  return { ok: !refusals.length, refusals };
}

// artifact → workflow → agent: every artifact the agent produces goes into one session, which owns
// exactly those artifacts' paths
export function castGap(dec, catalogue, plan) {
  const types = new Map((catalogue?.doctypes || []).map((d) => [d.id, d]));
  const byAgent = new Map();
  for (const a of dec?.gap?.artifacts || []) {
    const d = types.get(a.artifact);
    if (!d) continue;
    const cast = byAgent.get(d.produced_by) || {
      agent: d.produced_by,
      artifacts: [],
      workflows: [],
      owned: [],
      tasks: [],
    };
    cast.artifacts.push(d.id);
    cast.workflows.push(d.workflow);
    cast.owned.push(d.path.replaceAll('{plan}', plan));
    cast.tasks.push(`${d.title} (${d.path.replaceAll('{plan}', plan)}): ${a.task}`);
    byAgent.set(d.produced_by, cast);
  }
  return [...byAgent.values()];
}

// the paths an agent owns are the catalogue paths of the artifacts it produces
export function ownedBy(agentId, catalogue, plan) {
  return (catalogue?.doctypes || [])
    .filter((d) => d.produced_by === agentId)
    .map((d) => d.path.replaceAll('{plan}', plan));
}

// what a decision chose, in one comparable word: no-move, clarify, or the artifacts sorted and joined
export function gapKey(dec) {
  if (dec?.outcome !== 'move') return dec?.outcome || 'none';
  return (dec.gap?.artifacts || [])
    .map((a) => a?.artifact)
    .sort()
    .join('+');
}

// the overwrite warning (13.5): an artifact whose document already exists is rewritten, which is allowed
// and recorded, never blocked
export function overwrites(casts, existing) {
  return casts.flatMap((c) => c.owned.filter((p) => existing.includes(p)));
}
