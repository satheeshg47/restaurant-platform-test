# Security implementation and launch gates

## Identity and administrator authorization

- The platform has one configured Super Admin identity.
- Browser sign-in uses Auth0 OpenID Connect Authorization Code flow with PKCE.
- The Worker validates signed JWTs against the configured issuer/JWKS and API audience, including expiry and allowed signing algorithms.
- Super Admin authorization is based on the exact configured issuer + stable subject pair. Email address alone is never an administrator identity.
- The Auth0 tenant and SPA/API configuration are provisioned and administrator sign-in has been verified.
- **MFA/passkey enforcement is not yet configured and verified.** This remains a mandatory launch gate; do not describe the platform as production-ready.

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
- A successful health/readiness smoke test confirms service/schema availability only. It does not prove MFA, tenant isolation, offsite backup confidentiality or disaster recovery.

## Backup and recovery

- D1 Time Travel currently provides 7-day recovery; it is not an independent offsite backup.
- A Google Apps Script → private Google Drive snapshot bridge is configured. A manual production snapshot and manifest were created successfully; a separate temporary D1 restore completed.
- Direct read-only comparison of production and restore-test confirmed the same 43 required application tables plus the D1 migration ledger, matching schema objects and all existing rows. No production data was overwritten or deleted.
- The daily Apps Script trigger is configured for approximately 02:20 Asia/Kolkata. Scheduled runs and Drive capacity must continue to be monitored.
- The SQL dump is not client-side encrypted in the current bridge. Keep the Drive folder private, restrict Apps Script project editors, secure the Google account with MFA and do not share the backup folder.
- The Apps Script download path has a 50 MB response limit. Implement and test chunked transfer before the SQL export approaches that limit.
- Cloudflare R2 remains intentionally disabled because it conflicts with the strict ₹0/month constraint.
- No automatic D1 cleanup or Drive backup deletion is enabled. Do not prune legal, financial, audit, identity, ownership or master-data records.

## Current launch status

The Worker, Auth0 sign-in, production D1 schema, schema-aware readiness, tenant export/restore safeguards, configured Drive snapshot bridge and one isolated restore drill have been verified. The platform remains **pre-launch** until all of the following are complete:

1. Enforce and verify administrator MFA/passkeys.
2. Monitor scheduled backup executions and confirm recurring snapshots continue to arrive and validate in Drive.
3. Complete backup confidentiality hardening and establish a tested recovery-time procedure.
4. Complete the Update Centre release approval/deployment/rollback workflow.
5. Onboard and verify the first real restaurant and owner; do not create dummy tenant records.

Do not represent the system as production-ready or approved for customer operations before these gates pass.
