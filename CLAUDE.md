# hlab-b

A browser pacman with pixel art and keyboard control. This repo is one of two lab apps for the Mycelium SDD harness. The app is not the point; the harness is.

## The map (generated section below is rewritten by `npm run canon:map`; edit only the glue above it)

- `canon/` is the as-is representation of what is merged on main. Generated files under `canon/generated/` are never hand-edited; regenerate them. Authored canon files carry frontmatter with `id`, `kind`, `assurance`, `valid_from`.
- `intent/<slug>/` on a plan branch holds what is wanted: BMAD outputs, the sealed contract, proposed deltas. It becomes `records/<slug>/` at merge.
- `ledger/<slug>.jsonl` is append-only and written only by `scripts/harness/ledger.mjs`.
- `harness.json` holds the app status, the yolo dial, budgets and department policies.
- Source layout follows `canon/layer-map.json`. An unmapped path fails `npm run canon:check`.

## Rules for any agent working here

1. One-answer work is a script. Counting, validating, diffing, resolving and recording are never done by hand.
2. Every exported symbol that implements a criterion carries a `// canon: CAP-n.k` comment. The pointer index reads it.
3. Tests sit next to what they bind and cite their coverage row in the title.
4. No new dependency without a line in the plan's decisions. `npm run check` must stay green: prettier, eslint (no `any`), tsc strict, knip, vitest, security audit.
5. Never edit `canon/generated/**`, `records/**` or `ledger/**` directly.
6. Commits follow conventional commits. The changelog is a projection of the ledger.

## Commands

- `npm run check` full local gate · `npm run test:e2e` Playwright · `npm run canon:check` the four canon checks · `npm run canon:graph` regenerate graphs and the pointer index · `npm run harness:stats` this session's numbers

<!-- generated:start -->

- capabilities: 0 · criteria: 0 · pointers: 0 · departments: Testing
- layers: composition, ui, domain, transport, persistence, infrastructure, tests, harness

<!-- generated:end -->
