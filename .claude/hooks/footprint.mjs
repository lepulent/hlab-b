#!/usr/bin/env node
// PostToolUse (Mycelium FR-16, 14.5): the first witness of a seat, the settings-hook adapter of the seat
// policy's footprintLine. Every tool call a session makes is appended to
// .harness/footprint/<session>.jsonl as {tool, target} by this hook, never by the model. The
// orchestrator joins it with the state diff (the second witness) into the ActivationRecord.
// Fails open: a witness must never break the seat it observes (a guard fails closed; a witness does not).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, input } from './_util.mjs';
import { footprintLine } from '../../scripts/harness/seat-policy.mjs';

try {
  const data = input();
  const session = String(data.session_id || 'unknown').replace(/[^\w-]/g, '');
  const dir = join(ROOT, '.harness', 'footprint');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${session}.jsonl`),
    JSON.stringify({
      ts: new Date().toISOString(),
      ...footprintLine(data.tool_name, data.tool_input, ROOT),
    }) + '\n',
  );
} catch {
  /* fail open */
}
process.exit(0);
