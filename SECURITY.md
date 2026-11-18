# Security implementation and launch gates

## Identity and administrator authorization

- The platform has one configured Super Admin identity.
- Browser sign-in uses Auth0 OpenID Connect Authorization Code flow with PKCE.
- The Worker validates signed JWTs against the configured issuer/JWKS and API audience, including expiry and allowed signing algorithms.
- Super Admin authorization is based on the exact configured issuer + stable subject pair. Email address alone is never an administrator identity.
- The Auth0 tenant and SPA/API configuration are provisioned and administrator sign-in has been verified.
- **MFA/passkey enforcement is not yet configured and verified.** This is a mandatory launch gate; do not describe the platform as production-ready.

## Tenant authorization boundary

- Cloudflare D1 uses SQLite semantics and does not provide PostgreSQL row-level security. Do not rely on the legacy PostgreSQL RLS code to protect D1.
- Tenant-facing routes must derive the actor from a verified OIDC token and resolve active tenant membership server-side.
- Enforce tenant ownership in every query and mutation. A tenant ID from a URL, query parameter, header, local storage or JSON body is only a requested resource identifier, never authorization.
- Public guest QR access uses high-entropy table tokens; store only token hashes and validate the token against the active table/session.
- Keep tenant-owned child records linked to their tenant and parent; reject cross-tenant references.
- Add regression tests for owner, staff, guest and cross-tenant access whenever a route is added or changed.

## API and data handling

- Apply request-size limits and strict input validation at the Worker boundary.
- Return generic authentication/authorization errors; do not disclose token contents or secrets.
- Do not log bearer tokens, authorization headers, invitation secrets, payment credentials or full payment proofs.
- Administrative exports and restore operations require authorization and are audited.
- Restore must validate the backup, pass preflight, use the guarded target rules and must not overwrite a populated tenant target.
- Keep application release artifacts separate from tenant/customer data.

## Secrets and deployment

- Store private keys, administrator subject configuration and other credentials in Cloudflare Worker secrets or the provider's secret store.
- Never commit secrets or place private values in frontend environment variables.
- GitHub Actions must run build and test checks before deployment; the post-deployment smoke workflow checks `/api/health` and `/api/ready`.
- A successful health/readiness smoke test confirms service/schema availability only. It does not prove MFA, tenant isolation, offsite backups or disaster recovery.

## Backup and recovery

- D1 Time Travel currently provides 7-day recovery; it is not an independent offsite backup.
- Google Drive offsite integration is not configured because the connected Drive capability is unavailable under the account's administrator policy.
- Cloudflare R2 is intentionally not enabled because it requires a paid billing path and the project has a strict ₹0/month constraint.
- Tenant JSON/CSV export, validation, restore preflight and guarded restore foundations are available.
- Scheduled offsite backups and end-to-end restore drills remain mandatory launch gates.

## Current launch status

The Worker, Auth0 sign-in, production D1 schema, schema-aware readiness, tenant export/restore safeguards and live health/readiness smoke test have been verified. The platform remains **pre-launch** until all of the following are complete:

1. Enforce and verify administrator MFA/passkeys.
2. Configure a genuinely independent offsite backup destination without violating the zero-cost rule.
3. Run and document backup restoration drills.
4. Complete the Update Centre release approval/deployment/rollback workflow.
5. Onboard and verify the first real restaurant and owner; do not create dummy tenant records.

Do not represent the system as production-ready or approved for customer operations before these gates pass.
