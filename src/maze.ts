export type Cell = 'wall' | 'dot' | 'pellet' | 'empty';

export type Position = { x: number; y: number };

export type Maze = {
  readonly width: number;
  readonly height: number;
  readonly grid: readonly (readonly Cell[])[];
};

const WIDTH = 19;
const HEIGHT = 21;

const GHOST_HOUSE_ROWS = [9, 10, 11];
const GHOST_HOUSE_COLS = [8, 9, 10];

export const PACMAN_START: Position = { x: 9, y: 15 };
export const GHOST_STARTS: Position[] = [
  { x: 9, y: 9 },
  { x: 8, y: 10 },
  { x: 9, y: 10 },
  { x: 10, y: 10 },
];
const GHOST_HOUSE_DOOR: Position = { x: 9, y: 8 };

const isBorder = (row: number, col: number): boolean =>
  row === 0 || row === HEIGHT - 1 || col === 0 || col === WIDTH - 1;

const isGhostHouse = (row: number, col: number): boolean =>
  GHOST_HOUSE_ROWS.includes(row) && GHOST_HOUSE_COLS.includes(col);

// Isolated single-cell pillars, never adjacent to one another, so the floor graph they
// leave behind is always fully connected (see the reachability test in maze.test.ts).
const isPillar = (row: number, col: number): boolean =>
  row % 2 === 0 &&
  col % 2 === 0 &&
  row >= 2 &&
  row <= HEIGHT - 3 &&
  col >= 2 &&
  col <= WIDTH - 3 &&
  !isGhostHouse(row, col);

const isGhostHouseWall = (row: number, col: number): boolean => {
  if (row === GHOST_HOUSE_DOOR.y && col === GHOST_HOUSE_DOOR.x) return false;
  const topOrBottom = (row === 8 || row === 12) && col >= 7 && col <= 11;
  const sides = (col === 7 || col === 11) && row >= 9 && row <= 11;
  return topOrBottom || sides;
};

const isPelletCorner = (row: number, col: number): boolean =>
  (row === 1 || row === HEIGHT - 2) && (col === 1 || col === WIDTH - 2);

const setCell = (grid: Cell[][], pos: Position, cell: Cell): void => {
  const row = grid[pos.y];
  if (row) row[pos.x] = cell;
};

export function createMaze(): Maze {
  const grid: Cell[][] = [];
  for (let row = 0; row < HEIGHT; row++) {
    const line: Cell[] = [];
    for (let col = 0; col < WIDTH; col++) {
      if (isBorder(row, col) || isPillar(row, col) || isGhostHouseWall(row, col)) {
        line.push('wall');
      } else if (isGhostHouse(row, col)) {
        line.push('empty');
      } else {
        line.push(isPelletCorner(row, col) ? 'pellet' : 'dot');
      }
    }
    grid.push(line);
  }
  setCell(grid, PACMAN_START, 'empty');
  setCell(grid, GHOST_HOUSE_DOOR, 'empty');
  return { width: WIDTH, height: HEIGHT, grid };
}

export function cellAt(maze: Maze, pos: Position): Cell | undefined {
  return maze.grid[pos.y]?.[pos.x];
}

export function isWalkable(maze: Maze, pos: Position): boolean {
  return cellAt(maze, pos) !== undefined && cellAt(maze, pos) !== 'wall';
}

export function countRemaining(maze: Maze): number {
  let count = 0;
  for (const row of maze.grid)
    for (const cell of row) if (cell === 'dot' || cell === 'pellet') count++;
  return count;
}
