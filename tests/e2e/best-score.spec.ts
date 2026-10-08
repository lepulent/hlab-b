import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Ends the current run through the ?e2e seam in main.ts with the given status and score.
async function endRun(page: Page, status: 'won' | 'lost', score: number): Promise<void> {
  await page.evaluate(
    ({ s, sc }) => {
      const w = window as unknown as { __game: Record<string, unknown> };
      w.__game = { ...w.__game, status: s, score: sc };
    },
    { s: status, sc: score },
  );
}

test('P0-UI-018 a fresh page shows that there is no best yet', async ({ page }) => {
  await page.goto('/?e2e');
  await expect(page.locator('#best')).toHaveText('Best: –');
});

test('P0-GAME-037 P0-UI-019 a run ending raises the best; a new game keeps it', async ({
  page,
}) => {
  await page.goto('/?e2e');
  await endRun(page, 'lost', 120);
  await expect(page.locator('#best')).toHaveText('Best: 120');

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#score')).toHaveText('Score: 0');
  await expect(page.locator('#best')).toHaveText('Best: 120');

  await endRun(page, 'won', 300);
  await expect(page.locator('#best')).toHaveText('Best: 300');
});

test('P0-GAME-038 a lower run leaves the best unchanged', async ({ page }) => {
  await page.goto('/?e2e');
  await endRun(page, 'lost', 200);
  await expect(page.locator('#best')).toHaveText('Best: 200');

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#score')).toHaveText('Score: 0');
  await endRun(page, 'lost', 50);
  await expect(page.locator('#status')).not.toHaveText('');
  await expect(page.locator('#best')).toHaveText('Best: 200');
});

test('P0-GAME-036 the best survives a reload in the same tab', async ({ page }) => {
  await page.goto('/?e2e');
  await endRun(page, 'lost', 180);
  await expect(page.locator('#best')).toHaveText('Best: 180');

  await page.reload();
  await expect(page.locator('#best')).toHaveText('Best: 180');
});

test('P0-GAME-039 with storage blocked the best still works in memory', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get: () => {
        throw new Error('blocked');
      },
    });
  });
  await page.goto('/?e2e');
  await expect(page.locator('#best')).toHaveText('Best: –');

  await endRun(page, 'lost', 90);
  await expect(page.locator('#best')).toHaveText('Best: 90');
});
