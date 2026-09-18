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
  - CAP-1.9
---

# Seal: r0 pacman

A playable, single-level browser pacman: one procedurally-walled maze (every dot BFS-reachable,
tested), four ghosts sharing one chase/flee AI, dots and power pellets, lives and score on
screen, win when the board is clear, lose when lives run out, WASD or arrow-key control, pixel
art on a canvas that rescales to the viewport while holding its aspect ratio. No sound, no menu,
no leaderboard, no accounts, no backend — a static site, per the intent's constraints.

Domain logic (`src/game.ts`, `src/maze.ts`, `src/input.ts`) is pure and carries CAP-1's nine
criteria, each bound to a coverage row and proven by a vitest/Playwright test at HEAD
(`npm run test:report -- --e2e`: 36/36 passed at commit 59c7c57). `npm run check` and
`npm run canon:check` are fully green, including `criteria-bound-passed`.

This seal answers the review blocked at 1c881ab. The blocking finding (`tick` checked ghost
collisions only once, after both pacman and the ghost had moved, so pacman walking onto a
ghost's tile was never caught) is fixed by resolving collisions twice per tick — once right
after pacman moves, again after the ghosts move — proven by same-tick regression cases under
P0-GAME-004 in `src/game.test.ts`. The two canon-sync findings are answered by a new criterion,
CAP-1.9 (ghost chase/flee stepping, `src/game.ts#moveGhost`/`#moveGhosts`, bound to P0-GAME-008),
and by adding `src/render.ts#drawFrame` as a second pointer on CAP-1.8 for the pixel-art
sharpness half of that criterion.
