// The JEV client (docs/14 §1): typed questions answered with calibrated probabilities, over `fetch`,
// with no SDK and no new dependency. It writes nothing and decides nothing — it turns a row's criteria
// and state into a vector, and reports what the call cost and how long it took, on every call.
//
// The key is read from the orchestrator's own environment, never from a seat's: seats run with the
// allowlisted SEAT_ENV of conduct.mjs, which does not carry TYPESAFE_API_KEY, so a row can only be asked
// from the process that conducts (docs/14 §1, J8 changes that with a socket, not with a wider allowlist).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { ROOT } from './common.mjs';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// models.md: $0.042 per million input tokens, output free
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
export const PRIMITIVES = ['noul', 'choice', 'score'];
// 429 and 5xx are the vendor's back-pressure and its own faults; a 4xx is ours and is not retried
const RETRIES = 3;
const BACKOFF_MS = 400;

// --------------------------------------------------------------------------- the key
// A ten-line reader for a gitignored .env, so the lab needs no dotenv: `KEY=value`, `export KEY=value`,
// `#` comments, and one level of quoting. Nothing here is ever printed.
export function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.split(' #')[0].trim();
    out[m[1]] = v;
  }
  return out;
}
// The app is the root a harness script runs in, and the lab that holds both apps is its parent: one key
// serves both fixtures, so the lab's .env is the second place looked at and the last.
export const ENV_FILES = [join(ROOT, '.env'), join(ROOT, '..', '.env')];
export function apiKey(env = process.env) {
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;
  for (const f of ENV_FILES) {
    if (!existsSync(f)) continue;
    const v = parseEnv(readFileSync(f, 'utf8')).TYPESAFE_API_KEY;
    if (v) return v;
  }
  return null;
}
// a message that names what went wrong without ever carrying the secret that went with it
const scrub = (s, key) =>
  String(s || '')
    .split(key || '\u0000')
    .join('«key»')
    .slice(0, 300);

// --------------------------------------------------------------------------- state and hashes
export const hash = (text) =>
  createHash('sha256')
    .update(typeof text === 'string' ? text : JSON.stringify(text ?? null))
    .digest('hex')
    .slice(0, 12);
export const stateHash = (state) => hash(canonical(state));
// a stable rendering, so the same state hashes the same however its object was built
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

// The digest cap is the ceiling for a row's state, never its floor (docs/14 §2 rule 3): a state over the
// cap is cut field by field, widest first, and says which fields it cut rather than silently shrinking.
export const STATE_CAP = 4000;
export function fitState(state, cap = STATE_CAP, keep = []) {
  const out = { ...state };
  const cut = [];
  const note = `\n… (cut to fit ${cap} characters)`;
  const size = () => canonical(out).length;
  // only a field that still has something to give: an emptied one leaves the set, so the loop always
  // makes progress and a state that cannot be made to fit ends cut to the bone rather than spinning
  const widest = () =>
    Object.keys(out)
      .filter((k) => !keep.includes(k) && typeof out[k] === 'string' && out[k].length)
      .sort((a, b) => out[b].length - out[a].length)[0];
  while (size() > cap) {
    const k = widest();
    if (!k) break;
    const room = out[k].length - (size() - cap) - note.length;
    out[k] = room > 0 ? out[k].slice(0, room) + note : '';
    if (!cut.includes(k)) cut.push(k);
  }
  return { state: out, chars: size(), cut };
}

// --------------------------------------------------------------------------- the budget
// docs/14 §6: exceeding the plan's JEV budget makes the rows return "unmeasured" and the existing path
// run. It is a finding, never a kill, so nothing here throws and nothing here exits.
export function makeBudget(limitUsd) {
  let spent = 0;
  return {
    limit: limitUsd ?? null,
    get spent() {
      return spent;
    },
    exceeded() {
      return limitUsd != null && spent >= limitUsd;
    },
    charge(usd) {
      spent += Number(usd) || 0;
      return spent;
    },
  };
}

// --------------------------------------------------------------------------- reading a response
// The response's field names are not in docs/14 (§1 records the request and the primitives, not the body
// the vendor returns), so every shape the documented primitives could carry is accepted and the raw
// answer is kept beside the reading. The first live call settles which of these is real.
export function readAnswer(primitive, a) {
  const conf = num(a?.confidence ?? a?.certainty);
  if (primitive === 'noul') {
    const p = num(a?.p ?? a?.probability ?? a?.true ?? a?.yes ?? a);
    return {
      vector: p == null ? {} : { true: p },
      pick: p == null ? null : String(p >= 0.5),
      confidence: conf,
    };
  }
  const probs = a?.probabilities ?? a?.options ?? a?.levels ?? a?.distribution ?? null;
  const vector = {};
  if (probs && typeof probs === 'object')
    for (const [k, v] of Object.entries(probs)) {
      const p = num(v?.p ?? v?.probability ?? v);
      if (p != null) vector[k] = p;
    }
  const named = a?.choice ?? a?.level ?? a?.answer ?? null;
  const top = Object.entries(vector).sort((x, y) => y[1] - x[1])[0];
  return { vector, pick: named != null ? String(named) : (top?.[0] ?? null), confidence: conf };
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// the top two and whether they are a close call (docs/14 §3: within 0.1)
export function spread(vector) {
  const s = Object.entries(vector || {}).sort((a, b) => b[1] - a[1]);
  const top = s[0]?.[1] ?? null;
  const second = s[1]?.[1] ?? null;
  return { top, second, closeCall: top != null && second != null && top - second < 0.1 };
}

// --------------------------------------------------------------------------- the transports
// A recorded-vector mock, so `node --test` and a dry replay run offline and free. JEV_MOCK is either the
// path of a JSON file of recorded responses — keyed "<row>:<stateHash>", then "<row>", then "default" —
// or the word "echo", which answers every question with a flat vector and no confidence. Flat claims
// nothing: no threshold can be met by a number the lab invented for itself.
export function mockTransport(spec) {
  if (spec === 'echo') return echoTransport;
  const file = JSON.parse(readFileSync(spec, 'utf8'));
  return async (req) => {
    const answers = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const rec =
        file[`${req.rowId}:${req.stateHash}`] ??
        file[`${id}:${req.stateHash}`] ??
        file[req.rowId] ??
        file[id] ??
        file.default;
      if (!rec)
        throw new Error(`jev mock: no recorded vector for ${req.rowId}:${req.stateHash} (${id})`);
      answers[id] = rec[id] ?? rec;
      void q;
    }
    return { status: 200, body: { answers, usage: { input_tokens: estimateTokens(req) } } };
  };
}
async function echoTransport(req) {
  const answers = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const keys = Object.keys(q.criteria || {});
    if (q.type === 'noul') answers[id] = { p: 0.5, confidence: null };
    else {
      const flat = Object.fromEntries(keys.map((k) => [k, keys.length ? 1 / keys.length : 0]));
      answers[id] = { probabilities: flat, choice: keys[0] ?? null, confidence: null };
    }
  }
  return { status: 200, body: { answers, usage: { input_tokens: estimateTokens(req) } } };
}
export const estimateTokens = (req) => Math.ceil(JSON.stringify(req.body ?? req).length / 4);

function httpTransport(key) {
  return async (req) => {
    const res = await globalThis.fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      status: res.status,
      body,
      text,
      retryAfter: Number(res.headers.get('retry-after')) || 0,
    };
  };
}

// --------------------------------------------------------------------------- one call
// Many questions in one call run in parallel against the same state (patterns/fan-out.md), so `ask` takes
// the whole map. Returns the readings plus `usd` and `ms`, always, whatever the row does with them.
export async function ask({ model, state, questions, rowId = null }, opts = {}) {
  const key = opts.transport ? null : apiKey(opts.env ?? process.env);
  const mock = opts.transport ? null : (opts.mock ?? process.env.JEV_MOCK ?? null);
  const transport = opts.transport ?? (mock ? mockTransport(mock) : httpTransport(key));
  if (!opts.transport && !mock && !key)
    return { ok: false, error: 'TYPESAFE_API_KEY is not set and no mock was given', usd: 0, ms: 0 };
  const body = { model, state, questions };
  const req = { body, model, state, questions, rowId, stateHash: stateHash(state) };
  const started = Date.now();
  let last = null;
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    let r;
    try {
      r = await transport(req);
    } catch (e) {
      last = { status: 0, error: scrub(e.message, key) };
      r = null;
    }
    if (r && r.status >= 200 && r.status < 300 && r.body) {
      const tokens = num(r.body?.usage?.input_tokens);
      return {
        ok: true,
        model,
        answers: r.body.answers ?? r.body.results ?? r.body,
        raw: r.body,
        tokens: tokens ?? estimateTokens(req),
        tokens_estimated: tokens == null,
        usd: (tokens ?? estimateTokens(req)) * USD_PER_INPUT_TOKEN,
        ms: Date.now() - started,
        attempts: attempt,
        source: opts.transport ? 'transport' : mock ? `mock:${mock}` : 'live',
      };
    }
    if (r) last = { status: r.status, error: scrub(r.text ?? JSON.stringify(r.body), key) };
    const retryable = !r || r.status === 429 || r.status >= 500;
    if (!retryable || attempt > RETRIES) break;
    await sleep((r?.retryAfter ? r.retryAfter * 1000 : BACKOFF_MS) * 2 ** (attempt - 1));
  }
  return {
    ok: false,
    error: `jev: ${last?.status ?? 0} ${last?.error ?? 'no response'}`,
    usd: 0,
    ms: Date.now() - started,
  };
}

// --------------------------------------------------------------------------- one row, asked once
// The row builds its own state and criteria; this runs them and hands back the ruling with the vector
// beside it. At `mode: 'shadow'` the ruling changes nothing — it is recorded and the existing path runs.
export async function askRow(row, ctx, opts = {}) {
  const model = opts.model ?? 'jev-1.13.0';
  const budget = opts.budget ?? null;
  const built = typeof row.state === 'function' ? row.state(ctx) : { state: row.state, cut: [] };
  const state = built.state ?? built;
  const sh = stateHash(state);
  const base = {
    row: row.id,
    version: row.version,
    mode: row.mode,
    // the bands travel with the reading: a vector read later against thresholds that have since moved is
    // not the ruling that was made, and the line has to say which bands it was judged by
    thresholds: row.thresholds,
    stateHash: sh,
    state,
    cut: built.cut ?? [],
  };
  if (opts.enabled === false)
    return { ...base, unmeasured: true, reason: 'jev is disabled in harness.json', usd: 0, ms: 0 };
  if (budget?.exceeded())
    return {
      ...base,
      unmeasured: true,
      reason: `the plan's jev budget of $${budget.limit} is spent ($${budget.spent.toFixed(5)})`,
      usd: 0,
      ms: 0,
    };
  const criteria = typeof row.criteria === 'function' ? row.criteria(ctx) : row.criteria;
  const questions = Object.fromEntries(
    Object.entries(criteria).map(([id, q]) => [id, { type: row.primitive, ...q }]),
  );
  const r = await ask({ model, state, questions, rowId: row.id }, opts);
  budget?.charge(r.usd);
  if (!r.ok) return { ...base, unmeasured: true, reason: r.error, usd: r.usd, ms: r.ms };
  const read = Object.fromEntries(
    Object.keys(questions).map((id) => [id, readAnswer(row.primitive, r.answers?.[id])]),
  );
  const ruling = row.combine(read, ctx);
  return {
    ...base,
    criteria,
    questions,
    read,
    ruling,
    raw: r.raw,
    usd: r.usd,
    ms: r.ms,
    tokens: r.tokens,
    tokens_estimated: r.tokens_estimated,
    source: r.source,
    unmeasured: false,
  };
}

// --------------------------------------------------------------------------- the ledger line
// docs/14 §2 and §6: the line is written even in shadow and even when the ruling is ignored; a missing
// line is a finding. `agreesWith` names the label the row was measured against — the Master's answer,
// the agent's declaration, the observer's verdict — and `agreed` says whether it matched, so calibration
// is counted from the ledger rather than re-derived from a vector whose options have since moved.
export function jevLine(result, { agreesWith = null, agreed = null } = {}) {
  return {
    row: result.row,
    version: result.version,
    stateHash: result.stateHash,
    vector: result.ruling?.probabilities ?? result.ruling?.vector ?? {},
    confidence: result.ruling?.confidence ?? null,
    threshold: result.thresholds ?? result.ruling?.thresholds ?? null,
    mode: result.mode,
    agreesWith,
    agreed,
    usd: Number((result.usd ?? 0).toFixed(7)),
    ms: result.ms ?? null,
    ...(result.unmeasured ? { unmeasured: true, reason: result.reason ?? null } : {}),
  };
}
