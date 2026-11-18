# Restaurant Platform — Platform Core

Mobile-first Super Admin control plane for the Restaurant Suite, hosted on Cloudflare Workers with Cloudflare D1.

## Verified deployment

- Worker: `restaurant-platform-test`
- Production URL: https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev
- Source of truth: GitHub `main`; Cloudflare deploys the repository's `main` branch.
- Database: Cloudflare D1, database binding `DB`.
- Production schema: migrations `0001`–`0007`; 43 required application tables.
- Readiness: `GET /api/health` and schema-aware `GET /api/ready`.
- Identity: Auth0 OIDC Authorization Code + PKCE; the Worker validates signed tokens and authorizes the configured platform-admin subject.
- Latest verified main deployment: 2026-11-18; live health/readiness smoke test passed.

The dashboard is in **pre-launch mode**. Production hosting, OIDC sign-in, D1 schema/readiness, tenant data export and guarded restore foundations are deployed. This does not mean the platform is approved for real restaurant onboarding.

## Current launch gates

1. **Administrator MFA:** Auth0 sign-in works, but MFA/passkey enforcement has not been configured and verified.
2. **Offsite backups:** D1 Time Travel provides limited recovery, not an independent offsite backup. A Google Apps Script → Google Drive daily D1 export bridge has been added to the repository, but it is not active until its one-time secure setup, first successful backup and isolated restore drill are completed. Cloudflare R2 remains disabled.
3. **Recovery drills:** tenant export, validation, restore preflight and guarded restore are implemented, but scheduled offsite backup and end-to-end recovery drills remain outstanding.
4. **Update Centre:** release-manifest validation exists, but the full upload, approval, deployment and rollback workflow is not complete.
5. **First tenant:** no real restaurant or owner has been onboarded. Do not seed dummy customers or owners.

Do not use this project for live customer operations until the launch gates have been completed and verified.

## Zero-cost operating rule

The project is configured for Cloudflare Workers Free and D1 Free. No paid-plan upgrade, trial conversion, payment method, R2 subscription or automatic billing is authorized. Free-tier quotas are finite; if a quota or required capability cannot be met at zero cost, stop and report the limitation instead of enabling paid usage.

D1 Time Travel is a recovery feature, not a substitute for encrypted offsite backups. Never describe the current setup as having offsite backup protection.

## Local development

Requirements: Node.js 20+

```bash
npm install
npm run build
npm test
```

For local Worker development, use the Wrangler configuration and D1 local database. Do not apply production migrations blindly. Production already has migrations `0001`–`0007`; inspect the D1 migration ledger and schema before any migration operation.

## Architecture

- React + TypeScript frontend.
- Cloudflare Worker API in `worker/`.
- Cloudflare D1 SQLite database, bound as `DB`.
- Auth0 OIDC for administrator and owner identity.
- GitHub Actions for build, tests and post-deployment smoke checks.
- Tenant export formats: CSV and JSON; restore is guarded by validation, preflight, maintenance/empty-target safeguards and audit logging.

D1 does not provide PostgreSQL row-level security. Every tenant-facing Worker operation must enforce authorization in application code using the verified identity and active tenant membership. Never trust a tenant identifier supplied by the browser as proof of access.

## API health

- `GET /api/health` reports Worker liveness and deployment environment.
- `GET /api/ready` verifies the latest expected D1 migration and all 43 required application tables. It returns HTTP 503 if the schema is incomplete or D1 is unavailable.

## Security principles

- The platform-admin allowlist is enforced server-side using the verified OIDC issuer and stable subject.
- OIDC JWT signatures, issuer, audience and allowed algorithms are validated by the Worker.
- Keep secrets in Cloudflare Worker secrets, never in Git or frontend bundles.
- Tenant identity must come from verified identity and membership checks, not request parameters.
- Keep customer data separate from application code releases.
- Record sensitive administrative actions in the platform audit trail.
- Require MFA, offsite backups and successful restore drills before onboarding real customers.

## Release package inspection

The repository contains bounded ZIP/manifest inspection and release validation foundations. These are not equivalent to a complete release-management system. The full upload, staging, backup, explicit approval, deployment, health-check and rollback workflow remains a launch gate.

## Documentation

- [OIDC PKCE setup](docs/authentication-setup.md)
- [Cloudflare D1 migration and operating limits](docs/cloudflare-d1-migration.md)\n- [Google Drive backup and seven-day hot-data plan](docs/drive-backup-and-retention.md)
- [Security implementation notes](SECURITY.md)
