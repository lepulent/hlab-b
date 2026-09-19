#!/usr/bin/env node
// PreToolUse (Mycelium FR-17, D-3, NFR-8): a department veto enforced at the tool-call boundary. A call
// that matches a veto in canon/departments.json is denied (exit 2) with the department's stated reason,
// which the seat receives; permission mode does not change this. The denial is written to the seat's
// footprint, so the record shows the guarded action was attempted. Any error fails open.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, input, relOf } from './_util.mjs';
import { matchVeto } from '../../scripts/harness/department.mjs';

let data = {};
let veto = null;
let target = null;
try {
  data = input();
  const i = data.tool_input || {};
  target = relOf(i.file_path || i.notebook_path || i.path);
  const departments = JSON.parse(readFileSync(join(ROOT, 'canon', 'departments.json'), 'utf8'));
  veto = matchVeto(departments, data.tool_name, target);
} catch {
  process.exit(0);
}
if (!veto) process.exit(0);
try {
  const session = String(data.session_id || 'unknown').replace(/[^\w-]/g, '');
  const dir = join(ROOT, '.harness', 'footprint');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${session}.jsonl`),
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: data.tool_name,
      target,
      denied: veto.id,
      department: veto.department,
      reason: veto.reason,
    }) + '\n',
  );
} catch {
  /* the denial holds even if it cannot be recorded */
}
process.stderr.write(
  `Denied by the ${veto.department} department (${veto.id}): ${veto.reason} Do not try another way to reach ${target}; if your work needs it, raise a question naming this veto.`,
);
process.exit(2);
