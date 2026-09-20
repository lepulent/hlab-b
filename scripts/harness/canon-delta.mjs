// Typed canon deltas and derived semver (Mycelium E10.S2 `spec-deltas.ts`, E8.S3 `semver-deriver.ts`;
// lab H-1: deltas land at merge). A capability node is the lab's spec shard: its criteria are the
// committed contract. What a plan did to that contract is not asserted by any seat — it is read from the
// node as it stood at the seal base and as it stands at the merge, typed into the four ops, and the
// version bump follows from the ops by table. A version an agent typed is never trusted: land derives it,
// writes the derived one, and records the disagreement. Pure: the caller passes text and facts.
//
//   ADDED            a criterion that did not exist            → MINOR
//   MODIFIED         its sentence changed (the contract text)  → MAJOR when committed, else MINOR
//   REMOVED          it is gone; needs a reason and migration  → MAJOR when committed, else MINOR
//   RENAMED          the same sentence under a new id          → MINOR, never breaking
//   TEST_BINDING_FIX only its bindings or pointers changed     → PATCH

export const OPS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED', 'TEST_BINDING_FIX'];
export const BUMPS = ['NONE', 'PATCH', 'MINOR', 'MAJOR'];
const RANK = { NONE: 0, PATCH: 1, MINOR: 2, MAJOR: 3 };

// Mycelium's vertical axis, coarse to fine. A delta carries the altitude of what it changed, so a
// landing says at which height the system moved, not only which file did.
export const ALTITUDES = ['constitution', 'department', 'domain', 'capability', 'code'];

export function altitudeOf(path) {
  const p = String(path || '');
  if (/^canon\/constitution\.md$/.test(p)) return 'constitution';
  if (/^canon\/departments\.json$/.test(p)) return 'department';
  if (/^canon\/domains\/.+\.md$/.test(p)) return 'domain';
  if (/^canon\/capabilities\/.+\.md$/.test(p)) return 'capability';
  if (/^(src|api|tests|e2e)\//.test(p)) return 'code';
  return null;
}

export function maxBump(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

export function parseVersion(raw) {
  const s = String(raw ?? '').trim();
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(s);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}
export const formatVersion = (v) => v.join('.');

export function applyBump(version, bump) {
  const [major, minor, patch] = version;
  if (bump === 'MAJOR') return [major + 1, 0, 0];
  if (bump === 'MINOR') return [major, minor + 1, 0];
  if (bump === 'PATCH') return [major, minor, patch + 1];
  return [major, minor, patch];
}

// ---------------------------------------------------------------- reading a node
// A capability file: frontmatter, `## Criteria` with `### <id> <sentence>` headings, each followed by
// `bindings: [...]` and a `pointers:` list, and an optional `## Superseded` list that carries the reason
// and the migration for anything the plan removed.
const SUPERSEDED =
  /^-\s*([A-Z]+-[\d.]+)\s*[-—–:]*\s*reason:\s*(.+?)\s*[·;|]\s*migration:\s*(.+?)\s*$/i;

export function parseNode(text) {
  const src = String(text || '');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const front = {};
  if (fm)
    for (const line of fm[1].split('\n')) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (m) front[m[1]] = m[2].trim();
    }
  const body = fm ? src.slice(fm[0].length) : src;
  const criteria = [];
  const blocks = body.split(/^### /m).slice(1);
  for (const b of blocks) {
    const [head, ...rest] = b.split('\n');
    const m = /^(\S+)\s*(.*)$/.exec(head.trim());
    if (!m) continue;
    const text = rest.join('\n');
    const bindings = [
      ...(/^bindings:\s*\[(.*?)\]/m.exec(text)?.[1] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    const pointers = [...text.matchAll(/^-\s+(\S+#\S+)\s*$/gm)].map((x) => x[1]);
    criteria.push({ id: m[1], sentence: m[2].trim(), bindings, pointers });
  }
  const superseded = [...body.matchAll(new RegExp(SUPERSEDED, 'gim'))].map((m) => ({
    id: m[1],
    reason: m[2].trim(),
    migration: m[3].trim(),
  }));
  return {
    id: front.id || null,
    kind: front.kind || null,
    title: front.title || '',
    version: parseVersion(front.version),
    declaredVersion: front.version ?? null,
    assurance: front.assurance || 'draft',
    valid_from: front.valid_from || null,
    valid_to: front.valid_to || null,
    criteria,
    superseded,
  };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- typing the change
// before: the node as it stood at the seal base (null when the plan created it); after: as it stands at
// the merge (null when the plan deleted it). `committed` answers, for a criterion id, whether it was part
// of the durable contract before this plan — only a committed criterion can break.
export function diffNode(before, after, { committed = () => false } = {}) {
  const changes = [];
  const refusals = [];
  if (!after) {
    return {
      op: 'REMOVED',
      node: before?.id || null,
      changes: (before?.criteria || []).map((c) => ({
        op: 'REMOVED',
        id: c.id,
        committed: committed(c.id),
      })),
      refusals: ['the whole node was removed; canon keeps retired nodes with a valid_to'],
      ok: false,
    };
  }
  const was = new Map((before?.criteria || []).map((c) => [c.id, c]));
  const now = new Map(after.criteria.map((c) => [c.id, c]));
  const gone = [...was.values()].filter((c) => !now.has(c.id));
  const fresh = [...now.values()].filter((c) => !was.has(c.id));
  const renamedFrom = new Set();
  for (const c of fresh) {
    // the same sentence under a new id is a rename, not a removal followed by an addition
    const from = gone.find((g) => !renamedFrom.has(g.id) && g.sentence === c.sentence);
    if (from) {
      renamedFrom.add(from.id);
      changes.push({ op: 'RENAMED', id: c.id, from: from.id, committed: committed(from.id) });
    } else {
      changes.push({ op: 'ADDED', id: c.id, committed: false });
    }
  }
  for (const c of gone) {
    if (renamedFrom.has(c.id)) continue;
    const note = after.superseded.find((s) => s.id === c.id);
    if (!note)
      refusals.push(
        `REMOVED ${c.id}: no reason and migration under "## Superseded" in ${after.id || 'the node'}`,
      );
    changes.push({
      op: 'REMOVED',
      id: c.id,
      committed: committed(c.id),
      reason: note?.reason || null,
      migration: note?.migration || null,
    });
  }
  for (const c of now.values()) {
    const b = was.get(c.id);
    if (!b) continue;
    if (b.sentence !== c.sentence)
      changes.push({
        op: 'MODIFIED',
        id: c.id,
        committed: committed(c.id),
        breaking: true,
        was: b.sentence,
      });
    else if (!sameList(b.bindings, c.bindings) || !sameList(b.pointers, c.pointers))
      changes.push({ op: 'TEST_BINDING_FIX', id: c.id, committed: committed(c.id) });
  }
  const nodeOp = !before ? 'ADDED' : changes.length ? 'MODIFIED' : 'UNCHANGED';
  return { op: nodeOp, node: after.id, changes, refusals, ok: !refusals.length };
}

// the bump one typed change implies (ported table, no judgement)
export function changeBump(change) {
  switch (change.op) {
    case 'TEST_BINDING_FIX':
      return 'PATCH';
    case 'ADDED':
      return 'MINOR';
    case 'RENAMED':
      return 'MINOR';
    case 'REMOVED':
      return change.committed ? 'MAJOR' : 'MINOR';
    case 'MODIFIED':
      return change.committed && change.breaking ? 'MAJOR' : 'MINOR';
    default:
      return 'NONE';
  }
}

export function deriveBump(changes) {
  let bump = 'NONE';
  for (const c of changes) bump = maxBump(bump, changeBump(c));
  return bump;
}

// the whole landing: one node's typed delta, its derived version, and whether the file's own `version:`
// agreed. The declared one is never used — a disagreement is a finding, the derived value is written.
export function nodeDelta({ file, before, after, committed }) {
  const diff = diffNode(before, after, { committed });
  const bump = deriveBump(diff.changes);
  const from = before ? before.version : [0, 0, 0];
  const version = applyBump(from, bump);
  const declared = after ? after.declaredVersion : null;
  const mislabel =
    declared != null && formatVersion(parseVersion(declared)) !== formatVersion(version)
      ? { declared: String(declared), derived: formatVersion(version) }
      : null;
  return {
    file,
    node: diff.node,
    altitude: altitudeOf(file),
    op: diff.op,
    changes: diff.changes,
    bump,
    version: formatVersion(version),
    from: formatVersion(from),
    mislabel,
    refusals: diff.refusals,
    ok: diff.ok,
  };
}

// the product bump of a landing is the strongest of its nodes (E8.S3 `deriveProductSemver`)
export function landingBump(deltas) {
  let bump = 'NONE';
  for (const d of deltas) bump = maxBump(bump, d.bump || 'NONE');
  return bump;
}

// ---------------------------------------------------------------- version history
// Files are mutated in place, so the superseded version of a node exists only in git. The history is
// therefore kept as rows: the new version opens at the merge sha, and the row it replaced closes there.
// Append-only — a landing adds rows and stamps `valid_to`, it never rewrites one.
export function supersede(rows, { node, version, bump, altitude, plan, mergeSha, changes = [] }) {
  const out = rows.map((r) =>
    r.node === node && !r.valid_to ? { ...r, valid_to: mergeSha } : { ...r },
  );
  out.push({
    node,
    altitude,
    version,
    bump,
    plan,
    valid_from: mergeSha,
    valid_to: null,
    changes: changes.map((c) => ({ op: c.op, id: c.id, ...(c.from ? { from: c.from } : {}) })),
  });
  return out;
}

// what a landing is allowed to do to the history: rows already closed stay closed, and every row that
// was open for a node the landing did not touch stays open
export function historyOk(before, after) {
  const problems = [];
  for (const [i, row] of before.entries()) {
    const now = after[i];
    if (!now) return ['a row was dropped from the history'];
    if (now.node !== row.node || now.version !== row.version || now.valid_from !== row.valid_from)
      problems.push(`row ${i} (${row.node} ${row.version}) was rewritten`);
    if (row.valid_to && now.valid_to !== row.valid_to)
      problems.push(
        `row ${i} (${row.node} ${row.version}) was closed at ${row.valid_to}, now ${now.valid_to}`,
      );
  }
  return problems;
}
