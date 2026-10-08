#!/usr/bin/env node
// PreToolUse (Mycelium FR-17, D-3, NFR-8): a department veto enforced at the tool-call boundary, the
// settings-hook adapter of the seat policy (scripts/harness/seat-policy.mjs seatRuling). A call that
// matches a veto in canon/departments.json is denied (exit 2) with the department's stated reason, which
// the seat receives; permission mode does not change this. The denial is written to the seat's
// footprint, so the record shows the guarded action was attempted. Since step 17 it FAILS CLOSED, as the
// adapter contract requires: a guard that cannot rule (an unreadable call, an unreadable policy, its own
// error) denies. HARNESS_FORCE_GUARD_THROW is a lab lever that makes the guard throw, to prove it.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, input } from './_util.mjs';
import { seatRuling, deniedLine } from '../../scripts/harness/seat-policy.mjs';

let data = {};
let ruling;
try {
  data = input();
  if (process.env.HARNESS_FORCE_GUARD_THROW) throw new Error('forced by HARNESS_FORCE_GUARD_THROW');
  const departments = JSON.parse(readFileSync(join(ROOT, 'canon', 'departments.json'), 'utf8'));
  ruling = seatRuling({
    tool: data.tool_name,
    input: data.tool_input,
    cwd: data.cwd || process.cwd(),
    root: ROOT,
    departments,
  });
} catch (err) {
  ruling = {
    allow: false,
    by: 'guard-failed',
    reason: `the veto guard could not rule (${String(err?.message || err).slice(0, 120)}), so the call is denied`,
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
  /* the denial holds even if it cannot be recorded */
}
process.stderr.write(ruling.message || `Denied: ${ruling.reason}`);
process.exit(2);
