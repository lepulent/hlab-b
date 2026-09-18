import { describe, expect, it } from 'vitest';
import type { Cell, Maze } from './maze';
import { PACMAN_START } from './maze';
import {
  attemptMove,
  checkWin,
  createGameState,
  eatDot,
  loseLife,
  nextPosition,
  resolveGhostCollisions,
  tick,
  type GameState,
  type Ghost,
} from './game';

function buildMaze(rows: string[]): Maze {
  const grid: Cell[][] = rows.map((row) =>
    [...row].map((ch): Cell => {
      if (ch === '#') return 'wall';
      if (ch === '.') return 'dot';
      if (ch === 'o') return 'pellet';
      return 'empty';
    }),
  );
  return { width: rows[0]?.length ?? 0, height: rows.length, grid };
}

function buildGhost(overrides: Partial<Ghost> = {}): Ghost {
  return {
    id: 0,
    pos: { x: 1, y: 1 },
    dir: 'up',
    mode: 'chase',
    home: { x: 1, y: 1 },
    ...overrides,
  };
}

function buildState(overrides: Partial<GameState> = {}): GameState {
  const maze = buildMaze(['#####', '#...#', '#...#', '#...#', '#####']);
  return {
    maze,
    pacman: { pos: { x: 2, y: 2 }, dir: 'right' },
    ghosts: [],
    score: 0,
    lives: 3,
    dotsRemaining: 9,
    frightenedTicks: 0,
    status: 'playing',
    ...overrides,
  };
}

describe('nextPosition', () => {
  it('P0-GAME-001 moves right by incrementing x', () => {
    expect(nextPosition({ x: 0, y: 0 }, 'right')).toEqual({ x: 1, y: 0 });
  });

  it('P0-GAME-001 moves left by decrementing x', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'left')).toEqual({ x: 4, y: 5 });
  });

  it('P0-GAME-001 moves up by decrementing y', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'up')).toEqual({ x: 5, y: 4 });
  });

  it('P0-GAME-001 moves down by incrementing y', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'down')).toEqual({ x: 5, y: 6 });
  });

  it('does not mutate the input position', () => {
    const pos = { x: 0, y: 0 };
    nextPosition(pos, 'right');
    expect(pos).toEqual({ x: 0, y: 0 });
  });
});

describe('attemptMove', () => {
  it('P0-GAME-002 moves onto an open tile', () => {
    const maze = buildMaze(['###', '#..', '###']);
    expect(attemptMove(maze, { x: 1, y: 1 }, 'right')).toEqual({ x: 2, y: 1 });
  });

  it('P0-GAME-002 is blocked by a wall and keeps the current tile', () => {
    const maze = buildMaze(['###', '#.#', '###']);
    expect(attemptMove(maze, { x: 1, y: 1 }, 'right')).toEqual({ x: 1, y: 1 });
  });

  it('P0-GAME-002 is blocked at the edge of the maze', () => {
    const maze = buildMaze(['###', '#.#', '###']);
    expect(attemptMove(maze, { x: 1, y: 1 }, 'up')).toEqual({ x: 1, y: 1 });
  });
});

describe('eatDot', () => {
  it('P0-GAME-003 eats a dot, scores and clears the tile', () => {
    const state = buildState();
    const next = eatDot(state, { x: 2, y: 2 });
    expect(next.score).toBe(10);
    expect(next.dotsRemaining).toBe(8);
    expect(next.maze.grid[2]?.[2]).toBe('empty');
  });

  it('P0-GAME-003 eats a power pellet, scores more and frightens the ghosts', () => {
    const maze = buildMaze(['#####', '#o..#', '#...#', '#...#', '#####']);
    const state = buildState({ maze, ghosts: [buildGhost()] });
    const next = eatDot(state, { x: 1, y: 1 });
    expect(next.score).toBe(50);
    expect(next.frightenedTicks).toBeGreaterThan(0);
    expect(next.ghosts.every((g) => g.mode === 'frightened')).toBe(true);
  });

  it('P0-GAME-003 leaves an already-eaten tile unchanged', () => {
    const state = buildState();
    const eaten = eatDot(state, { x: 2, y: 2 });
    const again = eatDot(eaten, { x: 2, y: 2 });
    expect(again).toEqual(eaten);
  });
});

describe('resolveGhostCollisions', () => {
  it('P0-GAME-004 costs a life when a chasing ghost catches pacman', () => {
    const state = buildState({ ghosts: [buildGhost({ pos: { x: 2, y: 2 }, mode: 'chase' })] });
    const next = resolveGhostCollisions(state);
    expect(next.lives).toBe(2);
    expect(next.pacman.pos).toEqual(PACMAN_START);
  });

  it('P0-GAME-004 removes a frightened ghost and awards points without costing a life', () => {
    const ghost = buildGhost({ pos: { x: 2, y: 2 }, mode: 'frightened', home: { x: 3, y: 3 } });
    const state = buildState({ ghosts: [ghost], lives: 3 });
    const next = resolveGhostCollisions(state);
    expect(next.lives).toBe(3);
    expect(next.score).toBe(200);
    expect(next.ghosts[0]?.pos).toEqual({ x: 3, y: 3 });
    expect(next.ghosts[0]?.mode).toBe('chase');
  });

  it('P0-GAME-004 leaves the game unchanged when no ghost overlaps pacman', () => {
    const state = buildState({ ghosts: [buildGhost({ pos: { x: 1, y: 1 } })] });
    expect(resolveGhostCollisions(state)).toEqual(state);
  });

  it('P0-GAME-004 catches pacman moving onto a chasing ghost in the same tick', () => {
    const maze = buildMaze(['#####', '#...#', '#...#', '#...#', '#####']);
    const state = buildState({
      maze,
      pacman: { pos: { x: 2, y: 2 }, dir: 'right' },
      ghosts: [buildGhost({ pos: { x: 3, y: 2 }, mode: 'chase' })],
      lives: 3,
    });
    const next = tick(state, 'right');
    expect(next.lives).toBe(2);
    expect(next.pacman.pos).toEqual(PACMAN_START);
  });

  it('P0-GAME-004 eats a frightened ghost pacman moves onto in the same tick', () => {
    const maze = buildMaze(['#####', '#...#', '#...#', '#...#', '#####']);
    const ghost = buildGhost({ pos: { x: 3, y: 2 }, mode: 'frightened', home: { x: 1, y: 1 } });
    const state = buildState({
      maze,
      pacman: { pos: { x: 2, y: 2 }, dir: 'right' },
      ghosts: [ghost],
      lives: 3,
      frightenedTicks: 5,
    });
    const next = tick(state, 'right');
    expect(next.lives).toBe(3);
    expect(next.score).toBe(210);
  });
});

describe('moveGhost', () => {
  const room = buildMaze([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######',
  ]);

  it('P0-GAME-008 steps toward pacman while chasing', () => {
    const state = buildState({
      maze: room,
      pacman: { pos: { x: 1, y: 1 }, dir: 'left' },
      ghosts: [buildGhost({ pos: { x: 3, y: 3 }, dir: 'right', mode: 'chase' })],
    });
    const next = tick(state, null);
    expect(next.ghosts[0]?.pos).toEqual({ x: 3, y: 2 });
  });

  it('P0-GAME-008 steps away from pacman while frightened', () => {
    const state = buildState({
      maze: room,
      pacman: { pos: { x: 1, y: 1 }, dir: 'left' },
      ghosts: [buildGhost({ pos: { x: 3, y: 3 }, dir: 'right', mode: 'frightened' })],
      frightenedTicks: 1,
    });
    const next = tick(state, null);
    expect(next.ghosts[0]?.pos).toEqual({ x: 3, y: 4 });
  });
});

describe('checkWin', () => {
  it('P0-GAME-005 declares a win once no dots remain', () => {
    const state = buildState({ dotsRemaining: 0 });
    expect(checkWin(state).status).toBe('won');
  });

  it('P0-GAME-005 keeps playing while dots remain', () => {
    const state = buildState({ dotsRemaining: 1 });
    expect(checkWin(state).status).toBe('playing');
  });
});

describe('loseLife', () => {
  it('P0-GAME-006 respawns pacman and ghosts when lives remain', () => {
    const state = buildState({ lives: 2, ghosts: [buildGhost({ pos: { x: 4, y: 4 } })] });
    const next = loseLife(state);
    expect(next.lives).toBe(1);
    expect(next.status).toBe('playing');
    expect(next.pacman.pos).toEqual(PACMAN_START);
    expect(next.ghosts[0]?.pos).toEqual(next.ghosts[0]?.home);
  });

  it('P0-GAME-006 ends the game when the last life is lost', () => {
    const state = buildState({ lives: 1 });
    const next = loseLife(state);
    expect(next.lives).toBe(0);
    expect(next.status).toBe('lost');
  });
});

describe('createGameState', () => {
  it('builds a playable game with dots on the board and four ghosts', () => {
    const state = createGameState();
    expect(state.status).toBe('playing');
    expect(state.lives).toBe(3);
    expect(state.dotsRemaining).toBeGreaterThan(0);
    expect(state.ghosts).toHaveLength(4);
  });
});

describe('tick', () => {
  it('moves pacman one step per tick and leaves a finished game untouched', () => {
    const state = buildState();
    const next = tick(state, 'right');
    expect(next.pacman.pos).toEqual({ x: 3, y: 2 });

    const finished = buildState({ status: 'won' });
    expect(tick(finished, 'right')).toEqual(finished);
  });

  it('does not move ghosts through walls', () => {
    const maze = buildMaze(['#####', '#...#', '#...#', '#...#', '#####']);
    const state = buildState({ maze, ghosts: [buildGhost({ pos: { x: 1, y: 1 } })] });
    const next = tick(state, null);
    const ghost = next.ghosts[0];
    expect(ghost).toBeDefined();
    expect(maze.grid[ghost?.pos.y ?? 0]?.[ghost?.pos.x ?? 0]).not.toBe('wall');
  });
});
