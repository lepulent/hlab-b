# g3b technical spec: pacman speed boost after a power pellet

Prototype scale. No new dependency and no new file; tests go in the existing `src/game.test.ts`.

## Approach and stack

Plain TypeScript, the existing pure game loop `tick(state, dir) -> state`, vitest next to the code. Today one `tick` moves pacman one cell and each ghost one cell, and `main.ts` calls `tick` every `STEP_MS`. The boost makes pacman take more than one cell per tick while ghosts still take one. That makes pacman faster relative to everything else without touching the frame timing in `main.ts`.

## Where things live today

- `src/game.ts`: `eatDot` (eating a `pellet` cell: +50, sets `frightenedTicks`, frightens ghosts), `movePacman` (one `attemptMove`, then `eatDot` and `checkWin`), `tick` (movement, then `eatFruit`, `resolveGhostCollisions`, ghost move, timers), `loseLife`, `createGameState`.
- `src/main.ts`: the animation loop that calls `tick` at a fixed `STEP_MS`. Unchanged.
- `src/render.ts`: draws state. Unchanged (a visual cue is out of scope, see assumptions).

## Parts and responsibilities

1. **Constants** (`game.ts`, next to `FRIGHTENED_DURATION`), all tunable:
   - `BOOST_DURATION = 20` ticks. Shorter than the frightened time (30), so the boost reads as "brief".
   - `BOOST_SPEED_MULTIPLIER = 2`: pacman moves 2 cells per tick while boosted. It must be a positive integer, because it is used as a step count. A fractional speed would need a step accumulator, which is not built.
2. **State** (`GameState.boostTicks: number`): ticks of boost left, 0 means no boost.
3. **Start/refresh** (`eatDot`): when the eaten cell is a `pellet`, set `boostTicks = BOOST_DURATION`. Dots do nothing.
4. **Movement** (`tick`): the number of pacman steps this tick is `boostTicks > 0 ? BOOST_SPEED_MULTIPLIER : 1`, read at the start of the tick. Then `boostTicks` is decremented (floor 0). The pacman part of the tick becomes a loop over the steps, each step doing what one step does today: `movePacman`, `eatFruit(maybeSpawnFruit(...))`, `resolveGhostCollisions`. The loop stops early if `status` is no longer `playing` (won or lost), or if pacman did not move (wall), so a blocked pacman does not repeat work. Ghost movement, the frightened timer and fruit timer run once per tick as before.
5. **Reset** (`loseLife`, `createGameState`): `boostTicks = 0`.

## Second pellet during a boost

**Refresh, not stack.** `boostTicks` is set back to `BOOST_DURATION`; the multiplier stays `BOOST_SPEED_MULTIPLIER`. Speed never goes above the multiplier and the time never exceeds `BOOST_DURATION`. This matches how `frightenedTicks` already behaves (set, not added). Recorded as an assumption below.

## State kept

One new field, `GameState.boostTicks`, in the same object as `frightenedTicks`. No other state; the multiplier is a constant and nothing is persisted.

## Main flow

1. Tick N: pacman steps onto a pellet. `eatDot` scores 50, frightens ghosts and sets `boostTicks = BOOST_DURATION`. Ghosts move once. Pacman moved one cell this tick, because the step count was read before the pellet was eaten.
2. Ticks N+1 .. N+BOOST_DURATION: step count is 2. Each tick pacman moves up to two cells, eating dots/fruit and checking ghost collisions after every cell, so it cannot jump over a ghost. Ghosts move one cell. `boostTicks` goes down by one per tick.
3. After that `boostTicks` is 0 and pacman is back to one cell per tick.
4. Pause and the READY! hold return early in `tick`, so the boost does not count down while frozen. Losing a life clears the boost.

## Testing

In `src/game.test.ts`, using the existing `buildMaze`/`buildGhost`/`buildState` helpers; `npm run check` must stay green.

- **Unit, `eatDot`:** a pellet sets `boostTicks` to `BOOST_DURATION`; a dot leaves it unchanged.
- **Unit, `tick` movement:** with `boostTicks > 0`, a corridor lets pacman move `BOOST_SPEED_MULTIPLIER` cells in one tick; with 0 it moves one. Stops at a wall without error. Tests read the constants rather than hard-coding 2 and 20, so retuning does not break them.
- **Unit, countdown:** `boostTicks` drops by one per tick and stops at 0; after exactly `BOOST_DURATION` boosted ticks the next tick moves one cell.
- **Unit, refresh:** eating a second pellet mid-boost sets `boostTicks` back to `BOOST_DURATION`, not to the sum, and the step count stays at the multiplier.
- **Unit, interactions:** a dot on the second step is eaten and scored; a ghost on the second step is resolved (frightened ghost eaten, chase ghost costs a life) and pacman does not move further; the final dot on the second step wins the game; pause and READY! ticks leave `boostTicks` unchanged; `loseLife` and `createGameState` give 0.
- **Integration through `tick`, real maze:** from a state next to a pellet, tick through eating it and the full boost, asserting the cells moved per tick and that the boost ends.
- Render and e2e tests are not extended.

## Assumptions

- The intent leaves the duration and the multiplier open; 20 ticks and 2x are placeholder defaults, tunable in one place.
- A second pellet refreshes the boost rather than stacking (intent silent, easy to change in `eatDot`).
- The boost applies from the tick after the pellet is eaten.
- The boost is independent of frightened mode and runs on its own timer.
- No visual or audio cue is added; the intent asks only for the speed change.
- Canon capabilities for pacman movement and pellets will need a line for the boost; that is for the canon step, not this file.
