#!/usr/bin/env node
// Reports this repo's .harness/stats.jsonl (written by the stats hook): per session, tools by name, files touched, wall time.
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
const bySession = {};
for (const r of rows) {
  const s = (bySession[r.session] ||= {
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
for (const [sid, s] of Object.entries(bySession)) {
  const mins = ((new Date(s.last) - new Date(s.first)) / 60000).toFixed(1);
  console.log(
    `${sid.slice(0, 8)}  ${mins} min  ${s.events} events  files: ${s.files.size}  tools: ${Object.entries(
      s.tools,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
}
if (process.argv.includes('--json'))
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(bySession).map(([k, v]) => [k, { ...v, files: [...v.files] }]),
      ),
      null,
      2,
    ),
  );
