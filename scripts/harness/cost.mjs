// The USD series of a seat when the seat did not live to report it (H-34, NFR-16). A seat's own result
// JSON carries `total_cost_usd`; a killed seat never writes one, but its transcript still carries every
// message's usage and model, so its price is arithmetic over a rate table. The table is data: one row per
// model, USD per million tokens. A model with tokens and no row is unpriced, never zero.

// Fitted over the 91 seat rows of hlab-a and hlab-b that reported their own cost (plans s1…t5b): these four
// rates reproduce every one of them with a worst relative error below 1e-15.
export const RATES = Object.freeze({
  'claude-sonnet-5': Object.freeze({ input: 2, output: 10, cache_read: 0.2, cache_creation: 4 }),
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
