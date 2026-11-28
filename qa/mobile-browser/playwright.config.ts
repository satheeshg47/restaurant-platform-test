import { defineConfig } from '@playwright/test'
const baseURL = process.env.BASE_URL || 'https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev'
export default defineConfig({
  testDir: './tests', fullyParallel: false, forbidOnly: Boolean(process.env.CI),
  timeout: 180000,
  expect: { timeout: 15000 },
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure', actionTimeout: 10000, navigationTimeout: 30000 },
  projects: [
    { name: 'mobile-390x844', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } },
    { name: 'desktop-1440x900', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
  ],
  outputDir: 'test-results',
})
