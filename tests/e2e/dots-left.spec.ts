import { expect, test } from '@playwright/test';

test('P0-UI-020 P0-UI-021 P0-UI-023 dots left starts at the total and drops by one per dot', async ({
  page,
}) => {
  await page.goto('/?e2e');
  const total = await page.evaluate(() => {
    const w = window as unknown as { __game: { dotsRemaining: number } };
    return w.__game.dotsRemaining;
  });
  expect(total).toBeGreaterThan(0);
  await expect(page.locator('#dots')).toHaveText(`Dots left: ${total}`);

  await page.evaluate(() => {
    type Game = {
      maze: { grid: string[][] };
      pacman: { pos: { x: number; y: number } };
      dotsRemaining: number;
      status: string;
    };
    const w = window as unknown as { __game: Game };
    const game = w.__game;
    const grid = game.maze.grid.map((row) => [...row]);
    let found: { x: number; y: number } | null = null;
    for (let y = 0; y < grid.length && !found; y++) {
      const row = grid[y] ?? [];
      for (let x = 0; x < row.length; x++) {
        if (row[x] === 'dot' && grid[y]?.[x + 1] === 'empty') {
          found = { x, y };
          break;
        }
      }
    }
    if (!found) throw new Error('no dot next to an empty tile');
    // Pacman stands on the empty tile right of the dot, moving left onto it.
    w.__game = {
      ...game,
      ghosts: [],
      readyTicks: 0,
      pacman: { ...game.pacman, pos: { x: found.x + 1, y: found.y }, dir: 'left' },
    } as Game;
  });
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#dots')).toHaveText(`Dots left: ${total - 1}`);
});
