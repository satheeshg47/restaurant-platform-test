import { test, expect } from '@playwright/test'

test('Demo Bistro closed-loop QA runs only on isolated previews', async ({ request }) => {
  const response = await request.get('/api/health')
  expect(response.ok()).toBeTruthy()
  const health = await response.json()
  test.skip(health.environment !== 'preview')
})
