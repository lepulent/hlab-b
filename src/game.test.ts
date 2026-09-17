import { describe, expect, it } from 'vitest';
import { nextPosition } from './game';

describe('nextPosition', () => {
  it('moves right by incrementing x', () => {
    expect(nextPosition({ x: 0, y: 0 }, 'right')).toEqual({ x: 1, y: 0 });
  });

  it('moves left by decrementing x', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'left')).toEqual({ x: 4, y: 5 });
  });

  it('moves up by decrementing y', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'up')).toEqual({ x: 5, y: 4 });
  });

  it('moves down by incrementing y', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'down')).toEqual({ x: 5, y: 6 });
  });

  it('does not mutate the input position', () => {
    const pos = { x: 0, y: 0 };
    nextPosition(pos, 'right');
    expect(pos).toEqual({ x: 0, y: 0 });
  });
});
