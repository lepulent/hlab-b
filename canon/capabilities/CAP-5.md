---
id: CAP-5
kind: capability
title: Bonus fruit
version: 0.0.0
assurance: draft
valid_from: 27f9f5c
---

## Why

Eating half the dots earns the player a brief extra chance to score: a fruit appears in the
maze for a limited time and is worth more than a power pellet if pacman gets to it first.
It gives a reason to detour mid-level, and it is a one-off, so it stays a surprise.

## Criteria

### CAP-5.1 The fruit appears once half of the dots have been eaten, and not before

bindings: [P0-GAME-014]

### CAP-5.2 The fruit disappears when its time runs out without being eaten

bindings: [P0-GAME-015]

### CAP-5.3 Pacman reaching the fruit while it is showing eats it and removes it from the maze

bindings: [P0-GAME-016]

### CAP-5.4 Eating the fruit raises the score by more than a power pellet is worth

bindings: [P0-GAME-017]

### CAP-5.5 The fruit appears at most once per game, whether it was eaten or expired

bindings: [P0-GAME-018]
