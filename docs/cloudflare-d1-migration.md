# Cloudflare Workers + D1 migration

## Scope and rollout safety

The current PostgreSQL implementation is retained as a reference during the migration. The D1 database starts empty; no PostgreSQL customer data is copied or deleted. The migration is staged: schema first, then API routes, then restaurant-domain routes, then backup/restore, and only after parity tests may PostgreSQL code and dependencies be removed.

- Production database: `restaurant-platform`
- Isolated preview database: `restaurant-platform-preview`
- Binding name: `DB`
- Migration directory: `database/d1/migrations`
- Worker entry point: `worker/index.ts`

The preview database was initialized and the first platform schema migration was applied there. Production D1 remains empty until the migration has passed CI and is explicitly prepared for cutover.

## Security model

D1 uses SQLite semantics and does not provide PostgreSQL row-level security policies. The old PostgreSQL RLS policies are not copied as if they still protect D1. Every tenant-facing Worker route must derive tenant identity from a verified token and enforce tenant ownership in every query. Do not trust a tenant ID from a URL, query parameter, header, or JSON body as authorization. Tenant-scoped routes remain unavailable until they are ported with explicit tenant checks and tests.

The Worker currently exposes platform health/readiness, Super Admin, owner invitation and communications endpoints, plus Super Admin tenant creation, tenant-scoped restaurant settings, table management, table-session lifecycle and public QR menu reads. Restaurant menu CRUD, guest ordering, kitchen/waiter workflows, payments/refunds, invoices and reports remain explicitly unavailable until their feature-by-feature D1 ports and parity tests are merged. Do not use this stage to manage live restaurant operations.

## Migration sequence

1. Create and validate the D1 platform schema in an isolated preview database.
2. Port platform administration routes and verify OIDC issuer, audience, JWKS and owner subject checks.
3. Port owner invitations and communications with atomic D1 batches and concurrency-safe state transitions.
4. Translate the complete restaurant schema, including table sessions, menu/catalogue, order lifecycle, kitchen allocation, payments/refunds, service requests, reviews, GST snapshots and invoices.
5. Port restaurant routes in feature slices: tenant onboarding and profiles/tables/QR sessions; menu/catalogue; guest ordering; kitchen/waiter flows; payments/refunds/invoices; reports/reviews/settings.
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
- [ ] Configure the verified Super Admin subject in Worker environment.
- [ ] Port menu CRUD, guest ordering, kitchen/waiter, payments/refunds, invoices and reporting.
- [ ] Complete backup/restore migration and security tests.
- [ ] Apply schema to production D1 and deploy after all checks pass.
- [ ] Remove PostgreSQL dependencies only after parity and rollback checks.

This is an in-progress migration, not a production-ready system.
