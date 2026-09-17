#!/usr/bin/env node
// Stop: list source files touched this session whose citing canon nodes were not touched. Advisory, never blocks.
import { join } from 'node:path';
import { input, out, readJson, stat, sessionTouched, ROOT } from './_util.mjs';
try {
  const data = input();
  if (data.stop_hook_active) process.exit(0);
  const t = sessionTouched(data.session_id);
  stat({ session: data.session_id, event: 'stop', file: null });
  if (!t.list.length) process.exit(0);
  const idx = readJson(join(ROOT, 'canon', 'index', 'pointers.json'), { byFile: {} });
  const canonTouched = t.list.filter((f) => f.startsWith('canon/'));
  const stale = [];
  for (const f of t.list)
    for (const p of idx.byFile[f] || []) {
      const nodeFile = (p.node || p.criterion) && Object.entries(idx.byFile).length ? null : null; // node file lookup lives in canon-graph; keep advisory by id
      if (!canonTouched.length) stale.push(`${f} → ${p.criterion || p.node}`);
    }
  const uniq = [...new Set(stale)];
  if (uniq.length)
    out({
      systemMessage: `[canon sweep] ${uniq.length} cited file(s) changed and no canon file was touched this session: ${uniq.slice(0, 6).join('; ')}${uniq.length > 6 ? ' …' : ''}. Run \`npm run canon:check\` before merging.`,
    });
} catch {
  /* fail open */
}
