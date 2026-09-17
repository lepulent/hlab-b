#!/usr/bin/env node
// PostToolUse (Write|Edit|MultiEdit|Bash): after a source change, name the canon nodes that cite the touched file, and record the touch.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, input, out, readJson, stat, touchedFiles, sessionTouched } from './_util.mjs';
try {
  const data = input();
  const files = touchedFiles(data).filter((f) => f && !f.startsWith('.harness/'));
  stat({ session: data.session_id, event: 'tool', tool: data.tool_name, file: files[0] || null });
  if (!files.length) process.exit(0);
  const idx = readJson(join(ROOT, 'canon', 'index', 'pointers.json'), { byFile: {} });
  const notes = [];
  const t = sessionTouched(data.session_id);
  for (const f of files) {
    if (!t.list.includes(f)) t.list.push(f);
    const ptrs = idx.byFile[f] || [];
    if (ptrs.length)
      notes.push(
        `${f} is cited by ${[...new Set(ptrs.map((p) => p.criterion || p.node))].join(', ')}; if behaviour changed, the criterion or its bindings must change in the same plan.`,
      );
  }
  writeFileSync(t.path, JSON.stringify(t.list));
  if (notes.length)
    out({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '[canon impact] ' + notes.join(' '),
      },
    });
} catch {
  /* fail open */
}
