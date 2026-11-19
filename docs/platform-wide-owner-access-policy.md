# Platform-wide owner access, recovery and transfer policy

Status: approved product requirements; implementation and production rollout are pending.

## Scope

These rules belong to Platform Core identity and tenant administration, not to an individual application. Every application using the shared platform must inherit the same account, recovery and ownership lifecycle. Application-specific data, permissions and subscription rules remain application-scoped.

## Owner sign-in

- Owners sign in with their registered email address and password.
- Do not require a separate username or login ID in the Owner experience.
- Do not require an authenticator app, QR scan, TOTP code or 2FA enrollment during Owner registration or normal sign-in.
- Email ownership must be established by accepting a single-use invitation delivered to the invited email address. Merely typing an email address is not verification.
- A single Platform Core identity may hold memberships in more than one application or tenant. Do not create duplicate identities just because the person uses another application.
- Super Admin continues to require TOTP MFA. Staff use individual accounts and owner-assigned permissions; no shared staff credentials.

## Owner password recovery

- The Owner can request a reset using the registered email address.
- The response must not reveal whether the email address exists.
- Send a cryptographically random, single-use reset link to the registered address. Store only a hash of the token.
- Reset links expire after 15 minutes, are rate-limited, and are invalidated after use.
- On successful reset, update the password hash, update the password-change timestamp, revoke all existing sessions for that user, and send a password-change notification.
- Super Admin may initiate the same reset flow or require a reset at next sign-in. Super Admin must never view, retrieve, choose, or directly set an Owner password.
- Never send a password in email.

## Ownership transfer

Provide a dedicated Transfer Ownership workflow in the Super Admin control plane. Do not implement transfer as a password reset, email edit, or ordinary membership-role edit.

### Standard transfer

1. Super Admin selects the tenant and starts a transfer request.
2. Super Admin enters the incoming Owner's email address and records the reason/reference for the transfer.
3. The incoming Owner receives a single-use invitation addressed to that email and accepts it by setting or using their own password.
4. The transfer is committed atomically only after the new Owner has accepted and all preconditions are rechecked.
5. The incoming Owner becomes the sole active primary Owner for that tenant.
6. The outgoing Owner's owner membership is deactivated and all their active sessions are revoked. If that identity owns other tenants/apps, the security policy should explicitly decide whether to revoke all sessions (default: revoke all and require sign-in again).
7. Notify both parties where deliverable and write an immutable audit event containing actor, tenant, old owner, new owner, timestamp and transfer reason.

### Admin-controlled transfer

If the outgoing Owner is unavailable, Super Admin may initiate an admin-controlled transfer only after recording the verification basis and reason. This action must be separately labelled, require an explicit confirmation step in the UI, and be fully audited. It must not silently impersonate the outgoing Owner.

### Data and access preservation

- Keep tenant business data, orders, customers, menus, invoices, reports, subscription history and audit history attached to the tenant.
- Do not copy business data to a new tenant and do not delete the old Owner's historical audit identity.
- Retain staff accounts, but require the new Owner to review staff access and permissions.
- Ensure only one active primary Owner exists per tenant unless a future multi-owner feature is explicitly designed.
- Preserve application-specific memberships and permissions while changing the tenant's primary owner.
- Make transfer idempotent and protect against concurrent transfers, expired invitations, suspended tenants and stale Owner records.

## Shared implementation requirements

- Implement the account and recovery services once in Platform Core so all applications use the same APIs and authorization rules.
- Keep password hashes, reset-token hashes and invitation-token hashes only; never log secrets or place them in URLs other than short-lived one-time token links.
- Use generic API responses, rate limits, origin/CSRF checks, audit events and secure HttpOnly sessions.
- Do not trust tenant IDs supplied by the browser as proof of authorization.
- Do not weaken Super Admin MFA when removing Owner MFA.
- Do not enable production email-based flows until a real sender is configured and end-to-end delivery, token expiry, replay protection and abuse controls are tested.

## Implementation blockers and rollout gates

- A transactional email sender is required for invitations, password-reset links and security notifications. An authenticated Google Apps Script MailApp bridge has been added to the existing Drive-backup script, but it is not live until the user deploys the Web App and configures matching Worker secrets. MailApp quotas and sender identity must be verified.
- Additive D1 migration `0010_account_recovery_and_owner_transfer.sql` adds password-reset tokens, transfer invitations and ownership history. It must be applied to an isolated database and backed up/restored before production application.
- Implement and test Owner email login, invitation acceptance, password reset, Super Admin reset initiation, ownership transfer and session revocation in an isolated environment first.
- Test cross-application identity reuse, tenant isolation, staff permissions, suspended-tenant behavior, concurrent transfer attempts, token replay and rollback.
- Back up production D1 and verify a current-schema restore before production schema writes.
- Do not create or transfer a production Owner account until the intended recipient email has been explicitly confirmed.

## Current code status (2026-11-19)

As of 2026-11-19, the feature branch `feat/platform-wide-owner-access` removes mandatory Owner TOTP, changes Owner sign-in to registered email + password, removes the separate login-ID step from Owner invitation acceptance, and adds the account-recovery and ownership-transfer endpoints and screens. Automated API/build validation is still running. The Google Apps Script email bridge code is present but requires a Web App deployment and matching Worker secrets. No production migration or deployment has been performed. The requirements above are not a statement that these capabilities are live.
