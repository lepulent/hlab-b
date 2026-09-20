---
id: CAP-3
kind: capability
title: End-of-game score screen and restart
version: 0.0.0
assurance: draft
valid_from: 2aa73dc5c74c6b3db1b569d601074a4370b6bb00
---

## Why

When a game is won or lost the player should see how it went, and get another go without reloading the
page. The final score stays on the canvas until the player presses a key, which starts a fresh game.

## Criteria

### CAP-3.1 When the game is won, the canvas shows YOU WIN and the final score

bindings: [P0-UI-004]

### CAP-3.2 When the game is lost, the canvas shows GAME OVER and the final score

bindings: [P0-UI-005]

### CAP-3.3 On the score screen, pressing any key, P included, starts a fresh running game with the score, lives and dots back at their starting values

bindings: [P0-UI-006]

### CAP-3.4 The key that restarts the game does not steer pacman

bindings: [P0-UI-007]

### CAP-3.5 A held-down key repeating, or a key pressed with Ctrl, Meta or Alt, does not restart the game

bindings: [P0-UI-008]
