import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.BASE_URL || 'https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'android-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'small-android', use: { ...devices['Galaxy S9+'] } },
  ],
  outputDir: 'test-results',
})
