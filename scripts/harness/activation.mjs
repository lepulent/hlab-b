// Pure rules for conducted activations (H-32, H-33): an agent's jurisdiction is checked and transcripts
// are read for tool use. The Master's decision is validated in gap.mjs (H-35). No I/O here,
// so every rule is a unit test.

export function rosterById(roster) {
  return new Map((roster?.agents || []).map((a) => [a.id, a]));
}

// paths from `git status --porcelain --untracked-files=all`, relative to the repo root
export function parsePorcelain(text) {
  return String(text || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p));
}

export function outsideJurisdiction(changed, owned) {
  const own = new Set(owned);
  return changed.filter((p) => !own.has(p));
}

// Claude Code keeps a session's transcript under ~/.claude/projects/<cwd with every non-alphanumeric
// character replaced by "-">/<session id>.jsonl
export function transcriptDir(home, cwd) {
  return `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

// tool name → count, from a transcript's JSONL; the witness is what the session did, not what it said
export function toolUses(jsonl) {
  const counts = {};
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const content = j?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content)
      if (b?.type === 'tool_use' && b.name) counts[b.name] = (counts[b.name] || 0) + 1;
  }
  return counts;
}

// paths a session wrote, from the file_path of its authoring tool calls, relative to the repo root: the
// witness that attributes a file to one of several sessions sharing a working tree
export function authoredPaths(jsonl, root) {
  const out = new Set();
  const prefix = root.endsWith('/') ? root : `${root}/`;
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const content = j?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const f = b?.type === 'tool_use' && FILE_TOOLS.includes(b.name) && b.input?.file_path;
      if (f) out.add(f.startsWith(prefix) ? f.slice(prefix.length) : f);
    }
  }
  return [...out].sort();
}
const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// two or more [start, end] windows share a moment when the latest start is before the earliest end
export function overlapSeconds(windows) {
  if (windows.length < 2) return 0;
  const start = Math.max(...windows.map((w) => w.start));
  const end = Math.min(...windows.map((w) => w.end));
  return Math.max(0, Math.round((end - start) / 100) / 10);
}

// the token series of a session from its transcript (NFR-16): every assistant message carries its usage,
// so a seat killed before it could report its cost is still metered in tokens. A message is counted once
// by its id, since a streamed message is written in several lines.
export function transcriptUsage(jsonl) {
  const seen = new Map();
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const u = j?.message?.usage;
    if (!u) continue;
    seen.set(j.message.id || j.uuid || seen.size, u);
  }
  const t = { input: 0, output: 0, cache_read: 0, cache_creation: 0, messages: seen.size };
  for (const u of seen.values()) {
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cache_read += u.cache_read_input_tokens || 0;
    t.cache_creation += u.cache_creation_input_tokens || 0;
  }
  return t;
}

export const AUTHORING_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];
export function authoringCalls(counts) {
  return AUTHORING_TOOLS.reduce((n, t) => n + (counts[t] || 0), 0);
}
