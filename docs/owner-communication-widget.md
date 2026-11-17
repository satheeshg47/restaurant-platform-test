# Owner Communication Widget

`src/OwnerCommunications.tsx` is a reusable React component for embedding the Platform Core owner inbox inside a customer-facing application.

## Embed

The host application must already have an authenticated owner session. Pass its short-lived OIDC access token directly from the in-memory auth session; do not write it to local storage, session storage, URLs, analytics, or logs.

```tsx
import OwnerCommunications from './OwnerCommunications'

export function AccountSupport({ authSession }) {
  return (
    <OwnerCommunications
      accessToken={authSession.accessToken}
      apiBaseUrl="/platform-api"
      title="Messages & support"
    />
  )
}
```

Configure `/platform-api` as a same-origin reverse proxy to the Platform Core API. This avoids adding broad cross-origin access to the API. The token must be an OIDC access token whose issuer and audience match the Platform Core OIDC configuration.

## Owner identity prerequisite

The verified token's `iss` and `sub` must map to a row in `platform_users` using `auth_provider` and `auth_subject`. That user must have an active `owner` row in `tenant_memberships`. Only then can the owner use the messaging endpoints. Provisioning and account linking are separate owner-onboarding work and are not yet exposed in the Super Admin UI.

## API contract

- `GET /owner/communications` — conversations, latest message, status and unread count for the signed-in owner.
- `POST /owner/communications` — create a private support conversation with `{ "subject": "...", "message": "..." }`.
- `GET /owner/communications/:id` — read messages for a conversation the owner participates in; marks it read.
- `POST /owner/communications/:id/messages` — reply with `{ "message": "..." }`.

Group chats and announcements created by the Super Admin appear in the owner's conversation list and can be replied to. Owners cannot add participants, change status, or read conversations they do not belong to.

## Current limitations

- The component is reusable but is not yet mounted in the separate Restaurant App or other customer apps; those app repositories and their auth-session integration must be connected.
- The OIDC provider, owner provisioning/linking flow, browser sign-in experience and live PostgreSQL service still need configuration.
- No attachments, push notifications, email delivery, message editing or deletion are included.
- Messages are limited to 5,000 characters; JSON request bodies are limited to 16 KiB.
