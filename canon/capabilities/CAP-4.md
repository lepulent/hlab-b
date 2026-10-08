---
id: CAP-4
kind: capability
title: In-play score display
version: 0.2.0
assurance: draft
valid_from: de0454644d1d7e357bb0b4e6b57123d341e55d9d
---

## Why

A player chasing a high score should see it grow as they play, not only once the game is over. The score
is shown beside the lives for the whole run and follows every dot, pellet and ghost that scores. Only the
showing is in scope: the display shows the score as scoring (CAP-1) defines it, and what things are worth
is owned there, not here.

The same in-play display also shows how close the level is to clear: the number of dots and power pellets
still to eat. A player watching it can tell how much of the maze is left without leaving the game.

## Criteria

### CAP-4.1 While the game is being played, the score is visible on the page as Score followed by the current points, and reads Score: 0 before anything is eaten

bindings: [P0-UI-009]

### CAP-4.2 The score is shown in the same row as the lives, next to them

bindings: [P0-UI-010]

### CAP-4.3 Eating a dot raises the displayed score by the points scoring gives a dot

bindings: [P0-UI-011]

### CAP-4.4 Eating a power pellet raises the displayed score by the points scoring gives a power pellet

bindings: [P0-UI-012]

### CAP-4.5 Eating a frightened ghost raises the displayed score by the points scoring gives a caught ghost

bindings: [P0-UI-013]

### CAP-4.6 The score on the win and game-over screens equals the score the display showed on the last step

bindings: [P0-UI-014]

### CAP-4.7 At the start of a game, Dots left shows the number of dots and power pellets in the maze

bindings: [P0-UI-020]

### CAP-4.8 Eating a dot lowers the Dots left count by exactly one

bindings: [P0-UI-021]

### CAP-4.9 Eating a power pellet lowers the Dots left count by exactly one, the same as a dot

bindings: [P0-UI-022]

### CAP-4.10 The page shows the Dots left count as Dots left followed by the current number, and it reads 0 once every dot and pellet is eaten

bindings: [P0-UI-023]
