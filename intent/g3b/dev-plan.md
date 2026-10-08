# g3b development plan: pacman speed boost after a power pellet

Built on `intent/g3b/tech-spec.md`. Prototype scale: all changes are in `src/game.ts` and `src/game.test.ts`. No new file, no new dependency. `src/main.ts` and `src/render.ts` are unchanged. Every epic ends with `npm run check` green.

## Epic order and dependencies

E1 -> E2 -> E3 -> E4 -> E5. Each epic builds on the one before it. E5 (tests) covers E1 to E4, but each epic adds its own tests as it goes, so E5 is the final sweep and the integration test.

## E1. State and constants

- **Delivers:** `BOOST_DURATION = 20` and `BOOST_SPEED_MULTIPLIER = 2` next to `FRIGHTENED_DURATION`, both marked tunable. The multiplier is a positive integer. `GameState.boostTicks: number` is added next to `frightenedTicks`, initialised to 0 in `createGameState`.
- **Depends on:** nothing.
- **Done when:** the project compiles with the new field. A fresh game state has `boostTicks === 0`. The constants are exported or reachable by the tests. Existing tests still pass.

## E2. Eating a power pellet sets the boost

- **Delivers:** in `eatDot`, eating a `pellet` cell sets `boostTicks = BOOST_DURATION`. Dots do not touch it. A second pellet during a boost resets it to `BOOST_DURATION`. It does not add to the time, and the multiplier does not grow (refresh, not stack).
- **Depends on:** E1.
- **Done when:** unit tests show that a pellet gives `boostTicks === BOOST_DURATION`, a dot leaves it unchanged, and a second pellet mid-boost gives `BOOST_DURATION` and not the sum. Score and frightened behaviour of pellets are unchanged.

## E3. Multi-cell movement while boosted

- **Delivers:** in `tick`, the step count is read at the start of the tick: `BOOST_SPEED_MULTIPLIER` if `boostTicks > 0`, else 1. `boostTicks` is then decremented, with a floor of 0. The pacman part of the tick loops over the steps, and each step does `movePacman`, then `eatFruit(maybeSpawnFruit(...))`, then `resolveGhostCollisions`. The loop stops early when `status` is no longer `playing` or when pacman did not move. Ghost movement, the frightened timer and the fruit timer run once per tick as before. The tick in which the pellet is eaten moves one cell. The boost applies from the next tick.
- **Depends on:** E1, E2.
- **Done when:** unit tests show that:
  - with `boostTicks > 0` pacman moves `BOOST_SPEED_MULTIPLIER` cells in a corridor, and with 0 it moves one;
  - a wall stops the move without error;
  - `boostTicks` drops by one per tick and stops at 0, and after `BOOST_DURATION` boosted ticks the next tick moves one cell;
  - a dot on the second step is eaten and scored;
  - a ghost on the second step is resolved (a frightened ghost is eaten, a chase ghost costs a life) and pacman moves no further;
  - the final dot on the second step wins the game.

## E4. Resets and frozen ticks

- **Delivers:** `loseLife` sets `boostTicks = 0`. `createGameState` already gives 0 (E1). Pause and the READY! hold return early in `tick`, so they leave `boostTicks` unchanged and nothing counts down while frozen.
- **Depends on:** E1, E3.
- **Done when:** tests show that `loseLife` gives `boostTicks === 0` after a boost, that a paused tick and a READY! tick leave `boostTicks` unchanged, and that a new game starts with 0.

## E5. Tests and final check

- **Delivers:** all new tests live in `src/game.test.ts`, using the existing `buildMaze`, `buildGhost` and `buildState` helpers, and they read the constants rather than hard-coding 2 and 20. Adds one integration test through `tick` on the real maze: start next to a pellet, tick through eating it and the whole boost, and assert the cells moved per tick (1 on the eating tick, the multiplier for `BOOST_DURATION` ticks, then 1) and that `boostTicks` ends at 0. Render and e2e tests are not extended.
- **Depends on:** E1 to E4.
- **Done when:** the integration test passes, the test cases listed in the tech spec's Testing section each have a test, and `npm run check` is green. The tests still pass if the two constants are changed to other valid values (for example 10 and 3).

## Assumptions carried from the tech spec

- 20 ticks and 2x are placeholder defaults. The intent leaves them open, and they are tunable in one place.
- A second pellet refreshes the boost and does not stack. The intent is silent on this. It is a one-line change in `eatDot`.
- The boost is independent of frightened mode and has its own timer.
- No visual or audio cue is added.
- The canon entry for pacman movement and pellets needs a line about the boost. That is the canon step's job and is not in these epics.
- Nothing in the plan needs an answer from the team before work starts, so no question is open.
