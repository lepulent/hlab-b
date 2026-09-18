import { z } from 'zod';
import type { Direction } from './game';

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
