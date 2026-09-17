#!/usr/bin/env node
// Husky pre-push guard: refuses a direct push to main unless ALLOW_MAIN_PUSH=1 (H-30).
// Merges reach main only through the merge script (`gh pr merge --squash`); the boilerplate phase
// and reset-lab.sh set the variable explicitly. Reads the ref lines git gives a pre-push hook on stdin.
import { readFileSync } from 'node:fs';

if (process.env.ALLOW_MAIN_PUSH === '1') process.exit(0);
let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
const toMain = input
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length === 4 && p[2] === 'refs/heads/main' && p[1] !== '0'.repeat(40));
if (toMain.length) {
  console.error(
    'main-guard: direct pushes to main are refused; open a PR and let the merge script land it. ' +
      'Boilerplate or reset work: ALLOW_MAIN_PUSH=1 git push ...',
  );
  process.exit(1);
}
