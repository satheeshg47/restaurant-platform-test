# Platform Core email bridge setup

The existing Google Apps Script backup project now also contains a small authenticated transactional-email endpoint. It uses Apps Script MailApp (Gmail quota) and does not alter the Drive backup trigger, Cloudflare backup properties or stored backups.

## One-time Google Apps Script setup

1. Open the same Apps Script project currently running the D1 Drive backup.
2. Update its `Code.gs` with the current `google-apps-script/drive-backup/Code.gs` from this repository. Keep the existing backup script properties unchanged.
3. In **Project Settings → Script Properties**, add `EMAIL_BRIDGE_SECRET` with a new, long random secret (at least 32 random bytes). Do not reuse the Cloudflare API token or the D1 backup credentials.
4. Run `authorizeEmailBridge` once from the Apps Script editor and approve the requested MailApp permission. This checks the available daily recipient quota without sending a message.
5. Click **Deploy → New deployment → Web app**.
6. Set **Execute as** to your Google account. Set access to **Anyone** so the Cloudflare Worker can reach the endpoint; the endpoint rejects requests unless the JSON body contains the separate secret. Do not share the secret.
7. Deploy and copy the Web App URL ending in `/exec`. If updating an existing deployment, create a new version and edit the deployment to use it.
8. Keep the Apps Script project and Drive backup folder private. Only trusted editors should have access.

## Cloudflare Worker configuration

Set these as Worker secrets/variables on `restaurant-platform-test`:

- `EMAIL_BRIDGE_URL` — the Apps Script Web App `/exec` URL (not the editor URL).
- `EMAIL_BRIDGE_SECRET` — exactly the same random secret stored in Apps Script Script Properties.
- `APP_PUBLIC_URL` — optional public application origin. If omitted, reset/invitation links use the request origin.

Do not put the secret in Git, frontend variables, a URL query string, or chat. Use a secret binding, not a plain-text variable. Email delivery is not active until both Worker values and the Apps Script deployment are configured.

## Supported transactional messages

- Owner invitations (48-hour single-use link).
- Owner password reset (15-minute single-use link).
- Password-changed notification.
- Ownership transfer invitation (7-day single-use link).
- Ownership transfer completion notices.

The bridge accepts one recipient per request, limits message sizes, checks the shared secret, and does not log message bodies or secrets. MailApp sending remains subject to the Google account's Apps Script email quotas and Gmail sending limits. A successful bridge response means Apps Script accepted the send operation, not that the recipient's provider placed it in the inbox; monitor delivery and spam folders.

## Privacy and operations

The Web App endpoint is publicly reachable by design; security depends on the high-entropy secret. Rotate both copies together if it is exposed. Keep the script owner's Google account protected with MFA. Do not grant script editors broad access. Do not use this bridge for bulk marketing or unrelated mail.
