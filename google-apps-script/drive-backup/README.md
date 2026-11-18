# Google Drive daily D1 backup bridge

This Google Apps Script runs in Google's cloud and writes compressed D1 SQL exports to a private Drive folder. It is separate from the ChatGPT Drive connector.

## What it does

- Starts a Cloudflare D1 SQL export using the D1 REST API.
- Polls the export until complete (the D1 export API requires ongoing polling).
- Downloads the temporary signed SQL URL, gzip-compresses it, and saves it to Google Drive.
- Writes a JSON sidecar manifest with file ID, sizes and SHA-256 checksum.
- Runs daily at approximately 02:20 Asia/Kolkata after setup.
- Reschedules long-running export polling and retries temporary download failures.
- Never deletes old Drive backups or any D1 rows.

## One-time setup

1. Create a standalone Apps Script project at https://script.google.com/ using the Google account that owns the destination Drive.
2. Copy `Code.gs` into the project and save.
3. In Project Settings > Script Properties, add:
   - `CF_ACCOUNT_ID` = Cloudflare account ID
   - `CF_DATABASE_ID` = production D1 database ID
   - `CF_API_TOKEN` = a Cloudflare API token with D1 Edit permission, scoped to the required account/resource as narrowly as Cloudflare permits
4. Do not paste the API token into source code, chat, GitHub, or app settings. Script Properties are used so the token is not committed to the repository.
5. Run `testBackupConfiguration` once and approve the requested Google Drive and external-request permissions.
6. Run `setupDailyBackup` once to create the private Drive folder and daily trigger.
7. Run `runDailyBackup` manually once during a quiet period and verify the .sql.gz file and manifest in Drive.

## Important operational constraints

- The Cloudflare D1 export API requires D1 Edit permission and temporarily blocks D1 queries while an export is running. Run at the quietest time. Do not use this for daytime backups.
- Apps Script UrlFetch has a 50 MB per-call response limit. The script fails closed if the SQL dump exceeds that limit; no D1 data is deleted. A chunked upload design is required before reaching that size.
- Cloudflare's signed download URL is temporary. The script saves it only in Script Properties while retrying.
- Google Drive storage is finite and shared with Gmail/Photos. Monitor available Drive space. The script does not automatically delete backups.
- The checksum is calculated before upload and stored in the manifest and Drive file description; file-size equality is verified after upload. A separate restore drill is still required to prove recoverability.
- This is a full database snapshot each day, not an incremental archive. Retention/compaction and the seven-day D1 cleanup policy are deliberately not enabled in this first stage.

## Current safety boundary

**No data retention cleanup is performed.** D1 remains the system of record. Do not delete or archive old transactional rows until the backup has been configured, at least one backup has completed, a restore has been tested in an isolated database, and table-by-table retention rules have been reviewed for foreign-key and reporting dependencies.
