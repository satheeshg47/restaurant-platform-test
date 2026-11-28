# Native email/username and password authentication

## Decision

Replace the Auth0/OIDC dependency with first-party accounts stored in Cloudflare D1. Users sign in with their email address or individual username and password. No Auth0/OIDC provider, authenticator app, TOTP challenge, or email OTP is required for sign-in.

Staff accounts are individual accounts created and managed by their restaurant owner. Staff receive only the permissions assigned to their account. No shared staff credentials.

## Roles and access boundaries

- **Super Admin:** platform-wide control-plane access; email/username + password.
- **Restaurant owner:** access to the owner's tenant only; email/username + password; can create, disable, reset and permission staff in that tenant.
- **Staff:** individual email/username + password; tenant-scoped permissions assigned by the owner. Staff cannot manage owners or platform settings.
- **Viewer (where enabled):** read-only permissions within the assigned tenant.

The server derives the tenant from the authenticated account's active membership. A tenant ID supplied by the browser is never proof of access. Every protected API route must enforce role and tenant scope server-side.

## Credential and session controls

- Store password hashes only. Use a reviewed password-hashing implementation compatible with Cloudflare Workers; never store or log plaintext passwords.
- Store TOTP secrets encrypted using Web Crypto and a dedicated Worker secret named AUTH_ENCRYPTION_KEY. Never store TOTP secrets in plaintext or expose them after enrollment.
- Use one-time TOTP enrollment with QR provisioning URI, verify a first code before enabling MFA, and provide hashed one-time recovery codes.
- Use cryptographically random opaque session tokens. Store only their SHA-256 hashes in D1; issue them in HttpOnly, Secure (production), SameSite=Lax cookies with bounded expiry and server-side revocation.
- A correct password creates a server-side session; no second-factor challenge is part of the sign-in flow.
- Protect login and MFA endpoints with per-account and per-IP throttling, generic failure messages, bounded backoff, and audit events.
- Validate request origin and use CSRF protection for cookie-authenticated state-changing requests.
- Never place passwords, TOTP secrets, recovery codes, session tokens or bootstrap secrets in source control, URLs, logs or chat.

## Data model (additive D1 migration)

Add new tables without dropping or rewriting existing identity, tenant, audit, invitation or business data:

1. platform_user_credentials: one row per local account; normalized unique login ID, password hash, credential status, password-change timestamps, and optional encrypted TOTP secret plus MFA state.
2. platform_auth_sessions: hashed opaque session token, user ID, creation/expiry/last-seen timestamps, and revocation timestamp.
3. platform_auth_challenges: hashed short-lived pre-auth challenge, user ID, expiry and attempt count.
4. platform_auth_recovery_codes: hashed, single-use recovery codes.
5. platform_admin_accounts: explicit Super Admin grants, separate from restaurant tenant memberships.
6. platform_auth_rate_limits: bounded login/MFA attempt tracking.

Keep platform_users as the canonical user record and preserve its existing identity columns during transition. Map local accounts to that stable user ID so existing membership and audit foreign keys remain intact. New native identities must not be fabricated from email addresses.

## Account provisioning and recovery

- First Super Admin setup is a one-time bootstrap operation guarded by a secret configured directly in the Cloudflare Worker environment. It creates a unique username, optional email address and strong password. The bootstrap secret is never committed to Git.
- Owner accounts are provisioned by the platform administrator through an invitation/setup flow. The owner sets their own password and enrolls TOTP before the account becomes active.
- Owners create staff accounts within their own tenant and assign the minimum required permissions. Password resets invalidate existing sessions.
- Recovery codes are shown once at enrollment. A lost authenticator requires a recovery code or a separately audited administrator-assisted recovery procedure.

## Rollout sequence and safety gates

1. Keep the current OIDC login and its environment configuration intact while the native implementation is developed.
2. Add the D1 schema additively and test migrations against local and isolated preview databases.
3. Implement native password, TOTP, recovery, session, logout, bootstrap and owner/staff provisioning endpoints with unit tests.
4. Convert all protected Worker routes to consume the same server-verified native session identity and preserve tenant authorization. Remove OIDC-specific invitation acceptance only after a native invitation flow is tested.
5. Replace the frontend sign-in and callback flow with username/password and TOTP screens. Do not store session tokens in localStorage or React state; rely on HttpOnly cookies.
6. Verify Super Admin, owner and staff access; tenant isolation; permission denial; session expiry/revocation; CSRF; rate limits; recovery; and invitation flows on preview.
7. Back up production D1 and verify restore before the production cutover. Deploy the compatible backend and schema before switching the frontend. Retain a documented rollback path.
8. Only after production native sign-in is verified, remove Auth0 variables, OIDC code, dependencies and provider-side configuration.

## Explicit non-goals

- No Google Sign-In / OAuth dependency.
- No SMS, email OTP provider or paid MFA service.
- No Auth0 subscription or paid Cloudflare feature.
- No plaintext passwords, shared staff accounts, client-authoritative tenant IDs, or destructive migration.
- Do not claim the system is secured by MFA until TOTP enrollment and server-side enforcement are implemented and tested.

## Implementation status — 2026-11-19

The native authentication foundation is implemented and deployed to the production Worker:

- Native bootstrap, password login, TOTP enrollment/verification, recovery-code use, cookie sessions and logout endpoints are implemented.
- The additive D1 schema is applied through `0009_totp_replay_protection.sql` in production and preview.
- TOTP replay protection records the last accepted time-step; MFA verification is rate-limited by account and IP.
- Native owner invitation acceptance and owner-managed individual staff account provisioning are implemented.
- The Super Admin, owner and staff sign-in/workspace interfaces are deployed.
- The Cloudflare Worker secret `AUTH_ENCRYPTION_KEY` remains configured and stable. The one-time `AUTH_BOOTSTRAP_SECRET` was removed after the first Super Admin was provisioned and successfully signed in. Secret values are intentionally not stored in this repository.
- Production D1 confirms one active Super Admin grant, active credentials, TOTP enabled with an encrypted authenticator secret, and an active authenticated session. No restaurant tenant has been created yet.

**Rollout is not complete:** the first Super Admin setup is complete, but live owner invitation/acceptance, owner MFA, staff permission boundaries, tenant isolation, and a fresh current-schema Drive restore remain to be verified. The existing OIDC path remains available as a compatibility route until the native owner/staff flows and rollback plan are verified.

## Sign-in simplification — 2026-11-28

- Native login accepts either the normalized username or the account email address, plus the account password.
- Super Admin, owner and staff use the same simple credential form. No Auth0/OIDC redirect or authenticator challenge is presented.
- Existing secure HTTP-only session cookies, password hashing, rate limiting, account-status checks, and server-enforced tenant/role boundaries remain in place.
- Legacy TOTP schema and verification code are retained temporarily for compatibility; they are not required by the login path. Do not remove the old columns or stored encrypted values as part of this UI/login change.
