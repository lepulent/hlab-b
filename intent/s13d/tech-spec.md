# Tech spec: show the score while the game runs (s13d)

## Finding: the running score is already shown

The intent says the score is only visible at game end. The code says otherwise:

- `index.html:44-47` has a `#hud` div holding `<span id="score">Score: 0</span>` next to `<span id="lives">Lives: 3</span>`, above the canvas.
- `src/main.ts:56-61`, `render()`, sets `scoreEl.textContent = \`Score: ${state.score}\``and`livesEl.textContent` on every animation frame, whether the game is playing, paused or ended.
- `tests/e2e/app.spec.ts:4-11` already asserts that `#score` and `#lives` are in the page.

So on this branch a player already sees the score beside the lives during play. **OPEN (Q1):** is the intent's premise stale, or does the requester want something the HUD does not do today (for example the score drawn on the canvas, or a different look)? Everything below assumes the premise is stale and the work is to confirm and lock in what exists. If Q1 is answered otherwise, this spec needs a rewrite of "Approach".

## Scope

Only the display of the score. What eating a dot, a power pellet or a frightened ghost is worth is set by CAP-1.3 and CAP-1.4 and is not restated or changed here; where this spec needs an amount, it points at the canon id. The display behaviour itself is CAP-4.1 to CAP-4.6.

## Approach and stack

TypeScript, Vite, Vitest for unit tests, Playwright for end-to-end. No new dependency, no new file under `src/`. The game is a pure state machine in `src/game.ts`, drawn by `src/render.ts`, wired to the page by `src/main.ts`.

Proposed change, kept small (assumption A2): add one exported pure function `hudText(state)` in `src/render.ts`, next to the existing `statusText`. It returns `{ score: 'Score: N', lives: 'Lives: N' }`. `main.ts` `render()` calls it instead of building the strings inline. The point is testability: `main.ts` reads the DOM at import time, so its strings cannot be unit-tested, while `statusText` shows that pure text helpers in `render.ts` can. The export carries a `// canon: CAP-4.1` comment.

## Parts

| Part        | File            | Responsibility                                                                                     |
| ----------- | --------------- | -------------------------------------------------------------------------------------------------- |
| Game state  | `src/game.ts`   | Owns `score`, `lives` and every rule that changes them (CAP-1.3, CAP-1.4). Unchanged.              |
| HUD text    | `src/render.ts` | `hudText(state)`: turns state into the two HUD strings. New, pure.                                 |
| Page wiring | `src/main.ts`   | Each frame, writes the HUD strings into `#score` and `#lives`. Only the string building moves out. |
| HUD markup  | `index.html`    | The `#hud` spans, score beside lives (CAP-4.2). Unchanged.                                         |

Layering follows `canon/layer-map.json`: `render.ts` and `game.ts` are domain, `main.ts` and `index.html` are composition, and composition may depend on domain.

## State kept and where

`GameState.score` (`src/game.ts:22`) is the only score. It lives in memory in the `state` variable in `main.ts`, starts at 0 in `createGameState()`, and is replaced by a fresh state on restart (`src/input.ts` `handleKey`). Nothing is persisted. The HUD keeps no copy: it is derived from `state` on every frame, so it cannot drift from the real score.

## Where the score changes (read-only; not changed)

- Dot or power pellet eaten: `eatDot`, called from `movePacman`; the amounts are those of CAP-1.3.
- Ghost caught while frightened: `resolveGhostCollisions`, called twice per `tick`; the amount is that of CAP-1.4.
- Lives: `loseLife` decrements `lives` (CAP-1.6).

## Main flows

1. **Refresh.** `frame()` runs each animation frame. Every 160 ms, if playing and not paused, it runs `tick`, which returns a new `state` and may change `score`. Then `render()` runs regardless: it draws the canvas, then writes `hudText(state)` into `#score` and `#lives`. The HUD therefore shows a change on the next frame after `tick`.
2. **Dot / pellet.** Direction key sets `currentDirection`; `tick` → `movePacman` → `eatDot` → `score` rises by the CAP-1.3 amount → next `render()` shows it (CAP-4.3, CAP-4.4).
3. **Ghost.** `tick` → `resolveGhostCollisions` with a frightened ghost on pacman's tile → `score` rises by the CAP-1.4 amount → next `render()` shows it (CAP-4.5).
4. **Pause.** `tick` returns the state unchanged, so the HUD is unchanged (CAP-2.6).
5. **End of game.** `tick` stops changing an ended state. The HUD keeps showing the final score and the canvas overlay shows the same number (CAP-3.1, CAP-3.2, CAP-4.6).
6. **Restart.** Any key on the score screen makes a fresh state; the next `render()` shows the starting score and lives (CAP-3.3, CAP-4.1).

## Untouched

Scoring rules and amounts, `tick` order, ghost and life logic, pause and restart behaviour, the end-of-game score screen (`drawScoreScreen`) and its text, the `#hud` markup and styles, and the canvas drawing. The change, if any, is string building only.

## Canon

CAP-4 (bindings P0-UI-009 to P0-UI-014) now states the in-play display, so the earlier assumption that a criterion must still be added is settled. CAP-1.3 covers what is scored and says a power pellet scores more than a dot; this spec depends on that ordering only through the tests below. Canon files are authored by the canon step, not by this seat.

Note for the canon step, not a question: CAP-4.3 to CAP-4.5 write the amounts out, while CAP-1.3 no longer does. CAP-4.6 says they equal what CAP-1 scores, so the two must be kept in step if either changes.

## Testing

- **Unit (Vitest, `src/game.test.ts`, next to what they bind).**
  - P0-UI-009 / P0-UI-010: `hudText` returns the `Score: 0` and `Lives: 3` strings for a new game and the matching strings for a given state; both come from one call, so they sit together.
  - P0-UI-011 / P0-UI-012 / P0-UI-013: `tick` onto a dot, onto a pellet, and onto a frightened ghost each leave `hudText` showing the previous score plus the amount CAP-4.3, CAP-4.4 and CAP-4.5 give. The tests take the amounts from those criteria, not from this spec.
  - CAP-1.3 ordering: the pellet increase is larger than the dot increase.
  - Life lost: `hudText` shows one life fewer.
  - Paused: `hudText` is identical before and after ticks (extends P0-UI-002, CAP-2.6).
  - P0-UI-014: on a won and a lost state, the score in `hudText` equals the score the end screen shows.
  - Scoring unchanged: existing P0-GAME-003 and P0-GAME-004 tests must still pass untouched; that is the guard that scoring did not change.
- **End to end (Playwright, `tests/e2e/app.spec.ts`).** Load the page, check `#score` reads `Score: 0` in the same row as `#lives`; press a direction key and wait for `#score` to show a value above 0 without the game ending. This covers the wiring in `main.ts` that unit tests cannot reach. The existing axe accessibility test must stay green.
- **Gate.** `npm run check` (prettier, eslint, tsc, knip, vitest, audit) stays green; knip needs `hudText` to be used by `main.ts`.

## Assumptions

- A1: The intent's front matter names plan `s13b`; this work is plan `s13d` per `ROUTE.json`. Treated as a label slip.
- A2: Adding `hudText` is acceptable as a refactor for testing. If the team prefers no code change, drop it and rely on the e2e test alone.
- A3: A pressed direction key from the start tile reaches a dot within a few steps; the builder confirms against `src/maze.ts` (start `{9,15}`) before fixing the e2e wait.
