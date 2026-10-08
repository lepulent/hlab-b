import { describe, expect, it } from 'vitest';
import { BEST_KEY, bestText, nextBest, readBest, writeBest } from './best';

const fake = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => value });
const throwing = (): never => {
  throw new Error('blocked');
};

describe('nextBest', () => {
  it('P0-GAME-037 a score becomes the best when there is none or it is higher', () => {
    expect(nextBest(null, 120)).toBe(120);
    expect(nextBest(null, 0)).toBe(0);
    expect(nextBest(100, 120)).toBe(120);
  });

  it('P0-GAME-038 a lower or equal score leaves the best unchanged', () => {
    expect(nextBest(100, 40)).toBe(100);
    expect(nextBest(100, 100)).toBe(100);
  });
});

describe('readBest', () => {
  it('P0-GAME-036 reads back what writeBest stored', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    writeBest(storage, 250);
    expect(data.get(BEST_KEY)).toBe('250');
    expect(readBest(storage)).toBe(250);
  });

  it('P0-GAME-039 a missing or invalid stored value reads as no best', () => {
    expect(readBest(fake(null))).toBeNull();
    for (const bad of ['abc', '-5', '1.5', '', ' 7', '1e3']) {
      expect(readBest(fake(bad))).toBeNull();
    }
    expect(readBest(fake('0'))).toBe(0);
  });

  it('P0-GAME-039 unavailable storage reads as no best and never throws', () => {
    expect(readBest(null)).toBeNull();
    expect(readBest({ getItem: throwing })).toBeNull();
  });
});

describe('writeBest', () => {
  it('P0-GAME-039 unavailable or throwing storage does not throw', () => {
    expect(() => writeBest(null, 5)).not.toThrow();
    expect(() => writeBest({ setItem: throwing }, 5)).not.toThrow();
  });
});

describe('bestText', () => {
  it('P0-UI-018 shows the best as text, and a dash before any run has ended', () => {
    expect(bestText(120)).toBe('Best: 120');
    expect(bestText(0)).toBe('Best: 0');
    expect(bestText(null)).toBe('Best: –');
  });
});
