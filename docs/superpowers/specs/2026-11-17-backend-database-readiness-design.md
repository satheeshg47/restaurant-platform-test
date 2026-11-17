# Backend Database Readiness Design

## Intent
Connect the existing Platform Core API to its configured PostgreSQL database without exposing customer or administrator operations before authentication and authorization are implemented. This gives deployment checks an honest signal about whether the API process and database are ready.

## Goals
- Keep the existing `/health` endpoint as a process-liveness check.
- Add `/ready` as a database-readiness check.
- When `DATABASE_URL` is absent, report the database as not configured and return HTTP 503 from `/ready`.
- When configured, create one bounded PostgreSQL pool and verify it with a lightweight `SELECT 1`.
- Close the pool during graceful shutdown.
- Keep credentials out of source code and responses.

## Non-goals
- No login, OIDC callback, MFA, session, owner provisioning, tenant CRUD, or customer-facing routes in this phase.
- No production database credentials or hosting provider are provisioned.
- No migrations are automatically applied by the API process.

## Constraints
- Node.js 20+, existing ESM, `node:test`, and existing `pg` dependency.
- Preserve existing `/health` response semantics and security headers.
- Never claim readiness when PostgreSQL is absent or unreachable.
- Do not expose connection strings, query errors, or secrets in HTTP responses.
- Existing owner-only access and tenant isolation requirements remain mandatory before any administrative or tenant data routes are added.

## Approaches
1. **Separate liveness and readiness endpoints (selected):** keep `/health` process-only and add `/ready` for DB readiness. This avoids restarts during database outages and is standard for deployment probes.
2. **Make `/health` depend on PostgreSQL:** simple, but conflates process liveness with dependency readiness and can cause orchestrators to restart a healthy process during a DB outage.
3. **Add full authenticated admin API now:** too broad for a safe incremental phase because a trusted OIDC provider, callback/session design, and secret provisioning are not yet selected.

## Design decisions
- `createApiServer(config, { database })` accepts an optional database dependency for testability.
- A configured database is ready only when `database.query('SELECT 1')` succeeds.
- `/ready` returns 200 with `{status:"ready", checks:{database:"ok"}}` or 503 with a generic unavailable state.
- API startup creates a pool only when `DATABASE_URL` exists; shutdown ends the pool after the HTTP server closes.
- Database errors are logged server-side without returning details to callers.

## Builder decisions
- Keep this phase limited to runtime wiring and readiness. Authentication provider selection and owner identity enrollment are a separate design decision before protected routes are built.
