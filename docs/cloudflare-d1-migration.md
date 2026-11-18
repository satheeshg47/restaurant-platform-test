# Cloudflare Workers + D1 migration

## Scope and rollout safety

The current PostgreSQL implementation is retained as a reference during the migration. The D1 database starts empty; no PostgreSQL customer data is copied or deleted. The migration is staged: schema first, then API routes, then restaurant-domain routes, then backup/restore, and only after parity tests may PostgreSQL code and dependencies be removed.

- Production database: `restaurant-platform`
- Isolated preview database: `restaurant-platform-preview`
- Binding name: `DB`
- Migration directory: `database/d1/migrations`
- Worker entry point: `worker/index.ts`

The preview database contains migrations 0001-0007 and the seeded Restaurant Suite application. Production D1 was initially empty, backed up at a D1 Time Travel bookmark, then initialized with migrations 0001-0007 after CI and preview validation. It now contains 43 application tables, the migration ledger and the Restaurant Suite registry record; no tenant or owner records have been created.

## Security model

D1 uses SQLite semantics and does not provide PostgreSQL row-level security policies. The old PostgreSQL RLS policies are not copied as if they still protect D1. Every tenant-facing Worker route must derive tenant identity from a verified token and enforce tenant ownership in every query. Do not trust a tenant ID from a URL, query parameter, header, or JSON body as authorization. Tenant-scoped routes remain unavailable until they are ported with explicit tenant checks and tests.

The deployed Worker uses D1 for platform administration, owner invitations and communications, tenant onboarding, restaurant settings, tables and sessions, menu/catalogue CRUD, stock adjustments, QR guest menu reads and ordering, guest order tracking/cancellation and service requests, kitchen batching and item status, waiter boards and service requests, payment/refund ledgers, GST invoices, reports/daily summaries, reviews, CSV/JSON exports, backup validation and guarded tenant restore. Tenant-facing routes derive the tenant from verified identity and active membership; public guest routes require a high-entropy table token whose hash is stored in D1. The Worker test suite exercises the end-to-end owner, menu, QR order, kitchen/waiter, finance, GST invoice, reports, reviews, export and restore-preflight paths. External offsite backup scheduling and a production customer onboarding drill remain outstanding; do not treat schema deployment alone as production launch approval.

## Migration sequence

1. Create and validate the D1 platform schema in an isolated preview database.
2. Port platform administration routes and verify OIDC issuer, audience, JWKS and owner subject checks.
3. Port owner invitations and communications with atomic D1 batches and concurrency-safe state transitions.
4. Translate the complete restaurant schema, including table sessions, menu/catalogue, order lifecycle, kitchen allocation, payments/refunds, service requests, reviews, GST snapshots and invoices.
5. Port restaurant routes in feature slices: tenant onboarding and profiles/tables/QR sessions; menu/catalogue and audited stock; guest ordering; kitchen/waiter flows; payments/refunds/invoices; reports/reviews/settings.
6. Port export, backup and restore with tenant-boundary and non-empty-target safeguards.
7. Run cross-database fixture tests, route parity tests, authorization tests, migration replay tests and restore drills.
8. Only after all checks pass, apply additive migrations to the empty production D1 database, deploy the D1 Worker, verify health and smoke tests, and then remove the PostgreSQL runtime path in a later change.

Never run the PostgreSQL migrations against D1. They contain PostgreSQL-only features such as extensions, schemas, functions, row-level security, procedural blocks, JSONB operators and advisory locks.

## Free-tier budget guardrails

The intended deployment is Workers Free + D1 Free. As of 2026-11-17, D1 Free includes 5 million rows read per day, 100,000 rows written per day, 5 GB total account storage, up to 500 MB per database, and up to 10 databases. If daily read/write or storage limits are reached, D1 queries stop until the limit resets or unused data is removed; the app must not automatically upgrade or enable paid billing. Monitor `rows_read`, `rows_written` and database size. Optimize indexed queries and batch related statements.

The app must never initiate a paid-plan upgrade, add a payment method, or enable paid usage. Free-tier limits are hard limits, not a promise of unlimited capacity. If actual workload requires paid capacity, stop and ask the owner rather than upgrading.

## Current migration status

- [x] Create separate production and preview D1 databases in APAC.
- [x] Create the first SQLite-compatible platform schema migration.
- [x] Apply platform, owner communications, and restaurant-domain migrations 0001-0004 to the isolated preview database.
- [x] Confirm all 25 restaurant tables and 5 per-item timing columns exist; preview foreign-key check reports no violations.
- [x] Add a Cloudflare Worker entry point with D1-backed platform endpoints.
- [x] Port owner invitation and communications routes to D1 with integration tests.
- [x] Add Super Admin tenant onboarding and restaurant application activation.
- [x] Port restaurant settings, table management, table sessions and hashed QR menu reads with tenant-isolation tests.
- [x] Add D1 migration, Worker type-check and bundle checks to CI.
- [x] Configure the verified Super Admin subject as a Worker secret and verify the binding name is present.
- [x] Port menu CRUD, guest ordering, kitchen/waiter, payments/refunds, invoices, reports and reviews; exercise the integrated workflows in Worker tests.
- [x] Implement tenant JSON export, backup validation, restore preflight, empty-target/maintenance guards and atomic restore tests.\n- [ ] Configure an offsite backup destination and scheduled backup/restore drills.
- [x] Apply migrations 0001-0007 to the empty production D1 database after CI and preview validation; verify 43 application tables and zero foreign-key violations.\n- [x] Deploy the Worker with schema-aware readiness; verify the latest deployment receives 100% traffic.\n- [ ] Perform a live authenticated production smoke test and first-tenant onboarding drill.
- [ ] Remove PostgreSQL dependencies and legacy runtime code only after remaining parity, backup and rollback checks.

This is an in-progress migration, not a production-ready system.
