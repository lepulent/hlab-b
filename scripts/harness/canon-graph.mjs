#!/usr/bin/env node
// Emits the canon graph, the pointer index, and (when present) merges the system graph into one graph.json.
// Also regenerates the generated section of canon/MAP.md when run with --map.
// Reads: canon/**/*.md (frontmatter + criteria), src|api|tests `// canon: CAP-n.k` tags, canon/generated/system-graph.json
// Writes: canon/generated/canon-graph.json, canon/index/pointers.json, canon/generated/graph.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, parseFrontmatter, rel, readJson, writeJson, layerOf } from './common.mjs';

const EDGE_LISTS = [
  'binds',
  'requires',
  'provides',
  'preserves',
  'governs',
  'concerns',
  'contains',
  'supersedes',
  'derived_from',
];
const nodes = new Map();
const edges = [];
const pointers = []; // {node, criterion, file, symbol, range, blob}
const addNode = (n) => {
  if (!nodes.has(n.id)) nodes.set(n.id, n);
  return nodes.get(n.id);
};
const addEdge = (source, target, type, extra = {}) =>
  edges.push({ source, target, type, confidence: 'EXTRACTED', ...extra });

for (const p of walk(join(ROOT, 'canon'), { skip: ['generated', 'index'] })) {
  if (!p.endsWith('.md')) continue;
  const text = readFileSync(p, 'utf8');
  const { data, body } = parseFrontmatter(text);
  if (!data.id) continue;
  const node = addNode({
    id: data.id,
    kind: data.kind || 'doc',
    label: data.title || data.id,
    file: rel(p),
    assurance: data.assurance ?? null,
    version: data.version ?? null,
    valid_from: data.valid_from ?? null,
    valid_to: data.valid_to ?? null,
  });
  for (const key of EDGE_LISTS) for (const t of data[key] || []) addEdge(data.id, t, key);
  // criteria: ### CAP-n.k sentence ; following lines: bindings: [...] ; pointers: ; - path#symbol:a-b@blob
  const lines = body.split('\n');
  let crit = null;
  for (const line of lines) {
    const h = /^###\s+([A-Z]+-\d+\.\d+)\s+(.*)$/.exec(line);
    if (h) {
      crit = h[1];
      addNode({ id: crit, kind: 'criterion', label: h[2].trim(), file: rel(p), parent: data.id });
      addEdge(data.id, crit, 'contains');
      continue;
    }
    if (!crit) continue;
    const b = /^bindings:\s*\[(.*)\]/.exec(line.trim());
    if (b) {
      for (const x of b[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        addNode({ id: x, kind: x.startsWith('gate:') ? 'check' : 'coverage-row', label: x });
        addEdge(x, crit, 'tests');
      }
      continue;
    }
    const ptr = /^-\s+([^#\s]+)#([^:\s]+)(?::(\d+-\d+))?(?:@([0-9a-f]+))?\s*$/.exec(line.trim());
    if (ptr) {
      pointers.push({
        node: node.id,
        criterion: crit,
        file: ptr[1],
        symbol: ptr[2],
        range: ptr[3] || null,
        blob: ptr[4] || null,
      });
      addEdge(crit, `file:${ptr[1]}#${ptr[2]}`, 'implements');
      addNode({ id: `file:${ptr[1]}#${ptr[2]}`, kind: 'symbol', label: ptr[2], file: ptr[1] });
    }
  }
  // principles: ### C-n ... with "- check:" lines
  if (data.kind === 'constitution') {
    let pr = null;
    for (const line of lines) {
      const h = /^###\s+(C-\d+)\s+(.*)$/.exec(line);
      if (h) {
        pr = h[1];
        addNode({ id: pr, kind: 'principle', label: h[2].trim(), file: rel(p) });
        addEdge(data.id, pr, 'contains');
        continue;
      }
      const c = /^-\s+check:\s*(\S+)/.exec(line.trim());
      if (pr && c) {
        addNode({ id: 'check:' + c[1], kind: 'check', label: c[1] });
        addEdge(pr, 'check:' + c[1], 'enforced_by');
      }
      const t = /^-\s+tier:\s*(\S+)/.exec(line.trim());
      if (pr && t) nodes.get(pr).tier = t[1];
      const bf = /^-\s+binds_from:\s*(\S+)/.exec(line.trim());
      if (pr && bf) nodes.get(pr).binds_from = bf[1];
    }
  }
}
// source tags: // canon: CAP-n.k  (and #, -- for other languages)
const tagRe = /(?:\/\/|#|--)\s*canon:\s*([A-Z]+-\d+\.\d+)/g;
for (const p of walk(ROOT, {
  skip: [
    'node_modules',
    '.git',
    'dist',
    '.sst',
    '_bmad',
    '.claude',
    '.harness',
    'canon',
    'records',
    'ledger',
    'playwright-report',
    'test-results',
  ],
})) {
  if (!/\.(m?[jt]sx?|py|tf|yaml|yml)$/.test(p)) continue;
  const text = readFileSync(p, 'utf8');
  let m;
  const lines = text.split('\n');
  while ((m = tagRe.exec(text))) {
    const line = text.slice(0, m.index).split('\n').length;
    const sym =
      (lines[line] || lines[line - 1] || '').match(
        /(?:function|const|class|export\s+(?:default\s+)?(?:function|const|class)?)\s+([A-Za-z_$][\w$]*)/,
      )?.[1] || `L${line}`;
    pointers.push({
      node: null,
      criterion: m[1],
      file: rel(p),
      symbol: sym,
      range: null,
      blob: null,
      tag: true,
    });
    addNode({ id: m[1], kind: 'criterion', label: m[1] });
    addNode({ id: `file:${rel(p)}#${sym}`, kind: 'symbol', label: sym, file: rel(p) });
    addEdge(m[1], `file:${rel(p)}#${sym}`, 'implements', { via: 'tag', line });
  }
}
const layerMap = readJson(join(ROOT, 'canon', 'layer-map.json'), { layers: {} });
for (const n of nodes.values()) if (n.file) n.layer = layerOf(n.file, layerMap);

const canonGraph = { generatedAt: new Date().toISOString(), nodes: [...nodes.values()], edges };
writeJson(join(ROOT, 'canon', 'generated', 'canon-graph.json'), canonGraph);
const byFile = {};
for (const ptr of pointers) (byFile[ptr.file] ||= []).push(ptr);
writeJson(join(ROOT, 'canon', 'index', 'pointers.json'), {
  generatedAt: canonGraph.generatedAt,
  byFile,
  count: pointers.length,
});

const sys = readJson(join(ROOT, 'canon', 'generated', 'system-graph.json'));
if (sys) {
  // join: a canon symbol node `file:<path>#<sym>` is replaced by the system-graph node whose id ends with `<path>#<sym>` (func:, class:, method:)
  const bySuffix = new Map();
  for (const n of sys.nodes || []) {
    const m = /^[a-z]+:(.+#.+)$/.exec(n.id);
    if (m) bySuffix.set(m[1], n.id);
  }
  const remap = (id) => {
    const m = /^file:(.+#.+)$/.exec(id);
    return m && bySuffix.has(m[1]) ? bySuffix.get(m[1]) : id;
  };
  const cEdges = canonGraph.edges.map((e) => ({
    ...e,
    source: remap(e.source),
    target: remap(e.target),
  }));
  const cNodes = canonGraph.nodes.filter((n) => !(n.kind === 'symbol' && remap(n.id) !== n.id));
  const merged = {
    generatedAt: canonGraph.generatedAt,
    nodes: [...cNodes, ...(sys.nodes || [])],
    edges: [...cEdges, ...(sys.edges || [])],
  };
  writeJson(join(ROOT, 'canon', 'generated', 'graph.json'), merged);
} else {
  writeJson(join(ROOT, 'canon', 'generated', 'graph.json'), canonGraph);
}

if (process.argv.includes('--map')) {
  const caps = canonGraph.nodes.filter((n) => n.kind === 'capability');
  const crits = canonGraph.nodes.filter((n) => n.kind === 'criterion');
  const deps = readJson(join(ROOT, 'canon', 'departments.json'), { departments: [] });
  const q = readJson(join(ROOT, 'canon', 'quality.json'), { assurance: {} });
  const gen = [
    '',
    `- capabilities: ${caps.length} · criteria: ${crits.length} · pointers: ${pointers.length} · departments: ${deps.departments.map((d) => d.name).join(', ') || 'none'}`,
    ...caps.map(
      (c) =>
        `- ${c.id} ${c.label} · v${c.version ?? '0'} · ${q.assurance[c.id] || c.assurance || 'draft'}`,
    ),
    `- layers: ${Object.keys(layerMap.layers).join(', ')}`,
    '',
  ].join('\n');
  for (const f of [join(ROOT, 'canon', 'MAP.md'), join(ROOT, 'CLAUDE.md')]) {
    if (!existsSync(f)) continue;
    const t = readFileSync(f, 'utf8');
    writeFileSync(
      f,
      t.replace(
        /<!-- generated:start -->[\s\S]*?<!-- generated:end -->/,
        `<!-- generated:start -->${gen}<!-- generated:end -->`,
      ),
    );
  }
}
console.log(
  `canon-graph: ${nodes.size} nodes, ${edges.length} edges, ${pointers.length} pointers${sys ? ' (+ system graph merged)' : ''}`,
);
