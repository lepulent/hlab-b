// The JEV registry (docs/14 §2): every judgment the harness makes by prose or by a stand-in rule becomes
// a row here — id, primitive, criteria, state builder, combine, thresholds, evidence, mode. A row is data
// and two pure functions; it never calls the API and never writes. `jev.mjs` runs it, the caller records
// it. Criteria are the harness's wording: no seat sees them and no seat writes them (rule 5).
//
// A row that does not hold its shape is refused at load, loudly. A malformed row that loaded quietly
// would shadow a decision with nothing behind it, and the first anyone would know is a threshold set from
// numbers that were never measured.
import { fitState, spread, STATE_CAP } from './jev.mjs';

export const PRIMITIVES = ['noul', 'choice', 'score'];
export const MODES = ['shadow', 'act'];
export const FIELDS = [
  'id',
  'primitive',
  'version',
  'criteria',
  'state',
  'combine',
  'thresholds',
  'evidence',
  'mode',
];

export function validateRow(row) {
  const refusals = [];
  if (!row || typeof row !== 'object') return ['not an object'];
  for (const f of FIELDS) if (row[f] === undefined) refusals.push(`${f} is missing`);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(String(row.id || '')))
    refusals.push(`id "${row.id}" is not <area>.<decision>[.<atom>] in lower case`);
  if (!PRIMITIVES.includes(row.primitive))
    refusals.push(`primitive "${row.primitive}" is not one of ${PRIMITIVES.join(', ')}`);
  if (!Number.isInteger(row.version) || row.version < 1)
    refusals.push(`version ${row.version} is not a whole number from 1`);
  if (!MODES.includes(row.mode))
    refusals.push(`mode "${row.mode}" is not one of ${MODES.join(', ')}`);
  if (typeof row.state !== 'function') refusals.push('state is not a function of the context');
  if (typeof row.combine !== 'function') refusals.push('combine is not a function of the vectors');
  if (!row.criteria || !['object', 'function'].includes(typeof row.criteria))
    refusals.push('criteria is neither an option map nor a function of the context');
  if (typeof row.evidence !== 'string' || !row.evidence.trim())
    refusals.push('evidence does not cite the run the row was tested on');
  const t = row.thresholds;
  if (!t || typeof t !== 'object' || !('act' in t) || !('confirm' in t))
    refusals.push('thresholds does not carry both act and confirm (null for shadow)');
  else if (row.mode === 'act' && (t.act == null || t.confirm == null))
    refusals.push(
      'mode "act" with a null threshold: a row cannot act on a band it has not measured',
    );
  else if (t.act != null && t.confirm != null && t.confirm > t.act)
    refusals.push(`confirm ${t.confirm} is above act ${t.act}`);
  // A NEVER-EXERCISED FALLBACK ROTS (Atlassinator lesson 14, their best mechanism). The moment a row has
  // a band it can act on, the path it acts INSTEAD of has to be run on the same case by a named test, so
  // the two can be compared and the fallback cannot quietly stop working while the row carries the load.
  // Shadow rows owe nothing here: nothing is being replaced yet.
  const banded = row.mode === 'act' || (t && t.act != null);
  if (banded && (typeof row.pairTest !== 'string' || !row.pairTest.trim()))
    refusals.push(
      'a banded row must name a pairTest: the file that runs this row and its fallback on the same case',
    );
  return refusals;
}

// ------------------------------------------------------------------------------------ the rows

// An option id per alternative, by position. The alternatives are the agent's own words and differ in
// every question, so the option the API rules on is a slot and the row reads the answer back through it.
export const optId = (i) => `opt${i + 1}`;
export function optIndex(id) {
  const m = /^opt(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) - 1 : null;
}

// The guards the row owns (docs/14 §5, J2: "the agent's own alternative text plus the row's not_for
// guards"). They are doctrine, read off what the Master actually did across 38 answered questions on both
// apps, and they are the same on every option because the options are not the same twice: a question's
// alternatives are written fresh by the asking agent, so nothing option-specific can be written down in
// advance. What discriminates is which alternative the guards fit — see docs/14 §2 rule 4, which assumes
// an option set the registry knows ahead of time and does not yet say what a dynamic-option row owes.
// v2 (2026-10-05). v1 quoted answered questions from the corpus the row is scored on, with their
// answers: the labels were in the criteria (T5 review). A first v2 removed the ids but kept the same cases
// reworded (Ludwig 2026-10-05), which is the same leak. So the guards are bare principles and the
// examples come from a domain neither app has (a ferry timetable, a bakery's orders, a weather station),
// and v2 is scored ONLY on questions asked after SCORED_FROM: a split in time, not a promise in prose.
export const QUESTION_ANSWER_V2_SCORED_FROM = '2026-10-05T13:00:00Z';
const NOT_FOR = [
  'Not the answer when the option needs a paid service, an outside party or a dependency the intent does not fund.',
  "Not the answer when the option asks for more assurance than the plan's rigor calls for.",
  "Not the answer when the option contradicts what the agent's own document found about the code or the canon as they are now.",
  'Not the answer when the option accepts a loss or a risk the intent does not accept, unless the intent itself frames that risk as acceptable.',
  'Not the answer when the option repeats or reverses a decision already answered on this plan without new evidence.',
].join(' ');
const SIGNALS = [
  'the option is the smallest thing that satisfies what the intent asks for, and nothing beyond it',
  'the option follows from a finding the document states about the code or the canon as they are now',
  'the option costs nothing outside what the intent already funds, and adds no outside party',
  "the option sits at the plan's rigor: prototype takes a stand-in, production does not",
  'the option is consistent with every decision already answered on this plan',
];
const EXAMPLES = [
  'A ferry timetable asks whether a "morning sailing" means before noon or before 10:00; the answer is the option that names one cut-off the timetable can be checked against.',
  "A bakery's order form asks whether to take card payments online; for an intent that only asks to list today's orders for pickup, the answer is the option with no payment provider.",
  'A weather station asks which clock its daily summary uses; the answer is the option that gives every reader the same day, when the summary is shared between them.',
  'A weather station asks whether to validate every sensor model; the answer is the narrow option that checks the one sensor the intent names.',
];

// docs/14 §5, J2. Every allowed question costs a Master answer call ($0.0367–$0.0423 mean per app), and
// the choice is among alternatives the agent already wrote — the shape `choice` was made for. In shadow
// the answerer seat runs exactly as today; this row only records what it would have said.
const questionAnswer = {
  id: 'question.answer',
  primitive: 'choice',
  version: 2,
  mode: 'shadow',
  // set from shadow data on both apps, never from the vendor's bands (docs/14 §2, §6)
  thresholds: { act: null, confirm: null },
  evidence:
    'runs/: 38 answered questions across both apps (20 hlab-a, 18 hlab-b), every one of them with 3 or 4 alternatives and a recorded answer that is exactly one of them; baseline in runs/jev-shadow.md',
  // The smallest slice that decides this atom (rule 3): what was asked, why it was asked, the document it
  // was asked about, and what this plan has already settled. Not the ladder, not the catalogue, not the
  // maturity view, not the digest — a question about one document is not decided by the plan's shape.
  // The agent's `recommend` is left out on purpose: the answerer's own prompt calls it advice and not a
  // default, and a row that reads it would be shadowing the agent's preference, not the decision.
  state: (ctx) =>
    fitState(
      {
        intent: String(ctx.intent || '').trim(),
        question: String(ctx.question || '').trim(),
        why: String(ctx.why || '').trim(),
        document: String(ctx.document || '').trim(),
        decided: (ctx.decided || [])
          .map((d) => `${d.file}: ${d.question} → ${d.answer}`)
          .join('\n'),
      },
      STATE_CAP,
      ['question', 'why'],
    ),
  criteria: (ctx) => ({
    answer: {
      // `instructions` is the field the API reads. Under any other name it is DROPPED IN SILENCE and the
      // criteria carry the whole decision alone (docs/15 §2.1) — which is what v1 of this row did.
      instructions:
        'Which one of these alternatives should be the answer to the question in the state, on the evidence of the intent, the document and the decisions already answered?',
      criteria: Object.fromEntries(
        (ctx.alternatives || []).map((alt, i) => [
          optId(i),
          { what: String(alt).trim(), not_for: NOT_FOR, examples: EXAMPLES, signals: SIGNALS },
        ]),
      ),
    },
  }),
  // The ruling is the alternative at the ruled slot, so it is one of the listed alternatives by
  // construction — the same thing question.mjs validateAnswer holds the Master to. Counting and the
  // close-call comparison are here, in code, never in the question (rule 2).
  combine: (read, ctx) => {
    const a = read.answer || {};
    const alts = ctx.alternatives || [];
    const i = optIndex(a.pick);
    const s = spread(a.vector);
    const t = questionAnswer.thresholds;
    const confidence = a.confidence ?? null;
    const band =
      t.act == null || confidence == null
        ? 'shadow'
        : confidence >= t.act
          ? 'act'
          : t.confirm != null && confidence >= t.confirm
            ? 'confirm'
            : 'floor';
    return {
      answer: i != null && alts[i] != null ? alts[i] : null,
      option: a.pick ?? null,
      probabilities: a.vector || {},
      confidence,
      top: s.top,
      second: s.second,
      closeCall: s.closeCall,
      band,
      // at shadow nothing acts, whatever the numbers say (docs/14 §0.3)
      acts: band === 'act' && questionAnswer.mode === 'act',
    };
  },
};

// docs/14 §5 J5, §9. The one atom of the Master's decision the records do not settle (master-predicate.mjs):
// whether a rung that does not block the seal — recommended, optional, conditional — is worth a wave. The
// ladder answers every blocking rung by itself; this row is asked only for the others, one call per rung.
// Why a predicate cannot answer it: the ladder says the rung MAY be written, not whether THIS intent needs
// it; that turns on what the intent asks and what the plan's other documents already settle, which is
// reading, not counting. The free baseline it must beat is "never": over 211 such cases on both apps the
// Master spent a wave on 22, so never is right 0.896 (runs/hlab-*/master-replay.json).
// The criteria state the rule and quote no case: the corpus is the test set (T5 review, the label leak).
const gapArtifactNeeded = {
  id: 'gap.artifact.needed',
  primitive: 'noul',
  version: 1,
  mode: 'shadow',
  thresholds: { act: null, confirm: null },
  // REPLAYED AND FAILED, both apps (2026-09-29): hlab-a (tune half) agreed 49/113 against "never"
  // 100/113, AUC 0.68; hlab-b (held out, untouched) 24/98 against 89/98, AUC 0.58. Its probabilities sit
  // in 0.3–0.7 and it rates ux and brief above 0.5 though the Master built neither once. Kept so the
  // result can be rerun; not wired into conduct, and not to be until a version beats "never" on hlab-b.
  evidence:
    'runs/hlab-*/master-replay.json (211 cases, 22 given a wave); runs/hlab-*/master-replay-gap.artifact.needed.json (v1 replayed live: loses to "never" on both apps)',
  // the rung, the intent it would serve, and what the plan already has and still owes — not the digest,
  // not maturity, not the catalogue's other entries
  state: (ctx) =>
    fitState(
      {
        rung: `${ctx.rung?.title || ctx.rung?.id} (${ctx.rung?.requirement || 'not required'}): ${ctx.rung?.purpose || ''}`.trim(),
        rigor: String(ctx.rigor || ''),
        intent: String(ctx.intent || '').trim(),
        has: (ctx.has || []).join(', ') || 'nothing yet',
        still_owes: (ctx.owes || []).join(', ') || 'nothing',
      },
      STATE_CAP,
      ['rung', 'rigor', 'has', 'still_owes'],
    ),
  criteria: () => ({
    needed: {
      instructions:
        "Does this plan need the rung described in the state, in addition to what it has and still owes, to deliver what its intent asks at the plan's rigor?",
      criteria: {
        true: 'the intent asks for something this rung exists to settle, and nothing the plan has or still owes settles it; leaving it out would leave that part of the intent undecided',
        false:
          "what the intent asks is settled by what the plan has or still owes, so this rung would restate it; or the plan's rigor does not call for this rung",
      },
    },
  }),
  combine: (read) => {
    const a = read.needed || {};
    const p = a.vector?.true ?? null;
    return {
      answer: p == null ? null : p >= 0.5,
      option: a.pick ?? null,
      probabilities: a.vector || {},
      confidence: a.confidence ?? null,
      closeCall: !!a.closeCall,
      band: 'shadow',
      acts: false,
    };
  },
};

const ROWS = [questionAnswer, gapArtifactNeeded];

// loaded, not called: a bad row stops the module that imports it, at the import
const bad = ROWS.flatMap((r) => validateRow(r).map((x) => `${r?.id ?? '(no id)'}: ${x}`));
if (bad.length)
  throw new Error(`jev-registry: ${bad.length} refused row(s):\n- ${bad.join('\n- ')}`);

export const rows = new Map(ROWS.map((r) => [r.id, r]));
export function getRow(id) {
  const r = rows.get(id);
  if (!r)
    throw new Error(
      `jev-registry: no row "${id}"; rows are ${[...rows.keys()].join(', ') || '(none)'}`,
    );
  return r;
}
export const rowIds = () => [...rows.keys()];
