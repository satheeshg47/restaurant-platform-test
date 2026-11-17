# Restaurant App migration

The Restaurant App is being rebuilt as a native Platform Core application. The Google Apps Script runtime, Sheets database, CacheService, LockService and Drive dependencies are not part of the target architecture.

## Source of truth

The functional reference is `RestaurantApp-Handoff.zip`, including the 23-tab schema, Apps Script server functions, four role-facing pages and browser/server tests. No production records are being migrated because the previous app was a test deployment.

## Target architecture

- One Platform Core application registration (`restaurant`) can serve multiple restaurant tenants.
- Shared PostgreSQL database with tenant-scoped rows, composite tenant foreign keys and forced row-level security.
- Amounts are stored as integer minor units (paise for INR); menu and add-on names retain language variants as JSON objects.
- Customer QR access uses a hash of a high-entropy table token, never a raw reusable token in the database.
- Order item names, variants, add-ons and prices are snapshots so later menu edits do not rewrite historical bills.
- Idempotency keys prevent duplicate order submissions.
- Kitchen batches can group only identical item/variant/add-on/customization combinations; allocations preserve per-order and per-table readiness.
- Payments and refunds are append-only ledger records. Payment confirmation remains a staff action; no payment gateway is assumed.
- Existing Platform Core identity and tenant membership are the intended authentication boundary. Restaurant staff roles add cook/waiter permissions within a tenant.

## Delivery phases

1. Domain schema and tenant isolation (this migration).
2. Tenant-scoped repository and API, table/session lifecycle, menu reads and QR guest entry.
3. Server-priced ordering, stock reservation, idempotency and customer tracking.
4. Kitchen queue, batching, waiter service requests and table operations.
5. Payments/refunds, reviews, settings, reports, retention/export and owner UI.
6. End-to-end QA, deployment readiness, backups and operational documentation.

## Important limitations

This migration creates the database model only. It does not provision PostgreSQL, create a tenant, configure identity, expose restaurant endpoints or deploy a live restaurant. Those steps require a configured runtime and explicit deployment approval.
