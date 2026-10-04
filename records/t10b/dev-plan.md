# Development plan: a bonus fruit (t10b)

Builds on `intent/t10b/tech-spec.md` (A1-A7) and `canon/capabilities/CAP-5.md` (CAP-5.1-5.5). Rigor: prototype. Four epics, built in order; each ends with `npm run check` green and the existing tests untouched.

## Sequence and dependencies

E1 → E2 → E3 → E4. E2 and E3 both change `tick` in `src/game.ts` and need the E1 state, so they are not parallel. E4 needs the `fruit` state from E1 (and is only meaningful once E2 and E3 exist).

## E1: Fruit state and half-dots trigger

- Traces to: CAP-5.1, CAP-5.5 (guard foundation); A3 (constants), A4 (half), A7.
- Delivers: `dotsTotal` and `fruit { phase, ticksLeft }` on `GameState`, seeded in `createGameState` (`waiting`, 0); `FRUIT_SCORE`, `FRUIT_DURATION`, `FRUIT_POS`; pure `maybeSpawnFruit` called from `tick` after pacman moves (step 2). Phase moves only `waiting → active`.
- Done when (unit tests in `src/game.test.ts`):
  - A fresh game is `waiting`.
  - No fruit one dot below half; `active` with `ticksLeft = FRUIT_DURATION` exactly at half, for odd and even totals (`eaten * 2 >= dotsTotal`, dots and pellets together).
  - `FRUIT_POS` is walkable in `createMaze()` (A3).
  - Existing tests pass unchanged.
- Knip note: new exports must be used, so constants not yet consumed stay unexported until E2/E3 use them.

## E2: Lifetime and expiry

- Traces to: CAP-5.2, CAP-5.5 (expired branch); A1 (50 ticks), A5 (life lost does not touch the fruit).
- Delivers: pure `tickFruit` called last in `tick` (step 5): `ticksLeft` drops by one per tick while `active`; at 0 the phase becomes `done`. Paused ticks do nothing; respawn after a lost life leaves `fruit` alone.
- Done when (unit tests):
  - `ticksLeft` falls one per tick.
  - At 0 the fruit is `done` and the score is unchanged.
  - The countdown is frozen while paused and continues after a lost life.
  - An expired fruit is never reactivated by more dots eaten.

## E3: Eating and score above a power pellet

- Traces to: CAP-5.3, CAP-5.4, CAP-5.5 (eaten branch); A2 (score 100), A3.
- Delivers: pure `eatFruit` called in `tick` after the spawn check (step 3): when `active` and pacman's tile equals `FRUIT_POS`, add `FRUIT_SCORE` to `score` and set `done`.
- Done when (unit tests):
  - Pacman on `FRUIT_POS` while `active` adds `FRUIT_SCORE` once and marks `done`.
  - On that tile while `waiting` or `done`, nothing is added.
  - `FRUIT_SCORE > PELLET_SCORE`, checked from the score added by a pellet versus the fruit.
  - Over a full game played to a win, the fruit appears at most once, whether eaten or expired.

## E4: Rendering and e2e

- Traces to: CAP-5.1-5.3, CAP-5.5 as visible behaviour; A6 (simple coloured shape).
- Delivers: `drawFrame` in `src/render.ts` draws the fruit on its tile while `active`, under pacman and the ghosts. `src/main.ts` and `src/maze.ts` are unchanged.
- Done when:
  - Render tests with a stub context: an active fruit makes a draw call at `FRUIT_POS`'s tile; `waiting` and `done` make none.
  - The Playwright spec in `tests/e2e/app.spec.ts` still loads the page, shows the canvas and updates the score. The fruit flow itself is not driven by e2e (reaching half the dots by key presses is slow and brittle); unit and render tests cover it.
  - `npm run check` is green, including knip.

## Criteria coverage

| Criterion                             | Epics      |
| ------------------------------------- | ---------- |
| CAP-5.1 appears at half, not before   | E1, E4     |
| CAP-5.2 disappears when time runs out | E2, E4     |
| CAP-5.3 eaten and removed             | E3, E4     |
| CAP-5.4 score above a power pellet    | E3         |
| CAP-5.5 at most once per game         | E1, E2, E3 |

## Assumptions and gaps

- A1-A6 are carried from the tech spec as written (50 ticks, score 100, position `{9,13}`, "half" by `dotsRemaining`, life lost does not affect the fruit, simple shape).
- A7: CAP-5 is still `draft` and its bindings P0-GAME-014..018 are not yet attached to concrete tests. Mapping tests to those IDs is left to the canon/test step; this plan only says which epic's tests serve which criterion.
- Epic order inside `tick` follows the tech spec's step numbering; the plan adds nothing beyond it.
