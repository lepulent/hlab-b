// Pure rules for relay (H-33 step 5): what one wave hands to the next Master call and to the next
// agents is a digest built by a script, capped in size, and recorded; never the whole history. No I/O here.

const oneLine = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim();

// waves: [{ n, activations: [{ agent, task, written: [path], commit, summary }],
//           questions: [{ file, agent, question, verdict, answer }] }]
// The digest lists what exists and what was decided, newest wave last; documents are named with their
// commit so a reader can open exactly what was relayed. Over the cap, the oldest lines go first and the
// cut is recorded.
export function buildDigest(waves, cap) {
  const blocks = [];
  const latest = new Map(); // a document rewritten in a later wave is relayed at its latest commit
  for (const w of waves) {
    const lines = [`Wave ${w.n}:`];
    for (const a of w.activations) {
      lines.push(
        `- ${a.agent} (task: ${oneLine(a.task)}) wrote ${a.written.join(', ') || 'nothing'}${a.commit ? ` at ${a.commit.slice(0, 7)}` : ''}. It reported: ${oneLine(a.summary)}`,
      );
      for (const p of a.written)
        latest.set(p, { path: p, agent: a.agent, commit: a.commit || null });
    }
    for (const q of w.questions || [])
      lines.push(
        `- ${q.file} asked by ${q.agent}: ${oneLine(q.question)} → ${q.answer ? `answered by the Master: ${oneLine(q.answer)}` : `decider ${q.verdict}, unanswered`}`,
      );
    blocks.push(lines.join('\n'));
  }
  let text = blocks.join('\n\n');
  let truncated = false;
  while (text.length > cap && blocks.length > 1) {
    blocks.shift();
    truncated = true;
    text = `(earlier waves cut to fit ${cap} characters)\n\n${blocks.join('\n\n')}`;
  }
  if (text.length > cap) {
    text = text.slice(0, cap);
    truncated = true;
  }
  return { text, chars: text.length, truncated, sources: [...latest.values()] };
}

// paths a session touched with the given tools, from the file_path of its tool calls, relative to root
export function toolPaths(jsonl, root, tools) {
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
      const f = b?.type === 'tool_use' && tools.includes(b.name) && b.input?.file_path;
      if (f) out.add(f.startsWith(prefix) ? f.slice(prefix.length) : f);
    }
  }
  return [...out].sort();
}

// an agent consumed its relay when it opened at least one relayed document it does not own; an agent
// with nothing relayed to it (wave 1, or only its own files upstream) has nothing to consume
export function relayConsumed(relayed, owned, read) {
  const upstream = relayed.filter((p) => !owned.includes(p));
  if (!upstream.length) return { needed: false, ok: true, upstream, opened: [] };
  const opened = upstream.filter((p) => read.includes(p));
  return { needed: true, ok: opened.length > 0, upstream, opened };
}
