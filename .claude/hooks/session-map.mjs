#!/usr/bin/env node
// SessionStart: inject the canon map glance, the app status and the yolo dial. Never more than ~60 lines.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, input, out, readJson, stat } from './_util.mjs';
try {
  const data = input();
  const h = readJson(join(ROOT, 'harness.json'), {});
  const mapPath = join(ROOT, 'canon', 'MAP.md');
  const map = existsSync(mapPath)
    ? readFileSync(mapPath, 'utf8').split('\n').slice(0, 40).join('\n')
    : '(no canon map yet)';
  const ctx = [
    `[harness] app ${h.app?.name ?? '?'} status=${h.app?.status ?? '?'} · yolo mode=${h.yolo?.mode ?? '?'} rounds=${h.yolo?.rounds ?? '?'} locked=${h.yolo?.locked ?? false}`,
    `[harness] stop_on: ${(h.yolo?.stop_on || []).join(', ')}`,
    `[harness] canon map glance:`,
    map,
  ].join('\n');
  stat({ session: data.session_id, event: 'session-start' });
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } });
} catch {
  /* fail open */
}
