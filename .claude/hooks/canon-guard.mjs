#!/usr/bin/env node
// PreToolUse (Write|Edit|MultiEdit): refuse hand edits to generated canon, records and the ledger; require frontmatter id on authored canon files.
import { ROOT, input, out, relOf, stat } from './_util.mjs';
try {
  const data = input();
  const f = relOf(data.tool_input?.file_path);
  if (!f) process.exit(0);
  const deny = (reason) => {
    stat({ session: data.session_id, event: 'guard-deny', tool: data.tool_name, file: f });
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
    process.exit(0);
  };
  if (/^canon\/generated\//.test(f) || /^canon\/index\//.test(f))
    deny(`${f} is generated. Edit the source and run \`npm run canon:graph\` instead.`);
  if (/^records\//.test(f))
    deny(`${f} is a record of a merged plan. Records are history and are never edited.`);
  if (/^ledger\//.test(f))
    deny(`${f} is the ledger. Append through \`node scripts/harness/ledger.mjs append ...\`.`);
  if (/^canon\/.*\.md$/.test(f) && data.tool_name === 'Write') {
    const c = data.tool_input?.content || '';
    if (!/^---\n[\s\S]*?\bid:\s*\S+[\s\S]*?\n---/.test(c))
      deny(`${f}: a canon file needs frontmatter with at least \`id\` and \`kind\`.`);
  }
} catch {
  /* fail open */
}
