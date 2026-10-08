# g4b development plan: remember the best score this session

Rigor: prototype. Built on `intent/g4b/tech-spec.md` (42ec90a). Nothing here goes beyond it. Rule files `src/game.ts`, `src/input.ts`, `src/render.ts` are not touched in any epic.

## Order and dependencies

E1 → E2 → E3 → E4. E2 needs `best.ts` from E1. E3 needs the `#best` element from E2 and the wiring in E2. Unit tests (E1) can run without a browser; E4 needs everything.

## E1. Pure module `src/best.ts` and its Vitest tests

- **Delivers:** `nextBest`, `readBest`, `writeBest`, `bestText` as in the spec (key `pacman.bestScore`; only non-negative integer strings accepted; never throws; `"Best: N"` or `"Best: –"`). Plus `src/best.test.ts` with fake storage objects.
- **Done when:** Vitest passes for these cases:
  - `nextBest`: null → score; higher replaces; lower or equal keeps.
  - `readBest`: missing key, valid value, and `"abc"`, `"-5"`, `"1.5"`, `""` → `null` except the valid one; `null` storage → `null`; throwing `getItem` → `null`.
  - `writeBest`: writes the right key and value; `null` storage and throwing `setItem` do not throw.
  - `bestText`: both forms.
  - The module references no DOM global.

## E2. HUD element and wiring: `index.html` and `src/main.ts`

- **Delivers:**
  - `index.html`: `<span id="best">Best: –</span>` in the HUD row after `#score` and `#lives`. This is the default placement and is changeable (see below).
  - `main.ts`: get `sessionStorage` inside try/catch (`null` on failure); `best = readBest(storage)` at load; each frame sets `#best` text with `bestText(best)`; keep the previous status in a local variable and, on a `playing` → `won`/`lost` transition after `tick`, set `best = nextBest(best, state.score)` and call `writeBest(storage, best)` once. Restart leaves `best` untouched.
- **Done when:**
  - The project type-checks and the Vitest suite still passes.
  - Played by hand or through `?e2e`, ending a run updates `#best` once, restart resets `#score` only, and a reload restores the best.
  - With storage access throwing, the page still loads and best works in memory.

## E3. Playwright journeys: `tests/e2e/best-score.spec.ts`

- **Delivers:** journeys using the existing `?e2e` seam `window.__game`.
- **Done when**, against the built app, all of these pass:
  - Fresh page shows `Best: –`.
  - Forcing `status: 'lost'` with a given score shows that score in `#best`; a key press restarts with `#score` 0 and `#best` unchanged.
  - A later ended run with a lower score leaves the best; a higher one raises it.
  - Reload in the same tab still shows the best.
  - With an init script making `sessionStorage` access throw, the page loads, a run ends, and `#best` updates.

## E4. Regression check

- **Delivers:** confirmation that nothing existing broke.
- **Done when:** the existing `app.spec.ts` HUD tests and the accessibility (axe) scan pass with the new span, and the full Vitest and Playwright suites are green.

## Placement (changeable default)

`#best` sits in the HUD row after Score and Lives. The intent leaves placement open, so this is a default only. Moving it (for example to the end-of-run overlay in `drawScoreScreen`) changes only where `bestText` is rendered in `main.ts`/`index.html`/`render.ts` and the E3 selectors, not `best.ts` or the storage. No question is raised.

## Assumptions

- "Session" means the tab session (`sessionStorage`).
- A win and a loss both count as a run ending; the best updates only at run end, not live.
- Key name `pacman.bestScore` and wording `Best: N` / `Best: –` are the spec's choices and easy to change.
- Prototype depth: no extra tooling, no CI changes, no new dependency. I did not inspect the existing test files' helpers; E3 reuses whatever `app.spec.ts` already does for the `?e2e` seam.
