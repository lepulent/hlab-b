// Rigor ladders (Mycelium 13.2, 13.3; ported from src/lib/bmad/paths.ts): which artifacts a plan owes
// before its seal, selected by rigor × intent kind. Pure data and pure functions, so coverage is a
// lookup, never a model's word. Lab rigor words map to Mycelium's (H-2, H-36): prototype → explore,
// mvp → mvp, production → prod. Only the rungs up to the seal are ported; implementation is after it.

export const TRACK_FOR_RIGOR = { prototype: 'quick-flow', mvp: 'method', production: 'enterprise' };
// the safe default is the one that asks for more (paths.ts DEFAULT_LADDER)
export const DEFAULT_LADDER = 'method-greenfield';

const slot = (id, requirement, docTypes = [id]) => ({ id, requirement, docTypes });
// the Mycelium seal apex every track owes: a plan cannot seal without a dev plan
const sealApex = () => [slot('dev_plan', 'required'), slot('stories', 'recommended')];
// after the seal: the code the plan specified. Mycelium's implementation phase carries sprint_status;
// here it carries the implementation itself, which is what the lab has to show.
const implementation = () => ({
  phase: 'implementation',
  gate: 'warn',
  slots: [slot('implementation', 'required')],
});

export const LADDERS = {
  'quick-flow-greenfield': [
    { phase: 'planning', gate: 'block', slots: [slot('technical_spec', 'required')] },
    { phase: 'solutioning', gate: 'seal', slots: sealApex() },
    implementation(),
  ],
  'quick-flow-brownfield': [
    { phase: 'planning', gate: 'block', slots: [slot('technical_spec', 'required')] },
    { phase: 'solutioning', gate: 'seal', slots: sealApex() },
    implementation(),
  ],
  'method-greenfield': [
    { phase: 'discovery', gate: 'warn', slots: [slot('brief', 'recommended')] },
    {
      phase: 'planning',
      gate: 'block',
      slots: [slot('prd', 'required'), slot('ux', 'conditional', ['ux_spec'])],
    },
    {
      phase: 'solutioning',
      gate: 'seal',
      slots: [slot('architecture', 'required'), ...sealApex()],
    },
    implementation(),
  ],
  'method-brownfield': [
    { phase: 'discovery', gate: 'warn', slots: [slot('brief', 'optional')] },
    {
      phase: 'planning',
      gate: 'block',
      slots: [slot('prd', 'required'), slot('ux', 'conditional', ['ux_spec'])],
    },
    {
      phase: 'solutioning',
      gate: 'seal',
      slots: [slot('architecture', 'recommended'), ...sealApex()],
    },
    implementation(),
  ],
  'enterprise-greenfield': [
    { phase: 'discovery', gate: 'block', slots: [slot('brief', 'recommended')] },
    {
      phase: 'planning',
      gate: 'block',
      slots: [slot('prd', 'required'), slot('ux', 'recommended', ['ux_spec'])],
    },
    {
      phase: 'solutioning',
      gate: 'seal',
      slots: [
        slot('architecture', 'required'),
        slot('security_plan', 'optional'),
        slot('infrastructure_spec', 'optional'),
        ...sealApex(),
      ],
    },
    implementation(),
  ],
  'enterprise-brownfield': [
    { phase: 'discovery', gate: 'block', slots: [slot('brief', 'optional')] },
    {
      phase: 'planning',
      gate: 'block',
      slots: [slot('prd', 'required'), slot('ux', 'recommended', ['ux_spec'])],
    },
    {
      phase: 'solutioning',
      gate: 'seal',
      slots: [
        slot('architecture', 'required'),
        slot('security_plan', 'optional'),
        slot('infrastructure_spec', 'optional'),
        ...sealApex(),
      ],
    },
    implementation(),
  ],
};

// both axes or the default: a plan that declares only one of them is measured against the fuller ladder
export function ladderKey(rigor, intentKind) {
  const track = TRACK_FOR_RIGOR[rigor];
  if (!track || !['greenfield', 'brownfield'].includes(intentKind)) return DEFAULT_LADDER;
  return `${track}-${intentKind}`;
}

// an app's first plan is greenfield; a plan into an app that already landed one is brownfield
// (Mycelium intake-classify deriveIntentKind)
export function intentKindFor({ landedPlans = 0 } = {}) {
  return landedPlans > 0 ? 'brownfield' : 'greenfield';
}

// coverage of a ladder by the doc types that exist; stepsToSeal lists the required slots still missing,
// in ladder order, which is the order that unblocks the most
export function coverage(key, present, { code = true } = {}) {
  const has = new Set(present);
  const slots = (LADDERS[key] || LADDERS[DEFAULT_LADDER])
    .filter((p) => code || p.phase !== 'implementation')
    .flatMap((p) =>
      p.slots.map((s) => ({
        phase: p.phase,
        id: s.id,
        requirement: s.requirement,
        docTypes: s.docTypes,
        covered: s.docTypes.filter((t) => has.has(t)),
      })),
    );
  const stepsToSeal = slots
    .filter((s) => s.requirement === 'required' && !s.covered.length)
    .map((s) => s.id);
  return { key, slots, stepsToSeal, covered: !stepsToSeal.length };
}

// a one-line-per-slot view for a prompt or a digest
export function coverageView(cov) {
  return [
    `Ladder ${cov.key}. Required before the seal and still missing: ${cov.stepsToSeal.join(', ') || 'none'}.`,
    ...cov.slots.map(
      (s) =>
        `- ${s.phase} / ${s.id} (${s.requirement}): ${s.covered.length ? `covered by ${s.covered.join(', ')}` : 'missing'}`,
    ),
  ].join('\n');
}
