import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('home page renders heading and canvas', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Pacman Lab' })).toBeVisible();
  await expect(page.locator('#game')).toBeAttached();
});

test('home page has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/');

  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations).toEqual([]);
});
