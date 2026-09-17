#!/usr/bin/env node
// Pre-commit secret scanner: no dependencies, scans STAGED content only.
//
// Usage (installed by apply-quality.sh, prepended to .husky/pre-commit):
//   node scripts/quality/secret-scan.mjs
//
// Reads `git diff --cached --name-only --diff-filter=ACM` for the list of
// staged files, then reads each file's STAGED blob (`git show :<path>`) —
// not the working-tree copy — so a secret that was staged and then edited
// away in the working tree is still caught, and a secret only present in an
// unstaged edit is not a false alarm.
//
// Detects: AWS access key ids, private key headers, GitHub tokens
// (ghp_/gho_/github_pat_), OpenAI-style `sk-...` API keys, and the AWS secret
// key env var being assigned a literal value (see PATTERNS below).
//
// Exit codes: 0 = clean, 2 = at least one hit (printed as file:line).

import { execFileSync } from 'node:child_process';

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Gemfile.lock',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
]);

export const PATTERNS = [
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'private-key-header', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'github-token', re: /\b(?:ghp|gho)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'aws-secret-key-assignment', re: /AWS_SECRET_ACCESS_KEY\s*=\s*\S+/ },
];

export function isLockfile(filePath) {
  const base = filePath.split('/').pop() || filePath;
  return LOCKFILE_NAMES.has(base);
}

/** Heuristic binary check: a NUL byte in the sample means "not text". */
export function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

/** Returns [{line, id}] for every pattern hit in the given text content. */
export function scanContent(content) {
  const hits = [];
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const { id, re } of PATTERNS) {
      if (re.test(line)) hits.push({ line: index + 1, id });
    }
  }
  return hits;
}

function stagedFiles() {
  let output;
  try {
    output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return output.split('\n').filter((line) => line.trim().length > 0);
}

function readStagedBlob(filePath) {
  try {
    return execFileSync('git', ['show', `:${filePath}`], { maxBuffer: 1024 * 1024 * 50 });
  } catch {
    return null;
  }
}

function main() {
  const files = stagedFiles().filter((filePath) => !isLockfile(filePath));
  let hitCount = 0;

  for (const filePath of files) {
    const buffer = readStagedBlob(filePath);
    if (!buffer) continue;
    if (looksBinary(buffer)) continue;

    const content = buffer.toString('utf8');
    const hits = scanContent(content);
    for (const hit of hits) {
      hitCount += 1;
      process.stderr.write(`${filePath}:${hit.line}  [${hit.id}] possible secret staged\n`);
    }
  }

  if (hitCount > 0) {
    process.stderr.write(
      `secret-scan: ${hitCount} possible secret(s) staged. Remove them and re-stage before committing.\n`,
    );
    return 2;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
