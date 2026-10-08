# g4b technical spec: remember the best score this session

Rigor: prototype. Nothing here goes beyond the intent: keep the best score of the browser session and show it.

## Approach and stack

Same stack as the repository: TypeScript, Vite-served `index.html` plus `src/main.ts`, Vitest unit tests next to the source (`src/*.test.ts`), Playwright journeys in `tests/e2e`. No new dependency. The score lives in the browser's `sessionStorage` (one tab's session, gone when the tab closes, which is what "this session" means). The game rules in `src/game.ts` do not change: the score is already `state.score`, and `tick` stops changing a game once `status` is `won` or `lost`.

## Parts

- **`src/best.ts` (new, pure, no DOM globals).** Owns the rule and the storage access.
  - `nextBest(best: number | null, score: number): number`: returns the larger of the two; a `null` best becomes `score`.
  - `readBest(storage: Pick<Storage, 'getItem'> | null): number | null`: reads key `pacman.bestScore`, accepts only a non-negative integer string, otherwise returns `null`. Never throws.
  - `writeBest(storage: Pick<Storage, 'setItem'> | null, best: number): void`: writes the key; swallows any error (quota, privacy mode).
  - `bestText(best: number | null): string`: `"Best: 120"`, or `"Best: –"` when there is none yet.
- **`src/main.ts` (edited).** Wiring only. At startup it gets the storage (see "Unavailable storage"), loads the best into a module variable, and each frame sets the new `#best` element's text next to the existing score and lives writes. It also detects a run ending (below).
- **`index.html` (edited).** Adds `<span id="best">Best: –</span>` in the existing HUD row beside `#score` and `#lives`.
- **`src/game.ts`, `src/input.ts`, `src/render.ts`: unchanged.** The canvas end screen keeps showing only the run's score.

## State and where it is kept

- `sessionStorage["pacman.bestScore"]`: the best score as a decimal integer string. Survives page reload within the tab, cleared with the tab.
- `main.ts` keeps a copy in a module variable `best: number | null`, and the frame loop reads that variable, never storage. It is the source of truth while the page is open.
- **Unavailable storage:** `window.sessionStorage` can throw on access (blocked cookies, sandboxed frame). `main.ts` obtains it inside try/catch and uses `null` on failure. With `null`, `readBest` returns `null` and `writeBest` does nothing, so the best score still works in memory for the life of the page and is simply lost on reload. No error is shown to the player. A corrupt stored value is treated as no value.

## Main flows

1. **Page load.** Get storage (or `null`) → `best = readBest(storage)` → first render shows `bestText(best)`.
2. **Run ends.** In `frame`, after `tick`, if the previous status was `playing` and `state.status` is now `won` or `lost`: `best = nextBest(best, state.score)`; `writeBest(storage, best)`. This is a transition check (previous status kept in a local variable), so it runs once per run, not each frame. The hud shows the new best at the same render.
3. **Restart.** The existing "any key" path creates a fresh state; `best` is untouched, so the HUD keeps showing it while `Score` returns to 0.
4. **Reload mid-run or after a run.** The run is lost as today; step 1 restores the best from storage (if available).
5. **A run that ends with score 0** (lost with nothing eaten) sets best to 0, displayed `Best: 0`.

## Placement of the best score (default, changeable)

The intent leaves this open. Default: in the HUD row above the canvas, after Score and Lives, as `#best`. Reasons: the HUD is already DOM text read by tests and screen readers, it needs no canvas drawing code, and it is visible during play so the player can compare the running score to it. It is a default only: moving it (for example onto the end-of-run overlay in `drawScoreScreen`) changes only where `bestText` is rendered, not `best.ts` or the storage. No question is raised because nothing else in this document depends on the choice.

## Testing

- **Unit, `src/best.test.ts` (Vitest, fake storage objects, no browser).**
  - `nextBest`: null → score; higher score replaces; lower or equal score keeps.
  - `readBest`: missing key, valid value, garbage (`"abc"`, `"-5"`, `"1.5"`, empty) → `null`; `null` storage → `null`; storage whose `getItem` throws → `null`.
  - `writeBest`: writes the expected key and value; `null` storage and a throwing `setItem` do not throw.
  - `bestText`: both forms.
- **E2E, `tests/e2e/best-score.spec.ts` (Playwright, uses the existing `?e2e` seam `window.__game`).**
  - Fresh page shows `Best: –`.
  - Set `__game` to a state with `status: 'lost'` and a given score → `#best` shows that score; restart with a key press → `#score` is 0 and `#best` unchanged.
  - A later ended run with a lower score leaves the best; a higher one raises it.
  - Reload the page in the same tab → best still shown.
  - Storage unavailable (init script making `sessionStorage` access throw): page loads, ends a run, and `#best` still updates in memory.
- **Existing tests** (`app.spec.ts` HUD, accessibility scan) must still pass; the new span is plain text and must not add axe violations.

## Assumptions

- "Session" means the browser tab session (`sessionStorage`), not the whole browser or across days.
- Both a win and a loss count as a run ending; the best is only updated when a run ends, not live during play.
- Before any run has ended and with nothing stored, the HUD shows `Best: –`.
- The storage key name `pacman.bestScore` and the `Best: N` wording are my choices, easy to change.
