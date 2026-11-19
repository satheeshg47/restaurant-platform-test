# Security implementation and launch gates

## Identity and administrator authorization

- Native username/password authentication is implemented for Super Admin, restaurant owners and individually assigned staff accounts.
- Passwords are stored as PBKDF2-SHA256 hashes; plaintext passwords are never stored.
- Super Admin accounts require RFC 6238 TOTP using authenticator apps compatible with Google Authenticator. Owners sign in with email and password without mandatory authenticator setup. Recovery codes apply to Super Admin MFA and are random, single-use and stored as hashes.
- TOTP secrets are encrypted with the stable Cloudflare Worker secret `AUTH_ENCRYPTION_KEY`. Accepted TOTP counters are recorded so the same authenticator time-step cannot be replayed across challenges.
- Login and MFA attempts are rate-limited. Native sessions use opaque random tokens; only token hashes are stored in D1, and the browser receives an HttpOnly, Secure, SameSite cookie.
- `AUTH_ENCRYPTION_KEY` remains configured as a Cloudflare Worker secret and must remain stable because it encrypts enrolled authenticator secrets. The one-time `AUTH_BOOTSTRAP_SECRET` was removed after first-admin provisioning and successful native sign-in. Never place secret values in Git, browser bundles, screenshots or logs.
- The legacy Auth0 OIDC Authorization Code + PKCE path remains as a compatibility route during staged migration. Do not remove it until native Super Admin, owner and staff flows have passed end-to-end production verification.
- The first native Super Admin is provisioned and active. Production D1 confirms TOTP is enabled, the encrypted authenticator secret is present, and an authenticated session exists. No restaurant tenants have been created yet; the platform remains pre-launch.

## Tenant authorization boundary

- Cloudflare D1 uses SQLite semantics and does not provide PostgreSQL row-level security. Do not rely on legacy PostgreSQL RLS code to protect D1.
- Tenant-facing routes derive the actor from a native session or a verified OIDC identity and resolve active tenant membership server-side.
- Enforce tenant ownership in every query and mutation. A tenant ID from a URL, query parameter, header, local storage or JSON body is only a requested resource identifier, never authorization.
- Owner management routes require an active owner/admin membership. Staff routes derive staff role from the active tenant membership and restaurant staff record; client-supplied roles are never trusted.
- Public guest QR access uses high-entropy table tokens; store only token hashes and validate the token against the active table/session.
- Keep tenant-owned child records linked to their tenant and parent; reject cross-tenant references.
- Regression tests cover owner invitation acceptance, individual staff account creation, role assignment, suspension/reactivation, native login, guest QR ordering and tenant-scoped operations. Add owner, staff, guest and cross-tenant tests whenever a route is added or changed.

## API and data handling

- Apply request-size limits and strict input validation at the Worker boundary.
- Return generic authentication/authorization errors; do not disclose token contents or secrets.
- Do not log bearer tokens, authorization headers, invitation secrets, payment credentials or full payment proofs.
- Cookie-authenticated state-changing requests validate the request origin when an Origin header is present.
- Administrative exports and restore operations require authorization and are audited.
- Restore must validate the backup, pass preflight, use the guarded target rules and must not overwrite a populated tenant target.
- Keep application release artifacts separate from tenant/customer data.

## Secrets and deployment

- Store private keys, administrator subject configuration and other credentials in Cloudflare Worker secrets or the provider's secret store.
- Never commit secrets or place private values in frontend environment variables.
- GitHub Actions run tests, migrations, frontend build and Worker bundle validation. The post-deployment smoke workflow checks health, D1 readiness and native authentication bootstrap readiness without printing secret values.
- A successful health/readiness smoke test confirms service/schema availability only. It does not prove full MFA enrollment, tenant isolation, offsite backup confidentiality or disaster recovery.

## Backup and recovery

- D1 Time Travel provides short-window recovery; it is not an independent offsite backup.
- The Google Apps Script → private Google Drive snapshot bridge is configured with a daily trigger around 02:20 Asia/Kolkata. The bridge does not client-side encrypt SQL dumps and has a 50 MB Apps Script download limit.
- One isolated restore drill passed before native-auth migrations 0008 and 0009 were applied. That historical drill does **not** verify recovery of the current 0009 schema. A fresh production backup and isolated restore must be completed against the current schema before customer onboarding.
- Keep the Drive folder private, restrict Apps Script project editors, secure the Google account with MFA and do not share the backup folder.
- Cloudflare R2 remains intentionally disabled because it conflicts with the strict ₹0/month constraint.
- No automatic D1 cleanup or Drive backup deletion is enabled. Do not prune legal, financial, audit, identity, ownership or master-data records.

## Current launch status

The production Worker and preview Worker build are deployed. Migrations through `0009_totp_replay_protection.sql` are applied to both production and preview D1. The schema has 50 required application/authentication tables (53 total tables including platform metadata). Production now has one active native Super Admin account, one active platform-admin grant, and an active authenticated session; no restaurant tenants have been created yet. The foreign-key check returned zero violations. The native authentication code, owner/staff workspaces and automated tests are in place.

The platform remains **pre-launch** until all of the following are complete:

1. Confirm the Super Admin's one-time recovery codes are saved securely; the account, TOTP enrollment and native login are verified, and the bootstrap secret has been removed.
2. Verify a real owner invitation and acceptance in the live Worker, then confirm owner email/password sign-in without TOTP enrollment.
3. Create a controlled test tenant and verify owner/staff permissions, suspension, session revocation and tenant isolation end-to-end; do not create dummy production customers.
4. Run a fresh Google Drive backup and isolated restore against migration 0009; verify checksum, schema, row counts and foreign keys.
5. Monitor scheduled backup executions, Drive capacity and measured recovery time.
6. Complete the Update Centre package storage, approval, deployment, health-check and rollback workflow. It remains deliberately locked; no package can be deployed from the current screen.
7. Remove the OIDC compatibility path only after native owner/staff flows are verified and a rollback plan is documented.
8. Onboard the first real restaurant only after the gates above pass.

Do not represent the system as production-ready or approved for customer operations before these gates pass.
