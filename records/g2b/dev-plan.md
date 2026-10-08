# g2b development plan: eaten ghosts go home first

Prototype scale. Built on `intent/g2b/tech-spec.md`. No new dependency, no new file except tests in existing test files. Every step is done only when `npm run check` stays green.

## Order and dependencies

E1 -> E2 -> E3 -> E4 -> E5. E1 has no dependency. E2 needs E1 (the `returning` mode value is declared in E2 but moved by the path step from E1). E3 needs E2. E4 needs E3. E5 can be done alongside E3 and only needs E2, but is listed last.

## E1. Path finding: `stepToward` in `src/maze.ts`

**Delivers:** exported `stepToward(maze, from, to): Position | undefined`, breadth-first over walkable 4-neighbours, returns the first cell of a shortest path, `undefined` if already at `to` or unreachable.

**Done when** (tests in `src/maze.test.ts`, titled with their coverage row like existing tests):

- it returns a walkable neighbour of `from`;
- on a small hand-built maze with a wall in the way, following it reaches the target in the shortest step count;
- on the real `createMaze()`, from a cell outside the house, repeated steps reach every cell in `GHOST_STARTS` and pass through the door (9,8);
- it returns `undefined` when `from` equals `to` and when `to` is unreachable.

## E2. Mode and eating transition: `src/game.ts`

**Delivers:** `GhostMode` gains `'returning'`. In `resolveGhostCollisions`, a frightened ghost touched by pacman becomes `returning`, keeps its `pos`, scores `GHOST_SCORE` (200). A returning ghost overlapping pacman is ignored (no life lost, no score).

**Done when** (tests in `src/game.test.ts`):

- touching a frightened ghost makes it `returning` in place, +200, no life lost;
- the existing teleport tests `P0-GAME-004` and `P0-UI-013` are changed to expect `returning` and no teleport;
- a returning ghost on pacman costs nothing and scores nothing.

## E3. Returning movement and arrival: `src/game.ts`

**Delivers:** in `moveGhost`, a returning ghost ignores pacman, takes the `stepToward(maze, pos, home)` step (one cell per tick), and updates `dir` from the step. When it stands on `home` (no step) its mode becomes `chase`. If unreachable it stays put.

**Done when:**

- unit through `tick`: a returning ghost moves one step toward `home`, ignores pacman, never enters a wall;
- on arrival at `home` its mode is `chase`;
- integration on the real maze: eat a frightened ghost outside the house, tick until `chase`, assert it passed through (9,8), ended on `home`, within a bounded tick count.

## E4. Edge cases: `src/game.ts`

**Delivers:**

- `eatDot` frightens only ghosts that are not `returning`;
- the `frightenedTicks == 0` reset to `chase` skips `returning` ghosts;
- `loseLife` and `createGameState` leave no ghost `returning` (verify existing behaviour, change only if needed);
- paused and READY! ticks leave returning ghosts frozen (verify existing early return).

**Done when** (unit tests):

- pellet eaten mid-return leaves the ghost `returning`;
- `frightenedTicks` reaching 0 mid-return leaves it `returning` while other frightened ghosts become `chase`, and it later arrives and chases;
- `loseLife` puts a returning ghost on `home` in `chase`;
- a paused tick does not move it.

## E5. Render colour: `src/render.ts`

**Delivers:** `drawGhost` draws a returning ghost in a colour distinct from chase and frightened.

**Done when:** a unit test with the recording context shows the returning fill colour differs from the chase and frightened ones.

## Final check

`npm run check` green (type check, lint and unit tests as the repo defines them). The e2e Playwright test is not extended.

## Assumptions

- A returning ghost moves one cell per tick, as other ghosts do; the intent gives no speed.
- "Back in the house" means standing on its own `home` cell.
- A returning ghost can neither hurt nor be eaten by pacman.
- The returning colour is a dim colour chosen by the developer; the intent says nothing about looks.
- Ghost score stays 200.
- Canon entries CAP-1.4 and CAP-1.9 need a line for the returning state; that belongs to the canon step, not this plan.
- Where I wrote "verify existing behaviour" (`loseLife`, `createGameState`, paused ticks), this relies on the tech spec's reading of the code, which I did not re-check.
