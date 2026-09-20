# Tech spec: show the score while the game runs (s13d)

## Finding: the running score is already shown

The intent says the score is only visible at game end. The code says otherwise:

- `index.html:44-47` has a `#hud` div holding `<span id="score">Score: 0</span>` next to `<span id="lives">Lives: 3</span>`, above the canvas.
- `src/main.ts:56-61`, `render()`, sets `scoreEl.textContent = \`Score: ${state.score}\``and`livesEl.textContent` on every animation frame, whether the game is playing, paused or ended.
- `tests/e2e/app.spec.ts:4-11` already asserts that `#score` and `#lives` are in the page.

So on this branch a player already sees the score beside the lives during play. **OPEN (Q1):** is the intent's premise stale, or does the requester want something the HUD does not do today (for example the score drawn on the canvas, or a different look)? Everything below assumes the premise is stale and the work is to confirm and lock in what exists. If Q1 is answered otherwise, this spec needs a rewrite of "Approach".

## Approach and stack

TypeScript, Vite, Vitest for unit tests, Playwright for end-to-end. No new dependency, no new file under `src/`. The game is a pure state machine in `src/game.ts`, drawn by `src/render.ts`, wired to the page by `src/main.ts`.

Proposed change, kept small (assumption A2): add one exported pure function `hudText(state)` in `src/render.ts`, next to the existing `statusText`. It returns `{ score: 'Score: N', lives: 'Lives: N' }`. `main.ts` `render()` calls it instead of building the strings inline. The point is testability: `main.ts` reads the DOM at import time, so its strings cannot be unit-tested, while `statusText` shows that pure text helpers in `render.ts` can. The export carries a `// canon: CAP-n.k` comment (see Canon).

## Parts

| Part        | File            | Responsibility                                                                                     |
| ----------- | --------------- | -------------------------------------------------------------------------------------------------- |
| Game state  | `src/game.ts`   | Owns `score`, `lives` and every rule that changes them. Unchanged.                                 |
| HUD text    | `src/render.ts` | `hudText(state)`: turns state into the two HUD strings. New, pure.                                 |
| Page wiring | `src/main.ts`   | Each frame, writes the HUD strings into `#score` and `#lives`. Only the string building moves out. |
| HUD markup  | `index.html`    | The `#hud` spans. Unchanged.                                                                       |

Layering follows `canon/layer-map.json`: `render.ts` and `game.ts` are domain, `main.ts` and `index.html` are composition, and composition may depend on domain.

## State kept and where

`GameState.score` (`src/game.ts:22`) is the only score. It lives in memory in the `state` variable in `main.ts`, starts at 0 in `createGameState()`, and is replaced by a fresh state on restart (`src/input.ts` `handleKey`). Nothing is persisted. The HUD keeps no copy: it is derived from `state` on every frame, so it cannot drift from the real score.

## Where scoring happens (read-only; not changed)

- Dot: `eatDot` adds `DOT_SCORE` 10; pellet: adds `PELLET_SCORE` 50 (`game.ts:96`). Called from `movePacman`.
- Ghost caught while frightened: `resolveGhostCollisions` adds `GHOST_SCORE` 200 (`game.ts:134`). Called twice per `tick`.
- Lives: `loseLife` decrements `lives` (`game.ts:113`).

## Main flows

1. **Refresh.** `frame()` runs each animation frame. Every 160 ms, if playing and not paused, it runs `tick`, which returns a new `state` and may change `score`. Then `render()` runs regardless: it draws the canvas, then writes `hudText(state)` into `#score` and `#lives`. The HUD therefore shows a change on the next frame after `tick`.
2. **Dot / pellet.** Direction key sets `currentDirection`; `tick` → `movePacman` → `eatDot` → `score` +10 or +50 → next `render()` shows it.
3. **Ghost.** `tick` → `resolveGhostCollisions` with a frightened ghost on pacman's tile → `score` +200 → next `render()` shows it.
4. **Pause.** `tick` returns the state unchanged, so the HUD is unchanged (CAP-2.6).
5. **End of game.** `tick` stops changing an ended state. The HUD keeps showing the final score and the canvas overlay shows the same number (CAP-3.1, CAP-3.2).
6. **Restart.** Any key on the score screen makes a fresh state; the next `render()` shows `Score: 0` and `Lives: 3` (CAP-3.3).

## Untouched

Scoring values and rules, `tick` order, ghost and life logic, pause and restart behaviour, the end-of-game score screen (`drawScoreScreen`) and its text, the `#hud` markup and styles, and the canvas drawing. The change, if any, is string building only.

## Canon

Score during play is not in any CAP criterion today; CAP-1.3 covers only "adds to the score". Assumption A3: the build adds a criterion (for example under CAP-1) that the score and lives are shown during play and follow the game, bound to the tests below. Canon files are authored by the canon step, not by this seat.

## Testing

- **Unit (Vitest, `src/game.test.ts`, next to what they bind).**
  - `hudText` returns `Score: 0` / `Lives: 3` for a new game and the matching strings for a given state.
  - Dot: `tick` onto a dot, then `hudText` shows `Score: 10`. Pellet: `Score: 50`. Frightened ghost caught: `Score: 200` (the existing 210-point tick test is a model). Life lost: `Lives: 2`.
  - Paused: `hudText` is identical before and after ticks (extends P0-UI-002).
  - Ended game: `hudText` score equals the score on the canvas overlay.
  - Scoring unchanged: existing P0-GAME-003 and P0-GAME-004 tests must still pass untouched; that is the guard that scoring did not change.
- **End to end (Playwright, `tests/e2e/app.spec.ts`).** Load the page, check `#score` reads `Score: 0` next to `#lives`; press a direction key and wait for `#score` to show a value above 0 without the game ending. This covers the wiring in `main.ts` that unit tests cannot reach. The existing axe accessibility test must stay green.
- **Gate.** `npm run check` (prettier, eslint, tsc, knip, vitest, audit) stays green; knip needs `hudText` to be used by `main.ts`.

## Assumptions

- A1: The intent's front matter names plan `s13b`; this work is plan `s13d` per `ROUTE.json`. Treated as a label slip.
- A2: Adding `hudText` is acceptable as a refactor for testing. If the team prefers no code change, drop it and rely on the e2e test alone.
- A3: A new canon criterion is wanted for the HUD (see Canon).
- A4: A pressed direction key from the start tile reaches a dot within a few steps; the builder confirms against `src/maze.ts` (start `{9,15}`) before fixing the e2e wait.
