# Development plan: dots left in the maze (r20b)

Source: `intent/r20b/tech-spec.md` (spec-writer, ae61088). The count already exists in `GameState`
(`dotsRemaining`, `dotsTotal`), so the work is a pure helper, one HUD span, one wire-up, and tests.
No new dependencies.

## Epics in order

Single epic: **E1, Dots-left HUD counter.** Its steps run in the order below. Each step depends on the one
before it.

### Step 1: `dotsText` helper in `src/render.ts`

- **Delivers:** an exported pure function `dotsText(state: GameState): string` returning
  `Dots left: ${state.dotsRemaining}`. No canvas change; `drawFrame` is untouched.
- **Done when:** the function is exported, typed against `GameState`, and the unit tests in step 4 that
  call it pass. Type check passes. `drawFrame` output is unchanged for existing tests.

### Step 2: `#dots` span in `index.html`

- **Delivers:** `<span id="dots">Dots left: –</span>` inside `#hud`, placed between `#lives` and `#best`.
- **Done when:** the page HTML contains `<span id="dots">` after `#lives` and before `#best`. The existing
  P0-UI-009 and P0-UI-010 checks (score then lives) still pass.

### Step 3: wire-up in `src/main.ts`

- **Delivers:** `#dots` fetched with `required(...)` like the other HUD elements, and
  `dotsEl.textContent = dotsText(state)` set inside `render()`.
- **Depends on:** steps 1 and 2.
- **Done when:** after load the element reads `Dots left: N` with N equal to the initial count, with no
  placeholder left. A missing `#dots` element fails loudly, as the other `required(...)` lookups do.

### Step 4: unit tests in `src/game.test.ts`

- **Delivers:** the unit checks listed in the tech spec:
  - initial `dotsRemaining` equals `countRemaining(createMaze())` and `dotsTotal` (not hard-coded);
  - `eatDot` on a dot and on a pellet each lowers the count by exactly one; on an empty tile it is unchanged;
  - a boosted tick clearing two cells lowers the count by two;
  - a paused tick and a READY! tick leave the count unchanged;
  - `loseLife` leaves the count unchanged;
  - `dotsText` returns `Dots left: N`, including `0` after a win;
  - the HTML contains `<span id="dots">` after `#lives` and before `#best`, in the same style as P0-UI-009 and P0-UI-010.
- **Depends on:** steps 1 and 2 (the HTML check and `dotsText`).
- **Done when:** all listed tests pass under vitest.

### Step 5: end-to-end check in `tests/e2e/`

- **Delivers:** with `?e2e`, the `#dots` text after load equals the initial count. After pacman moves onto
  a dot (set through `window.__game`), the text is one lower.
- **Depends on:** steps 2 and 3.
- **Done when:** the Playwright test passes against the built page.

### Step 6: canon follow-up (outside this plan's ownership)

- **Delivers:** the criterion (for example CAP-4.7, "the dots left shown equal the dots not yet eaten") and
  its test bindings in `canon/capabilities/CAP-4.md`. Test IDs (for example P0-UI-018) are assigned by the
  test writer using the next free numbers.
- **Depends on:** steps 4 and 5, so the IDs and bindings refer to tests that exist.
- **Done when:** CAP-4 lists the criterion and binds it to the unit and e2e tests from steps 4 and 5. This
  step is not performed by this plan's author; it needs a seat that owns `canon/`.

## Assumptions

- "Dots" means every `dot` and `pellet` cell, the same set `checkWin` uses. Pellets are counted.
- The count appears only in the HUD, not on the canvas, using the wording `Dots left: N`.
- The `#dots` span placement (between `#lives` and `#best`) is as the spec states; no other placement is
  considered.
- `src/game.ts` needs no change; the existing `eatDot`, `countRemaining`, and `createGameState` are reused.
- The `–` placeholder in the HTML is replaced at load by `render()`, so it is never seen after the first frame.
- No open questions were raised; the spec settles every decision the intent leaves open.
