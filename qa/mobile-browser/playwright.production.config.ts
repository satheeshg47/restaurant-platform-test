import { defineConfig } from '@playwright/test'

const baseURL = (process.env.BASE_URL || 'https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev').replace(/\/$/, '')

export default defineConfig({
  testDir: './production-tests',
  fullyParallel: false,
  forbidOnly: true,
  timeout: 180000,
  expect: { timeout: 20000 },
  workers: 1,
  retries: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results-production/results.json' }]],
  outputDir: 'test-results-production',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
  projects: [
    { name: 'mobile-390x844', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } },
    { name: 'desktop-1440x900', testMatch: '**/role-signin.spec.ts', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
  ],
})
