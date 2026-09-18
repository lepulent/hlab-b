import type { Direction } from './game';
import { createGameState, tick } from './game';
import { keyToDirection } from './input';
import { drawFrame, TILE } from './render';

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

const canvas = required(
  document.querySelector<HTMLCanvasElement>('#game'),
  'Canvas element with id "game" was not found',
);
const ctx = required(canvas.getContext('2d'), '2D rendering context is not available');
const scoreEl = required(
  document.querySelector<HTMLElement>('#score'),
  'Score element was not found',
);
const livesEl = required(
  document.querySelector<HTMLElement>('#lives'),
  'Lives element was not found',
);
const statusEl = required(
  document.querySelector<HTMLElement>('#status'),
  'Status element was not found',
);

const STEP_MS = 160;

let state = createGameState();
canvas.width = state.maze.width * TILE;
canvas.height = state.maze.height * TILE;

// canon: CAP-1.8
function applyScale(): void {
  const scale = Math.max(
    Math.min(window.innerWidth / canvas.width, window.innerHeight / canvas.height),
    0.2,
  );
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
}

let currentDirection: Direction | null = null;
window.addEventListener('keydown', (event) => {
  const dir = keyToDirection(event.key);
  if (dir) {
    currentDirection = dir;
    event.preventDefault();
  }
});
window.addEventListener('resize', applyScale);

function render(): void {
  drawFrame(ctx, state);
  scoreEl.textContent = `Score: ${state.score}`;
  livesEl.textContent = `Lives: ${state.lives}`;
  statusEl.textContent =
    state.status === 'won' ? 'You win!' : state.status === 'lost' ? 'Game over' : '';
}

let last = 0;
function frame(timestamp: number): void {
  if (state.status === 'playing' && timestamp - last >= STEP_MS) {
    state = tick(state, currentDirection);
    last = timestamp;
  }
  render();
  window.requestAnimationFrame(frame);
}

applyScale();
render();
window.requestAnimationFrame(frame);
