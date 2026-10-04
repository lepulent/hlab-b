// Step 15 (FR-24, D-4, D-6; docs/17-step15-authority.md): every act the harness takes on the Master's
// behalf is ruled, with a stated reason, by action class × rung — Mycelium's masterMay
// (src/lib/master-policy.ts), ported whole. PURE: no I/O, no clock; the grants in force are passed in.
//
// The lab runs with floor ["cost"] (H-34: the only human floor is real cost), so an act with no real cost
// is allowed and the table's consent and grow columns never stop the Master. An app that sets no floor
// gets Mycelium's full table. The floor a ruling was made under is part of the ruling, so "configured
// off" is a recorded fact (Ludwig 2026-10-02, fix 7).

export const RUNGS = ['lookup', 'reason', 'run', 'grow', 'convene', 'hire', 'signoff', 'amend'];

// The acts the harness takes, each with its class, its rung and whether it spends real (billed) money.
// Seat and lens spend on the CLI login is a list-price equivalent, not billed: it is bounded by the plan
// budget (H-34's "budget exceeded" clause), never by a spend grant (fix 4). In the lab today the one
// billed act is a JEV call (the Typesafe API key).
export const ACTS = {
  'master.decide': { actionClass: 'fact', rung: 'reason', cost: false },
  'question.answer': { actionClass: 'consent', rung: 'reason', cost: false },
  'seat.cast': { actionClass: 'fact', rung: 'run', cost: false },
  'node.grow': { actionClass: 'consent', rung: 'grow', cost: false },
  'jev.call': { actionClass: 'fact', rung: 'run', cost: true },
  // the lenses and the PR run on the CLI login with the allowlisted environment (common.mjs modelEnv):
  // no billed credential reaches them, so delivery is not real cost (82faaab)
  'review.lens': { actionClass: 'fact', rung: 'run', cost: false },
  'deliver.open': { actionClass: 'consent', rung: 'run', cost: false },
  'merge.main': { actionClass: 'consent', rung: 'run', cost: false },
  'agent.hire': { actionClass: 'consent', rung: 'hire', cost: false },
  'department.signoff': { actionClass: 'consent', rung: 'signoff', cost: false },
  'constitution.amend': { actionClass: 'consent', rung: 'amend', cost: false },
};

export const LAB_FLOOR = ['cost'];

const ruling = (verdict, reason, extra = {}) => ({ verdict, reason, ...extra });

// a spend grant covers an act when it names it, or names no act at all
const covers = (g, act) => g.kind === 'spend' && (!g.acts?.length || g.acts.includes(act));

// rule({ act, floor, grants, mode, critical }) → { verdict, reason, floor, act, grant? }
// verdict: allow | propose (a human accepts it) | escalate (stop for the owner) | deny (structural)
export function rule({ act, floor = null, grants = [], mode = 'full', critical = false } = {}) {
  const a = ACTS[act];
  const base = { floor: floor ? [...floor] : null, act };
  if (!a)
    return ruling('deny', `"${act}" is not an act the harness knows; it is refused unruled`, base);
  const { actionClass, rung } = a;

  // structural refusals: no floor, mode or grant lifts these (D-6)
  if (rung === 'signoff')
    return ruling('deny', 'Department sign-off is a human act. No grant delegates it.', base);
  if (rung === 'amend')
    return ruling('deny', 'The constitution may not be amended by a machine, in any mode.', base);
  // hiring creates jurisdiction the Master lacked: proposed in every column
  if (rung === 'hire')
    return ruling(
      'propose',
      'Hiring creates jurisdiction the Master lacked, so it is proposed for a human, never taken.',
      base,
    );

  // real cost needs a live spend grant under any floor (H-34's one floor; D-4 for the rest)
  if (a.cost) {
    const g = grants.find((x) => covers(x, act));
    return g
      ? ruling('allow', `${act} spends real money; spend grant ${g.id} covers it.`, {
          ...base,
          grant: g.id,
        })
      : ruling(
          'escalate',
          `${act} spends real money and no live spend grant covers it: the owner issues one (npm run harness:grant).`,
          base,
        );
  }

  // the lab floor: nothing else is a human floor, so nothing else stops the Master
  if (floor && floor.length === 1 && floor[0] === 'cost')
    return ruling(
      'allow',
      `Allowed: ${actionClass}-class ${rung} has no real cost (floor cost).`,
      base,
    );

  // Mycelium's full table, for an app that sets no floor
  const has = (k) => grants.some((x) => x.kind === k);
  if (mode === 'manual')
    return rung === 'lookup' || rung === 'reason'
      ? ruling('propose', 'Mode is `manual`: the Master may suggest, not act.', base)
      : ruling('escalate', "Mode is `manual`: every action is the human's to take.", base);
  if (actionClass === 'consent' && !has('consent'))
    return ruling(
      'escalate',
      'This act commits what a human would have committed. That is consent-class and needs a scoped grant.',
      base,
    );
  if (rung === 'grow' && !has('grow'))
    return ruling(
      'propose',
      'Creating a node changes the shape of the plan. Without a `grow` grant it is proposed, not taken.',
      base,
    );
  if (mode === 'critical-only' && critical && rung !== 'lookup' && rung !== 'reason')
    return ruling(
      'escalate',
      'Mode is `critical-only` and this node is on the critical path.',
      base,
    );
  return ruling('allow', `Allowed: ${actionClass}-class ${rung} under \`${mode}\`.`, base);
}
