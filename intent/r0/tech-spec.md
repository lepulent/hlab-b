---
kind: tech-spec
plan: r0
rigor: prototype
---

# Tech spec: pacman (round 0)

## Shape

Static Vite/TS site, no backend, no persistence. Domain logic is pure and unit-testable
(`environment: node` in vitest); rendering, input and the game loop are DOM-bound and live
only in the composition layer, exercised by Playwright.

- `src/maze.ts` — the maze as data. Procedurally generated so every dot is provably reachable
  (a BFS test walks it): bordered grid, isolated interior pillars (never touching, so they can't
  wall anything off), a walled ghost house with one door, four corner power pellets.
- `src/game.ts` — pure state machine. `GameState` is an immutable value; every exported
  function takes a state and returns a new one. One function per rule: `nextPosition`
  (movement), `attemptMove` (wall collision), `eatDot` (dot/pellet scoring, frightens ghosts on
  a pellet), `resolveGhostCollisions` (ghost touch: eaten while frightened or costs a life),
  `loseLife` (respawn or end the run), `checkWin` (all dots gone). `tick` composes these plus a
  simple deterministic ghost-chase step (Manhattan-distance greedy, no reversal unless forced,
  flees when frightened) into one call per frame.
- `src/input.ts` — `keyToDirection`: a pure key-string → `Direction` lookup, WASD and arrows.
- `src/render.ts` — canvas drawing only, reads `GameState`, writes pixels. No game logic.
- `src/main.ts` — composition: wires canvas + HUD, keyboard listener, `requestAnimationFrame`
  loop at a fixed step, viewport resize (scales the canvas element, keeps the internal
  resolution and aspect ratio fixed for crisp pixel art).

## Why this split

Rule H-6 (determinism first) and the intent's explicit test list (movement, wall collision, dot
eating, ghost collision, win, lose) both point at the same shape: each rule is a separate pure
function so each gets its own unit test, and nothing that touches `canvas`/`window` needs to be
unit tested at all — Playwright covers the wiring.

## Out of scope this round

Sound, menu, leaderboard, persistence, ghost scatter/tunnel behaviour, level 2. One maze, one
life-cycle, four ghosts with one shared AI.
