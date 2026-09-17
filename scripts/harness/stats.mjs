#!/usr/bin/env node
// Reports .harness/stats.jsonl: rows come from the hooks (tool events per interactive session) and from
// the headless seats (review lenses, master rounds: minutes, cost, tokens, from claude -p JSON output, never estimated).
// Usage: node stats.mjs [--json] [--plan <slug>]   → per station and per seat: seats, minutes, cost, tokens in/out/cache
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './common.mjs';

const f = join(ROOT, '.harness', 'stats.jsonl');
if (!existsSync(f)) {
  console.log('no stats yet');
  process.exit(0);
}
const rows = readFileSync(f, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const num = (x) => (typeof x === 'number' ? x : 0);
const tok = (u) => ({
  in: num(u?.input_tokens),
  out: num(u?.output_tokens),
  cacheRead: num(u?.cache_read_input_tokens),
  cacheWrite: num(u?.cache_creation_input_tokens),
});

// seats: rows with a station (headless)
const stations = {};
for (const r of rows.filter((r) => r.station)) {
  const s = (stations[r.station] ||= {
    seats: 0,
    failed: 0,
    minutes: 0,
    cost_usd: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    last: null,
  });
  s.seats++;
  if (r.ok === false) s.failed++;
  s.minutes += num(r.minutes);
  s.cost_usd += num(r.cost_usd);
  const t = tok(r.tokens);
  for (const k of Object.keys(t)) s.tokens[k] += t[k];
  s.last = r.ts;
}
// interactive sessions: rows with a tool event and no station
const sessions = {};
for (const r of rows.filter((r) => !r.station)) {
  const s = (sessions[r.session] ||= {
    first: r.ts,
    last: r.ts,
    tools: {},
    files: new Set(),
    events: 0,
  });
  s.last = r.ts;
  s.events++;
  if (r.tool) s.tools[r.tool] = (s.tools[r.tool] || 0) + 1;
  if (r.file) s.files.add(r.file);
}

const total = Object.values(stations).reduce(
  (a, s) => ({
    minutes: a.minutes + s.minutes,
    cost_usd: a.cost_usd + s.cost_usd,
    seats: a.seats + s.seats,
  }),
  { minutes: 0, cost_usd: 0, seats: 0 },
);
if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        stations,
        total,
        sessions: Object.fromEntries(
          Object.entries(sessions).map(([k, v]) => [k, { ...v, files: [...v.files] }]),
        ),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (Object.keys(stations).length) {
  console.log('station        seats  failed  minutes   cost_usd   tokens in/out/cacheRead');
  for (const [name, s] of Object.entries(stations))
    console.log(
      `${name.padEnd(14)} ${String(s.seats).padStart(5)}  ${String(s.failed).padStart(6)}  ${s.minutes.toFixed(1).padStart(7)}  ${s.cost_usd.toFixed(3).padStart(9)}   ${s.tokens.in}/${s.tokens.out}/${s.tokens.cacheRead}`,
    );
  console.log(
    `total          ${String(total.seats).padStart(5)}          ${total.minutes.toFixed(1).padStart(7)}  ${total.cost_usd.toFixed(3).padStart(9)}`,
  );
}
for (const [sid, s] of Object.entries(sessions)) {
  const mins = ((new Date(s.last) - new Date(s.first)) / 60000).toFixed(1);
  console.log(
    `session ${String(sid).slice(0, 8)}  ${mins} min  ${s.events} events  files: ${s.files.size}  tools: ${Object.entries(
      s.tools,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
}
