import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('home page renders heading, canvas and HUD', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Pacman Lab' })).toBeVisible();
  await expect(page.locator('#game')).toBeAttached();
  await expect(page.locator('#score')).toContainText('Score');
  await expect(page.locator('#lives')).toContainText('Lives');
});

test('P0-UI-001 canvas scales to the viewport while keeping its aspect ratio', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/');
  const canvas = page.locator('#game');
  const wide = await canvas.boundingBox();

  await page.setViewportSize({ width: 420, height: 900 });
  const tall = await canvas.boundingBox();

  if (!wide || !tall) throw new Error('canvas bounding box missing');
  const ratio = (box: { width: number; height: number }): number => box.width / box.height;
  expect(Math.abs(ratio(tall) - ratio(wide))).toBeLessThan(0.05);
});

test('home page has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/');

  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations).toEqual([]);
});
