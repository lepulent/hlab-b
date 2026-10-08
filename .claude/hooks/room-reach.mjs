#!/usr/bin/env node
// PreToolUse for a room seat (step 16): every place a tool call names must lie under the seat's own
// folder or the shared one, given as arguments by room-run.mjs (room.mjs reachRuling). A denied call is
// written to the seat's footprint as denied, so the record shows the attempt. Unlike the other hooks this
// one FAILS CLOSED: a guard that cannot rule denies, because a read outside the partition cannot be
// taken back.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, input } from './_util.mjs';
import { reachRuling } from '../../scripts/harness/room.mjs';

const roots = process.argv.slice(2);
let ruling;
let data = {};
try {
  data = input();
  ruling = roots.length
    ? reachRuling(data.tool_name, data.tool_input, data.cwd || process.cwd(), roots)
    : { allow: false, reason: 'the guard was given no folders' };
} catch {
  ruling = { allow: false, reason: 'the reach guard failed, so the call is denied' };
}
if (ruling.allow) process.exit(0);
try {
  const session = String(data.session_id || 'unknown').replace(/[^\w-]/g, '');
  const dir = join(ROOT, '.harness', 'footprint');
  mkdirSync(dir, { recursive: true });
  const i = data.tool_input || {};
  appendFileSync(
    join(dir, `${session}.jsonl`),
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: data.tool_name || null,
      target: i.file_path || i.path || i.pattern || null,
      denied: 'room-reach',
      reason: ruling.reason,
    }) + '\n',
  );
} catch {
  /* the denial stands even when it cannot be recorded */
}
process.stderr.write(`room reach: ${ruling.reason}`);
process.exit(2);
