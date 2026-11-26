# Platform Core — Mobile Browser QA

This folder runs real Chromium browser checks using Playwright's Android device profiles.

## What it checks

- Super Admin entry and Demo Owner entry both return a document without a server error.
- No uncaught browser JavaScript errors on the initial unauthenticated screen.
- No horizontal page overflow at Pixel 7 and compact Android viewport sizes.
- API health and readiness routes respond.
- Full-page screenshots, traces and videos are retained in CI when a test fails.

## Run locally

```sh
npm install
npx playwright install --with-deps chromium
BASE_URL=https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev npm test
```

## GitHub Actions

Run **Mobile browser QA** manually from Actions or on its weekly schedule. Set `BASE_URL` to test a preview deployment by dispatching with a different value.

The initial suite deliberately tests the public sign-in/entry surfaces and does not store account passwords. Authenticated restaurant workflows (menu, tables/QR, kitchen and owner workspace) should be added only after a dedicated least-privilege QA account is provisioned through GitHub Actions secrets. Never commit credentials or put them in chat.
