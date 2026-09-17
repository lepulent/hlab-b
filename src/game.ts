import { z } from 'zod';

const directionSchema = z.enum(['up', 'down', 'left', 'right']);
type Direction = z.infer<typeof directionSchema>;

const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
type Position = z.infer<typeof positionSchema>;

const STEP = 1;

/**
 * Pure function: given a position and a direction, returns the next position.
 * Does not mutate its input and performs no I/O, so it is trivial to unit test.
 */
export function nextPosition(pos: Position, dir: Direction): Position {
  const validPos = positionSchema.parse(pos);
  const validDir = directionSchema.parse(dir);

  switch (validDir) {
    case 'up':
      return { x: validPos.x, y: validPos.y - STEP };
    case 'down':
      return { x: validPos.x, y: validPos.y + STEP };
    case 'left':
      return { x: validPos.x - STEP, y: validPos.y };
    case 'right':
      return { x: validPos.x + STEP, y: validPos.y };
  }
}
