#!/usr/bin/env node
// PreToolUse for a room seat (step 16): every place a tool call names must lie under the seat's own
// folder or the shared one, given as arguments by room-run.mjs; the settings-hook adapter of the seat
// policy (scripts/harness/seat-policy.mjs seatRuling with reach). A denied call is written to the seat's
// footprint as an attempt. It FAILS CLOSED: a guard that cannot rule denies, because a read outside the
// partition cannot be taken back. HARNESS_FORCE_GUARD_THROW makes it throw, to prove it.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, input } from './_util.mjs';
import { seatRuling, deniedLine } from '../../scripts/harness/seat-policy.mjs';

const roots = process.argv.slice(2);
let ruling;
let data = {};
try {
  data = input();
  if (process.env.HARNESS_FORCE_GUARD_THROW) throw new Error('forced by HARNESS_FORCE_GUARD_THROW');
  ruling = roots.length
    ? seatRuling({
        tool: data.tool_name,
        input: data.tool_input,
        cwd: data.cwd || process.cwd(),
        root: ROOT,
        reach: roots,
      })
    : { allow: false, by: 'room-reach', reason: 'the guard was given no folders' };
} catch (err) {
  ruling = {
    allow: false,
    by: 'guard-failed',
    reason: `the reach guard could not rule (${String(err?.message || err).slice(0, 120)}), so the call is denied`,
  };
}
if (ruling.allow) process.exit(0);
try {
  const session = String(data.session_id || 'unknown').replace(/[^\w-]/g, '');
  const dir = join(ROOT, '.harness', 'footprint');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${session}.jsonl`),
    JSON.stringify({
      ts: new Date().toISOString(),
      ...deniedLine(data.tool_name, data.tool_input, ROOT, ruling),
    }) + '\n',
  );
} catch {
  /* the denial stands even when it cannot be recorded */
}
process.stderr.write(ruling.message || `room reach: ${ruling.reason}`);
process.exit(2);
