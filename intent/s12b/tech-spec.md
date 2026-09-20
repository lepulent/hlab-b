---
kind: tech-spec
plan: s12b
rigor: prototype
---

# Tech spec: pause with P, and a score screen when the game ends

## Approach and stack

Extend the existing game; add nothing new. TypeScript with Vite, the 2D canvas for drawing, zod at the
keyboard boundary (`src/input.ts`), Vitest for unit tests and Playwright for the browser test. The
rules stay pure functions in `src/game.ts` (state in, state out); `src/main.ts` owns the loop, the
keyboard listener and the DOM; `src/render.ts` only draws. No new dependency, no new file in `src/`
(new tests go next to the existing ones).

## Parts

- **`game.ts`, the rules.** Gains `paused: boolean` on `GameState`, set to `false` in `createGameState()`.
  Gains `togglePause(state)`: flips `paused` while `status === 'playing'`, otherwise returns the state
  unchanged. `tick` returns the state unchanged when paused. Restart needs nothing new: it is
  `createGameState()`.
- **`input.ts`, the key boundary.** Gains `isPauseKey(key)`, true for `p` or `P`. `keyToDirection` is unchanged.
- **`main.ts`, the loop and the keys.** The `keydown` handler becomes a three-way dispatch on the
  current state (see Flows). The frame loop skips ticking while paused. The HUD `#status` element shows
  `Paused` while paused, next to the existing `You win!` and `Game over` text.
- **`render.ts`, drawing.** `drawFrame` draws the score screen over the frozen maze when
  `status !== 'playing'`: a dark translucent layer, `YOU WIN` or `GAME OVER`, `Score: <state.score>`,
  and `Press any key to play again`. Canvas text with the existing `imageSmoothingEnabled = false`.
  Exact layout and type size are left to the UX step. Pausing draws nothing extra on the canvas (assumption).

## State and where it lives

- In `GameState` (in memory, replaced on each tick as today): the new `paused` flag. The ended state
  and the final score need **no new fields**: `status` is already `'won' | 'lost'` and `score` already
  holds the final score, because `tick` stops changing an ended game.
- In `main.ts`, as today: `currentDirection` and the `last` frame timestamp. A restart resets both.
- Nothing is persisted. No storage, no network, no backend. There is no high score.

## Flows

**Pause and resume.** P pressed while `status === 'playing'`: `state = togglePause(state)`. While
`paused`, `tick` is a no-op, so pacman and the ghosts stay put, nothing is eaten, no life is lost,
and `frightenedTicks` does not count down. While paused the frame loop only redraws, and sets
`last = timestamp` so the game resumes one full step after the next P, not with an instant step.
P again clears the flag.

**Key dispatch (`keydown`).** Ignore events with `event.repeat` or with Ctrl, Meta or Alt held (so
browser shortcuts still work). Then, by state:

1. `status !== 'playing'` (score screen): any key restarts (below), P included.
2. `paused`: P resumes. Every other key is ignored, and `currentDirection` is not changed.
3. otherwise: P pauses; a direction key sets `currentDirection`, as today. Other keys are ignored.

`preventDefault()` is called for keys the game consumes (P, direction keys, and any key that restarts),
so arrows and Space do not scroll the page.

**Game ends.** No new code path. `loseLife` and `checkWin` already set `status` to `'lost'` or `'won'`
and `tick` stops; the next `render()` draws the score screen and sets `#status` and `#score`.

**Restart.** On the score screen, any key: `state = createGameState()`, `currentDirection = null`,
`last = 0`. The new game is unpaused and starts running at once, as a page load does today. The key
that restarted it is consumed and does not steer pacman; the player presses a direction as usual.

## Decisions on what the intent leaves open

- **P before the first direction key.** Pauses like any other time. The repository has no "not started"
  state: the loop ticks from page load and the ghosts already move before the first key. This spec adds
  no start gate and no start screen (assumption; the intent's "runs from the first key" does not match
  the code, and the code's behaviour is kept).
- **P on the score screen.** Counts as "a key" and restarts. There is nothing to pause.
- **Which key restarts, and does it also start play.** Any key except auto-repeat and modifier
  shortcuts. Yes, it starts a fresh running game; it does not also steer.
- **Direction keys while paused.** Ignored, not buffered.
- **Known rough edge (assumption, left as is).** A player still mashing direction keys when the last
  life goes will restart at once and never see the score. A short lockout would fix this; it is not
  specified because the intent asks for none.

## Testing

- **Unit, `src/game.test.ts` (Vitest).** `tick` on a paused state returns it unchanged: pacman and
  ghost positions, `score`, `lives`, `dotsRemaining` and `frightenedTicks` all equal. Cases: pacman
  facing a dot, a ghost on pacman's tile (no life lost), a frightened ghost on pacman (no score).
  `togglePause` flips both ways, and does nothing on a `won` or `lost` state. `createGameState()` has
  `paused === false`. After a pause and resume, `tick` moves again. The `buildState` helper in this
  file needs `paused: false` to keep type-checking.
- **Unit, `src/input.test.ts`.** `isPauseKey` accepts `p` and `P` and rejects `w`, `Escape`, and an empty string.
- **Browser, `tests/e2e/app.spec.ts` (Playwright).** Drive the real page by keyboard. P shows `Paused`
  in `#status`; the `Score` and `Lives` text and the canvas pixels do not change over several step
  times while paused; P again clears `Paused`. Reaching a real game end by playing is slow and random, so
  the score-screen and restart checks (final score drawn, any key restarts, `Score: 0` and `Lives: 3`
  again) need a way to force the ended state, for example a test-only hook or URL flag. That hook is
  an assumption for the build step to size; if it is judged too much for a prototype, those checks
  are done by hand and the gap is stated.
- **Not tested.** Canvas text layout and look (UX review), and the exact restart timing.
- Existing tests must keep passing; the accessibility check on the home page runs unchanged.
