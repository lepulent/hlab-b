import { describe, expect, it } from 'vitest';
import type { Position } from './maze';
import { cellAt, createMaze, GHOST_STARTS, isWalkable, PACMAN_START, stepToward } from './maze';

function mazeOf(rows: string[]): ReturnType<typeof createMaze> {
  return {
    width: rows[0]?.length ?? 0,
    height: rows.length,
    grid: rows.map((r) =>
      [...r].map((ch) => (ch === '#' ? ('wall' as const) : ('empty' as const))),
    ),
  };
}

describe('stepToward', () => {
  it('P0-GAME-024 returns a walkable neighbour of the start cell', () => {
    const maze = mazeOf(['#####', '#   #', '#   #', '#####']);
    const from = { x: 1, y: 1 };
    const step = stepToward(maze, from, { x: 3, y: 2 });
    expect(step).toBeDefined();
    expect(Math.abs((step?.x ?? 0) - from.x) + Math.abs((step?.y ?? 0) - from.y)).toBe(1);
    expect(isWalkable(maze, step ?? { x: 0, y: 0 })).toBe(true);
  });

  it('P0-GAME-024 reaches the target in the shortest number of steps around a wall', () => {
    const maze = mazeOf(['#######', '#  #  #', '#  #  #', '#     #', '#######']);
    let pos = { x: 1, y: 1 };
    const to = { x: 5, y: 1 };
    let steps = 0;
    while (pos.x !== to.x || pos.y !== to.y) {
      const next = stepToward(maze, pos, to);
      if (!next || steps > 20) break;
      pos = next;
      steps++;
    }
    expect(pos).toEqual(to);
    expect(steps).toBe(8);
  });

  it('P0-GAME-025 enters every ghost house cell through the door at (9,8)', () => {
    const maze = createMaze();
    for (const home of GHOST_STARTS) {
      let pos = { x: 9, y: 6 };
      const path: string[] = [];
      for (let i = 0; i < 40 && (pos.x !== home.x || pos.y !== home.y); i++) {
        const next = stepToward(maze, pos, home);
        if (!next) break;
        pos = next;
        path.push(`${pos.x},${pos.y}`);
      }
      expect(pos).toEqual(home);
      expect(path).toContain('9,8');
    }
  });

  it('P0-GAME-024 returns undefined when already at the target or when it is unreachable', () => {
    const maze = mazeOf(['#####', '# # #', '#####']);
    expect(stepToward(maze, { x: 1, y: 1 }, { x: 1, y: 1 })).toBeUndefined();
    expect(stepToward(maze, { x: 1, y: 1 }, { x: 3, y: 1 })).toBeUndefined();
  });
});

describe('createMaze', () => {
  it('encloses the whole grid with walls on the border', () => {
    const maze = createMaze();
    for (let x = 0; x < maze.width; x++) {
      expect(cellAt(maze, { x, y: 0 })).toBe('wall');
      expect(cellAt(maze, { x, y: maze.height - 1 })).toBe('wall');
    }
    for (let y = 0; y < maze.height; y++) {
      expect(cellAt(maze, { x: 0, y })).toBe('wall');
      expect(cellAt(maze, { x: maze.width - 1, y })).toBe('wall');
    }
  });

  it('reaches every dot and pellet from the pacman start (BFS)', () => {
    const maze = createMaze();
    const key = (p: Position): string => `${p.x},${p.y}`;
    const seen = new Set<string>([key(PACMAN_START)]);
    const queue: Position[] = [PACMAN_START];
    const deltas: Position[] = [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ];

    while (queue.length > 0) {
      const pos = queue.shift();
      if (!pos) break;
      for (const d of deltas) {
        const next = { x: pos.x + d.x, y: pos.y + d.y };
        if (seen.has(key(next)) || !isWalkable(maze, next)) continue;
        seen.add(key(next));
        queue.push(next);
      }
    }

    let unreachable = 0;
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const cell = cellAt(maze, { x, y });
        if ((cell === 'dot' || cell === 'pellet') && !seen.has(key({ x, y }))) unreachable++;
      }
    }
    expect(unreachable).toBe(0);
  });
});
