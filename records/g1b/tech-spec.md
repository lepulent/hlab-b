# g1b technical spec: a short "Ready!" message

Rigor: prototype. No new dependencies, files or build changes.

## Approach and stack

The game is a TypeScript app: pure state logic in `src/game.ts`, a canvas renderer in `src/render.ts`, input dispatch in `src/input.ts`, and a `requestAnimationFrame` loop in `src/main.ts`. Tests use the existing unit test files (`src/*.test.ts`) and Playwright (`tests/e2e`). Ready is a small countdown **inside `GameState`**, counted in game ticks. It follows how `frightenedTicks` and `fruit.ticksLeft` already work, so `main.ts` does not change.

## Parts

- **`game.ts`** owns the state and the rule:
  - `GameState` gets `readyTicks: number`.
  - A new constant `READY_TICKS` sets the duration.
  - `createGameState()` starts with `readyTicks: READY_TICKS`.
  - `loseLife()` sets `readyTicks: READY_TICKS` on its non-final branch, the one that resets pacman and the ghosts.
  - `tick()` returns early while `readyTicks > 0`: it decrements the counter and does nothing else. The existing guard for `status !== 'playing' || paused` stays first, so pausing also pauses the countdown.
- **`render.ts`** draws the message. `drawFrame` calls a new `drawReady(ctx, state)` after the sprites and only when `status === 'playing' && readyTicks > 0`.
- **`input.ts`** and **`main.ts`** are unchanged. A restart already calls `createGameState()`, so it gets Ready for free. `statusText` is also unchanged: the message is in the maze, not the HUD.

## State

One number, `GameState.readyTicks`, held in the single `state` variable in `main.ts`. It is not persisted. Invariant: it is `0` whenever movement is allowed.

## Duration

`READY_TICKS = 12`. At the 160 ms step (`STEP_MS`) that is about 1.9 s. This is an assumption. It is a named constant, so the team can tune it. Because `tick` counts it, the time is tied to the game clock, not wall time.

## Holding movement

The hold is entirely in `tick()`. While `readyTicks > 0`, neither pacman nor the ghosts move, and the fruit, frightened and collision logic do not run. Nothing can change score or lives. Since a new life resets positions and clears frightened modes, the frozen picture is the correct start position. Direction keys are still read by `handleKey`, so the held direction (`currentDirection` in `main.ts`) is applied on the first tick after Ready ends. Assumption: a player who presses a direction during Ready should move at once when play starts.

## Rendering

`drawReady` draws `READY!` in `PACMAN_COLOR` (yellow), `bold 14px monospace`, centered at column 9 (middle of the 19-column maze), row 12 (just under the ghost house, rows 9 to 11, and above pacman at row 15). It uses `textAlign = 'center'`, `textBaseline = 'middle'` and a `maxWidth` of `width - 2 * TILE`, like `drawScoreScreen`. It has no overlay, so the maze and the characters stay visible. Assumption: any dots on that row sit under the text; a dark backing strip is a tuning detail.

## Flows

1. **New game or restart:** `createGameState()` sets `readyTicks = 12`. The frame loop draws the maze with `READY!`. Each step calls `tick`, which decrements the counter. After 12 steps the message disappears and the next tick moves everything.
2. **Life lost:** `resolveGhostCollisions` calls `loseLife`. On a remaining life, positions reset and `readyTicks = 12`. The same countdown then runs. On the final life, `status` becomes `'lost'` and no Ready is shown.
3. **Pause during Ready:** `P` sets `paused`. `tick` returns early and the counter stays put. The message remains until unpaused.

## Testing

- **Unit, `src/game.test.ts`:**
  - A new state has `readyTicks === READY_TICKS`.
  - While Ready, `tick` with a direction leaves pacman and ghost positions unchanged and lowers `readyTicks` by 1.
  - After `READY_TICKS` ticks, the next tick moves pacman.
  - `loseLife` with lives left sets `readyTicks` again, and with the last life does not.
  - A paused state keeps its counter.
  - Existing tests that tick straight from `createGameState()` must first skip Ready, for example by setting `readyTicks: 0`.
- **Unit, render (new `src/render.test.ts`, or the existing pattern if one exists):** with a stub canvas context, `drawFrame` calls `fillText('READY!', …)` when `readyTicks > 0` and not when it is `0` or the game is over.
- **E2E, `tests/e2e/app.spec.ts`:** a smoke check that the page loads and the game starts. Reading the canvas text is not reliable, so the unit tests cover the message itself. The accessibility check is unchanged.
