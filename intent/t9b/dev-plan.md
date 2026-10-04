# t9b Levels: development plan

Builds on `intent/t9b/tech-spec.md` and `canon/capabilities/CAP-5.md`. Decisions already taken (Q-1, Q-2): the `won` status and YOU WIN screen are removed entirely, and the game ends only by losing all lives.

## Order and dependencies

E1 → E2 → E3, and E1 → E4. E3 and E4 are independent of each other; E4 touches the same test files as E1/E2, so do it after E2 to avoid conflicts. Suggested order: E1, E2, E3, E4.

## E1. Level state and `advanceLevel`

Depends on: nothing.

Delivers:

- `level: number` on `GameState` in `src/game.ts`, starting at 1 in `createGameState`.
- A pure `advanceLevel(state)` that returns the next state with `level + 1`.
- `checkWin` (the win-detection point: `playing` and `dotsRemaining <= 0`) calls `advanceLevel` instead of setting `won`. `tick` returns straight after it, so ghosts do not move or collide in the clearing tick.
- `loseLife` and restart keep their behaviour; restart returns `level` to 1 via `createGameState`.

Done when (CAP-5 criteria):

- CAP-5.4: eating the last dot gives `level + 1` and status `playing`, including when the last dot is a pellet; two clears in a row give level 3.
- CAP-5.6: `createGameState` has `level` 1, and restart brings it back to 1.
- Unit tests in `game.test.ts` and `input.test.ts` pass, titled with their coverage rows (P0-GAME-017, P0-GAME-019).

## E2. Reset of maze, pacman and ghosts, with score and lives kept

Depends on: E1 (the reset lives inside `advanceLevel`).

Delivers:

- Inside `advanceLevel`: `maze` from `createMaze()` with `dotsRemaining` from `countRemaining`; pacman at `PACMAN_START` facing `left`; each ghost at its `home`, `mode: 'chase'`, `dir: 'up'`; `frightenedTicks` 0.
- `score`, `lives`, `status` and `paused` carried over unchanged.

Done when:

- CAP-5.1: after a clear the maze is full and `dotsRemaining` matches it (P0-GAME-014).
- CAP-5.2: pacman is at its start (P0-GAME-015).
- CAP-5.3: every ghost is at its start (P0-GAME-016).
- CAP-5.5: score and lives equal their values just before the last dot, apart from that dot's points (P0-GAME-018).
- Unit tests for each pass; a test shows the ghosts did not move in the clearing tick.

## E3. HUD level display next to the score

Depends on: E1 (needs `state.level`).

Delivers:

- Pure helper `levelText(state)` in `src/render.ts` returning `Level: n`.
- `<span id="level">` in `index.html`'s `#hud` beside `#score`, written each frame in `main.ts` `render()`.

Done when:

- CAP-5.7: the home page shows `#level` containing `Level: 1` beside the score (Playwright, P0-UI-015); the axe check still passes.
- CAP-5.8: `levelText` on a state after a clear returns the level plus 1 (unit test, P0-UI-016). The e2e suite does not play a whole maze; this is covered at unit level on a nearly cleared state.

## E4. Remove `won` and YOU WIN; reconcile CAP-1.5 and CAP-3.1

Depends on: E1 and E2 (nothing may reach `won` any more once the clear leads to a new level).

Delivers:

- `'won'` removed from the status type; the YOU WIN overlay in `render.ts` and the "You win!" text in `statusText` removed; any remaining code path to `won` removed.
- Existing `checkWin`/`won` tests and the YOU WIN rendering tests deleted or rewritten to the level behaviour.
- Canon: CAP-1.5 and CAP-3.1 reconciled with CAP-5 so no criterion says eating every dot wins. Those files are not owned by this plan document; the curator does that. Reconciliation is by removing or rewriting those criteria so they state that the game ends only when all lives are lost. The "Open question" paragraph in CAP-5 "Why" is then closed.

Done when:

- A search of `src/`, `tests/` and `canon/` finds no `won` status, "YOU WIN" or "You win!".
- The game can only end through `lost` (all lives gone); a test confirms that clearing the maze never ends the game.
- CAP-1.5, CAP-3.1 and CAP-5 no longer contradict each other (CAP-5.1 to CAP-5.5 stand as written), and the tests bound to the removed criteria are removed or rebound.
- Full unit and e2e suites pass.

## Assumptions

- No last level and no difficulty change between levels (from the tech spec and CAP-5).
- Frightened mode is cleared on level-up; pacman's held direction in `main.ts` is left as it is.
- Which bindings from CAP-1.5 and CAP-3.1 are retired or rebound is for the curator to decide in E4; this plan does not name them because those canon files were not part of the documents given.
- Nothing is persisted; there is no new dependency.

## Open questions

None.
