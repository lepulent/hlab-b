// Resume (Mycelium NFR-1, NFR-2): the Master is re-read, never resumed, and everything it sees is a
// deterministic fold over recorded state. So a conduct that starts on a plan which already has waves
// rebuilds them from the ledger — what each wave produced, how it ended, which gaps stand, which
// questions were answered — instead of starting blind. Pure: the caller passes the ledger's lines.

// lines: the plan's ledger, oldest first, already parsed
export function rebuild(lines) {
  const waves = new Map(); // n → { n, gap, activations, questions }
  const gaps = new Map(); // id → { id, n, statement, artifacts, status }
  const questions = [];
  const wave = (n) => {
    if (!waves.has(n)) waves.set(n, { n, gap: null, activations: [], questions: [] });
    return waves.get(n);
  };
  for (const l of lines) {
    const d = l?.data || {};
    if (l?.kind === 'gap' && d.id) {
      const g = gaps.get(d.id) || {
        id: d.id,
        n: d.wave ?? null,
        artifacts: [],
        status: 'declared',
      };
      if (d.status) g.status = d.status;
      if (d.statement) g.statement = d.statement;
      if (Array.isArray(d.artifacts)) g.artifacts = d.artifacts.map((a) => a.artifact || a);
      if (d.wave != null) {
        g.n = g.n ?? d.wave;
        const w = wave(d.wave);
        if (!w.gap) w.gap = { id: g.id, statement: g.statement || '' };
        else if (!w.gap.statement && g.statement) w.gap.statement = g.statement;
      }
      gaps.set(d.id, g);
    }
    if (
      l?.kind === 'seat-end' &&
      d.station === 'conduct' &&
      d.seat !== 'master' &&
      d.wave != null
    ) {
      wave(d.wave).activations.push({
        agent: d.seat,
        artifacts: d.artifacts || [],
        task: '',
        written: (d.authored || []).slice(),
        commit: null,
        summary: d.summary || '',
        terminal: d.terminal || null,
        reason: d.reason || '',
        session: d.session,
      });
    }
    if (l?.kind === 'question' && d.file && d.valid !== false && d.question) {
      questions.push({
        file: d.file,
        wave: d.wave ?? null,
        agent: String(l.actor || '').replace(/^agent:/, ''),
        question: d.question,
        verdict: null,
        answer: null,
      });
    }
    if (l?.kind === 'answer' && d.file) {
      const q = questions.find((x) => x.file === d.file);
      if (q && d.valid) q.answer = d.answer;
    }
    if (l?.kind === 'decision' && d.station === 'decider' && d.file) {
      const q = questions.find((x) => x.file === d.file);
      if (q) q.verdict = d.verdict;
    }
  }
  for (const q of questions) if (q.wave != null) wave(q.wave).questions.push(q);
  // a commit for an artifact is recorded on the gap line that closed it
  for (const l of lines) {
    const d = l?.data || {};
    if (l?.kind === 'gap' && Array.isArray(d.commits) && d.wave != null) {
      const w = waves.get(d.wave);
      if (w) w.activations.forEach((a, i) => (a.commit = d.commits[i] ?? a.commit));
    }
  }
  const ordered = [...waves.values()].sort((a, b) => a.n - b.n).filter((w) => w.activations.length);
  return {
    waves: ordered,
    gaps: [...gaps.values()],
    questions,
    lastWave: ordered.length ? ordered[ordered.length - 1].n : 0,
    agents: [...new Set(ordered.flatMap((w) => w.activations.map((a) => a.agent)))].sort(),
  };
}

// the ledger of a plan, oldest first, from its JSONL text
export function parseLedger(text) {
  return String(text || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
