// The USD series of a seat when the seat did not live to report it (H-34, NFR-16). A seat's own result
// JSON carries `total_cost_usd`; a killed seat never writes one, but its transcript still carries every
// message's usage and model, so its price is arithmetic over a rate table. The table is data: one row per
// model, USD per million tokens. A model with tokens and no row is unpriced, never zero.

// Each row is fitted, never looked up: claude-sonnet-5 over the 91 self-priced seats of plans s1…t5b,
// claude-sonnet-5-5 over the 17 of t6a/t6b (the `sonnet` alias moved to it between T5 and t6; t6b's
// killed spec-writer is how the table found out — it went unpriced and cost-per-session went red). Both
// reproduce every row with a worst relative error below 1e-15. A new model gets a row the same way.
export const RATES = Object.freeze({
  'claude-sonnet-5': Object.freeze({ input: 2, output: 10, cache_read: 0.2, cache_creation: 4 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10, cache_read: 0.2, cache_creation: 4 }),
  // fitted to the six self-reported haiku seats of hlab-a r19a-route2 and hlab-b r19b-route2 (step 19):
  // exact to 1e-11 USD; the cost test below holds it to every priced seat in both apps
  'claude-haiku-5-5': Object.freeze({
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_creation: 0.2,
  }),
});

const FIELDS = ['input', 'output', 'cache_read', 'cache_creation'];
const spent = (t) => FIELDS.some((f) => (t[f] || 0) > 0);

// byModel: { model: { input, output, cache_read, cache_creation } } → { usd, unpriced: [model] }.
// A model that spent no token (the CLI's `<synthetic>` error messages) costs nothing and needs no rate.
export function priceTokens(byModel, rates = RATES) {
  let usd = 0;
  const unpriced = [];
  for (const [model, t] of Object.entries(byModel || {})) {
    if (!spent(t)) continue;
    const r = rates[model];
    if (!r) {
      unpriced.push(model);
      continue;
    }
    usd += FIELDS.reduce((s, f) => s + (t[f] || 0) * r[f], 0) / 1e6;
  }
  return { usd: unpriced.length ? null : usd, unpriced: unpriced.sort() };
}

// The seat's cost: its own report when it made one, otherwise derived from the transcript and flagged.
export function seatCost(reported, transcriptTokens, rates = RATES) {
  if (typeof reported === 'number') return { cost_usd: reported };
  // no transcript is no evidence: an empty series would price at $0, which is the lie this module exists to stop
  if (!transcriptTokens?.messages)
    return { cost_usd: null, cost_derived: false, cost_unpriced: ['no-transcript'] };
  const { usd, unpriced } = priceTokens(transcriptTokens?.by_model, rates);
  return unpriced.length
    ? { cost_usd: null, cost_derived: false, cost_unpriced: unpriced }
    : { cost_usd: usd, cost_derived: true };
}

// The plan's cost, read from its whole ledger (T5 review 2: the check summed only this process's
// in-memory seats, so a resumed plan's earlier waves read "agents $0.000" and a seat that never ended
// counted as nothing). priceOf(session) prices a seat from its transcript when its line carries no
// report. The check is ok only when every seat opened has ended and every seat that ended is priced.
export function ledgerCost(lines, priceOf) {
  const starts = lines.filter((l) => l?.kind === 'seat-start' && l.data?.session);
  const ends = lines.filter((l) => l?.kind === 'seat-end' && l.data?.session).map((l) => l.data);
  const ended = new Set(ends.map((d) => d.session));
  const open = starts
    .filter((l) => !ended.has(l.data.session))
    .map((l) => `${l.data.seat} w${l.data.wave ?? '?'} ${String(l.data.session).slice(0, 8)}`);
  const seats = ends.map((d) => {
    const priced =
      typeof d.cost_usd === 'number'
        ? { cost_usd: d.cost_usd, cost_derived: !!d.cost_derived }
        : priceOf(d.session);
    const role = d.station === 'answer' ? 'answers' : d.seat === 'master' ? 'master' : 'agents';
    return { ...d, ...priced, role };
  });
  const sum = (role) =>
    seats.filter((x) => x.role === role).reduce((a, x) => a + (x.cost_usd || 0), 0);
  const who = (x) => `${x.seat} w${x.wave ?? '?'} ${String(x.session).slice(0, 8)}`;
  const unpriced = seats
    .filter((x) => typeof x.cost_usd !== 'number')
    .map((x) => `${who(x)} [${(x.cost_unpriced || ['no rate']).join(', ')}]`);
  return {
    ok: !open.length && !unpriced.length,
    master: sum('master'),
    answers: sum('answers'),
    agents: sum('agents'),
    seats: seats.length,
    derived: seats
      .filter((x) => x.cost_derived && typeof x.cost_usd === 'number')
      .map((x) => `${who(x)} $${x.cost_usd.toFixed(3)}${x.orphaned ? ' (orphaned)' : ''}`),
    unpriced,
    open,
  };
}
