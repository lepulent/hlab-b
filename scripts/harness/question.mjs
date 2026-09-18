// Pure rules for one question (H-33 step 3): an agent raises it, a script writes it as a file the decider
// reads, and the Master's answer is validated against the alternatives the agent listed. No I/O here.

export const KINDS = ['decision', 'requirement', 'risk', 'ops', 'secret', 'scope', 'other'];
// the decider's floor (docs/08); an agent declares which apply, the decider alone decides what follows
export const TRIGGERS = [
  'irreversible',
  'constitutional',
  'crossDeptConflict',
  'authorityGap',
  'reserved',
  'external',
];
const MIN_WORDS = { question: 6, why: 4, reason: 4, rejection: 3 };
const words = (s) =>
  String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
const norm = (s) =>
  String(s || '')
    .trim()
    .toLowerCase();

export function validateQuestion(q) {
  const refusals = [];
  if (!q || typeof q !== 'object') return { ok: false, refusals: ['no question object'] };
  if (words(q.question) < MIN_WORDS.question)
    refusals.push(`question has fewer than ${MIN_WORDS.question} words`);
  if (words(q.why) < MIN_WORDS.why) refusals.push(`why has fewer than ${MIN_WORDS.why} words`);
  if (!KINDS.includes(q.kind)) refusals.push(`kind "${q.kind}" is not one of ${KINDS.join(', ')}`);
  const stakes = Number(q.stakes);
  if (!(stakes >= 0 && stakes <= 1)) refusals.push(`stakes ${q.stakes} is not between 0 and 1`);
  for (const t of q.triggers || [])
    if (!TRIGGERS.includes(t)) refusals.push(`trigger "${t}" is not a floor trigger`);
  const alts = (q.alternatives || []).map(norm).filter(Boolean);
  if (alts.length < 2) refusals.push('fewer than two alternatives');
  if (new Set(alts).size !== alts.length) refusals.push('alternatives repeat');
  return { ok: !refusals.length, refusals };
}

// a question file the decider reads: block lists, so an alternative may hold commas
export function renderQuestion(q, { asked_by, phase }) {
  const list = (k, xs) =>
    xs?.length ? `${k}:\n${xs.map((x) => `  - ${oneLine(x)}`).join('\n')}` : `${k}:`;
  return [
    '---',
    'status: open',
    `kind: ${q.kind}`,
    `stakes: ${Number(q.stakes)}`,
    list('triggers', q.triggers),
    list('alternatives', q.alternatives),
    `recommend: ${oneLine(q.recommend || '')}`,
    `asked_by: ${asked_by}`,
    `phase: ${phase}`,
    '---',
    '',
    `# ${oneLine(q.question)}`,
    '',
    String(q.why || '').trim(),
    '',
  ].join('\n');
}
const oneLine = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim();

// The Master answers with one of the listed alternatives and rejects every other one with a reason,
// the same shape as an activation: a decision records what else was possible.
export function validateAnswer(ans, q) {
  const refusals = [];
  if (!ans || typeof ans !== 'object') return { ok: false, refusals: ['no answer object'] };
  const alts = (q.alternatives || []).map(norm);
  const chosen = norm(ans.answer);
  if (!alts.includes(chosen)) refusals.push(`answer "${ans.answer}" is not a listed alternative`);
  if (words(ans.reason) < MIN_WORDS.reason)
    refusals.push(`reason has fewer than ${MIN_WORDS.reason} words`);
  const rejected = new Set();
  for (const r of ans.rejected || []) {
    if (words(r?.why) < MIN_WORDS.rejection)
      refusals.push(`rejection of "${r?.option}" has fewer than ${MIN_WORDS.rejection} words`);
    rejected.add(norm(r?.option));
  }
  if (rejected.has(chosen)) refusals.push(`the chosen answer is also listed as rejected`);
  for (const a of alts)
    if (a !== chosen && !rejected.has(a))
      refusals.push(`alternative "${a}" was neither chosen nor rejected`);
  return { ok: !refusals.length, refusals };
}

// what the step's questions came to: needs-input when the decider stops, answered when every question
// was allowed and answered, parked when the decider escalated without stopping, none when nothing was asked
export function questionOutcome(results) {
  if (!results.length) return 'none';
  if (results.some((r) => r.stopsRound)) return 'needs-input';
  if (results.every((r) => r.verdict === 'allow' && r.answered)) return 'answered';
  return 'parked';
}

// set frontmatter fields on a question file, replacing a scalar line or appending it to the frontmatter
export function setFields(text, fields) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return text;
  let fm = m[1];
  for (const [k, v] of Object.entries(fields)) {
    const re = new RegExp(`^${k}:.*$`, 'm');
    const line = `${k}: ${oneLine(v)}`;
    fm = re.test(fm) ? fm.replace(re, line) : `${fm}\n${line}`;
  }
  return `---\n${fm}\n---\n${text.slice(m[0].length)}`;
}
