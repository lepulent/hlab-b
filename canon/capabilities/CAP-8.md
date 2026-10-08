---
id: CAP-8
kind: capability
title: Speed boost after a power pellet
version: 0.1.0
assurance: draft
valid_from: e1328bfae9dc31af55798497e18ca06b6ae34250
---

## Why

Eating a power pellet should feel like a moment of strength. For a short time afterwards pacman
moves faster than everything else in the maze, so the player can use the pellet to cover ground,
chase frightened ghosts and escape. The boost length and the speed-up are tunable constants, not
part of this contract; the criteria hold for whatever values are set (the speed-up being a whole
number of cells per tick above one).

## Criteria

### CAP-8.1 Eating a power pellet starts a speed boost that applies from the next tick; eating an ordinary dot does not

bindings: [P0-GAME-029]

### CAP-8.2 While the boost is active pacman moves the boost multiplier of cells per tick, stopping at a wall, while ghosts still move one cell per tick

bindings: [P0-GAME-030]

### CAP-8.3 The boost lasts exactly the boost duration in ticks, after which pacman moves one cell per tick again

bindings: [P0-GAME-031]

### CAP-8.4 A power pellet eaten during a boost restores the full boost duration and does not add to the remaining time or raise the speed

bindings: [P0-GAME-032]

### CAP-8.5 Every cell pacman crosses during a boosted tick is resolved in turn: dots and fruit are eaten, a ghost met is eaten or costs a life, and pacman moves no further once the game is won or the life is lost

bindings: [P0-GAME-033]

### CAP-8.6 The boost does not count down while the game is paused or the ready message is showing

bindings: [P0-GAME-034]

### CAP-8.7 Losing a life or starting a new game ends any boost

bindings: [P0-GAME-035]
