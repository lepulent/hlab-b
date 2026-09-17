import { defineConfig, devices } from '@playwright/test';

// The QA station points the same journeys at a deployed stage: PLAYWRIGHT_BASE_URL skips the local server.
const remote = process.env['PLAYWRIGHT_BASE_URL'];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: remote ?? 'http://localhost:4173',
    screenshot: process.env['PLAYWRIGHT_SCREENSHOT'] === 'on' ? 'on' : 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: remote
    ? undefined
    : {
        command: 'npm run build && npm run preview -- --port 4173 --strictPort',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
