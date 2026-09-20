---
id: CAP-4
kind: capability
title: In-play score display
version: 0.0.0
assurance: draft
valid_from: 238ab75
---

## Why

A player chasing a high score should see it grow as they play, not only once the game is over. The score
is shown beside the lives for the whole run and follows every dot, pellet and ghost that scores. Only the
showing is in scope: what things are worth and the end-of-game score stay as they are.

## Criteria

### CAP-4.1 While the game is being played, the score is visible on the page as Score followed by the current points, and reads Score: 0 before anything is eaten

bindings: [P0-UI-009]

### CAP-4.2 The score is shown in the same row as the lives, next to them

bindings: [P0-UI-010]

### CAP-4.3 Eating a dot raises the displayed score by 10

bindings: [P0-UI-011]

### CAP-4.4 Eating a power pellet raises the displayed score by 50

bindings: [P0-UI-012]

### CAP-4.5 Eating a frightened ghost raises the displayed score by 200

bindings: [P0-UI-013]

### CAP-4.6 The score on the win and game-over screens equals the score the display showed on the last step, and the values in CAP-4.3 to CAP-4.5 are the ones CAP-1 already scores

bindings: [P0-UI-014]
