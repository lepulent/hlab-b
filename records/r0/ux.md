---
kind: ux-if-screen
plan: r0
rigor: prototype
---

# UX: pacman (round 0), one screen

Single screen, no navigation, no accounts. Dark page, centered column:

1. `h1` title.
2. HUD row: score (left), lives (right), plain text, updates every tick.
3. Canvas: fixed internal resolution (maze grid × 16px tile) for crisp pixel art
   (`image-rendering: pixelated`, `imageSmoothingEnabled = false`); CSS size is rescaled on
   `resize` to fit the viewport while holding the maze's aspect ratio, never upscaled past 1:1
   internal pixels beyond what the viewport allows.
4. Status line below the canvas (`aria-live="polite"`): empty while playing, "You win!" or
   "Game over" at the end. No modal, no restart button this round — a reload restarts.

Controls: WASD or arrow keys, both bound to the same four directions, no on-screen touch
controls this round (desktop-first prototype). Canvas carries `role="img"` with an
`aria-label` so the existing axe a11y check has something other than a bare `<canvas>` to
evaluate.
