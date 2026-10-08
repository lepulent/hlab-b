# Tech spec: dots left in the maze (r20b)

## Approach and stack

No new dependencies. The game is TypeScript in `src/`, drawn on a canvas, with the HUD as DOM spans in
`index.html`. Unit tests use vitest in `src/*.test.ts`; end-to-end tests use Playwright in `tests/e2e/`.
The count already exists in game state, so the change is a HUD span plus its tests.

## Parts

- **Count source, `src/game.ts` (no change).** `GameState.dotsRemaining` already holds the count and
  `dotsTotal` the starting total. `createGameState` sets both from `countRemaining(createMaze())`, and
  `eatDot` lowers `dotsRemaining` by one for each `dot` or `pellet` cell it clears. The count therefore
  comes from the maze grid through the existing functions, not from a separate counter.
- **HUD text, `src/render.ts` (recommended small addition).** Add an exported pure function
  `dotsText(state: GameState): string` returning `Dots left: ${state.dotsRemaining}`. This lets the unit
  tests call it directly. `drawFrame` does not draw the count on the canvas.
- **Page, `index.html`.** Add `<span id="dots">Dots left: –</span>` inside `#hud`, between `#lives` and
  `#best`. Keeping it after `#lives` leaves the existing P0-UI-010 check (score then lives) passing.
- **Wiring, `src/main.ts`.** Get the `#dots` element with `required(...)` like the others, and set
  `dotsEl.textContent = dotsText(state)` in `render()`. `render()` runs before the first frame, so the
  placeholder is replaced at load.

## State

All state is in `GameState`, in memory, for the life of the page. Nothing is written to storage. The count
is reset only by `createGameState`, which runs on a new game. `loseLife` does not restore eaten dots.

## Main flows

1. **Page load.** `main.ts` builds the state with `createGameState()`. `dotsRemaining` = `dotsTotal` =
   the number of `dot` and `pellet` cells in the maze. `render()` writes `Dots left: N`.
2. **Eating a dot or pellet.** `tick` calls `movePacman`, which calls `eatDot` on the tile pacman enters.
   `dotsRemaining` drops by one. The next `render()` (each animation frame) shows the new value. No
   other code path changes the count.
3. **Boosted steps.** `movePacmanSteps` may call `eatDot` more than once in a tick. Each call lowers the
   count by one, so the HUD shows the value after every cell cleared in that tick.
4. **Paused or READY!.** `tick` returns early, `eatDot` is not called, and the count does not change.
5. **Lost life.** `loseLife` keeps the maze and `dotsRemaining`. The HUD value carries on.
6. **Win.** When `dotsRemaining` reaches 0, `checkWin` sets `status` to `won`. The HUD reads
   `Dots left: 0`, and the win screen is drawn as before.

## Tests

- **Unit, `src/game.test.ts`.**
  - Initial value: `createGameState().dotsRemaining` equals `countRemaining(createMaze())` and equals
    `dotsTotal`. Do not hard-code the number.
  - `eatDot` on a dot and on a pellet each lowers `dotsRemaining` by exactly one. Eating an already-empty
    tile leaves it unchanged.
  - A boosted tick that clears two cells lowers the count by two.
  - A paused tick and a READY! tick leave the count unchanged.
  - `loseLife` leaves the count unchanged.
  - `dotsText` returns `Dots left: N` for the state's count, including `0` after a win.
  - The page HTML contains `<span id="dots">` after `#lives` and before `#best`, in the same way as the
    P0-UI-009 and P0-UI-010 checks.
- **End to end, `tests/e2e/`.** With `?e2e`, the `#dots` text after load equals the initial count. After
  pacman moves onto a dot (set through `window.__game`), the text is one lower.
- **Canon.** The criterion (for example CAP-4.7, "the dots left shown equal the dots not yet eaten") and
  its test bindings belong in `canon/capabilities/CAP-4.md`. That file is not owned by this spec. Test IDs
  (for example P0-UI-018) are to be assigned by the test writer, using the next free numbers.

## Assumptions

- "Dots" means every `dot` and `pellet` cell, the same set `checkWin` uses. Pellets are counted because
  they are eaten and count toward the win.
- The count is shown only in the HUD, not on the canvas, and uses the wording `Dots left: N`.
- The `#dots` span sits between `#lives` and `#best`; its placement is not otherwise specified.
