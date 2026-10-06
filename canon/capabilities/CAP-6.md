---
id: CAP-6
kind: capability
title: Ready message at the start of each life
version: 0.1.0
assurance: draft
valid_from: a2d86597a0ff55f235355cc30671a847ea16f0e8
---

## Why

A life that starts with everything already in motion gives the player no time to see where pacman
and the ghosts stand. A short READY! message in the maze, with everyone held still, lets the
player get oriented before play begins, at the start of the game and again after each life lost.

## Criteria

### CAP-6.1 When a game starts, the canvas shows READY! in the maze

bindings: [P0-UI-015]

### CAP-6.2 After a life is lost while lives remain, the canvas shows READY! in the maze

bindings: [P0-UI-016]

### CAP-6.3 When the last life is lost, no READY! is shown and the game is lost

bindings: [P0-GAME-019]

### CAP-6.4 While READY! is showing, pacman and every ghost stay on their tiles, even when a direction is requested

bindings: [P0-GAME-020]

### CAP-6.5 When READY! ends, the message disappears and pacman and the ghosts move on the next step

bindings: [P0-GAME-021]
