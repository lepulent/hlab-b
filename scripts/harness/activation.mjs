// Pure rules for conducted activations (H-32, H-33 steps 1 and 4): the Master's decision is validated,
// an agent's jurisdiction is resolved and checked, and transcripts are read for tool use. No I/O here,
// so every rule is a unit test.

const MIN_WORDS = { task: 4, reason: 4, rejection: 3 };
// an option names an agent when its id appears as a whole token ("spec-writer", "spec-writer (tech spec)")
const names = (option, id) =>
  new RegExp(`(^|[^a-z0-9-])${id.replace(/[-]/g, '\\-')}($|[^a-z0-9-])`, 'i').test(
    String(option || ''),
  );
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

// The Master's output is accepted only when every activation names a roster agent and says what to do
// in words that carry something; a well-formed but empty decision is refused, never recorded as if it
// were one. A wave (H-33 step 4) holds at most maxWave agents, each once, whose owned paths are disjoint,
// so no two sessions running at the same time may write the same file.
export function validateActivation(act, roster, { plan = 'plan', maxWave = 1 } = {}) {
  const refusals = [];
  const agents = rosterById(roster);
  if (!act || typeof act !== 'object') return { ok: false, refusals: ['no decision object'] };
  if (!['activate', 'no-move'].includes(act.decision))
    refusals.push(`decision "${act.decision}" is not activate or no-move`);
  const wave = Array.isArray(act.activations) ? act.activations : [];
  if (act.decision === 'activate') {
    if (!wave.length) refusals.push('activate names no agent');
    if (wave.length > maxWave)
      refusals.push(`a wave of ${wave.length} exceeds the limit of ${maxWave}`);
    const seen = new Set();
    const owner = new Map();
    for (const a of wave) {
      if (!agents.has(a?.agent)) refusals.push(`agent "${a?.agent}" is not in the roster`);
      if (seen.has(a?.agent)) refusals.push(`agent "${a?.agent}" is activated twice`);
      seen.add(a?.agent);
      if (words(a?.task) < MIN_WORDS.task)
        refusals.push(`task for "${a?.agent}" has fewer than ${MIN_WORDS.task} words`);
      for (const p of resolveOwns(agents.get(a?.agent)?.owns, plan)) {
        if (owner.has(p) && owner.get(p) !== a.agent)
          refusals.push(`"${p}" is owned by both "${owner.get(p)}" and "${a.agent}"`);
        owner.set(p, a.agent);
      }
    }
  }
  if (act.decision === 'no-move' && wave.length) refusals.push('no-move activates an agent');
  if (words(act.reason) < MIN_WORDS.reason)
    refusals.push(`reason has fewer than ${MIN_WORDS.reason} words`);
  for (const r of act.rejected || [])
    if (words(r?.why) < MIN_WORDS.rejection)
      refusals.push(`rejection of "${r?.option}" has fewer than ${MIN_WORDS.rejection} words`);
  // a decision records what else was possible: every roster agent is either chosen or rejected with a
  // reason, and never both (step 1, hlab-b: "brief-writer — Chosen, not rejected." passed the gate)
  const rejectedIds = new Set(
    (act.rejected || []).flatMap((r) => [...agents.keys()].filter((id) => names(r?.option, id))),
  );
  const chosen = new Set(act.decision === 'activate' ? wave.map((a) => a?.agent) : []);
  for (const id of chosen)
    if (rejectedIds.has(id)) refusals.push(`the chosen agent "${id}" is also listed as rejected`);
  for (const id of agents.keys())
    if (!chosen.has(id) && !rejectedIds.has(id))
      refusals.push(`roster agent "${id}" was neither chosen nor rejected`);
  return { ok: !refusals.length, refusals };
}

// what a decision chose, in one comparable word: "no-move", or the activated agents sorted and joined
export function chosenKey(act) {
  if (act?.decision === 'no-move') return 'no-move';
  return (act?.activations || [])
    .map((a) => a?.agent)
    .sort()
    .join('+');
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

// paths a session wrote, from the file_path of its authoring tool calls, relative to the repo root: the
// witness that attributes a file to one of several sessions sharing a working tree
export function authoredPaths(jsonl, root) {
  const out = new Set();
  const prefix = root.endsWith('/') ? root : `${root}/`;
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
    for (const b of content) {
      const f = b?.type === 'tool_use' && FILE_TOOLS.includes(b.name) && b.input?.file_path;
      if (f) out.add(f.startsWith(prefix) ? f.slice(prefix.length) : f);
    }
  }
  return [...out].sort();
}
const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// two or more [start, end] windows share a moment when the latest start is before the earliest end
export function overlapSeconds(windows) {
  if (windows.length < 2) return 0;
  const start = Math.max(...windows.map((w) => w.start));
  const end = Math.min(...windows.map((w) => w.end));
  return Math.max(0, Math.round((end - start) / 100) / 10);
}

export const AUTHORING_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];
export function authoringCalls(counts) {
  return AUTHORING_TOOLS.reduce((n, t) => n + (counts[t] || 0), 0);
}
