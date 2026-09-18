import type { GameState, Ghost } from './game';

export const TILE = 16;

const WALL_COLOR = '#1919c2';
const DOT_COLOR = '#ffd8a8';
const PACMAN_COLOR = '#fedd00';
const FRIGHTENED_COLOR = '#2121de';
const GHOST_COLORS = ['#ff0000', '#ffb8ff', '#00ffff', '#ffb852'];

function drawPacman(ctx: CanvasRenderingContext2D, state: GameState): void {
  const { pos } = state.pacman;
  ctx.fillStyle = PACMAN_COLOR;
  ctx.beginPath();
  ctx.arc(
    pos.x * TILE + TILE / 2,
    pos.y * TILE + TILE / 2,
    TILE / 2 - 1,
    0.25 * Math.PI,
    1.75 * Math.PI,
  );
  ctx.lineTo(pos.x * TILE + TILE / 2, pos.y * TILE + TILE / 2);
  ctx.fill();
}

function drawGhost(ctx: CanvasRenderingContext2D, ghost: Ghost): void {
  ctx.fillStyle =
    ghost.mode === 'frightened'
      ? FRIGHTENED_COLOR
      : (GHOST_COLORS[ghost.id % GHOST_COLORS.length] ?? '#fff');
  ctx.fillRect(ghost.pos.x * TILE + 2, ghost.pos.y * TILE + 2, TILE - 4, TILE - 4);
}

export function drawFrame(ctx: CanvasRenderingContext2D, state: GameState): void {
  const { maze } = state;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, maze.width * TILE, maze.height * TILE);

  for (let y = 0; y < maze.height; y++) {
    for (let x = 0; x < maze.width; x++) {
      const cell = maze.grid[y]?.[x];
      const px = x * TILE;
      const py = y * TILE;
      if (cell === 'wall') {
        ctx.fillStyle = WALL_COLOR;
        ctx.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
      } else if (cell === 'dot') {
        ctx.fillStyle = DOT_COLOR;
        ctx.fillRect(px + TILE / 2 - 1, py + TILE / 2 - 1, 2, 2);
      } else if (cell === 'pellet') {
        ctx.fillStyle = DOT_COLOR;
        ctx.beginPath();
        ctx.arc(px + TILE / 2, py + TILE / 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawPacman(ctx, state);
  for (const ghost of state.ghosts) drawGhost(ctx, ghost);
}
