---
id: CAP-2
kind: capability
title: Pause and resume
version: 0.1.0
assurance: draft
valid_from: a941f1ab393cc9c6ee8e05c49ea33f3d28e2a914
---

## Why

A player who has to look away should not lose their lives for it. The P key freezes the game where it
stands and lets the player pick it up again, with nothing eaten and nothing lost in between.

## Criteria

### CAP-2.1 Pressing P or p while the game is being played pauses it, and pressing it again resumes it

bindings: [P0-GAME-009]

### CAP-2.2 While the game is paused, pacman and every ghost stay on their tiles

bindings: [P0-GAME-010]

### CAP-2.3 While the game is paused, nothing is eaten and no life is lost, even with a ghost on pacman's tile, and the frightened timer does not count down

bindings: [P0-GAME-011]

### CAP-2.4 Once resumed, pacman and the ghosts move again on the next step

bindings: [P0-GAME-012]

### CAP-2.5 A game that has been won or lost cannot be paused

bindings: [P0-GAME-013]

### CAP-2.6 While the game is paused the status line reads Paused and the score, lives and canvas do not change, including when P is pressed before the first direction key

bindings: [P0-UI-002]

### CAP-2.7 Direction keys pressed while the game is paused are ignored and do not steer pacman after it resumes

bindings: [P0-UI-003]
