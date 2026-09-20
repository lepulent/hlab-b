import { z } from 'zod';
import type { Direction, GameState } from './game';
import { createGameState, togglePause } from './game';

const directionSchema = z.enum(['up', 'down', 'left', 'right']);

const KEY_MAP: Record<string, Direction> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
};

// Keyboard input is the one untrusted boundary in this app (no accounts, no backend),
// so the raw key lookup is validated against the domain's Direction enum before use.
// canon: CAP-1.7
export function keyToDirection(key: string): Direction | null {
  const parsed = directionSchema.safeParse(KEY_MAP[key.toLowerCase()]);
  return parsed.success ? parsed.data : null;
}

// canon: CAP-2.1
export function isPauseKey(key: string): boolean {
  return key.toLowerCase() === 'p';
}

export type KeyInput = {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

type KeyResult = {
  state: GameState;
  direction: Direction | null;
  restarted: boolean;
  consumed: boolean;
};

// What one keydown does to the game: the whole three-way dispatch, kept pure so main.ts only
// applies the result (`restarted` means the frame clock must reset, `consumed` means preventDefault).
// canon: CAP-2.1
// canon: CAP-2.7
// canon: CAP-3.3
// canon: CAP-3.4
// canon: CAP-3.5
export function handleKey(
  state: GameState,
  direction: Direction | null,
  input: KeyInput,
): KeyResult {
  const ignored: KeyResult = { state, direction, restarted: false, consumed: false };
  if (input.repeat || input.ctrlKey || input.metaKey || input.altKey) return ignored;

  if (state.status !== 'playing') {
    return { state: createGameState(), direction: null, restarted: true, consumed: true };
  }
  if (isPauseKey(input.key)) {
    return { state: togglePause(state), direction, restarted: false, consumed: true };
  }
  if (state.paused) return ignored;

  const dir = keyToDirection(input.key);
  if (!dir) return ignored;
  return { state, direction: dir, restarted: false, consumed: true };
}
