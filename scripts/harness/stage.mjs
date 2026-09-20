// Stage (lab H-36; the stakes dial ported from Mycelium src/lib/applicability.ts). PURE.
//
// A NOTE ON LINEAGE, SO NOTHING HERE CLAIMS A PARENT IT DOES NOT HAVE: Mycelium has no stage and no
// lifecycle phase. Its axes are `authority` (draft | committed) and `RigorMode` (explore | mvp | prod),
// and its seal is deliberately titled "precision, not maturity". The stage ladder below is a LAB
// invention. What is ported, exactly, is the stakes dial out of applicability.ts — its levels, its
// adjustment table and the rule that a dial turn re-weights everything at once.
//
// ONE VOCABULARY, AND IT IS A RANK.
//
//   sandbox → alpha → beta → live        (+ retired, which ranks above live)
//
// What this replaces: `app.status`, which was set to "prototyping" by the template and compared in
// router.mjs against `['alpha', 'beta', 'production']`. Those are two different vocabularies, so the
// rule they served — "a brownfield app at alpha or above never routes vertical, there is a canon to
// respect" — could never fire on any app this harness has ever installed. A word that is on no ladder
// cannot be above anything. Every question a stage answers is answered here by comparing ranks.
//
// THE STAGE IS A DIAL, NOT A SWITCH. Mycelium's law, kept: a stakes level re-weights every artifact's
// commit depth *at once*, so one turn re-prioritises the whole ladder rather than editing rungs one by
// one. The lab maps stage → stakes and then applies Mycelium's own adjustment table.
//
// NOTHING HERE READS A FILE OR CALLS A MODEL. The caller passes the stage and the ladder; what a plan
// owes is arithmetic on two rank tables.

// ---------------------------------------------------------------- the ladder

export const STAGES = ['sandbox', 'alpha', 'beta', 'live', 'retired'];
export const STAGE_RANK = { sandbox: 0, alpha: 1, beta: 2, live: 3, retired: 4 };
export const DEFAULT_STAGE = 'sandbox';

// ---------------------------------------------------------------- the stakes dial (applicability.ts)

export const STAKES_RANK = { hobby: 0, internal: 1, launch: 2, regulated: 3 };

// Mycelium STAKES_DEPTH_ADJUSTMENT, unchanged: a hobby project relaxes every artifact one notch,
// launch and regulated tighten them. Applied uniformly — that uniformity is the whole point of a dial.
export const STAKES_DEPTH_ADJUSTMENT = { hobby: -1, internal: 0, launch: 1, regulated: 2 };

// Mycelium CommitDepth, unchanged. `required` and `mandatory` both block coverage today; the fourth
// rank exists so `regulated` has somewhere to push, and so a rung can sit above the one a waiver may
// reach once waivers exist (step 15 owns that). It is not a second blocking level.
export const DEPTHS = ['optional', 'recommended', 'required', 'mandatory'];
export const DEPTH_RANK = { optional: 0, recommended: 1, required: 2, mandatory: 3 };
export const BLOCKS_AT = DEPTH_RANK.required;

// ---------------------------------------------------------------- the tiers a stage blocks on
//
// Mycelium's tiers, unchanged (governance.ts PrincipleTier), ranked by descending authority.
export const TIER_ORDER = { constitutional: 0, governing: 1, advisory: 2 };

// TWO AXES, AND NEITHER IS DECORATION.
//
//   TIER decides who can clear a violation. Ported from Mycelium's override ceiling: an advisory flag
//   an agent clears, a governing one a human lead clears, a constitutional one only an amendment.
//
//   STAGE decides whether an uncleared violation stops the seal *now*.
//
// The constitutional tier is the floor at EVERY stage. That is Mycelium's one unclearable gate — "an
// open blocker BLOCKS the seal iff it traces to a constitutional-tier principle, and nothing else" —
// and the lab keeps it stage-independent on purpose: a constitution a stage can switch off is not a
// constitution, it is a preference. What the stage moves is the GOVERNING tier, which is flagged and
// carried as debt while the app is disposable and blocks once it is not. Advisory never blocks.
//
//   tier \ stage     sandbox · alpha      beta · live · retired
//   constitutional   blocks               blocks
//   governing        flag → debt          blocks
//   advisory         flag → debt          flag → debt

// ---------------------------------------------------------------- what a stage decides
//
// Every field below has a consumer. A stage that decided things nothing reads would be a table of
// opinions, and this harness does not keep those.
//
//   stakes        → the dial that re-weights the ladder (ladder.mjs coverage)
//   floorRigor    → the lowest rigor a plan may route at (router.mjs, above the assurance floor)
//   blocksAtTier  → the lowest-authority tier whose violation stops the seal (constitution.mjs)
//   ratchet       → whether a merge may lower a touched node's assurance (pipeline.mjs)
//   disposableData→ whether a rule about real records applies at all (constitution.mjs applicability)
//   verticalTrack → whether a plan may still route vertical with a canon present (router.mjs)
export const STAGE_LAW = {
  sandbox: {
    stakes: 'hobby',
    floorRigor: 'prototype',
    blocksAtTier: 'constitutional',
    ratchet: false,
    disposableData: true,
    verticalTrack: true,
  },
  alpha: {
    stakes: 'internal',
    floorRigor: 'prototype',
    blocksAtTier: 'constitutional',
    ratchet: true,
    disposableData: true,
    verticalTrack: false,
  },
  beta: {
    stakes: 'launch',
    floorRigor: 'mvp',
    blocksAtTier: 'governing',
    ratchet: true,
    disposableData: false,
    verticalTrack: false,
  },
  live: {
    stakes: 'regulated',
    floorRigor: 'production',
    blocksAtTier: 'governing',
    ratchet: true,
    disposableData: false,
    verticalTrack: false,
  },
  // Retired keeps every protection live has: the app is not being grown, but what it holds is still
  // real and what it promised is still promised.
  retired: {
    stakes: 'regulated',
    floorRigor: 'production',
    blocksAtTier: 'governing',
    ratchet: true,
    disposableData: false,
    verticalTrack: false,
  },
};

/** The declared stage, or the safe default. An unknown word is not silently treated as sandbox. */
export function stageOf(harness = {}) {
  const declared = harness.app?.stage;
  if (declared === undefined || declared === null) return { stage: DEFAULT_STAGE, declared: false };
  if (!STAGES.includes(declared))
    return {
      stage: DEFAULT_STAGE,
      declared: false,
      refusal: `stage "${declared}" is not ${STAGES.join(' | ')}`,
    };
  return { stage: declared, declared: true };
}

/** The law for a stage. Unknown stages fall to the default rather than returning undefined. */
export function lawFor(stage) {
  return STAGE_LAW[stage] || STAGE_LAW[DEFAULT_STAGE];
}

export const atLeast = (stage, floor) => (STAGE_RANK[stage] ?? 0) >= (STAGE_RANK[floor] ?? 0);

// ---------------------------------------------------------------- the dial applied

const clamp = (n) => Math.max(0, Math.min(DEPTHS.length - 1, n));

/**
 * A rung's requirement after the dial (Mycelium effectiveCommitDepth). `conditional` is not on the
 * scale — it means "required when its condition holds", which is a question about the plan and not a
 * depth — so the dial passes it through untouched rather than inventing a rank for it.
 */
export function effectiveRequirement(base, stage) {
  if (!DEPTHS.includes(base)) return base;
  const stakes = lawFor(stage).stakes;
  return DEPTHS[clamp(DEPTH_RANK[base] + STAKES_DEPTH_ADJUSTMENT[stakes])];
}

/**
 * Does a violation of a rule at this tier stop the seal at this stage? The constitutional tier
 * answers true everywhere; the governing tier answers true only once the app stopped being
 * disposable; advisory never does. A tier this harness does not know reads as constitutional, which
 * is Mycelium's own fail-safe: an unrecognised rule never silently LOSES authority.
 */
export function tierBlocks(tier, stage) {
  const rank = TIER_ORDER[tier] ?? TIER_ORDER.constitutional;
  return rank <= TIER_ORDER[lawFor(stage).blocksAtTier];
}

/** Does a rung at this requirement block the seal under this stage? */
export function blocks(base, stage) {
  const eff = effectiveRequirement(base, stage);
  return DEPTH_RANK[eff] >= BLOCKS_AT;
}

/**
 * The rigor a plan routes at: never below the stage's floor, never below the floor its touched shards
 * already hold. Two floors, and the higher one wins — a stage may raise what a plan owes, it may never
 * lower what the canon already earned.
 */
export function rigorFloor(stage, assuranceFloor = 'prototype') {
  const order = ['prototype', 'mvp', 'production'];
  const a = order.indexOf(lawFor(stage).floorRigor);
  const b = order.indexOf(assuranceFloor);
  return order[Math.max(a < 0 ? 0 : a, b < 0 ? 0 : b)];
}

/** A one-line view for a prompt, a digest or a check message. */
export function stageView(stage) {
  const l = lawFor(stage);
  return (
    `Stage ${stage} (stakes ${l.stakes}): rigor at least ${l.floorRigor}, ` +
    `a ${l.blocksAtTier} violation blocks the seal and anything below it is flagged and recorded as debt, ` +
    `the assurance ratchet is ${l.ratchet ? 'on' : 'off'}, ` +
    `data is ${l.disposableData ? 'disposable' : 'real'}.`
  );
}
