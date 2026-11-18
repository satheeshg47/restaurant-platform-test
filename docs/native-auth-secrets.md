# Native authentication secrets and first administrator setup

The native authentication code is deployed and both required Worker secrets are configured on the production Worker. Secret values are not stored in this repository. Do not rotate or replace `AUTH_ENCRYPTION_KEY` after authenticator enrollment without a planned key migration and re-enrollment.

## If the secrets ever need to be provisioned again\n\nThe following steps are only for a new deployment or recovery where the Worker secrets are missing. They are already configured for the current production deployment.\n\n## 1. Generate two independent values

Generate a fresh 32-byte base64url value for each secret. The output is 43 characters and contains only letters, digits, underscore and hyphen.

On a terminal with OpenSSL:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Run the command twice and keep the two outputs separate.

## 2. Add the Worker secrets

In Cloudflare:

1. Open **Workers & Pages**.
2. Select **restaurant-platform-test**.
3. Open **Settings → Variables and Secrets**.
4. Add a secret named `AUTH_ENCRYPTION_KEY` and paste the first value.
5. Add a second secret named `AUTH_BOOTSTRAP_SECRET` and paste the second value.
6. Save the changes and ensure the latest Worker deployment uses these secrets.

Both must be **Secret** bindings, not plain-text variables.

**Important:** Keep `AUTH_ENCRYPTION_KEY` stable. It encrypts stored authenticator secrets. Changing it later without a planned re-enrollment would prevent existing authenticator secrets from being decrypted.

## 3. Create the first Super Admin

Open the production application:

https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev/

The sign-in screen will show **Set up the first Super Admin account** once both secrets are available. Enter the second value (`AUTH_BOOTSTRAP_SECRET`) in the one-time bootstrap field, choose a login ID and a password of at least 12 characters, and optionally add an email address.

The application will then:

- Create the first Super Admin account.
- Require Google Authenticator-compatible TOTP enrollment.
- Show one-time recovery codes. Save them somewhere private before continuing.

After the first administrator is created, the bootstrap endpoint cannot create another administrator. Remove `AUTH_BOOTSTRAP_SECRET` from Worker secrets after confirming the first Super Admin can sign in; keep `AUTH_ENCRYPTION_KEY` stable.

## 4. Owner and staff accounts

Platform administrators create owner invitations. Invitees create their individual owner login from the one-time invitation link and enroll TOTP on first sign-in.

Owners create individual staff login IDs and passwords in **Owner workspace → Staff access**. Staff sign in at `/staff` with the role assigned by the owner (manager, cook or waiter).
