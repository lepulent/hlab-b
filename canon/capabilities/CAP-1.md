---
id: CAP-1
kind: capability
title: Pacman gameplay
version: 2.0.0
assurance: draft
valid_from: 18e2778f08822b567b864016a8252275b905082c
---

## Why

Round 0 asks for a playable, single-level pacman: pixel art on a responsive canvas, WASD or
arrow-key control, dots and power pellets, four ghosts, lives and a score, with a win and a
lose condition. This capability is the whole vertical slice.

## Criteria

### CAP-1.1 Pacman moves one tile per step in the requested direction

bindings: [P0-GAME-001]
pointers:

- src/game.ts#nextPosition

### CAP-1.2 A move into a wall tile is refused and pacman stays put

bindings: [P0-GAME-002]
pointers:

- src/game.ts#attemptMove

### CAP-1.3 Moving onto a dot or power pellet eats it and adds to the score, a pellet being worth more than a dot; a pellet also frightens every ghost

bindings: [P0-GAME-003]
pointers:

- src/game.ts#eatDot

### CAP-1.4 Touching a ghost costs a life, unless the ghost is frightened, in which case it is eaten for points

bindings: [P0-GAME-004]
pointers:

- src/game.ts#resolveGhostCollisions

### CAP-1.5 The game is won once every dot and pellet is eaten

bindings: [P0-GAME-005]
pointers:

- src/game.ts#checkWin

### CAP-1.6 The game is lost once the last life is spent; otherwise pacman and the ghosts respawn

bindings: [P0-GAME-006]
pointers:

- src/game.ts#loseLife

### CAP-1.7 WASD and the arrow keys both drive the same four directions

bindings: [P0-GAME-007]
pointers:

- src/input.ts#keyToDirection

### CAP-1.8 The canvas rescales to the viewport, keeping the maze's aspect ratio and pixel-art sharpness

bindings: [P0-UI-001]
pointers:

- src/main.ts#applyScale
- src/render.ts#drawFrame

### CAP-1.9 Each tick, every ghost advances one walkable step toward pacman when chasing and away from pacman when frightened

bindings: [P0-GAME-008]
pointers:

- src/game.ts#moveGhost
- src/game.ts#moveGhosts
