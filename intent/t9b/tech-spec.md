# t9b Levels: technical spec

## Approach and stack

Brownfield change to the existing game: TypeScript (strict), Vite, canvas rendering, vitest for unit tests, Playwright for e2e. No new dependency. The game logic is a set of pure functions over `GameState` (`src/game.ts`); `main.ts` only runs the loop and writes the HUD. Levels follow that shape: a new field and one new pure transition, with no new module.

## Parts and responsibilities

- `src/game.ts` (domain). Adds `level: number` to `GameState` (starts at 1) and the pure function `advanceLevel(state)`. It owns the win-detection point and the reset.
- `src/maze.ts` (domain). Unchanged. `createMaze()`, `PACMAN_START`, `GHOST_STARTS` and `countRemaining()` already give a full maze and the starting places.
- `src/render.ts` (ui). `drawFrame` is unchanged apart from the question below. Adds a small pure helper `levelText(state)` returning `Level: n`.
- `src/main.ts` and `index.html` (composition). A new `<span id="level">` in `#hud` beside `#score`, written in `render()` like the score and lives.
- `src/input.ts`. Unchanged. Restart still calls `createGameState()`, so `level` goes back to 1.

## State and where it is kept

`level` lives in `GameState`, in memory only, next to `score` and `lives`. Nothing is persisted (no storage, no backend). A new game or a restart resets it to 1. `score`, `lives` and `paused` are carried over a level change as they are.

## Main flows

Clearing a level:

1. `tick` calls `movePacman`, which calls `eatDot` and then `checkWin`. `checkWin` is the point where the win is detected: `status === 'playing'` and `dotsRemaining <= 0`.
2. Instead of setting `status: 'won'`, that point now returns `advanceLevel(state)`.
3. `advanceLevel` builds the next state from the current one:
   - `maze`: `createMaze()`, and `dotsRemaining`: `countRemaining(maze)`;
   - `pacman`: position `PACMAN_START`, direction `left`;
   - `ghosts`: each back to its `home`, `mode: 'chase'`, `dir: 'up'`;
   - `frightenedTicks`: 0;
   - `level`: `level + 1`;
   - `score`, `lives`, `status: 'playing'` and `paused` are unchanged.
4. `tick` carries on from the new state. It stops after `movePacman` only when the status is no longer `playing`. A level change keeps `playing`, so the same tick would go on to the ghost steps against the fresh state. The implementation must return straight after `advanceLevel`, so ghosts do not move or collide in the tick that cleared the level.

HUD: each frame `main.ts` `render()` sets `levelEl.textContent = levelText(state)`, next to the score.

Restart, pause, and losing a life are unchanged. `loseLife` keeps `level`, because it spreads the state.

## Assumptions

- The game has no last level. Levels go up without limit.
- Difficulty does not change between levels: same maze, same speed, same frightened duration. The intent asks only for the refill, the reset and the number.
- Pacman's held direction in `main.ts` (`currentDirection`) is left as it is on a level change.
- Frightened mode and its timer are cleared on a level change (the ghosts return to chase).

## Open question

What becomes of the existing `won` status, the YOU WIN screen and `statusText`'s "You win!"? The intent says the game "should not simply end in a win", but does not say whether any win is left. This spec assumes level-up replaces the win in normal play and leaves the `won` type and its screen in the code, unreachable by play. Removing them would change canon CAP-1.5 and CAP-3 criteria and their tests. Decision pending.

## Testing

Unit tests (vitest, beside the code, titled with their coverage row as the repo's rules require):

- `game.test.ts`, `advanceLevel`: maze is full again and `dotsRemaining` matches; pacman and each ghost are at their starts, in chase mode; `frightenedTicks` is 0; `level` is +1; `score` and `lives` are equal to before.
- `game.test.ts`, `tick` win point: eating the last dot gives `level + 1` and status `playing`, not `won`. Another case: the last dot is a pellet. A third: ghosts did not move in that tick.
- `game.test.ts`, repeated clears: two in a row give level 3 with the score kept. `loseLife` keeps `level`.
- `game.test.ts`, `createGameState` has `level` 1, and `handleKey` restart (`input.test.ts`) brings it back to 1.
- `game.test.ts`: `levelText` returns `Level: n`. Existing `checkWin` and `won` tests are updated to whatever the open question decides.

E2E (Playwright, `tests/e2e/app.spec.ts`): the home page shows `#level` containing `Level: 1` beside the score, and the axe check still passes. Playing through a whole maze is not an e2e case; it is covered by the unit tests on a nearly cleared state.
