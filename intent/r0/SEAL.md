---
plan: r0
rigor: prototype
base: 3be626e35f8d3a3ef5a3fe3366fa08d64bc2f650
track: vertical
touches:
  - CAP-1
  - CAP-1.1
  - CAP-1.2
  - CAP-1.3
  - CAP-1.4
  - CAP-1.5
  - CAP-1.6
  - CAP-1.7
  - CAP-1.8
---

# Seal: r0 pacman

A playable, single-level browser pacman: one procedurally-walled maze (every dot BFS-reachable,
tested), four ghosts sharing one chase/flee AI, dots and power pellets, lives and score on
screen, win when the board is clear, lose when lives run out, WASD or arrow-key control, pixel
art on a canvas that rescales to the viewport while holding its aspect ratio. No sound, no menu,
no leaderboard, no accounts, no backend — a static site, per the intent's constraints.

Domain logic (`src/game.ts`, `src/maze.ts`, `src/input.ts`) is pure and carries CAP-1's eight
criteria, each bound to a coverage row and proven by a vitest/Playwright test at HEAD
(`npm run test:report -- --e2e`: 32/32 passed at commit f95bd25). `npm run check` and
`npm run canon:check` are green except `criteria-bound-passed`, which the checker reports
`unmeasured` only because `ledger/r0.jsonl` — written solely by `scripts/harness/ledger.mjs` and
outside this seat's jurisdiction — is untracked, which the dirty-tree guard in
`scripts/harness/test-run.mjs` correctly refuses to certify against; the binding proofs
themselves are all green in `.harness/test-results.json`.
