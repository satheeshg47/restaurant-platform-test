# Cloudflare Workers + D1 migration

## Scope and rollout safety

The PostgreSQL implementation is retained as a reference during the migration. Cloudflare D1 is the operational database for the deployed Worker. The production and preview D1 databases are separate; no PostgreSQL customer data is copied or deleted. The migration remains staged: schema, Worker routes, authorization tests, backup/restore verification, and only then removal of legacy PostgreSQL runtime code.

- Production database: `restaurant-platform`
- Preview database: `restaurant-platform-preview`
- Binding name: `DB`
- Migration directory: `database/d1/migrations`
- Worker entry point: `worker/index.ts`
- Production Worker: `restaurant-platform-test`

## Current production schema (2026-11-18)

Migrations `0001` through `0009` are applied to both production and preview D1. The current readiness endpoint requires 50 application/authentication tables. D1 currently reports 53 tables total, including migration metadata and Cloudflare-managed internal tables. Production and preview have zero users, tenants and sessions; the foreign-key check returned zero violations.

Migration 0008 added native authentication credentials, sessions, MFA challenges, recovery codes, platform administrator grants, rate limits and tenant permission records. Migration 0009 added the last-accepted TOTP counter to prevent authenticator time-step replay.

The production database has not been seeded with dummy restaurants, owners or staff. Do not add sample customer identities to production.

## Security model

D1 uses SQLite semantics and does not provide PostgreSQL row-level security. The old PostgreSQL RLS policies are not copied as if they still protect D1. Tenant-facing routes derive the actor from a native session or a verified OIDC identity, resolve active tenant membership server-side, and enforce tenant ownership in every query. Never trust a tenant ID from a URL, query parameter, header or JSON body as proof of access.

Owner management routes require active owner/admin membership. Staff permissions derive from the active membership and restaurant staff record; client-supplied roles are not trusted. Public guest QR access uses high-entropy table tokens, stores only token hashes and validates tokens against active tables/sessions.

## Deployed application areas

The Worker and React frontend include platform administration, application registry, tenant onboarding, owner invitations, owner communications, subscription plans/payments, audit and monitoring, restaurant profiles/settings, menu/catalogue, tables and QR, guest menu/order flows, kitchen batches, waiter/service operations, stock adjustments, payments/refunds, GST invoices, daily summaries/reports, customer reviews, CSV/JSON export and guarded restore foundations.

The owner workspace supports restaurant access and individual staff accounts. Staff workspaces are role-specific (manager, cook and waiter) and the server enforces role restrictions. Guest QR routes are public only with a valid high-entropy table token.

## Authentication status

Native username/password authentication is implemented. Super Admin and owner accounts require TOTP; staff accounts use individual credentials and owner-assigned permissions. TOTP secrets are encrypted with a Cloudflare Worker secret, recovery codes are hashed and single-use, sessions are opaque and HttpOnly, and accepted TOTP counters cannot be replayed. MFA attempts are rate-limited.

The existing OIDC/Auth0 route remains as a compatibility path during the staged transition. The first native Super Admin has not yet been provisioned. Do not remove OIDC configuration until native Super Admin, owner invitation, owner MFA, staff access and tenant-isolation flows are verified end-to-end.

## Migration sequence

1. Build and validate the SQLite-compatible schema in isolated preview D1.
2. Port platform administration and identity/authorization routes.
3. Port owner invitations and communications with atomic D1 batches and concurrency-safe state transitions.
4. Port restaurant profiles, tables, sessions, menu/catalogue, stock, orders, kitchen/waiter flows, payments/refunds, invoices, reports and reviews.
5. Port export, backup validation and guarded restore with tenant-boundary and non-empty-target safeguards.
6. Run route parity, authorization, migration replay, owner/staff and restore tests.
7. Apply additive migrations to production only after CI and preview validation; preserve existing data.
8. Verify production health, schema readiness and native-auth readiness. Complete the first Super Admin and controlled tenant onboarding only after the launch gates pass.
9. Remove legacy PostgreSQL runtime code and OIDC compatibility only after parity, backup and rollback checks.

Never run PostgreSQL migrations against D1. PostgreSQL migrations contain features such as extensions, schemas, functions, row-level security, procedural blocks, JSONB operators and advisory locks that do not map directly to D1.

## Free-tier budget guardrails

The intended deployment is Workers Free + D1 Free. No paid-plan upgrade, trial conversion, payment method, R2 subscription or automatic billing is authorized. Free-tier quotas are finite; if a quota or required capability cannot be met at zero cost, stop and report the limitation instead of enabling paid usage.

D1 does not provide unlimited capacity. Monitor rows read/written and database size, optimize indexed queries and batch related statements. If workload requires paid capacity, stop and ask the owner rather than upgrading.

## Current migration status

- [x] Production and preview D1 created separately.
- [x] Migrations 0001–0009 applied to production and preview.
- [x] Schema-aware readiness verifies the 50 required application/authentication tables.
- [x] Worker tests, frontend build and Worker dry-run bundle checks pass on main.
- [x] Live health/readiness smoke test passed after migration 0009.
- [x] Native authentication, owner/staff account management and role-specific workspaces implemented and deployed.
- [x] TOTP replay prevention and MFA rate limiting implemented and tested.
- [x] Worker secrets for TOTP encryption and one-time Super Admin bootstrap configured.
- [x] Google Drive backup bridge configured and one historical isolated restore drill completed before migrations 0008–0009.
- [ ] Provision first native Super Admin, enroll TOTP and remove bootstrap secret.
- [ ] Complete live owner invitation and staff access verification with a controlled test tenant.
- [ ] Repeat the Google Drive backup and isolated restore against the current 0009 schema.
- [ ] Complete the Update Centre package storage, approval, deployment, health-check and rollback workflow.
- [ ] Remove OIDC and PostgreSQL compatibility only after the relevant cutover gates pass.
- [ ] Onboard the first real restaurant after all launch gates pass.

This is a deployed pre-launch platform, not a production-approved customer service.
