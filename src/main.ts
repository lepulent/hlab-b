import { nextPosition } from './game';

const canvas = document.querySelector<HTMLCanvasElement>('#game');

if (!canvas) {
  throw new Error('Canvas element with id "game" was not found');
}

const ctx = canvas.getContext('2d');

if (!ctx) {
  throw new Error('2D rendering context is not available');
}

// A trivial demonstration that the pure game logic and the canvas are wired together.
const start = { x: 20, y: 20 };
const moved = nextPosition(start, 'right');

ctx.fillStyle = '#fedd00';
ctx.fillRect(moved.x, moved.y, 40, 40);
