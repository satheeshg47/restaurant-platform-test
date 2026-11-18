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

## Security note\n\nThe first bridge version does not apply client-side encryption to the SQL dump. Drive access is controlled by the Google account and folder permissions. Keep the backup folder unshared, restrict Apps Script project editors, and complete Google account MFA before using it for real customer data. Client-side encryption is a separate hardening item; do not describe the current bridge as end-to-end encrypted.\n\n## Phase 2 — verify archive and recovery

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

## Live schema inventory and conservative retention classes

The production D1 schema was inspected read-only on 2026-11-18. It has the 43 required application tables, plus D1's migration ledger and internal `_cf_KV` table. No restaurant tenants or owners have been onboarded. The following is a conservative classification, not authorization to delete anything.

| Class | Tables | Policy |
|---|---|---|
| Financial and legal history | `restaurant_orders`, `restaurant_order_items`, `restaurant_payments`, `restaurant_refunds`, `restaurant_invoices`, `restaurant_invoice_counters`, `restaurant_daily_summaries`, `subscription_payments`, `subscriptions` | Keep online until a separate accounting/legal retention policy and historical-reporting design are approved. A seven-day purge is not safe. |
| Audit, security and ownership history | `audit_events`, `platform_audit_events`, `restaurant_stock_events`, `owner_transfer_requests`, `platform_owner_invitations`, `tenant_memberships`, `platform_users` | Do not prune under the seven-day rule. These support accountability, inventory traceability, access and ownership history. |
| Tenant configuration and master data | `tenants`, `tenant_applications`, `restaurant_profiles`, `restaurant_settings`, `restaurant_tables`, `restaurant_staff`, `restaurant_staff_assignments`, `restaurant_menu_categories`, `restaurant_menu_items`, `restaurant_menu_variants`, `restaurant_addon_groups`, `restaurant_addons`, `restaurant_item_addon_groups`, `restaurant_tenant_controls` | Keep online. These are current operating configuration, not disposable event history. |
| Operational history requiring dependency review | `restaurant_table_sessions`, `restaurant_kitchen_batches`, `restaurant_batch_allocations`, `restaurant_service_requests`, `restaurant_reviews`, `restaurant_activity_events` | Candidate for archive-first treatment only after terminal-state checks, dependency review and restore testing. Do not delete open sessions, active kitchen work, unresolved service requests or records referenced by financial workflows. |
| Platform communications and release control | `communication_conversations`, `communication_messages`, `communication_participants`, `application_releases`, `application_deployments`, `applications`, `subscription_plans` | Keep until a separate support-history and platform-release retention policy is approved. |
| Schema metadata | `d1_migrations` | Never prune as part of tenant data retention. |

Some operational tables do not have a simple `created_at` field (for example, batch allocations, addon links, staff assignments and invoice counters). They cannot be handled safely by a generic date-based deletion job. Use the actual event timestamps and parent/child relationships for each table.

### Required cleanup gate

A future retention job must:
1. Run only after a completed Drive snapshot has been saved and verified for the same database and a known export bookmark.
2. Select only records older than the seven-day cutoff using the tenant's configured timezone and a canonical timestamp.
3. Exclude unresolved/in-progress records and all financial, legal, audit, master and identity records unless a separate approved policy explicitly covers them.
4. Preserve parent/child relationships and record counts; use a dry-run report before any delete.
5. Write a retention audit event and record the backup file ID, checksum, cutoff, table counts and deleted-row counts.
6. Stop immediately if the Drive backup is missing, stale, incomplete, or cannot be verified.

The daily Drive files are full point-in-time snapshots, not incremental deltas. Older snapshots must be retained if they are the only copy of records later removed from D1. Drive storage is finite; storage monitoring and an archive retrieval/restore workflow are required before production scale.

## Non-goals of Phase 1

- No D1 row deletion or pruning.
- No Google Drive public sharing.
- No R2, paid Cloudflare plan, or new paid storage.
- No assumption that the Drive backup is already configured.
- No use of GitHub as a customer-data archive.
