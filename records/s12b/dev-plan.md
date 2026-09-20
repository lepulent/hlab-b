---
kind: dev-plan
plan: s12b
rigor: prototype
---

# Development plan: pause with P, and a score screen when the game ends

Built on `intent/s12b/tech-spec.md`. Two epics, in order. Both extend existing files; no new file in
`src/`, no new dependency. New tests go next to the existing ones.

## Order and dependencies

1. Epic 1: Pause state and tick freeze (P key). No dependency.
2. Epic 2: End-of-game score screen and restart. Depends on Epic 1, because both change the
   `keydown` dispatch in `src/main.ts` (Epic 2 adds the score-screen branch to the three-way dispatch)
   and Epic 2's restart must produce an unpaused state (`paused: false`), which exists only after Epic 1.

## Epic 1: Pause state and tick freeze (P key)

**Delivers**

- `src/game.ts`: `paused: boolean` on `GameState`, `false` in `createGameState()`; `togglePause(state)`
  flips `paused` only while `status === 'playing'`, otherwise returns the state unchanged; `tick`
  returns the state unchanged while paused.
- `src/input.ts`: `isPauseKey(key)`, true for `p` and `P`. `keyToDirection` unchanged.
- `src/main.ts`: `keydown` handler ignores `event.repeat` and Ctrl/Meta/Alt events; P toggles pause;
  while paused every other key is ignored and `currentDirection` is not changed; the frame loop only
  redraws while paused and sets `last = timestamp`; `#status` shows `Paused` while paused;
  `preventDefault()` for consumed keys (P and direction keys).
- Pausing draws nothing extra on the canvas (assumption from the spec).

**Done when**

- Unit, `src/game.test.ts` (Vitest):
  - `createGameState()` has `paused === false`.
  - `tick` on a paused state returns it unchanged: pacman and ghost positions, `score`, `lives`,
    `dotsRemaining` and `frightenedTicks` all equal. Three cases: pacman facing a dot; a ghost on
    pacman's tile (no life lost); a frightened ghost on pacman (no score).
  - `togglePause` flips `false` to `true` and back; on a `won` state and on a `lost` state it returns
    the state unchanged.
  - After pause then resume, `tick` moves pacman and ghosts again.
  - The `buildState` helper gets `paused: false` so the file type-checks.
- Unit, `src/input.test.ts`: `isPauseKey` accepts `p` and `P`, rejects `w`, `Escape` and `''`.
- Browser, `tests/e2e/app.spec.ts` (Playwright): P shows `Paused` in `#status`; the `Score` and `Lives`
  text and the canvas pixels do not change over several step times while paused; P again clears
  `Paused` and the game moves again.
- Existing tests still pass, including the accessibility check on the home page.

## Epic 2: End-of-game score screen and restart

**Delivers**

- `src/render.ts`: `drawFrame` draws the score screen over the frozen maze when `status !== 'playing'`:
  a dark translucent layer, `YOU WIN` or `GAME OVER`, `Score: <state.score>`, and
  `Press any key to play again`, as canvas text with `imageSmoothingEnabled = false`. Exact layout and
  type size are left to the UX step.
- `src/main.ts`: the first branch of the `keydown` dispatch. When `status !== 'playing'`, any key
  (P included; auto-repeat and Ctrl/Meta/Alt shortcuts excluded) restarts: `state = createGameState()`,
  `currentDirection = null`, `last = 0`. The new game is unpaused and running; the restarting key is
  consumed and does not steer. `preventDefault()` for the restarting key.
- No new state fields: `status` (`won` or `lost`) and `score` already carry the ended state and final
  score. Nothing is persisted; no high score.

**Done when**

- Unit tests: the rules a restart relies on are covered by Epic 1's tests (`createGameState()` gives
  `paused === false`; `togglePause` is a no-op on `won` and `lost`). Add to `src/game.test.ts` a case
  that `tick` on a `won` or `lost` state leaves `status` and `score` unchanged, since the score screen
  reads them as the final result (assumption: the spec says this already holds; the test pins it).
- Browser, `tests/e2e/app.spec.ts` (Playwright), given a way to force the ended state: the final score
  is drawn on the canvas; any key restarts; `Score: 0` and `Lives: 3` show again; `#status` no longer
  shows `You win!` or `Game over`; the restarting key does not steer pacman.
- The forcing hook (a test-only hook or URL flag) is an assumption for the build step to size. If it is
  judged too much for a prototype, these browser checks are done by hand and the gap is stated in the
  build report.
- Not tested automatically: canvas text layout and look (UX review) and exact restart timing.
- Existing tests still pass, including the accessibility check on the home page.

## Assumptions a reader must know

- P before the first direction key pauses like any other time; there is no start gate or start screen,
  because the loop already ticks from page load.
- Direction keys while paused are ignored, not buffered.
- Known rough edge, left as is: a player still pressing keys when the last life goes restarts at once
  and never sees the score. No lockout is specified because the intent asks for none.
- The score-screen text and layout are not checked by a test; only the final score value, restart and
  reset values are.
