---
id: CAP-7
kind: capability
title: Eaten ghosts return to the ghost house
version: 0.1.0
assurance: draft
valid_from: ad1df41095556646cbc3249f0709a1dc99d1aca6
---

## Why

A ghost that pacman eats should not pop straight back into the chase. It goes home to the
ghost house in the centre of the maze first, and only then starts chasing again, so eating a
ghost buys the player a visible breather.

## Criteria

### CAP-7.1 A frightened ghost touched by pacman is eaten for points and starts returning from where it was eaten

bindings: [P0-GAME-022]

### CAP-7.2 A returning ghost is harmless and uneatable: touching pacman costs no life and scores nothing

bindings: [P0-GAME-023]

### CAP-7.3 Each tick a returning ghost advances one walkable step along a shortest path to its home cell in the ghost house, ignoring pacman

bindings: [P0-GAME-024]

### CAP-7.4 A returning ghost enters the ghost house through its door and, on reaching its home cell, resumes chasing

bindings: [P0-GAME-025]

### CAP-7.5 A power pellet eaten while a ghost is returning does not frighten that ghost, and it keeps returning

bindings: [P0-GAME-026]

### CAP-7.6 When frightened mode ends while a ghost is still returning, that ghost keeps returning while the other ghosts resume chasing

bindings: [P0-GAME-027]

### CAP-7.7 Losing a life or starting a new game puts every ghost, including a returning one, on its home cell chasing

bindings: [P0-GAME-028]

### CAP-7.8 A returning ghost is drawn in a colour different from chasing and frightened ghosts

bindings: [P0-UI-017]
