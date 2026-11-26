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


## Screenshot PDF guide

After each successful live deployment smoke test (and on manual or scheduled runs), the workflow also generates:

- `guide-output/platform-core-app-guide.pdf` — landscape A4 guide with desktop and mobile screenshots, a short explanation for each screen, and operating guidelines.
- `guide-output/screenshots/` — original PNG screenshots used in the PDF.
- `guide-output/manifest.json` — capture status for every expected screen.
- `guide-output/index.html` — printable HTML source for the PDF.

Download the artifact named `platform-core-app-guide-<run number>` from the **Full browser QA** workflow's Actions run. The artifact contains the PDF, source screenshots, Playwright traces/results and HTML report.

### Authenticated page coverage

The public guest QR menu can be captured without a login. Super Admin, Owner and Staff pages are protected, so the workflow never stores passwords or attempts to bypass sign-in. To include the real authenticated pages, create Playwright storage-state JSON files from dedicated, least-privilege QA accounts and add their base64-encoded contents as GitHub Actions repository secrets:

- `QA_ADMIN_STORAGE_STATE_B64` — dedicated Super Admin QA session.
- `QA_OWNER_STORAGE_STATE_B64` — owner QA session for a disposable/demo restaurant.
- `QA_COOK_STORAGE_STATE_B64` — optional Cook session.
- `QA_WAITER_STORAGE_STATE_B64` — optional Waiter session.

A storage-state file is the JSON output of Playwright's `browserContext.storageState()`; base64-encode the complete JSON before saving it as a repository secret. Keep these accounts isolated from real customer data, rotate/revoke them when no longer needed, and do not commit the JSON files. Without these secrets, the PDF includes the sign-in screens and clearly marks protected pages as login-required rather than claiming they were captured.

### Read-only safety

The screenshot generator navigates and captures screens only. It does not create tenants, invite staff, change settings, submit a guest order, close a table session or mutate production business records. The guest cart is used only to show item customization and order review.
