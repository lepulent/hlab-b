# g1b development plan: a short "Ready!" message

Rigor: prototype. Built on `intent/g1b/tech-spec.md`. No new dependencies, files or build changes (a new `src/render.test.ts` is allowed only if no render test file exists).

## Epics in order

### 1. Ready state and tick hold (`src/game.ts`)

Depends on: nothing.

Delivers:

- `readyTicks: number` on `GameState` and a named constant `READY_TICKS = 12`.
- `createGameState()` starts with `readyTicks: READY_TICKS`.
- `loseLife()` sets `readyTicks: READY_TICKS` on the branch where lives remain; the final-life branch (`status: 'lost'`) does not.
- `tick()` keeps the existing `status !== 'playing' || paused` guard first, then returns early while `readyTicks > 0`, decrementing the counter and changing nothing else.

Done when:

- A new state has `readyTicks === READY_TICKS`.
- While Ready, `tick` with a direction leaves pacman and all ghost positions, score and lives unchanged and lowers `readyTicks` by 1.
- After `READY_TICKS` ticks, the next tick moves pacman.
- `loseLife` with lives left sets `readyTicks` to `READY_TICKS`; with the last life it does not.
- A paused state keeps its counter through a `tick`.
- Existing `src/game.test.ts` tests that tick straight from `createGameState()` are updated (for example `readyTicks: 0`) and pass.

### 2. `drawReady` rendering (`src/render.ts`)

Depends on: epic 1 (reads `readyTicks`).

Delivers:

- `drawReady(ctx, state)`: `READY!` in `PACMAN_COLOR`, `bold 14px monospace`, `textAlign = 'center'`, `textBaseline = 'middle'`, at column 9, row 12, `maxWidth` of `width - 2 * TILE`, no overlay.
- `drawFrame` calls it after the sprites, only when `status === 'playing' && readyTicks > 0`.
- `input.ts`, `main.ts` and `statusText` stay unchanged.

Done when:

- With a stub context, `drawFrame` calls `fillText('READY!', …)` when `readyTicks > 0` and the game is playing.
- It does not when `readyTicks` is `0`, or when status is not `'playing'`.
- The maze and characters are still drawn in the same frame (no overlay call).

### 3. Tests and verification

Depends on: epics 1 and 2. The unit tests for each epic are written with that epic; this step closes the gap.

Delivers:

- Unit tests listed under epics 1 and 2, in `src/game.test.ts` and a render test (existing pattern, else new `src/render.test.ts`).
- An e2e smoke check in `tests/e2e/app.spec.ts`: the page loads and the game starts. The accessibility check is unchanged.

Done when:

- The full unit suite and the Playwright suite pass with no skipped or removed existing tests.
- Restart (which calls `createGameState()`) and a lost life with lives remaining both show Ready, covered by the unit tests above.

## Order

1 → 2 → 3. Epic 1 alone already freezes the game for 12 ticks with no message, so it is safe to land first.

## Assumptions

- `READY_TICKS = 12` (about 1.9 s at `STEP_MS` 160 ms) is a tunable constant, not a requirement.
- A direction pressed during Ready applies on the first tick after it ends.
- The text sits at column 9, row 12, over any dots there; a dark backing strip is a tuning detail, out of scope.
- E2E cannot read canvas text, so the message itself is verified only by the render unit test.
- The tech spec's author could not run anything, so file names and existing test patterns are taken from the spec, not checked. Whoever implements should confirm them.

## Open questions

None.
