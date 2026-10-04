---
id: CAP-5
kind: capability
title: Level progression
version: 0.0.0
assurance: draft
valid_from: 11a6bbf
---

## Why

A player who clears the maze should be able to keep playing, with the game getting a fresh round instead of
ending. Clearing the maze starts the next level: the maze is full again, everyone is back at the start, and the
run's score and lives carry on. The level number tells the player how far they have got. What a dot is worth
is owned by scoring (CAP-1), and how the score is shown by CAP-4; this capability only covers the move from
one level to the next and the display of the level.

Open question: CAP-1.5 and CAP-3.1 say eating every dot ends the game with a win. This capability says it
starts the next level. Whether a win still exists at all (and when) is not settled; see the question raised
with this node. Until it is answered, CAP-1.5 and CAP-3.1 are left as they are.

## Criteria

### CAP-5.1 When the last dot is eaten, the maze is refilled with all its dots and power pellets

bindings: [P0-GAME-014]

### CAP-5.2 When the maze is refilled, pacman returns to its starting place

bindings: [P0-GAME-015]

### CAP-5.3 When the maze is refilled, every ghost returns to its starting place

bindings: [P0-GAME-016]

### CAP-5.4 When the maze is refilled, the level goes up by 1

bindings: [P0-GAME-017]

### CAP-5.5 The score and the number of lives are the same after the maze is refilled as just before the last dot was eaten, apart from the points that dot is worth

bindings: [P0-GAME-018]

### CAP-5.6 The game starts at level 1

bindings: [P0-GAME-019]

### CAP-5.7 While the game is being played, the current level is visible on the page next to the score

bindings: [P0-UI-015]

### CAP-5.8 The level shown on the page goes up by 1 when the maze is refilled

bindings: [P0-UI-016]
