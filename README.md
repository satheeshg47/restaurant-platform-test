# Platform Core

Central Super Admin platform for managing multiple applications, owners, subscriptions, deployments and backups.

## Current stage

Stage 2 — mobile-first Super Admin dashboard with live API and database-readiness indicators.

The Overview now reads API liveness and database readiness from the backend. Application, owner, subscription and release lists remain prototype/sample data. The API can connect to PostgreSQL when `DATABASE_URL` is configured, but authentication, payment provider, file storage, deployment infrastructure, and production monitoring are not connected. Do not use it to manage real customers or production data.

## Development

Requirements: Node.js 20+

```bash
npm install
# Terminal 1: API
npm run api

# Terminal 2: frontend
npm run dev

# Production build
npm run build
```

## Architecture direction

- React + TypeScript frontend.
- PostgreSQL as the portable relational database.
- Tenant isolation enforced by server-side authorization and PostgreSQL row-level security.
- S3-compatible object storage for application assets and backups.
- Versioned application packages and separately versioned database migrations.
- Deployment adapters so infrastructure can be changed without rewriting the control plane.

## Security and release principles

- Super Admin access is owner-only.
- Require MFA/passkeys before production access.
- Never put secrets in frontend code or Git.
- ZIP updates must be staged, validated, backed up, explicitly approved, health-checked, and rollback-capable.
- Application code updates must never overwrite customer data.
- Backups must be encrypted and restore-tested.

## User decisions

- Initial Super Admin access: only the platform owner.
- Subscription management: manual confirmation and automatic online payments.
- Application updates: approval required before deployment.
- Database architecture: shared database with strict tenant/application isolation.
- Development priority: mobile-first and zero recurring cost where practical.
- Portability: standard PostgreSQL and S3-compatible storage; export/import and migration support.

## Roadmap

1. Frontend dashboard and navigation (prototype).
2. API skeleton and PostgreSQL schema foundation (in progress).
3. Tenant-scoped transaction helper and initial automated tests (in progress).
4. OIDC authentication, MFA and server-side authorization.
5. Application, owner transfer, subscription and payment workflows.
6. Secure ZIP release pipeline and rollback.
7. Encrypted backups, restore and migration tools.
8. Monitoring, deployment and load testing.

Production costs and capacity depend on the selected providers and actual workload. Free tiers are for development/testing, not a reliability guarantee.


See [SECURITY.md](SECURITY.md) for identity and tenant-boundary requirements. The API now creates a PostgreSQL connection pool when `DATABASE_URL` is configured. Set `DATABASE_SSL=true` when the provider requires verified TLS, and optionally set `DB_POOL_MAX` (1–50, default 10) to tune the pool size. The API does not apply migrations automatically. Apply numbered SQL migrations with a dedicated migration role using `DATABASE_URL=... npm run db:migrate`. The runner takes a PostgreSQL advisory lock, records each successful migration in `platform_schema_migrations`, applies each file transactionally, and safely skips versions already recorded. Back up the database before running migrations in a live environment.

- `GET /health` reports process liveness and remains healthy during database outages.
- `GET /ready` returns HTTP 200 only when PostgreSQL responds to `SELECT 1`; it returns HTTP 503 when the database is missing or unavailable.

During local development, Vite proxies `/api/*` to the API on `127.0.0.1:8787`. For another environment, set `VITE_API_BASE_URL` to the same-origin API prefix (default `/api`) and configure the hosting reverse proxy accordingly. Do not expose the API directly to browsers across origins without an explicit CORS and authentication design.

A generic OIDC JWT access-token verifier, protected `GET /admin/session` endpoint, and browser sign-in UI using Authorization Code + PKCE are implemented. No identity-provider account or environment configuration has been provisioned. The frontend requires a public client ID and API resource audience; the API independently verifies signed access tokens against its configured issuer, API audience and JWKS. The protected `GET /admin/applications` and `POST /admin/applications` endpoints provide the first database-backed Super Admin registry operations once OIDC and PostgreSQL are configured. Other management modules remain prototypes.


## Administrator authentication foundation

The API supports a generic OIDC access-token verifier for the single configured platform owner. It verifies JWT signatures against the provider's HTTPS JWKS endpoint, enforces issuer, audience and allowed signing algorithms, and authorizes only the exact configured issuer + stable subject pair. Email alone is never an administrator identity.

Configure all of these server environment variables together before enabling the protected session endpoint:

- `OIDC_ISSUER` — exact HTTPS issuer URL from your identity provider.
- `OIDC_AUDIENCE` — API audience configured for the access token.
- `OIDC_CLIENT_ID` — public browser client ID, used by the API to verify ID tokens during invitation acceptance.
- `OIDC_JWKS_URL` — HTTPS JSON Web Key Set URL.
- `PLATFORM_ADMIN_SUBJECT` — stable `sub` claim for the one platform owner.

`GET /admin/session` requires an `Authorization: Bearer <access-token>` header. Until all settings are present, it returns `503 admin_auth_not_configured`. The browser sign-in UI and PKCE flow are implemented, but no identity-provider account or environment configuration has been provisioned. Invitation acceptance also requires `OIDC_CLIENT_ID` so the API can independently verify the ID token's verified-email claim. Never use an ID token as an API access token.


## Platform audit trail

Migration `0003_platform_audit_events.sql` adds a global control-plane audit table. Creating an application writes the registry row and its `application.created` audit event in one PostgreSQL statement, so a failed audit insert also prevents the application from being created. Events record the verified OIDC issuer and stable subject, action, resource identifier, and limited application metadata. The owner-only `GET /admin/audit-events` endpoint exposes a paginated, newest-first read view (default 25 events; maximum 100 per request). It returns only stored audit fields and never caches responses. The migration is applied by the tracked migration runner; the dashboard UI is not connected yet.

## Release package inspection

Release manifests are validated independently from ZIP archives. `server/releases/archive.mjs` inspects a bounded ZIP buffer against a validated manifest without extracting files to disk or executing package contents. It rejects malformed archives, path traversal and protected paths, duplicate entries, symlinks and non-regular files, encrypted entries, unsupported compression, unlisted or missing files, size mismatches, excessive compression ratios, and SHA-256 mismatches. Defaults cap the compressed archive at 100 MiB, entries at 5,000, each uncompressed file at 100 MiB, total uncompressed content at 500 MiB, and compression ratio at 100:1.

This is an inspection primitive only. It does not accept uploads, persist packages, stage releases, back up customer data, apply migrations, approve releases, or deploy/rollback applications. A later release workflow must preserve those separate safety gates.


## Browser authentication

See [OIDC PKCE browser sign-in setup](docs/authentication-setup.md) for frontend and API environment configuration.


## Cloudflare Workers + D1 migration (in progress)

The new Worker entry point and D1 platform foundation are being introduced in stages. See [the D1 migration plan](docs/cloudflare-d1-migration.md) for the isolated preview/production databases, SQLite schema, tenant authorization requirements, free-tier limits and cutover gates. PostgreSQL route modules remain in the repository until their D1 replacements pass parity, authorization and recovery tests. The Worker currently exposes only the platform endpoints implemented in `worker/index.ts`; restaurant and owner routes are deliberately marked unavailable until ported. Do not use this stage for live customer or restaurant operations.
