import type { GameState, Ghost } from './game';
import { FRUIT_POS } from './game';

export const TILE = 16;

const WALL_COLOR = '#1919c2';
const DOT_COLOR = '#ffd8a8';
const PACMAN_COLOR = '#fedd00';
const FRIGHTENED_COLOR = '#2121de';
const RETURNING_COLOR = '#555566';
const FRUIT_COLOR = '#ff3355';
const OVERLAY_COLOR = 'rgba(0, 0, 0, 0.75)';
const LOST_COLOR = '#ff0000';
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

// canon: CAP-5.1
// canon: CAP-5.2
// canon: CAP-5.3
function drawFruit(ctx: CanvasRenderingContext2D, state: GameState): void {
  if (state.fruit.phase !== 'active') return;
  ctx.fillStyle = FRUIT_COLOR;
  ctx.beginPath();
  ctx.arc(
    FRUIT_POS.x * TILE + TILE / 2,
    FRUIT_POS.y * TILE + TILE / 2,
    TILE / 2 - 3,
    0,
    Math.PI * 2,
  );
  ctx.fill();
}

// canon: CAP-7.8
function ghostColor(ghost: Ghost): string {
  if (ghost.mode === 'returning') return RETURNING_COLOR;
  if (ghost.mode === 'frightened') return FRIGHTENED_COLOR;
  return GHOST_COLORS[ghost.id % GHOST_COLORS.length] ?? '#fff';
}

function drawGhost(ctx: CanvasRenderingContext2D, ghost: Ghost): void {
  ctx.fillStyle = ghostColor(ghost);
  ctx.fillRect(ghost.pos.x * TILE + 2, ghost.pos.y * TILE + 2, TILE - 4, TILE - 4);
}

// The final score is `state.score`: tick stops changing an ended game, so nothing more is stored.
// canon: CAP-3.1
// canon: CAP-3.2
function drawScoreScreen(ctx: CanvasRenderingContext2D, state: GameState): void {
  const width = state.maze.width * TILE;
  const height = state.maze.height * TILE;
  ctx.fillStyle = OVERLAY_COLOR;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxWidth = width - 2 * TILE;
  const won = state.status === 'won';
  ctx.fillStyle = won ? PACMAN_COLOR : LOST_COLOR;
  ctx.font = 'bold 28px monospace';
  ctx.fillText(won ? 'YOU WIN' : 'GAME OVER', width / 2, height / 2 - 28, maxWidth);
  ctx.fillStyle = '#fff';
  ctx.font = '18px monospace';
  ctx.fillText(`Score: ${state.score}`, width / 2, height / 2 + 4, maxWidth);
  ctx.font = '11px monospace';
  ctx.fillText('Press any key to play again', width / 2, height / 2 + 32, maxWidth);
}

// canon: CAP-6.1
// canon: CAP-6.2
function drawReady(ctx: CanvasRenderingContext2D, state: GameState): void {
  const width = state.maze.width * TILE;
  ctx.fillStyle = PACMAN_COLOR;
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('READY!', 9 * TILE + TILE / 2, 12 * TILE + TILE / 2, width - 2 * TILE);
}

// canon: CAP-2.6
export function statusText(state: GameState): string {
  if (state.status === 'won') return 'You win!';
  if (state.status === 'lost') return 'Game over';
  return state.paused ? 'Paused' : '';
}

// canon: CAP-4.10
export function dotsText(state: GameState): string {
  return `Dots left: ${state.dotsRemaining}`;
}

// canon: CAP-1.8
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

  drawFruit(ctx, state);
  drawPacman(ctx, state);
  for (const ghost of state.ghosts) drawGhost(ctx, ghost);
  if (state.status === 'playing' && state.readyTicks > 0) drawReady(ctx, state);
  if (state.status !== 'playing') drawScoreScreen(ctx, state);
}
