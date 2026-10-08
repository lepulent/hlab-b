# g2b technical spec: eaten ghosts go home first

Prototype scale. No new dependency, no new file except tests added to existing test files.

## Approach and stack

Plain TypeScript, the existing pure-function game loop (`tick(state, dir) -> state`), vitest next to the code. An eaten ghost gets a third mode, `returning`. In that mode it walks the shortest walkable path to its own `home` cell inside the ghost house, then flips back to `chase`. Nothing is added to the render loop or `main.ts` beyond a colour.

## Where things live today

- `src/game.ts`: `Ghost` (`pos`, `dir`, `mode`, `home`), `GhostMode = 'chase' | 'frightened'`, `eatDot` (a pellet sets every ghost frightened), `resolveGhostCollisions` (a frightened ghost is eaten: teleported to `home`, mode `chase`, +200), `moveGhost`/`moveGhosts` (greedy one step by Manhattan distance), `tick` (when `frightenedTicks` reaches 0 every ghost is set to `chase`), `loseLife` (ghosts back to `home`, `chase`).
- `src/maze.ts`: the grid, `isWalkable`, `GHOST_STARTS` (the four interior cells of the house, x 8..10, y 9..11) and the single door at (9,8). Every ghost `home` is one of those interior cells.
- `src/render.ts`: `drawGhost` picks the colour from `mode`.

## Parts and responsibilities

1. **Mode** (`game.ts`): `GhostMode` gains `'returning'`.
2. **Path finding** (`maze.ts`, new exported `stepToward(maze, from, to): Position | undefined`): breadth-first search over walkable cells (4-neighbours). It returns the first cell of a shortest path, or `undefined` if already at `to` or unreachable. The maze is small (19x21) so it is run per returning ghost per tick, with no caching. BFS is used because the house has one door and the greedy distance rule in `moveGhost` would get stuck on the house wall.
3. **Movement** (`game.ts`, `moveGhost`): a returning ghost ignores pacman and takes the `stepToward(ghost.pos, ghost.home)` step, updating `dir` from the step. If there is no step because the ghost is on `home`, it becomes `chase`. If the target is unreachable it stays put (cannot happen on the real maze; the existing reachability test covers it).
4. **Eating** (`game.ts`, `resolveGhostCollisions`): a frightened ghost touched by pacman gets `mode: 'returning'`, keeps its `pos` (no teleport) and still scores `GHOST_SCORE`. A `returning` ghost overlapping pacman is ignored: no life lost, no score.
5. **Colour** (`render.ts`): returning ghosts are drawn in a distinct colour (assumption below).

## State kept

No new top-level state. The only change is the extra value of `Ghost.mode`, held in `GameState.ghosts`. The target is not stored: it is always `ghost.home`. The path is recomputed each tick.

## State transitions (per ghost)

- `chase -> frightened`: pellet eaten (unchanged).
- `frightened -> returning`: pacman touches it (replaces "teleport to home as chase").
- `returning -> chase`: ghost reaches `home` (inside the house, so it has passed through the door).
- `frightened -> chase`: `frightenedTicks` reaches 0 (unchanged).
- any mode `-> chase` at `home`: `loseLife` (level/life reset).
- `returning` has no other exit and no other entry. Pellets and the timer never touch it.

## Main flows

Eating a ghost, in one tick: pacman moves, `resolveGhostCollisions` finds the overlapping ghost, it is frightened, so it becomes `returning` in place, score +200. `moveGhosts` then moves it one step toward `home` in the same tick.

Returning: each tick `moveGhost` calls `stepToward(maze, pos, home)`, moves one cell (same speed as other ghosts), through the door at (9,8) and down to `home`. On the tick it stands on `home` its mode becomes `chase`, and the next tick it chases as normal.

## Edge cases

- **Eaten while frightened mode is running:** that is the only way to be eaten. The other ghosts stay frightened with the shared timer.
- **Pellet eaten while a ghost is returning:** `eatDot` frightens only ghosts not `returning`. The returning ghost keeps going home.
- **Frightened mode ends while a ghost is still returning:** the timer's reset to `chase` skips `returning` ghosts. It finishes its trip home, then chases. It does not turn into chase mid-maze.
- **Returning ghost touches pacman:** harmless, passes through.
- **Life lost or new game (the repo has no separate level; the reset points are `loseLife` and `createGameState`):** `loseLife` already sets every ghost to its `home` with `chase`, which clears `returning`. `createGameState` starts all ghosts in `chase`.
- **Pause and READY! hold:** `tick` returns early, so returning ghosts freeze with everything else.
- **Two ghosts returning to different `home` cells:** may overlap on the way; no ghost-ghost collision exists today and none is added.

## Testing

All in `src/game.test.ts` (game rules) and `src/maze.test.ts` (path), titled with their coverage row like the existing tests, using the existing `buildMaze`/`buildGhost`/`buildState` helpers.

- **`stepToward` (unit, maze.test.ts):** returns a neighbouring walkable cell; reaches the target in the shortest number of steps on a small hand-built maze with a wall in the way; goes through the door on the real `createMaze()` from a ghost outside to each cell in `GHOST_STARTS`; returns `undefined` when already there or unreachable.
- **Transition (unit):** touching a frightened ghost makes it `returning`, in place, +200, no life lost; the existing teleport tests (`P0-GAME-004`, `P0-UI-013`) are changed to expect `returning` instead of `chase` at `home`.
- **Movement (unit through `tick`):** a returning ghost moves one step toward `home`, ignoring pacman, never into a wall; on arrival its mode is `chase`.
- **Full trip (integration through `tick`, real maze):** eat a frightened ghost outside the house, tick until `chase`, assert it passed through (9,8) and ended on `home`, within a bounded number of ticks.
- **Edge cases (unit):** pellet eaten mid-return leaves it `returning`; `frightenedTicks` reaching 0 mid-return leaves it `returning` while others become `chase`; a returning ghost on pacman costs nothing; `loseLife` resets a returning ghost to `chase` at `home`; paused ticks do not move it.
- **Render (unit, recording context):** a returning ghost is drawn in a different colour from chase and frightened.
- The e2e Playwright test is not extended; `npm run check` must stay green.

## Assumptions

- A returning ghost moves one cell per tick, the same as the others (the intent gives no speed).
- "Re-enters the house" is met when the ghost stands on its own `home` cell, which is inside the walls.
- A returning ghost can neither hurt nor be eaten by pacman.
- The returning colour is a visual choice (a dim colour), since the intent says nothing about looks.
- The ghost score stays 200 and is not scaled.
- Canon CAP-1.4 and CAP-1.9 describe ghost behaviour and will need a line for the returning state; that is for the canon step, not this file.
