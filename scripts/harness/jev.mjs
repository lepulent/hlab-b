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
import { setTimeout, clearTimeout } from 'node:timers';
import { createHash } from 'node:crypto';
import { ROOT } from './common.mjs';
import { answerStood } from './resume.mjs';

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

// --------------------------------------------------------------------------- the request, validated
// The API DROPS an unknown key in a question object: it does not reject it, does not charge for it and
// does not read it. Measured on 2026-09-28 (docs/15 §2.1) — a 160-token string under `question:` costs
// the same input tokens as omitting it entirely, while the same string under `instructions:` costs 162
// more. So a misspelled field is a question silently asked without its question, and no status code will
// ever tell us. The vendor cannot validate our spelling; this does.
export const QUESTION_KEYS = ['type', 'instructions', 'criteria'];
export const MAX_CHOICE_OPTIONS = 255; // 256 → HTTP 400 "at most 255 options" (Atlassinator, probed)
export const SCORE_LEVELS = { min: 2, max: 10 };

export function validateQuestions(questions) {
  const refusals = [];
  const entries = Object.entries(questions || {});
  if (!entries.length) refusals.push('no questions were given');
  for (const [id, q] of entries) {
    if (!q || typeof q !== 'object') {
      refusals.push(`${id}: not an object`);
      continue;
    }
    for (const k of Object.keys(q))
      if (!QUESTION_KEYS.includes(k))
        refusals.push(
          `${id}: unknown field "${k}" would be dropped silently; the field is one of ${QUESTION_KEYS.join(', ')}`,
        );
    if (!PRIMITIVES.includes(q.type))
      refusals.push(`${id}: type "${q.type}" is not one of ${PRIMITIVES.join(', ')}`);
    if (q.instructions == null || (typeof q.instructions === 'string' && !q.instructions.trim()))
      refusals.push(`${id}: no instructions; the criteria alone would carry the whole decision`);
    const c = q.criteria;
    if (q.type === 'noul') {
      // the documented shape is { true, false }; anything else is a key the API will drop
      if (c != null && (typeof c !== 'object' || Array.isArray(c)))
        refusals.push(`${id}: a noul's criteria is { true, false } or absent`);
      else if (c)
        for (const k of Object.keys(c))
          if (!['true', 'false'].includes(k))
            refusals.push(`${id}: a noul's criteria may only carry true and false, not "${k}"`);
    } else if (q.type === 'choice') {
      if (!c || typeof c !== 'object' || Array.isArray(c))
        refusals.push(`${id}: a choice's criteria is a map of option id → description`);
      else if (!Object.keys(c).length) refusals.push(`${id}: a choice with no options`);
      else if (Object.keys(c).length > MAX_CHOICE_OPTIONS)
        refusals.push(
          `${id}: ${Object.keys(c).length} options is over the ${MAX_CHOICE_OPTIONS} the API accepts`,
        );
    } else if (q.type === 'score') {
      if (!Array.isArray(c))
        refusals.push(
          `${id}: a score's criteria is an ordered array of level labels, lowest first`,
        );
      else if (c.length < SCORE_LEVELS.min || c.length > SCORE_LEVELS.max)
        refusals.push(
          `${id}: ${c.length} levels is outside the ${SCORE_LEVELS.min}–${SCORE_LEVELS.max} the API accepts`,
        );
    }
  }
  return refusals;
}

// --------------------------------------------------------------------------- reading a response
// VERIFIED against the live API on 2026-09-28; every shape below was returned by a real call and is
// recorded in docs/15 §1 with its raw body. The previous version of this function guessed, and guessed
// wrong for two of the three primitives.
//
//   noul   { "type": "noul", "noul": 0.04 }                                  — and NO confidence field
//   choice { "type": "choice", "choice": k, "probabilities": {…}, "confidence": c }
//   score  { "type": "score", "score": 1.05, "legend": {…}, "probabilities": {…}, "confidence": c }

// Probabilities are rounded to two decimals and may sum to 0.99 (Atlassinator, measured). A reader that
// does not divide by the sum reads a rounded distribution as a lower value than it is.
export function normalise(vector) {
  const sum = Object.values(vector).reduce((a, b) => a + b, 0);
  if (!(sum > 0) || Math.abs(sum - 1) <= 0.005)
    return { vector, sum: sum || 0, renormalised: false };
  return {
    vector: Object.fromEntries(Object.entries(vector).map(([k, v]) => [k, v / sum])),
    sum,
    renormalised: true,
  };
}

export function readAnswer(primitive, a, criteria = null) {
  if (primitive === 'noul') {
    // `noul` is the direct API's field; `probability` is the Vercel Gateway's name for the same number
    const p = num(a?.noul ?? a?.probability);
    if (p == null)
      return {
        vector: {},
        pick: null,
        confidence: null,
        confidenceDerived: false,
        closeCall: false,
      };
    return {
      // the recorded vector is the one number the API gave; `false` is its complement by construction,
      // which is safe within ONE answer — what is NOT safe is comparing P(x) with 1−P(not x) across two
      // separate nouls, which the vendor's own jaggedness page shows summing to 1.19
      vector: { true: p, false: 1 - p },
      pick: String(p >= 0.5),
      // A NOUL CARRIES NO CONFIDENCE. Distance from the coin flip is the only signal it has, so that is
      // what the bands read, and the flag says the number was derived here and not returned.
      confidence: Math.max(p, 1 - p),
      confidenceDerived: true,
      closeCall: Math.abs(p - 0.5) < 0.05,
    };
  }

  const raw = {};
  if (a?.probabilities && typeof a.probabilities === 'object')
    for (const [k, v] of Object.entries(a.probabilities)) {
      const p = num(v);
      if (p != null) raw[k] = p;
    }
  const { vector, sum, renormalised } = normalise(raw);
  const conf = num(a?.confidence);

  if (primitive === 'score') {
    // The live service keys score probabilities by level INDEX, not by criterion text (Atlassinator
    // recorded `"reading": "index"` on every live row) — but the documented example keys them by text.
    // Read both, and when neither matches fall back to the fractional `score`, which is the expected
    // level and is the only thing that survives a keying we do not recognise.
    const levels = Array.isArray(criteria) ? criteria : Object.values(a?.legend ?? {});
    const keys = Object.keys(vector);
    const byIndex = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
    const byText = !byIndex && keys.length > 0 && keys.every((k) => levels.includes(k));
    const reading = byIndex ? 'index' : byText ? 'text' : 'interpolated';
    const score = num(a?.score);
    let pick = null;
    if (byIndex || byText) {
      const top = Object.entries(vector).sort((x, y) => y[1] - x[1])[0];
      pick = top?.[0] ?? null;
    } else if (score != null) {
      pick = String(Math.round(score));
    }
    return {
      vector,
      pick,
      confidence: conf,
      confidenceDerived: false,
      // the expected level, which is what makes a score a score: it interpolates between levels
      score,
      legend: a?.legend ?? null,
      reading,
      sum,
      renormalised,
      closeCall: spread(vector).closeCall,
    };
  }

  // choice: the API names the winner, and it is the argmax by definition — but read the name, not our
  // own argmax, so a disagreement between the two is visible rather than smoothed over
  const named = a?.choice ?? null;
  const top = Object.entries(vector).sort((x, y) => y[1] - x[1])[0];
  return {
    vector,
    pick: named != null ? String(named) : (top?.[0] ?? null),
    confidence: conf,
    confidenceDerived: false,
    argmax: top?.[0] ?? null,
    sum,
    renormalised,
    closeCall: spread(vector).closeCall,
  };
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
// The echo answers in the REAL response shapes (docs/15 §1), because a mock that shares the client's
// guesses cannot catch the client's guesses — which is exactly how a noul reader that never read `.noul`
// stayed green over nineteen tests.
async function echoTransport(req) {
  const answers = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: 0.5 };
    } else if (q.type === 'score') {
      const levels = Array.isArray(q.criteria) ? q.criteria : [];
      const flat = Object.fromEntries(
        levels.map((_, i) => [String(i), levels.length ? 1 / levels.length : 0]),
      );
      answers[id] = {
        type: 'score',
        score: levels.length ? (levels.length - 1) / 2 : 0,
        legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
        probabilities: flat,
        confidence: null,
      };
    } else {
      const keys = Object.keys(q.criteria || {});
      const flat = Object.fromEntries(keys.map((k) => [k, keys.length ? 1 / keys.length : 0]));
      answers[id] = {
        type: 'choice',
        choice: keys[0] ?? null,
        probabilities: flat,
        confidence: null,
      };
    }
  }
  return { status: 200, body: { answers, usage: { input_tokens: estimateTokens(req) } } };
}
export const estimateTokens = (req) => Math.ceil(JSON.stringify(req.body ?? req).length / 4);

function httpTransport(key) {
  return async (req, signal) => {
    const res = await globalThis.fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
      ...(signal ? { signal } : {}),
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
  // fail closed BEFORE the call: an unknown key would be dropped in silence and charged for as if the
  // question had been asked properly (docs/15 §2.1)
  const refusals = validateQuestions(questions);
  if (refusals.length)
    return {
      ok: false,
      error: `jev: the request was refused before it was sent: ${refusals.join('; ')}`,
      usd: 0,
      ms: 0,
      refusals,
    };
  const body = { model, state, questions };
  const req = { body, model, state, questions, rowId, stateHash: stateHash(state) };
  // A live call is billed (the Typesafe key), so it is ruled first, every call (step 15, docs/17 §4.3):
  // the caller passes `authorize`, which rules jev.call against the grants in force and records the
  // ruling. No authorize, or a ruling that does not allow, and nothing is sent: the reading is
  // skipped and the plan continues (an escalate here stops the call, never the plan). Mocks and injected
  // transports cost nothing and are not ruled.
  if (!opts.transport && !mock) {
    const usd = Number((estimateTokens(req) * USD_PER_INPUT_TOKEN).toFixed(8));
    const ruling = opts.authorize
      ? await opts.authorize({ act: 'jev.call', row: rowId, usd })
      : {
          verdict: 'escalate',
          reason: 'a live JEV call is billed and its caller passed no authority',
        };
    if (ruling?.verdict !== 'allow')
      return {
        ok: false,
        error: `jev: not sent — ${ruling?.reason || 'no ruling'}`,
        usd: 0,
        ms: 0,
        ruling,
      };
  }
  const started = Date.now();
  // A DEADLINE OVER THE WHOLE CALL, retries included. Measured on 2026-09-28: p50 438 ms but p95 84 s
  // and a worst case of 138 s, because the vendor's 503 "high demand" arrives in bursts and four attempts
  // with exponential backoff sit behind it. An offline replay is allowed to wait; a row asked inside a
  // live decision is not — the Master's own deadline is 180 s, and a shadow reading that eats it has
  // made the harness worse in exchange for a number nobody acts on. Past the deadline the call gives up
  // and the caller records `unmeasured`, which is the existing path running (docs/14 §6).
  const deadlineMs = opts.deadlineMs ?? null;
  const left = () => (deadlineMs == null ? Infinity : started + deadlineMs - Date.now());
  let last = null;
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    if (left() <= 0) {
      last = { status: 0, error: `gave up after ${deadlineMs} ms` };
      break;
    }
    let r;
    const controller = deadlineMs == null ? null : new globalThis.AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, left())) : null;
    try {
      r = await transport(req, controller?.signal);
    } catch (e) {
      last = {
        status: 0,
        error: controller?.signal.aborted
          ? `gave up after ${deadlineMs} ms`
          : scrub(e.message, key),
      };
      r = null;
    } finally {
      if (timer) clearTimeout(timer);
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
    const wait = (r?.retryAfter ? r.retryAfter * 1000 : BACKOFF_MS) * 2 ** (attempt - 1);
    if (wait >= left()) {
      last = { status: last?.status ?? 0, error: `gave up after ${deadlineMs} ms` };
      break;
    }
    await sleep(wait);
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
  if (!r.ok)
    return {
      ...base,
      unmeasured: true,
      reason: r.error,
      usd: r.usd,
      ms: r.ms,
      // a call the authority did not allow was never sent: refused by rule, not failed
      ...(r.ruling && r.ruling.verdict !== 'allow' ? { not_granted: true } : {}),
    };
  const read = Object.fromEntries(
    Object.keys(questions).map((id) => [
      id,
      readAnswer(row.primitive, r.answers?.[id], questions[id]?.criteria),
    ]),
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
// Grade a reading against the label that actually stood. An answer is a label only when the harness
// accepted it (question.mjs validated it, the seat authored nothing): grading against a refused answer
// counts a rejected label as ground truth (hlab-b t5b Q-1, runs/t5-paired.md). A refused label is
// recorded as `label_rejected`, never as a disagreement. Comparison is text after whitespace and case,
// since the answer must be one of the listed alternatives.
export const normAnswer = (x) =>
  String(x ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
export function gradeShadow(result, { answer, answered }) {
  if (result?.unmeasured) return { agreed: null };
  if (!answered) return { agreed: null, label_rejected: true };
  return { agreed: normAnswer(result?.ruling?.answer) === normAnswer(answer) };
}

export function jevLine(
  result,
  { agreesWith = null, agreed = null, label_rejected = false, file = null, wave = null } = {},
) {
  return {
    row: result.row,
    // the decision this reading shadows: an answer line and its jev line pair on (wave, file)
    ...(file ? { file, wave } : {}),
    version: result.version,
    stateHash: result.stateHash,
    vector: result.ruling?.probabilities ?? result.ruling?.vector ?? {},
    // what the row ruled, and how close it was: without these the line cannot be re-graded, re-banded or
    // told apart from a client bug later — the replay kept them and the live line did not (T5 review)
    ruled: result.ruling?.answer ?? null,
    option: result.ruling?.option ?? null,
    confidence: result.ruling?.confidence ?? null,
    closeCall: result.ruling?.closeCall ?? null,
    band: result.ruling?.band ?? null,
    threshold: result.thresholds ?? result.ruling?.thresholds ?? null,
    mode: result.mode,
    agreesWith,
    agreed,
    ...(label_rejected ? { label_rejected: true } : {}),
    // the state that was cut to fit, where the reading came from, and whether its price is an estimate
    cut: result.cut ?? [],
    source: result.source ?? null,
    tokens: result.tokens ?? null,
    tokens_estimated: result.tokens_estimated ?? null,
    usd: Number((result.usd ?? 0).toFixed(7)),
    ms: result.ms ?? null,
    // docs/15 §6: the raw body, so a vendor rename and a client bug do not look the same on a later read
    raw: result.raw ?? null,
    ...(result.unmeasured ? { unmeasured: true, reason: result.reason ?? null } : {}),
    ...(result.not_granted ? { not_granted: true } : {}),
  };
}

// What a row must beat before its agreement means anything (lab rule 1: counting is a script). Two
// predicates cost nothing and read no content: "pick the first alternative", since the asking agent tends
// to write its preference first, and "pick what the asking agent recommended". Over T5 the row agreed 2/6
// on hlab-a while both predicates scored 4/6, and no report counted them. items: { alternatives,
// recommend, answer } → hits and n per predicate, n being the items that carry what it reads.
export function freeBaselines(items) {
  const count = (pick) => {
    const scored = items.filter((x) => pick(x) != null && x.answer != null);
    return {
      hits: scored.filter((x) => normAnswer(pick(x)) === normAnswer(x.answer)).length,
      n: scored.length,
    };
  };
  return {
    first: count((x) => (x.alternatives?.length ? x.alternatives[0] : null)),
    recommended: count((x) => x.recommend || null),
  };
}
export const baselineText = (row, b) =>
  `row ${row.hits}/${row.n} · first-alternative ${b.first.hits}/${b.first.n} · recommended ${b.recommended.hits}/${b.recommended.n}`;

// Was every answer on this plan shadowed, and measured? Read from the plan's whole ledger, so a resumed
// run counts the readings of the processes before it (hlab-a t5a resumed twice and its in-memory list
// held none of the six readings, so the check vanished). Returns null only when the row is declared off
// for the app; otherwise the check exists even when nothing was asked, and says so. An unmeasured
// reading is not a measurement: no key, a spent budget or a dead API is red, never green.
export function shadowCoverage(lines, { enabled = true, row = 'question.answer' } = {}) {
  if (!enabled) return null;
  const answerLines = lines.filter((l) => l?.kind === 'answer' && l.data?.file);
  const answers = answerLines.map((l) => l.data);
  // an answer the harness refused is no label, whatever the reading line said when it was written
  // (hlab-b t5b Q-1 was graded DIFFERED against a ruling that never stood)
  const stood = new Map(answerLines.map((l) => [l.data, answerStood(l, lines)]));
  const jevs = lines.filter((l) => l?.kind === 'jev' && l.data?.row === row).map((l) => l.data);
  const free = [...jevs];
  const take = (pred) => {
    const i = free.findIndex(pred);
    return i < 0 ? null : free.splice(i, 1)[0];
  };
  // lines written before `file` travelled on them pair on the answer they were compared against
  const pairs = answers.map((a) => ({
    answer: a,
    jev:
      take((j) => j.file === a.file && j.wave === a.wave) ??
      take((j) => !j.file && j.agreesWith === `master:answer=${a.answer ?? null}`),
  }));
  const missing = pairs.filter((p) => !p.jev).map((p) => `w${p.answer.wave} ${p.answer.file}`);
  // a reading the authority refused (no spend grant, step 15) was never sent: it is the floor working,
  // named, not a missing or failed reading
  const notGranted = pairs.filter((p) => p.jev?.unmeasured && p.jev.not_granted);
  const unmeasured = pairs.filter((p) => p.jev?.unmeasured && !p.jev.not_granted);
  const measured = pairs.filter((p) => p.jev && !p.jev.unmeasured);
  const rejected = (p) => p.jev.label_rejected || !stood.get(p.answer);
  const graded = measured.filter(
    (p) => !rejected(p) && (p.jev.agreed === true || p.jev.agreed === false),
  );
  // the same graded points, scored by the free predicates, from the question each answer answered
  const asked = lines.filter((l) => l?.kind === 'question' && l.data?.file).map((l) => l.data);
  const questionOf = (a) =>
    asked.findLast((q) => q.file === a.file && q.wave === a.wave) ??
    asked.findLast((q) => q.file === a.file);
  const baselines = freeBaselines(
    graded.map((p) => ({ ...(questionOf(p.answer) || {}), answer: p.answer.answer })),
  );
  return {
    ok: !missing.length && !unmeasured.length,
    answers: answers.length,
    measured: measured.length,
    graded: graded.length,
    agreed: graded.filter((p) => p.jev.agreed).length,
    labelRejected: measured.filter(rejected).length,
    baselines,
    missing,
    unmeasured: unmeasured.map((p) => `w${p.answer.wave} ${p.answer.file} (${p.jev.reason})`),
    notGranted: notGranted.map((p) => `w${p.answer.wave} ${p.answer.file}`),
    usd: jevs.reduce((a, j) => a + (j.usd || 0), 0),
    pairs,
    isRejected: rejected,
  };
}
