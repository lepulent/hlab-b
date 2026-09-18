import { describe, expect, it } from 'vitest';
import type { Position } from './maze';
import { cellAt, createMaze, isWalkable, PACMAN_START } from './maze';

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
