import type { Maze, Position } from './maze';
import { GHOST_STARTS, PACMAN_START, cellAt, createMaze, countRemaining, isWalkable } from './maze';

export type Direction = 'up' | 'down' | 'left' | 'right';
type GhostMode = 'chase' | 'frightened';

export type Ghost = {
  readonly id: number;
  pos: Position;
  dir: Direction;
  mode: GhostMode;
  readonly home: Position;
};

type PacmanEntity = { pos: Position; dir: Direction };
type GameStatus = 'playing' | 'won' | 'lost';

export type GameState = {
  maze: Maze;
  pacman: PacmanEntity;
  ghosts: Ghost[];
  score: number;
  lives: number;
  dotsRemaining: number;
  frightenedTicks: number;
  status: GameStatus;
  paused: boolean;
};

const DOT_SCORE = 10;
const PELLET_SCORE = 50;
const GHOST_SCORE = 200;
const FRIGHTENED_DURATION = 30;
const STARTING_LIVES = 3;

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];
const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

// canon: CAP-1.1
export function nextPosition(pos: Position, dir: Direction): Position {
  switch (dir) {
    case 'up':
      return { x: pos.x, y: pos.y - 1 };
    case 'down':
      return { x: pos.x, y: pos.y + 1 };
    case 'left':
      return { x: pos.x - 1, y: pos.y };
    case 'right':
      return { x: pos.x + 1, y: pos.y };
  }
}

export function createGameState(): GameState {
  const maze = createMaze();
  return {
    maze,
    pacman: { pos: { ...PACMAN_START }, dir: 'left' },
    ghosts: GHOST_STARTS.map((home, id) => ({
      id,
      pos: { ...home },
      dir: 'up',
      mode: 'chase',
      home: { ...home },
    })),
    score: 0,
    lives: STARTING_LIVES,
    dotsRemaining: countRemaining(maze),
    frightenedTicks: 0,
    status: 'playing',
    paused: false,
  };
}

// canon: CAP-1.2
export function attemptMove(maze: Maze, pos: Position, dir: Direction): Position {
  const target = nextPosition(pos, dir);
  return isWalkable(maze, target) ? target : pos;
}

// canon: CAP-1.3
export function eatDot(state: GameState, pos: Position): GameState {
  const cell = cellAt(state.maze, pos);
  if (cell !== 'dot' && cell !== 'pellet') return state;

  const grid = state.maze.grid.map((row) => [...row]);
  const row = grid[pos.y];
  if (row) row[pos.x] = 'empty';
  const maze: Maze = { ...state.maze, grid };

  const dotsRemaining = state.dotsRemaining - 1;
  const score = state.score + (cell === 'pellet' ? PELLET_SCORE : DOT_SCORE);
  const frightenedTicks = cell === 'pellet' ? FRIGHTENED_DURATION : state.frightenedTicks;
  const ghosts =
    cell === 'pellet'
      ? state.ghosts.map((g) => ({ ...g, mode: 'frightened' as GhostMode }))
      : state.ghosts;

  return { ...state, maze, dotsRemaining, score, frightenedTicks, ghosts };
}

// canon: CAP-1.5
export function checkWin(state: GameState): GameState {
  if (state.status === 'playing' && state.dotsRemaining <= 0) return { ...state, status: 'won' };
  return state;
}

// canon: CAP-1.6
export function loseLife(state: GameState): GameState {
  const lives = state.lives - 1;
  if (lives <= 0) return { ...state, lives: 0, status: 'lost' };
  return {
    ...state,
    lives,
    pacman: { pos: { ...PACMAN_START }, dir: 'left' },
    ghosts: state.ghosts.map((g) => ({ ...g, pos: { ...g.home }, mode: 'chase' as GhostMode })),
  };
}

// canon: CAP-1.4
export function resolveGhostCollisions(state: GameState): GameState {
  const collided = state.ghosts.find(
    (g) => g.pos.x === state.pacman.pos.x && g.pos.y === state.pacman.pos.y,
  );
  if (!collided) return state;
  if (collided.mode === 'frightened') {
    const ghosts = state.ghosts.map((g) =>
      g.id === collided.id ? { ...g, pos: { ...g.home }, mode: 'chase' as GhostMode } : g,
    );
    return { ...state, ghosts, score: state.score + GHOST_SCORE };
  }
  return loseLife(state);
}

function movePacman(state: GameState, dir: Direction): GameState {
  const target = attemptMove(state.maze, state.pacman.pos, dir);
  const moved = { ...state, pacman: { pos: target, dir } };
  return checkWin(eatDot(moved, target));
}

// canon: CAP-1.9
function moveGhost(maze: Maze, ghost: Ghost, target: Position): Ghost {
  const options = DIRECTIONS.map((dir) => ({ dir, pos: nextPosition(ghost.pos, dir) })).filter(
    ({ pos }) => isWalkable(maze, pos),
  );
  const nonReverse = options.filter(({ dir }) => dir !== OPPOSITE[ghost.dir]);
  const pool = nonReverse.length > 0 ? nonReverse : options;
  if (pool.length === 0) return ghost;

  const distance = (pos: Position): number =>
    Math.abs(pos.x - target.x) + Math.abs(pos.y - target.y);
  const sign = ghost.mode === 'frightened' ? -1 : 1;
  const choice = pool.reduce((best, o) =>
    sign * distance(o.pos) < sign * distance(best.pos) ? o : best,
  );
  return { ...ghost, pos: choice.pos, dir: choice.dir };
}

// canon: CAP-1.9
function moveGhosts(state: GameState): GameState {
  return { ...state, ghosts: state.ghosts.map((g) => moveGhost(state.maze, g, state.pacman.pos)) };
}

// canon: CAP-2.1
// canon: CAP-2.5
export function togglePause(state: GameState): GameState {
  if (state.status !== 'playing') return state;
  return { ...state, paused: !state.paused };
}

// canon: CAP-2.2
// canon: CAP-2.3
// canon: CAP-2.4
export function tick(state: GameState, dir: Direction | null): GameState {
  if (state.status !== 'playing' || state.paused) return state;
  const afterPacman = dir ? movePacman(state, dir) : state;
  if (afterPacman.status !== 'playing') return afterPacman;

  const afterPacmanCollision = resolveGhostCollisions(afterPacman);
  if (afterPacmanCollision.status !== 'playing') return afterPacmanCollision;

  const afterGhosts = moveGhosts(afterPacmanCollision);
  const frightenedTicks = Math.max(0, afterGhosts.frightenedTicks - 1);
  const ghosts =
    frightenedTicks === 0
      ? afterGhosts.ghosts.map((g) => ({ ...g, mode: 'chase' as GhostMode }))
      : afterGhosts.ghosts;

  return resolveGhostCollisions({ ...afterGhosts, frightenedTicks, ghosts });
}
