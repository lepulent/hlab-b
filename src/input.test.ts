import { describe, expect, it } from 'vitest';
import type { GameState } from './game';
import { createGameState, togglePause } from './game';
import { handleKey, isPauseKey, keyToDirection, type KeyInput } from './input';

function press(key: string, overrides: Partial<KeyInput> = {}): KeyInput {
  return { key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...overrides };
}

function ended(status: 'won' | 'lost'): GameState {
  return { ...createGameState(), status, score: 120, lives: status === 'lost' ? 0 : 2 };
}

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

describe('isPauseKey', () => {
  it('P0-GAME-009 accepts p and P', () => {
    expect(isPauseKey('p')).toBe(true);
    expect(isPauseKey('P')).toBe(true);
  });

  it('P0-GAME-009 rejects other keys and the empty string', () => {
    expect(isPauseKey('w')).toBe(false);
    expect(isPauseKey('Escape')).toBe(false);
    expect(isPauseKey('')).toBe(false);
  });
});

describe('handleKey while playing', () => {
  it('P0-GAME-009 pauses on P and resumes on the next P', () => {
    const paused = handleKey(createGameState(), 'left', press('p'));
    expect(paused.state.paused).toBe(true);
    expect(paused.consumed).toBe(true);

    const resumed = handleKey(paused.state, paused.direction, press('P'));
    expect(resumed.state.paused).toBe(false);
  });

  it('P0-UI-002 pauses on P before any direction key was pressed', () => {
    const result = handleKey(createGameState(), null, press('p'));
    expect(result.state.paused).toBe(true);
    expect(result.direction).toBeNull();
  });

  it('steers on a direction key and ignores other keys', () => {
    const state = createGameState();
    const steered = handleKey(state, null, press('ArrowUp'));
    expect(steered.direction).toBe('up');
    expect(steered.consumed).toBe(true);

    const other = handleKey(state, 'up', press('q'));
    expect(other.direction).toBe('up');
    expect(other.consumed).toBe(false);
  });

  it('P0-UI-008 does not pause on a repeating P or on P with a modifier', () => {
    const state = createGameState();
    expect(handleKey(state, null, press('p', { repeat: true })).state.paused).toBe(false);
    expect(handleKey(state, null, press('p', { ctrlKey: true })).state.paused).toBe(false);
  });
});

describe('handleKey while paused', () => {
  const paused = togglePause(createGameState());

  it('P0-UI-003 ignores direction keys and keeps the direction', () => {
    const result = handleKey(paused, 'left', press('ArrowUp'));
    expect(result.state).toBe(paused);
    expect(result.direction).toBe('left');
    expect(result.consumed).toBe(false);
  });

  it('P0-UI-003 does not steer after resuming with a direction pressed while paused', () => {
    const during = handleKey(paused, 'left', press('d'));
    const resumed = handleKey(during.state, during.direction, press('p'));
    expect(resumed.state.paused).toBe(false);
    expect(resumed.direction).toBe('left');
  });

  it('P0-UI-003 does not start a direction from none while paused', () => {
    const result = handleKey(paused, null, press('ArrowDown'));
    expect(result.direction).toBeNull();
  });
});

describe('handleKey on the score screen', () => {
  const fresh = createGameState();

  it.each([
    ['won', 'x'],
    ['lost', 'Enter'],
    ['won', 'p'],
    ['lost', 'P'],
  ] as const)('P0-UI-006 restarts a %s game on %s', (status, key) => {
    const result = handleKey(ended(status), 'left', press(key));
    expect(result.restarted).toBe(true);
    expect(result.state.status).toBe('playing');
    expect(result.state.paused).toBe(false);
    expect(result.state.score).toBe(0);
    expect(result.state.lives).toBe(3);
    expect(result.state.dotsRemaining).toBe(fresh.dotsRemaining);
    expect(result.state.pacman).toEqual(fresh.pacman);
  });

  it('P0-UI-007 clears the direction so the restarting key does not steer', () => {
    const result = handleKey(ended('lost'), 'left', press('ArrowUp'));
    expect(result.restarted).toBe(true);
    expect(result.direction).toBeNull();
    expect(result.consumed).toBe(true);
  });

  it.each([
    ['a repeating key', { repeat: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Alt', { altKey: true }],
  ] as const)('P0-UI-008 does not restart on %s', (_name, modifier) => {
    const lost = ended('lost');
    const result = handleKey(lost, 'left', press('x', modifier));
    expect(result.restarted).toBe(false);
    expect(result.state).toBe(lost);
    expect(result.direction).toBe('left');
    expect(result.consumed).toBe(false);
  });
});
