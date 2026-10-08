// Step 17: the seat policies every adapter enforces, in one module that imports NOTHING, so the same
// rules run in a settings hook (Node), in the runner, and inside a mod's own environment (no Node, no
// DOM), where install-bundle.sh copies this file. Pure: what the caller passes in, a ruling out.
//
//   matchVeto     a department veto at the call (Mycelium departments.ts, FR-17, D-3)
//   reachRuling   a room seat held to its two folders (step 16, 44a04d9)
//   footprintLine what the witness records of a call that ran (Mycelium FR-16, 14.5)
//   seatRuling    the one ruling an adapter asks for: reach first, then the veto
//
// The adapter contract (adapter-contract.mjs) is what an adapter must do with these: deny at the call
// with the ruling's message, record the denial as an attempt, record every call that ran, and FAIL
// CLOSED when it cannot rule.

export function globToRegex(glob) {
  // tokens first so the expansions of ** and * never feed each other
  const t = glob
    .replace(/\*\*\//g, '\u{1F}A')
    .replace(/\*\*/g, '\u{1F}B')
    .replace(/\*/g, '\u{1F}C');
  const esc = t.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  const re = esc
    .split('\u{1F}A')
    .join('(?:.*/)?')
    .split('\u{1F}B')
    .join('.*')
    .split('\u{1F}C')
    .join('[^/]*');
  return new RegExp('^' + re + '$');
}

// the first veto of any department that forbids this tool on this target, or null
export function matchVeto(departments, tool, target) {
  if (!tool || !target) return null;
  for (const d of departments?.departments || [])
    for (const v of d.vetoes || [])
      if (
        (v.tools || []).includes(tool) &&
        (v.targets || []).some((g) => globToRegex(g).test(String(target)))
      )
        return { department: d.name, id: v.id, reason: v.reason };
  return null;
}

// Reach at the call: every place a tool call names lies under the seat's own folder or the shared one.
// The CLI does not hold this: read-only tools run outside the folders a seat was given (hlab-a and
// hlab-b r16b, round 1: each seat's Glob over the workspace root listed the other seat's note and the
// orchestrator's manifest). A path, a pattern's fixed prefix (resolved from its base) and a Grep glob are
// all places; a `..` in a pattern or glob is refused, since its place is not known until it runs.
const GLOB_CHARS = /[*?[{]/;
export function reachRuling(tool, input, cwd, roots) {
  // a call the guard cannot read is a call it cannot rule on: denied (a malformed hook input parses to {})
  if (!tool || !cwd || !roots?.length)
    return { allow: false, reason: 'the call cannot be read, so it is denied' };
  const i = input || {};
  const inside = (p) => roots.some((r) => p === r || p.startsWith(`${r}/`));
  const base = i.path ? resolvePath(cwd, i.path) : cwd;
  const places = [i.file_path, i.notebook_path].filter(Boolean).map((p) => resolvePath(cwd, p));
  if (i.path) places.push(base);
  for (const pat of tool === 'Glob' ? [i.pattern] : [i.glob]) {
    if (!pat) continue;
    if (/(^|\/)\.\.(\/|$)/.test(pat))
      return { allow: false, reason: `the pattern ${pat} climbs out with ..` };
    const fixed =
      String(pat)
        .split(GLOB_CHARS)[0]
        .replace(/\/[^/]*$/, '') || '.';
    places.push(resolvePath(base, fixed));
  }
  const outside = places.find((p) => !inside(p));
  return outside
    ? { allow: false, reason: `${outside} is outside this seat's folders` }
    : { allow: true };
}
// a pure path resolve: this module imports nothing, so a mod's environment (no Node) can carry it
function resolvePath(from, p) {
  const parts = (String(p).startsWith('/') ? String(p) : `${from}/${p}`).split('/');
  const out = [];
  for (const x of parts) {
    if (!x || x === '.') continue;
    if (x === '..') out.pop();
    else out.push(x);
  }
  return `/${out.join('/')}`;
}

// the place a call names, relative to the app root when under it (the footprint hook's relOf)
export function relOf(p, root) {
  if (!p) return null;
  const s = String(p).split('\\').join('/');
  return root && s.startsWith(`${root}/`) ? s.slice(root.length + 1) : s;
}
// what the witness records of a call that ran: its tool and the one place it names
export function footprintLine(tool, input, root) {
  const i = input || {};
  const target =
    relOf(i.file_path || i.notebook_path || i.path, root) ||
    i.pattern ||
    (i.command ? String(i.command).slice(0, 200) : null) ||
    i.url ||
    null;
  return { tool: tool || null, target };
}

// The one ruling an adapter asks for. A call it cannot read is denied (a malformed hook input parses to
// {}). Reach first, when the seat is held to folders; then the departments' vetoes on the root-relative
// target. The message is what the seat receives.
export function seatRuling({ tool, input, cwd, root, departments = null, reach = null } = {}) {
  if (!tool)
    return { allow: false, by: 'unreadable', reason: 'the call cannot be read, so it is denied' };
  if (reach) {
    const r = reachRuling(tool, input, cwd, reach);
    if (!r.allow)
      return {
        allow: false,
        by: 'room-reach',
        reason: r.reason,
        message: `room reach: ${r.reason}`,
      };
  }
  if (departments) {
    const i = input || {};
    const target = relOf(i.file_path || i.notebook_path || i.path, root);
    const v = matchVeto(departments, tool, target);
    if (v)
      return {
        allow: false,
        by: 'veto',
        id: v.id,
        department: v.department,
        reason: v.reason,
        target,
        message: `Denied by the ${v.department} department (${v.id}): ${v.reason} Do not try another way to reach ${target}; if your work needs it, raise a question naming this veto.`,
      };
  }
  return { allow: true };
}
// the footprint line of a denied call: an attempt, recorded, never a write
export function deniedLine(tool, input, root, ruling) {
  const base = footprintLine(tool, input, root);
  return ruling.by === 'veto'
    ? {
        ...base,
        target: ruling.target ?? base.target,
        denied: ruling.id,
        department: ruling.department,
        reason: ruling.reason,
      }
    : { ...base, denied: ruling.by, reason: ruling.reason };
}
