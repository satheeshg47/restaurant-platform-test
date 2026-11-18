# Restaurant Suite on Platform Core

## Runtime and data model

Restaurant Suite is a native Platform Core application using Cloudflare Workers and Cloudflare D1. The D1 database is the source of truth for platform and tenant records. The previous Google Apps Script/Sheets runtime and the PostgreSQL implementation are not used by the deployed Worker.

- One application registration (`restaurant`) serves multiple restaurant tenants.
- All operational rows are tenant-scoped. Worker routes derive tenant identity from a verified Auth0 identity and active tenant membership; request-supplied tenant IDs are never treated as authorization.
- Guest QR access uses a high-entropy table token. Only its SHA-256 hash is stored in D1.
- Amounts use integer minor units (paise for INR); localized names and historical order/invoice snapshots are preserved as JSON.
- Guest ordering is server-priced and idempotent. Stock reservation, kitchen batching and per-order allocations are performed in D1.
- Payments and refunds are ledger records; payment capture is manual. No payment gateway or card-data storage is enabled.
- GST invoices preserve seller, tax and item snapshots. Invoice numbering is tenant-scoped.
- Tenant export strips private QR tokens and idempotency keys. Restore requires a validated backup, explicit confirmation, an empty target, and guarded atomic writes.

## Implemented and tested

The D1 Worker currently supports:
1. Super Admin application registry, tenant creation, owner invitations, subscriptions, manual payment review, monitoring and audit events.
2. Owner identity verification and tenant membership checks.
3. Restaurant profile/settings, tables, QR tokens and table sessions.
4. Multilingual menu categories/items, variants, add-on groups, availability, stock tracking and audited stock adjustments.
5. Guest QR menu, cart ordering, idempotency, order tracking/cancellation and service requests.
6. Kitchen queue/batching, cook item transitions, waiter board, service-request handling and item serving.
7. Manual payments/refunds, bill views, GST invoices and safe table closing.
8. Reports, daily summaries, customer reviews and owner responses.
9. Tenant CSV/JSON export, backup validation, restore preflight and guarded restore.

The Worker test suite runs the main owner-to-guest workflow against an isolated SQLite/D1-compatible test database. CI also applies all seven D1 migrations locally, validates the PostgreSQL reference migrations, builds the frontend and bundles the Worker.

## Production database status

- Production D1: migrations 0001-0007 applied.
- Schema: 43 application tables; migration ledger contains all seven migrations.
- Integrity check: `PRAGMA foreign_key_check` returned zero violations.
- Seed registry: Restaurant Suite is active.
- Tenant and owner records: none; no demo customer data was inserted.
- The API readiness route verifies the latest migration and all required application tables, rather than only running `SELECT 1`.

## Remaining launch gates

- Configure and verify scheduled offsite backups to the chosen free storage destination, then complete restore drills.
- Complete a live authenticated production smoke test and first-tenant onboarding drill.
- Verify real owner login, tenant isolation and operational workflows with a non-demo tenant.
- Review free-tier usage and quotas. No paid plan, payment gateway or automatic billing upgrade is enabled.

Schema deployment is not equivalent to a production launch. Keep customer onboarding and live restaurant operations disabled until these gates are complete.
