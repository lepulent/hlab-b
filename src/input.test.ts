import { describe, expect, it } from 'vitest';
import { keyToDirection } from './input';

describe('keyToDirection', () => {
  it('P0-GAME-007 maps WASD keys to directions', () => {
    expect(keyToDirection('w')).toBe('up');
    expect(keyToDirection('a')).toBe('left');
    expect(keyToDirection('s')).toBe('down');
    expect(keyToDirection('d')).toBe('right');
  });

  it('P0-GAME-007 maps arrow keys to directions', () => {
    expect(keyToDirection('ArrowUp')).toBe('up');
    expect(keyToDirection('ArrowLeft')).toBe('left');
    expect(keyToDirection('ArrowDown')).toBe('down');
    expect(keyToDirection('ArrowRight')).toBe('right');
  });

  it('P0-GAME-007 ignores unrelated keys', () => {
    expect(keyToDirection('q')).toBeNull();
    expect(keyToDirection(' ')).toBeNull();
  });
});
