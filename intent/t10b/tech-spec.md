# Tech spec: a bonus fruit (t10b)

## Scope

Once half of the dots are eaten, one fruit appears for a limited time. Pacman reaching it eats it for more points than a power pellet; running out of time removes it. At most once per game. Nothing else about scoring, ghosts, lives, pause or restart changes.

## Approach and stack

TypeScript, Vite, Vitest, Playwright; no new dependency and no new file under `src/`. The game stays a pure state machine in `src/game.ts`, drawn by `src/render.ts`, wired by `src/main.ts`. The fruit is a new field on `GameState` with pure helpers beside `eatDot` and `resolveGhostCollisions`, called from `tick`.

## Parts

| Part          | File            | Responsibility                                                                                                                                                                  |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fruit rules   | `src/game.ts`   | `FRUIT_SCORE`, `FRUIT_DURATION`, `FRUIT_POS`; `maybeSpawnFruit`, `eatFruit`, `tickFruit`, all pure (state in, state out). `tick` calls them. `createGameState` seeds the fruit. |
| Maze data     | `src/maze.ts`   | Unchanged. The fruit is not a `Cell`: it is state, not terrain, so the grid, `countRemaining` and the win rule keep working.                                                    |
| Fruit drawing | `src/render.ts` | `drawFrame` draws a fruit on its tile while it is active, under pacman and the ghosts.                                                                                          |
| Wiring        | `src/main.ts`   | Unchanged: it already calls `tick` and `drawFrame` with the state.                                                                                                              |

Layering follows the existing split: rules in domain, drawing in domain, composition untouched.

## State kept and where

One new field in `GameState` (in memory, in `main.ts`'s `state`; nothing persisted):

- `dotsTotal: number`: dots and pellets at game start, set in `createGameState` from `countRemaining`. It makes "half" independent of the maze layout.
- `fruit: { phase: 'waiting' | 'active' | 'done'; ticksLeft: number }`: starts `waiting`, `ticksLeft` 0.

`phase` is the once-per-game guard: it only moves `waiting → active → done` and never back. Restart builds a fresh state, so a new game gets a new fruit. Position is the constant `FRUIT_POS`, not state.

## Main flows

Order inside `tick` (existing steps kept; new steps marked +):

1. Pacman moves and eats a dot (`movePacman`, unchanged).
2. - `maybeSpawnFruit`: if `phase` is `waiting` and `dotsTotal - dotsRemaining` is at least half of `dotsTotal` (`eaten * 2 >= dotsTotal`), set `active` and `ticksLeft = FRUIT_DURATION`.
3. - `eatFruit`: if `active` and pacman's tile equals `FRUIT_POS`, add `FRUIT_SCORE` to `score` and set `done`.
4. Ghost collisions, ghost movement, frightened countdown (unchanged).
5. - `tickFruit`: if `active`, `ticksLeft` drops by one; at 0 the phase becomes `done` and the fruit is gone.

Cases:

- **Appear.** The dot that reaches half triggers step 2 in the same tick; the next `drawFrame` shows the fruit.
- **Eaten.** Pacman steps on `FRUIT_POS` while active: score rises by `FRUIT_SCORE`, the fruit vanishes, no second one ever comes.
- **Expired.** `ticksLeft` reaches 0 uncollected: the fruit vanishes, nothing is scored, none returns.
- **Pause.** `tick` returns early when paused, so the countdown freezes.
- **Life lost.** Respawn does not touch `fruit`; the countdown continues. Game won or lost ends `tick`, so nothing more happens.
- **Restart.** New `GameState`, fruit `waiting`.

`FRUIT_SCORE` is strictly above `PELLET_SCORE`, enforced by a test, not by a comment.

## Testing

- **Unit (Vitest, `src/game.test.ts`, beside the tests of what they extend).**
  - Trigger: no fruit just below half the dots eaten; fruit active exactly at half (odd and even totals); a fresh game has `waiting`.
  - Position: an active fruit sits on `FRUIT_POS`, and that tile is walkable in `createMaze()`.
  - Lifetime: `ticksLeft` falls one per tick; at 0 the fruit is `done` and the score is unchanged; unchanged while paused.
  - Eating: pacman on `FRUIT_POS` while active adds `FRUIT_SCORE` once and marks `done`; pacman on that tile while `waiting` or `done` adds nothing.
  - Value: `FRUIT_SCORE > PELLET_SCORE`, checked from the score added by eating a pellet versus the fruit in one state.
  - Once only: after eaten or expired, eating more dots never reactivates it, over a full game played to a win.
  - Unchanged behaviour: the existing `eatDot`, `resolveGhostCollisions`, `tick` and pause tests pass untouched.
- **Render (Vitest, as existing `drawFrame` tests do).** With a stub context, an active fruit makes a draw call at its tile; `waiting` and `done` make none.
- **End to end (Playwright, `tests/e2e/app.spec.ts`).** Load the page; the canvas and score still work. Reaching half the dots by key presses is slow and brittle, so the fruit flow is covered by the unit and render tests; this spec only guards that the page still loads and plays.
- **Gate.** `npm run check` stays green; knip requires every new export to be used.

## Assumptions

- A1: Lifetime is counted in ticks like `frightenedTicks`: `FRUIT_DURATION = 50` (about 8 s at 160 ms per step).
- A2: `FRUIT_SCORE = 100`; any value above 50 meets the intent.
- A3: `FRUIT_POS = { x: 9, y: 13 }`, the open tile below the ghost house on pacman's side. The builder confirms it is walkable against `src/maze.ts`; a dot may sit under it and is eaten as usual.
- A4: "Half" means at least half of the starting dots and pellets together, as `dotsRemaining` counts them.
- A5: A lost life does not reset or pause the fruit.
- A6: The fruit is drawn as a simple coloured shape; the look is not specified.
- A7: No canon criterion exists for this yet; the canon step adds one and binds the tests above. This seat does not edit canon.
