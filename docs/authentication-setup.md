# Browser sign-in setup

Platform Core uses OpenID Connect (OIDC) Authorization Code flow with PKCE. The browser is a public client: **do not put a client secret in frontend variables**.

## Frontend variables

Set these in the frontend hosting environment and rebuild the frontend:

- `VITE_OIDC_ISSUER`: exact issuer URL from the provider's OIDC discovery document.
- `VITE_OIDC_CLIENT_ID`: public web application client ID.
- `VITE_OIDC_API_AUDIENCE`: API identifier requested through Auth0's OAuth `audience` parameter. It must match the audience configured in the API.
- `VITE_OIDC_REDIRECT_URI`: exact callback URL, ending in `/auth/callback`. It must use HTTPS in production and share the frontend origin.
- `VITE_API_BASE_URL`: API base path, normally `/api`.

Register the exact callback URL in the identity provider's allowed redirect URI list. In Auth0, create a custom API using the same identifier as the audience and configure it to issue signed JWT access tokens. The provider must support a public client using authorization code + PKCE, return an ID token, and support the Auth0 `audience` parameter for custom APIs.

For local development, the callback may use `http://localhost:<port>/auth/callback`.

## API variables

Set these in the API hosting environment:

- `OIDC_ISSUER`: same issuer as `VITE_OIDC_ISSUER`.
- `OIDC_AUDIENCE`: API resource identifier; it must exactly match `VITE_OIDC_API_AUDIENCE` and the JWT access-token audience.
- `OIDC_CLIENT_ID`: public browser client ID; the API uses this separate audience to verify ID tokens during owner invitation acceptance.
- `OIDC_JWKS_URL`: provider's HTTPS JSON Web Key Set URL.
- `PLATFORM_ADMIN_SUBJECT`: stable OIDC `sub` claim for the one permitted Super Admin.
- `DATABASE_URL`: PostgreSQL connection string.

The Super Admin is identified by the verified issuer + subject pair, not by email. Owner identities use the same verified issuer + subject identity and must have an active owner membership for the selected restaurant.

## Security behaviour

- Authorization Code + PKCE uses a random state, nonce and verifier for each login.
- The browser validates the ID token's cryptographic signature using the provider's discovery JWKS, and checks issuer, client audience, nonce, expiry and subject.
- The browser sends the separate OAuth bearer access token to the API. The API independently verifies its JWT signature, issuer, API audience and subject using the configured JWKS. An ID token must never be used as an API credential.
- During invitation acceptance only, the browser also sends the ID token in a dedicated `X-OIDC-ID-Token` header. The API independently verifies that token against `OIDC_CLIENT_ID` and requires its issuer + subject to match the access-token identity before trusting its verified-email claim.
- The access token is held in application memory only. It is not written to localStorage, cookies or a persistent browser database. Refreshing the page requires signing in again.
- The frontend never receives an OIDC client secret.
- The owner support inbox is available at `/owner`; the platform control plane is at `/`. Super Admins can share a one-time owner invitation link from the Owners page. The invited person opens `/owner/invitations/accept#token=...`, signs in with the invited verified email address, and accepts the invitation. The token is carried in the URL fragment, not sent in the initial page request.
- A successful browser login does not replace API/database setup. Protected API calls remain unavailable until the matching API variables and PostgreSQL are configured.

Do not publish ID tokens, access tokens, client secrets or database credentials in source control, screenshots or chat messages.
