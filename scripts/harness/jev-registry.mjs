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
const NOT_FOR = [
  'Not the answer when the option needs a paid service, an outside party or a dependency the intent does not fund: hlab-a/s5c Q-2.md rejected "digest through an office mail server at no cost" for "no digest in the first version", and hlab-b/s9 Q-2.md rejected "Add a server that holds the salt (an outside service)" for "Accept it as a deterrent only".',
  'Not the answer when the option asks for more assurance than the plan\'s rigor: hlab-b/s13d Q-3.md chose "Accept the unit-level stand-ins at prototype rigor" over widening a seat\'s OWNS to write Playwright tests, and hlab-a/s7b Q-3.md chose "Neither in the first version" over editing and deleting saves.',
  'Not the answer when the option contradicts what the agent\'s own document found: hlab-b/s13d Q-2.md chose "Intent is stale; only lock in the existing display with tests" because the spec had found the score already shown next to the lives, and hlab-a/s9 Q-1.md chose the option that gives the key names without their values, which is what the spec said it needed.',
  'Not the answer when the option accepts a loss the intent does not accept: hlab-a/s10 Q-1.md rejected "No backup routine, accept the loss risk" for a named teammate copying weekly, while hlab-b/s9 Q-2.md accepted "Accept it as a deterrent only" precisely because the intent framed the salt as a deterrent and nothing more.',
  'Not the answer when the option repeats a decision already answered on this plan that did not hold: hlab-a/s11b Q-2.md chose "Run the five commands outside the agent and record the results" after Q-1.md had already approved them, and hlab-b/s11c Q-3.md chose "Have a human run `npm run check` and paste the output into a question answer" after Q-1.md and Q-2.md had approved it twice.',
].join(' ');
const SIGNALS = [
  'the option is the smallest thing that satisfies what the intent asks for, and nothing beyond it',
  'the option follows from a finding the document states about the code or the canon as they are now',
  'the option costs nothing outside what the intent already funds, and adds no outside party',
  "the option sits at the plan's rigor: prototype takes a stand-in, production does not",
  'the option is consistent with every decision already answered on this plan',
];
const EXAMPLES = [
  'hlab-a/s7b Q-2.md "How is \'that week\' defined…" → "Calendar week starting Monday 00:00 office local time": the option that names one rule the spec can be written against.',
  'hlab-a/s8 Q-1.md "…anyone on the office network can pick any of the three names with no password…" → "Name picker only, no password": three teammates on one office laptop, so the intent does not fund a login.',
  'hlab-b/s7b Q-1.md "…UTC calendar date or the player\'s local calendar date?" → "UTC calendar date for everyone": one date for one seed, which is what the daily challenge needs.',
  'hlab-b/s8c Q-1.md "Should Firefox and WebKit Playwright projects be added…" → "Add Firefox and WebKit projects, golden spec only": the narrow option that tests the claim without carrying the whole suite.',
];

// docs/14 §5, J2. Every allowed question costs a Master answer call ($0.0367–$0.0423 mean per app), and
// the choice is among alternatives the agent already wrote — the shape `choice` was made for. In shadow
// the answerer seat runs exactly as today; this row only records what it would have said.
const questionAnswer = {
  id: 'question.answer',
  primitive: 'choice',
  version: 1,
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
      question:
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

const ROWS = [questionAnswer];

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
