// Step 19: model and effort routing. Which model, at which effort, each role of a plan runs on: the
// Master's decisions and answers, and each seat by its agent. Data, not judgement: a table the owner
// sets (harness.json `routing`, or a file given to conduct with --routing), read by one pure function.
// The settings adapter applies a route as the seat's --model/--effort; the mod adapter applies it to
// every model request of the seat in a turn.step hook, which is where routing can later differ per step.
//
//   { "default": { "model": "sonnet", "effort": "low" },
//     "master":  { "effort": "low" },
//     "seats":   { "dev": { "effort": "medium" } } }

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// A turn.step rewrite takes a model's full id: an alias ("haiku") fails the request in silence, as a
// `<synthetic>` reply at $0 (probe 2026-10-08, CLI 2.1.294). So a route is resolved to this build's ids
// before it reaches either adapter; the routing-held check reads the model each request used.
export const MODEL_IDS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};
export const resolveModel = (m) => (m == null ? null : MODEL_IDS[m] || m);
const MODEL_RE = /^(haiku|sonnet|opus|fable|claude-[a-z0-9.-]+)$/;

export function validateRouting(routing) {
  const refusals = [];
  const each = [
    ['default', routing?.default],
    ['master', routing?.master],
    ['answer', routing?.answer],
    ...Object.entries(routing?.seats || {}).map(([k, v]) => [`seats.${k}`, v]),
  ].filter(([, v]) => v != null);
  for (const [where, r] of each) {
    if (r.model != null && !MODEL_RE.test(String(r.model)))
      refusals.push(`${where}: model "${r.model}" is not a model name`);
    if (r.effort != null && !EFFORTS.includes(r.effort))
      refusals.push(`${where}: effort "${r.effort}" is not one of ${EFFORTS.join(', ')}`);
    const extra = Object.keys(r).filter((k) => !['model', 'effort'].includes(k));
    if (extra.length) refusals.push(`${where}: unknown key(s) ${extra.join(', ')}`);
  }
  return { ok: !refusals.length, refusals };
}

// role: 'master' (a decision), 'answer' (the Master answering a question), or a seat's agent id.
// The answerer falls back to the master's route; a seat to the default; anything unset stays unset
// (the session's own model or effort).
export function routeFor(role, routing, fallbackModel = null) {
  const r = routing || {};
  const own =
    role === 'master' ? r.master : role === 'answer' ? (r.answer ?? r.master) : r.seats?.[role];
  const route = { ...(r.default || {}), ...(own || {}) };
  const model = resolveModel(route.model ?? fallbackModel ?? null);
  return { ...(model ? { model } : {}), ...(route.effort ? { effort: route.effort } : {}) };
}
