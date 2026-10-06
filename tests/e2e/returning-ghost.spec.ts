import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type Cell = { x: number; y: number };
type GhostView = { pos: Cell; mode: string; home: Cell };
type View = { ghosts: GhostView[]; score: number; lives: number };

const TILE = 16;
const RETURNING_RGB = '85,85,102';

// Replaces the game state through the ?e2e seam in main.ts: pacman and ghost 0 on the same cell.
async function setUp(page: Page, mode: 'frightened' | 'returning'): Promise<void> {
  await page.goto('/?e2e');
  await page.evaluate((ghostMode) => {
    const w = window as unknown as { __game: Record<string, unknown> };
    const s = w.__game as {
      pacman: { pos: Cell; dir: string };
      ghosts: GhostView[];
    };
    const spot = { x: 1, y: 1 };
    w.__game = {
      ...s,
      readyTicks: 0,
      frightenedTicks: 30,
      pacman: { ...s.pacman, pos: spot },
      ghosts: s.ghosts.map((g, i) =>
        i === 0 ? { ...g, pos: spot, mode: ghostMode } : { ...g, mode: 'chase' },
      ),
    };
  }, mode);
}

const view = (page: Page): Promise<View> =>
  page.evaluate(() => (window as unknown as { __game: View }).__game);

test('P0-GAME-022 P0-GAME-024 P0-GAME-025 P0-UI-017 an eaten ghost walks home, then chases again', async ({
  page,
}) => {
  await setUp(page, 'frightened');

  await expect.poll(async () => (await view(page)).ghosts[0]?.mode).toBe('returning');
  expect((await view(page)).score).toBeGreaterThanOrEqual(200);

  const colour = (): Promise<string> =>
    page.evaluate((tile) => {
      const w = window as unknown as { __game: View };
      const g = w.__game.ghosts[0];
      const canvas = document.querySelector<HTMLCanvasElement>('#game');
      const ctx = canvas?.getContext('2d');
      if (!g || !ctx) return '';
      const d = ctx.getImageData(g.pos.x * tile + 8, g.pos.y * tile + 8, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    }, TILE);
  await expect.poll(colour).toBe(RETURNING_RGB);

  await expect
    .poll(async () => (await view(page)).ghosts[0]?.mode, { timeout: 15000 })
    .toBe('chase');
  const ghost = (await view(page)).ghosts[0];
  expect(ghost?.pos).toEqual(ghost?.home);
});

test('P0-GAME-023 a returning ghost touching pacman costs no life', async ({ page }) => {
  await setUp(page, 'returning');
  await page.waitForTimeout(400);

  const after = await view(page);
  expect(after.lives).toBe(3);
  expect(after.score).toBe(0);
});
