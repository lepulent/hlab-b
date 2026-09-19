// Pure rules for the seat record (Mycelium FR-14, FR-16, 14.5, 15.4): how a seat ended, read from facts
// and never inferred from silence; whether two independent witnesses of what it did agree; and the
// ActivationRecord, in which only resultProse is written by the model. No I/O here.

export const TERMINALS = ['complete', 'escalated', 'blocked', 'abandoned'];
const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// `git status --porcelain` lines as mutations: what changed on disk, and how
export function parsePorcelainOps(text) {
  const ops = { A: 'added', '?': 'added', M: 'modified', D: 'deleted', R: 'renamed' };
  return String(text || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const code = (l[0] !== ' ' ? l[0] : l[1]) || 'M';
      let path = l.slice(3).replace(/^"|"$/g, '');
      if (path.includes(' -> ')) path = path.split(' -> ')[1];
      return { target: path, op: ops[code] || 'modified' };
    });
}

// a footprint is the hook's lines; the paths a session wrote are its file-tool targets
export function footprintWrites(footprint) {
  return [
    ...new Set(
      (footprint || []).filter((f) => FILE_TOOLS.includes(f.tool) && f.target).map((f) => f.target),
    ),
  ].sort();
}

// The terminal comes from facts, in precedence order: a veto that denied a call blocks the seat; a
// deadline or a failed session abandons it (its partial work is kept as evidence); a question of its own
// that the floor stopped escalates it; a session that ended without writing what it owned is abandoned;
// anything else is complete.
export function terminalFor({
  ok,
  timedOut = false,
  deadlineS = null,
  error = null,
  denied = [],
  escalated = null,
  owned = [],
  written = [],
}) {
  if (denied.length) return { terminal: 'blocked', reason: `veto: ${denied[0]}` };
  if (timedOut) return { terminal: 'abandoned', reason: `deadline of ${deadlineS}s passed` };
  if (!ok) return { terminal: 'abandoned', reason: `session failed: ${error || 'no result'}` };
  if (escalated) return { terminal: 'escalated', reason: `question ${escalated} stopped the plan` };
  const missing = owned.filter((p) => !written.includes(p));
  if (missing.length)
    return { terminal: 'abandoned', reason: `ended without writing ${missing.join(', ')}` };
  return { terminal: 'complete', reason: `wrote ${written.join(', ')}` };
}

// Two witnesses that no model authored, and the transcript as a third: per session, the hook's file
// writes and the transcript's must be the same paths; across the wave, every path git saw change must
// have been written by some session's hook, and every hook write must be a change git saw or a file
// whose content ended unchanged (a write of identical bytes).
export function corroborate(sessions, mutations, { unchanged = [] } = {}) {
  const disagreements = [];
  const changed = new Set(mutations.map((m) => m.target));
  const hookAll = new Set();
  for (const s of sessions) {
    const hook = footprintWrites(s.footprint);
    hook.forEach((p) => hookAll.add(p));
    const authored = [...new Set(s.authored || [])].sort();
    if (JSON.stringify(hook) !== JSON.stringify(authored))
      disagreements.push(
        `${s.agent}: hook saw writes to ${hook.join(', ') || 'nothing'}, transcript to ${authored.join(', ') || 'nothing'}`,
      );
    for (const p of hook)
      if (!changed.has(p) && !unchanged.includes(p))
        disagreements.push(`${s.agent}: hook saw a write to ${p}, git saw no change`);
  }
  for (const p of changed)
    if (!hookAll.has(p)) disagreements.push(`git saw ${p} change, no session's hook wrote it`);
  return { ok: !disagreements.length, disagreements };
}

// The ActivationRecord: every field is machine-written except resultProse, which is the seat's own
// summary and says so by its name
export function buildRecord({
  gapId,
  artifacts,
  agent,
  session,
  footprint,
  mutations,
  decisionsTouched,
  terminal,
  reason,
  resultProse,
}) {
  return {
    nodeId: gapId,
    artifacts,
    agentId: agent,
    sessionId: session,
    toolFootprint: (footprint || []).map((f) => ({ tool: f.tool, target: f.target })),
    stateMutations: mutations,
    decisionsTouched: decisionsTouched || [],
    terminal,
    reason,
    resultProse: String(resultProse || ''),
  };
}

// When a gap closes, an earlier gap that is still open and named any of the same artifacts is superseded
// by it: no gap ends in any state but closed, superseded or deferred (13.4)
export function supersede(gaps, closed) {
  return gaps
    .filter(
      (g) =>
        g.id !== closed.id &&
        ['declared', 'linked'].includes(g.status) &&
        g.artifacts.some((a) => closed.artifacts.includes(a)),
    )
    .map((g) => g.id);
}
