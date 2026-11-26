# Platform Core — Playwright browser QA

Runs Chromium against the live Cloudflare Worker at exact viewports: mobile **390 × 844** and desktop **1440 × 900**.

## Coverage
- Super Admin entry, Owner entry, and demo restaurant Table 1 guest QR.
- Guest menu and language selector (English, Hindi, Kannada, Tamil, Telugu, Malayalam).
- Guest item-customization and order-review modal flow; the suite stops before submitting a real order.
- API health and readiness.
- Horizontal overflow, visible interactive targets below 36 × 36 px, clipped leaf text, overlapping interactive controls, and controls obscured by fixed bottom bars.
- Full-page screenshots for each route plus screenshots of guest customization and order-review modals. Traces and videos are retained on failure.

## Run locally
```sh
npm install
npx playwright install --with-deps chromium
BASE_URL=https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev npm test
```

## GitHub Actions
**Full browser QA** runs after the live deployment smoke test succeeds, weekly, or manually from Actions. The HTML report, screenshots, traces, and failure videos are uploaded as a 30-day artifact.

## Authenticated role journeys — safety boundary
The full Super Admin → Owner → Cook/Waiter → Guest → Kitchen/Waiter transaction flow is not run against the shared live demo by default. Creating workspaces, staff, orders, or closing sessions mutates business data. It requires a disposable QA tenant and least-privilege test identities. Add role-specific Playwright storage states as GitHub Actions secrets and run destructive workflows only against that isolated tenant. Never use production customer accounts or the production D1 database.

This suite does not claim authenticated role-isolation, staff-revocation, cross-table aggregation, or final-bill tests until that isolated environment is provisioned.
