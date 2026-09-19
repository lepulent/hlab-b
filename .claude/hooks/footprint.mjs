#!/usr/bin/env node
// PostToolUse (Mycelium FR-16, 14.5): the first witness of a seat. Every tool call a session makes is
// appended to .harness/footprint/<session>.jsonl as {tool, target} by this hook, never by the model.
// The orchestrator joins it with the state diff (the second witness) into the ActivationRecord.
// Fails open: a hook must never break the seat it observes.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, input, relOf } from './_util.mjs';

try {
  const data = input();
  const session = String(data.session_id || 'unknown').replace(/[^\w-]/g, '');
  const i = data.tool_input || {};
  const target =
    relOf(i.file_path || i.notebook_path || i.path) ||
    i.pattern ||
    (i.command ? String(i.command).slice(0, 200) : null) ||
    i.url ||
    null;
  const dir = join(ROOT, '.harness', 'footprint');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${session}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), tool: data.tool_name || null, target }) + '\n',
  );
} catch {
  /* fail open */
}
process.exit(0);
