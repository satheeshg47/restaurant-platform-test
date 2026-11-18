# Google Drive backup and seven-day hot-data plan

## Target architecture

- **Cloudflare D1 (hot operational store):** retain the most recent seven days of eligible high-volume transactional records for fast day-to-day screens and reports.
- **Google Drive (cold archive):** keep verified daily database snapshots and historical archives, separated by date and environment.
- **Cloudflare D1 Time Travel:** short-window recovery only; it is not the independent offsite archive.

## Phase 1 — daily offsite snapshot bridge

A standalone Google Apps Script runs under the user's Google account. It calls the Cloudflare D1 export REST API, polls the export job, downloads its temporary signed URL, compresses the SQL file, and writes it to a private Drive folder with a JSON manifest and SHA-256 checksum.

The script is in `google-apps-script/drive-backup/Code.gs`.

### Known platform behavior and constraints

- D1 export can block database requests until the export completes. Schedule it during the quietest window (currently configured around 02:20 Asia/Kolkata).
- The D1 export endpoint requires a Cloudflare API token with D1 Edit permission. Store it only in Apps Script Script Properties, never in source control or ChatGPT.
- The Apps Script UrlFetch response limit is 50 MB per call. The current script refuses larger SQL downloads. Implement chunked transfer before the database approaches this limit.
- Drive storage is finite. No automatic deletion is implemented.
- A backup is not considered recoverable until a separate isolated restore drill succeeds.

## Phase 2 — verify archive and recovery

Before any D1 cleanup:
1. Configure the Apps Script properties and authorize Drive access.
2. Run a manual production backup during a quiet period.
3. Verify the SQL file and manifest are present in Drive; compare recorded size and checksum.
4. Restore the SQL dump into a separate, isolated test D1 database (never production) and verify schema, migration ledger, foreign keys and representative tenant workflows.
5. Document the restore procedure and measured recovery time.

## Phase 3 — seven-day hot retention

Do not use a generic `DELETE WHERE created_at < ...` rule. Different tables have different date columns, parent/child relationships, accounting/legal retention requirements, and reporting dependencies.

Create a reviewed retention matrix for each eligible transactional table:
- canonical timestamp column and timezone semantics;
- parent/child deletion order or archive reference;
- whether invoices, payments, refunds, GST records, audit events, reviews, and customer requests must remain online;
- whether older reports can be rebuilt from archived snapshots;
- whether an owner can retrieve historical data from Drive without restoring the full database.

Only after that matrix and restore tests pass may cleanup be implemented. Cleanup must be gated on a successful, verified backup bookmark newer than the records being removed. A failed or missing backup must stop cleanup.

## Non-goals of Phase 1

- No D1 row deletion or pruning.
- No Google Drive public sharing.
- No R2, paid Cloudflare plan, or new paid storage.
- No assumption that the Drive backup is already configured.
- No use of GitHub as a customer-data archive.
