// Step 17: the adapter contract, as cases. An adapter is whatever puts the seat policy
// (seat-policy.mjs) in front of a seat's tool calls: today the settings hooks (veto.mjs, room-reach.mjs,
// footprint.mjs, given to `claude -p` through --settings), from step 18 a mod loaded with --plugin-dir.
// Whatever the mechanism, an adapter must, for every case here:
//
//   1. rule each call as seatRuling does: allowed, or denied with its `by` (veto, room-reach, ...);
//   2. hand the seat the ruling's message on a deny (the department and its reason, or the reach);
//   3. record a call that ran as exactly one footprint line {tool, target} (footprintLine);
//   4. record a denied call as exactly one line carrying `denied`, and nothing that says it ran;
//   5. FAIL CLOSED: a call it cannot read, a policy it cannot read, or its own failure denies.
//
// Pure data and one pure comparison; the drivers that run an adapter against these are in
// conformance.mjs. A new rule an adapter must hold is a case here, never a sentence in a prompt.

export const DEPARTMENTS = {
  departments: [
    {
      name: 'Platform',
      vetoes: [
        {
          id: 'V-GEN',
          tools: ['Write', 'Edit', 'MultiEdit'],
          targets: ['canon/generated/**'],
          reason: 'Generated canon is rebuilt by its script, never written.',
        },
      ],
    },
    {
      name: 'Security',
      vetoes: [
        {
          id: 'V-ENV',
          tools: ['Read', 'Write', 'Edit'],
          targets: ['.env', '**/.env'],
          reason: 'Secrets are not read or written by a seat.',
        },
      ],
    },
  ],
};
// paths are under the adapter's root, written {root}; a room seat's folders under {root}/ws
export const CASES = [
  {
    name: 'a call no policy touches runs and is witnessed',
    call: { tool: 'Read', input: { file_path: '{root}/src/a.ts' } },
    expect: { verdict: 'allow', line: { tool: 'Read', target: 'src/a.ts' } },
  },
  {
    name: 'a vetoed write is denied with the department and its reason',
    call: {
      tool: 'Write',
      input: { file_path: '{root}/canon/generated/graph.json', content: 'x' },
    },
    expect: {
      verdict: 'deny',
      by: 'veto',
      message: ['Platform', 'V-GEN', 'rebuilt by its script'],
    },
  },
  {
    name: 'a veto names its tools: a read of the same target runs',
    call: { tool: 'Read', input: { file_path: '{root}/canon/generated/graph.json' } },
    expect: { verdict: 'allow', line: { tool: 'Read', target: 'canon/generated/graph.json' } },
  },
  {
    name: 'a nested secret is denied by its glob',
    call: { tool: 'Read', input: { file_path: '{root}/config/.env' } },
    expect: { verdict: 'deny', by: 'veto', message: ['Security', 'V-ENV'] },
  },
  {
    name: 'a shell call is witnessed by its command',
    call: { tool: 'Bash', input: { command: 'npm run -s test' } },
    expect: { verdict: 'allow', line: { tool: 'Bash', target: 'npm run -s test' } },
  },
  {
    name: 'a room seat reads inside its own folder',
    call: { tool: 'Read', input: { file_path: '{root}/ws/1/private/note.md' } },
    reach: ['{root}/ws/1/private', '{root}/ws/shared'],
    cwd: '{root}/ws/1/private',
    expect: { verdict: 'allow', line: { tool: 'Read', target: 'ws/1/private/note.md' } },
  },
  {
    name: "a room seat is denied the other seat's folder",
    call: { tool: 'Read', input: { file_path: '{root}/ws/2/private/note.md' } },
    reach: ['{root}/ws/1/private', '{root}/ws/shared'],
    cwd: '{root}/ws/1/private',
    expect: { verdict: 'deny', by: 'room-reach', message: ['outside this seat'] },
  },
  {
    name: 'a room seat is denied a Glob over the workspace root (hlab-a, hlab-b r16b)',
    call: { tool: 'Glob', input: { pattern: '**/*', path: '{root}/ws' } },
    reach: ['{root}/ws/1/private', '{root}/ws/shared'],
    cwd: '{root}/ws/1/private',
    expect: { verdict: 'deny', by: 'room-reach' },
  },
  {
    name: 'fails closed: a call it cannot read is denied',
    call: { tool: null, input: {} },
    expect: { verdict: 'deny' },
  },
  {
    name: 'fails closed: a policy it cannot read is denied',
    call: { tool: 'Read', input: { file_path: '{root}/src/a.ts' } },
    fault: 'no-policy',
    expect: { verdict: 'deny' },
  },
  {
    name: 'fails closed: a guard that throws denies',
    call: { tool: 'Read', input: { file_path: '{root}/src/a.ts' } },
    fault: 'throw',
    expect: { verdict: 'deny' },
  },
];

// what an adapter did with one case → the contract's verdict on it
// observed: { verdict, by?, message?, lines: [footprint lines] }
export function conform(c, observed) {
  const why = [];
  const e = c.expect;
  const o = observed || {};
  const lines = o.lines || [];
  if (o.verdict !== e.verdict) why.push(`ruled ${o.verdict}, the contract says ${e.verdict}`);
  if (e.by && o.by !== e.by) why.push(`denied by ${o.by ?? 'nothing'}, the contract says ${e.by}`);
  for (const m of e.message || [])
    if (!String(o.message || '').includes(m)) why.push(`the seat was not told "${m}"`);
  if (e.verdict === 'allow') {
    const ran = lines.filter((l) => !l.denied);
    if (ran.length !== 1) why.push(`${ran.length} footprint line(s) for a call that ran, not 1`);
    else if (e.line && (ran[0].tool !== e.line.tool || ran[0].target !== e.line.target))
      why.push(`witnessed ${ran[0].tool} ${ran[0].target}, not ${e.line.tool} ${e.line.target}`);
  } else {
    if (lines.some((l) => !l.denied)) why.push('a denied call was recorded as one that ran');
    // a call the adapter cannot read has no session to record against; the deny is what matters
    if (c.call.tool && lines.filter((l) => l.denied).length !== 1)
      why.push(`${lines.filter((l) => l.denied).length} denied line(s), not 1`);
  }
  return { name: c.name, ok: !why.length, why };
}

// a case with {root} filled in
export function bind(c, root) {
  const fill = (v) =>
    typeof v === 'string'
      ? v.replaceAll('{root}', root)
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
  return fill(c);
}
