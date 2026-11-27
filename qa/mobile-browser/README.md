# Platform Core — Playwright browser QA

Runs Chromium at exact mobile **390 × 844** and desktop **1440 × 900** viewports.

## Authenticated Demo Bistro coverage

The dedicated preview D1 database is used for all mutating QA. The suite refuses to run unless `GET /api/health` reports `environment: preview`.

- Preview-only Super Admin, Restaurant Owner, Cook and Waiter sessions.
- Admin Apps → **Open Demo Bistro** one-click workspace entry and reset/re-seed control.
- Editable multilingual menu, portions and add-ons.
- Table creation, QR token validation and table label changes.
- Staff creation, role assignment, access revocation and denied-login verification.
- Guest QR ordering from two tables at once.
- Kitchen batch aggregation across tables while retaining per-table allocations.
- Kitchen status progression: new → accepted → preparing → ready.
- Waiter service requests, ready-item service, billing, cash payment and session close.
- Sales/report and customer-review updates after the completed transaction.
- Real authenticated screenshots for Super Admin, Owner, Cook and Waiter on both viewports.
- Regenerated landscape PDF walkthrough, source screenshots and manifest.

All payments in Demo Bistro are simulated. The suite never connects to a payment gateway or moves real money.

## Preview-only QA accounts

The disposable preview environment provisions the following demo-only identities automatically:

| Role | Login ID | Preview password |
|---|---|---|
| Super Admin | `demo.admin` | `DemoAdmin#2026!` |
| Restaurant Owner | `demo.owner` | `DemoOwner#2026!` |
| Cook | `demo.cook` | `DemoCook#2026!` |
| Waiter | `demo.waiter` | `DemoWaiter#2026!` |

These credentials are intentionally limited to the isolated preview database. Never copy them into production or use them for real restaurant data.

## Run locally

Install the app and browser dependencies, then point at an HTTPS Cloudflare preview deployment:

```sh
npm install
npm run build
cd qa/mobile-browser
npm install
npx playwright install --with-deps chromium
BASE_URL=https://YOUR-ISOLATED-PREVIEW-URL npm test
BASE_URL=https://YOUR-ISOLATED-PREVIEW-URL npm run guide
```

The tests refuse non-preview environments. They reset Demo Bistro before each journey, so do not point them at production.

## GitHub Actions

The **Demo Bistro authenticated browser QA** workflow runs on pushes to the QA branch when repository variable `DEMO_BISTRO_PREVIEW_URL` is configured. It can also be started manually with the isolated preview URL as an input.

The workflow verifies the target environment before any mutation, runs mobile and desktop journeys, regenerates the PDF and uploads the report, screenshots, traces and guide as a 30-day artifact.

## Screenshot PDF guide

The generated assets are:

- `guide-output/platform-core-app-guide.pdf` — landscape A4 walkthrough.
- `guide-output/screenshots/` — original PNG screenshots.
- `guide-output/manifest.json` — capture status for each screen.
- `guide-output/index.html` — printable source.

The guide generator automatically establishes the preview-only demo role sessions. Storage-state secrets are optional; do not commit browser session JSON or passwords.

## Retention and isolation

Demo records are stored through the dedicated `DEMO_DB` binding. The configured retention period is 365 days; a daily Cloudflare scheduled task prunes expired closed-session history and related transactional records. The Admin reset action clears and re-seeds the Demo Bistro workspace.

The preview deployment uses its isolated D1 binding. The production business database is not a QA target. Keep the production `DB` and preview `DEMO_DB` bindings separate when publishing.
