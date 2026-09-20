# Development plan: show the score while the game runs (s13d)

Rigor: prototype. Built on `intent/s13d/tech-spec.md` and `canon/capabilities/CAP-4.md`.

## Decision on record: Q-2 answered

Q-2 asked whether the intent is out of date or whether the current display lacks something. The Master answered: **the intent is stale; only lock in the existing display with tests.**

The running score already shows beside the lives. `index.html` has `#score` next to `#lives` in `#hud`, and `render()` in `src/main.ts` writes `Score: ${state.score}` and `Lives: ${state.lives}` on every animation frame. So the intent's premise ("only visible when the game ends") no longer holds, and the work is tests that lock in that display.

This closes open question Q1 in the tech spec.

## Scope: what this plan does not do

- No behaviour change.
- No scoring change. What a dot, a power pellet and a caught ghost are worth stays as CAP-1.3 and CAP-1.4 set it; this plan cites them by id and does not restate amounts.
- No `hudText` refactor. The tech spec's assumption A2 (add `hudText` to `src/render.ts` and have `main.ts` call it) is **overridden by Q-2**. No change under `src/`, `index.html` or styles. The tech-spec sections "Approach and stack", "Parts", and the unit-test bullets that call `hudText` are superseded by this plan.

The new work is test files only: `tests/e2e/app.spec.ts` and, next to existing tests, `src/game.test.ts`.

## Epic order

| Order | Epic                                           | Depends on |
| ----- | ---------------------------------------------- | ---------- |
| 1     | E1: Tests locking in the in-play score display | none       |
| 2     | E2: Suite passes                               | E1         |

### E1: Tests locking in the in-play score display (CAP-4.1 to CAP-4.6)

**Delivers.** Tests, each carrying a `// canon: CAP-4.x` comment and bound to its `P0-UI-0xx` id, that pass against the code as it stands:

| Criterion | Binding   | What the test locks in                                                                           | Where                                                        |
| --------- | --------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| CAP-4.1   | P0-UI-009 | During play `#score` is visible and reads `Score: 0` before anything is eaten.                   | e2e                                                          |
| CAP-4.2   | P0-UI-010 | `#score` is in the same row as `#lives`, next to it (compare bounding boxes).                    | e2e                                                          |
| CAP-4.3   | P0-UI-011 | Eating a dot raises the displayed score by the amount CAP-1.3 gives a dot.                       | e2e for the DOM; unit for the state change `render()` writes |
| CAP-4.4   | P0-UI-012 | Eating a power pellet raises the displayed score by the amount CAP-1.3 gives a power pellet.     | unit                                                         |
| CAP-4.5   | P0-UI-013 | Catching a frightened ghost raises the displayed score by the amount CAP-1.4 gives.              | unit                                                         |
| CAP-4.6   | P0-UI-014 | On the win and game-over screens the score equals the score the display showed on the last step. | unit                                                         |

Expected amounts come from CAP-1.3 and CAP-1.4 (through the canon or the constants `game.ts` already exports), never from this plan.

**Done when**, checked by a reader of the diff and by running the tests:

1. There is at least one test bound to each of P0-UI-009 to P0-UI-014, and each one passes.
2. The diff touches test files only. No file under `src/` (other than `src/game.test.ts`), no `index.html`, no canon file changes.
3. The existing scoring tests (P0-GAME-003, P0-GAME-004) are unchanged and still pass; that is the guard that scoring did not change.
4. No test states a point value as a literal that CAP-1.3 or CAP-1.4 owns without tying it to that id.

### E2: Suite passes

**Delivers.** Evidence that the new tests sit cleanly in the whole suite: `npm run check` (prettier, eslint, tsc, knip, vitest, audit) and the Playwright e2e run, including the existing axe accessibility test.

**Done when:**

1. `npm run check` exits green with E1's tests included.
2. The Playwright e2e run is green, including the existing home-page, canvas-scaling and axe tests.
3. `git diff` against the base shows only test-file changes.
4. If anything fails, the failure is reported with its output; a test is not weakened or skipped to get green. A failing lock-in test means the display does not do what CAP-4 says, and that goes back to the Master, not into a code fix under this plan.

## Assumptions

- A1 (from the tech spec): the intent's front matter names plan `s13b`; this is plan `s13d` per `ROUTE.json`. Treated as a label slip.
- A2: Without `hudText`, `main.ts` cannot be unit-tested, because it reads the DOM at import time. So the DOM strings are checked by Playwright, and the unit tests check the `state.score` changes that `render()` writes verbatim as `Score: ${state.score}`. That does not test the string itself. It is accepted at prototype rigor.
- A3: The power pellet and the frightened ghost are hard to reach reliably in real time in a browser, so CAP-4.4 and CAP-4.5 are checked at unit level, and only the dot (CAP-4.3) is also checked end to end. The builder confirms the route to a dot from the start tile against `src/maze.ts` (tech spec A3) before fixing the wait.
- A4: The end screen (`drawScoreScreen`) draws on the canvas, so its text cannot be read from the DOM. CAP-4.6 is checked by asserting that the score on an ended state is the one the last `tick` produced and does not change afterwards. If the builder finds the end-screen code reads a different value, that is a finding to report, not something to fix here.
- A5: "Same row" for CAP-4.2 means the two elements' bounding boxes overlap vertically and `#score` is adjacent to `#lives`.

## Open questions

None. Q-2 settled the one decision that changed what this plan says.
