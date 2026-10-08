---
id: CAP-9
kind: capability
title: Best score of the session
version: 0.1.0
assurance: draft
valid_from: 5b2f0805b4b0953af9629dbe9a11a2ccef69ae4f
---

## Why

A player wants to know whether they beat their best run. The game remembers the highest score
reached by a finished run during the browser tab session and shows it, so the player can compare
the running score with it. "Session" means the tab session: the best survives a reload of the tab
and is gone when the tab is closed. Where on the screen the best score appears is not part of this
contract.

## Criteria

### CAP-9.1 The best score is kept for the tab session: after a run ends and the page is reloaded in the same tab, the best score is shown again

bindings: [P0-GAME-036]

### CAP-9.2 When a run ends in a win or a loss with a score higher than the best, or with no best yet, that score becomes the best

bindings: [P0-GAME-037]

### CAP-9.3 A run that ends with a score lower than or equal to the best leaves the best unchanged, and the best does not change while a run is still in play

bindings: [P0-GAME-038]

### CAP-9.4 When session storage is unavailable or holds an invalid value, the game still runs and the best score is kept in memory for the life of the page

bindings: [P0-GAME-039]

### CAP-9.5 The best score is displayed as text, and shows that no best exists yet until a run has ended

bindings: [P0-UI-018]

### CAP-9.6 Starting a new game resets the score but not the displayed best score

bindings: [P0-UI-019]
