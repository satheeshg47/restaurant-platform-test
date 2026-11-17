# Security implementation notes

## Identity and access boundary

- The initial platform owner is the only Super Admin. Do not create a default password or seed an account from a public email address.
- Authentication must be provided by a vetted OIDC identity provider with MFA/passkey enforcement.
- The API must validate issuer, audience, signature, expiry and nonce/state through the provider's supported SDK or a reviewed OIDC implementation.
- The allowlist of platform administrators is server-side configuration or a protected database record changed only through an audited owner recovery procedure.
- Never trust user, role, tenant, or email headers supplied directly by a browser. If a trusted identity proxy is used, accept its identity headers only from a verified private origin and validate its signed assertion.
- Sessions must use Secure, HttpOnly, SameSite cookies, CSRF protection for state-changing requests, rotation, expiry and revocation.
- Do not log bearer tokens, session cookies, passwords, payment secrets or full payment proofs.

## Tenant boundary

- Resolve tenant membership from the authenticated identity on the server.
- Do not authorize a tenant based on a request body, URL parameter or browser storage value alone.
- Use withTenantTransaction for every tenant-scoped database operation. It sets the PostgreSQL tenant context transaction-locally and rolls back failed operations.
- Runtime DB role must be separate from the migration owner and must not have BYPASSRLS.
- Keep tenant identifiers in composite foreign keys wherever a child row belongs to a tenant-owned parent.

## Operational safeguards

- Keep secrets out of Git and frontend bundles. Use the hosting provider's secret manager.
- Enforce rate limits, request size limits, origin policy and security headers at the API boundary.
- Require explicit review before release deployment. Verify package hashes and manifests; keep customer data and schema migrations separate from app code.
- Encrypt backups and test restoration before relying on them.
- Treat this repository as development scaffolding until identity, authorization, secrets, database connectivity, deployment and security tests are implemented.

## Current limitation

No login endpoint or identity provider is configured yet. The API health endpoint is public and reports the database as not_configured; it must not be exposed as a production admin API.
