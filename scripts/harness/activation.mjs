// Pure rules for one conducted activation (H-32, H-33 step 1): the Master's decision is validated,
// an agent's jurisdiction is resolved and checked, and transcripts are read for tool use. No I/O here,
// so every rule is a unit test.

const MIN_WORDS = { task: 4, reason: 4, rejection: 3 };
const words = (s) =>
  String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

// {plan} in a roster path is the plan slug; nothing else is interpolated
export function resolveOwns(owns, plan) {
  return (owns || []).map((p) => p.replaceAll('{plan}', plan));
}

export function rosterById(roster) {
  return new Map((roster?.agents || []).map((a) => [a.id, a]));
}

// The Master's output is accepted only when it names a roster agent and says why in words that carry
// something; a well-formed but empty decision is refused, never recorded as if it were one.
export function validateActivation(act, roster) {
  const refusals = [];
  const agents = rosterById(roster);
  if (!act || typeof act !== 'object') return { ok: false, refusals: ['no decision object'] };
  if (!['activate', 'no-move'].includes(act.decision))
    refusals.push(`decision "${act.decision}" is not activate or no-move`);
  if (act.decision === 'activate') {
    if (!agents.has(act.agent)) refusals.push(`agent "${act.agent}" is not in the roster`);
    if (words(act.task) < MIN_WORDS.task)
      refusals.push(`task has fewer than ${MIN_WORDS.task} words`);
  }
  if (words(act.reason) < MIN_WORDS.reason)
    refusals.push(`reason has fewer than ${MIN_WORDS.reason} words`);
  for (const r of act.rejected || [])
    if (words(r?.why) < MIN_WORDS.rejection)
      refusals.push(`rejection of "${r?.option}" has fewer than ${MIN_WORDS.rejection} words`);
  return { ok: !refusals.length, refusals };
}

// paths from `git status --porcelain --untracked-files=all`, relative to the repo root
export function parsePorcelain(text) {
  return String(text || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p));
}

export function outsideJurisdiction(changed, owned) {
  const own = new Set(owned);
  return changed.filter((p) => !own.has(p));
}

// Claude Code keeps a session's transcript under ~/.claude/projects/<cwd with every non-alphanumeric
// character replaced by "-">/<session id>.jsonl
export function transcriptDir(home, cwd) {
  return `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

// tool name → count, from a transcript's JSONL; the witness is what the session did, not what it said
export function toolUses(jsonl) {
  const counts = {};
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const content = j?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content)
      if (b?.type === 'tool_use' && b.name) counts[b.name] = (counts[b.name] || 0) + 1;
  }
  return counts;
}

export const AUTHORING_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];
export function authoringCalls(counts) {
  return AUTHORING_TOOLS.reduce((n, t) => n + (counts[t] || 0), 0);
}
