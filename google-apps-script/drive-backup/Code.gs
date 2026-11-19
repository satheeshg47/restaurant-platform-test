/**
 * Restaurant Platform — daily Cloudflare D1 to Google Drive backup.
 *
 * Configure Script Properties before running:
 *   CF_ACCOUNT_ID
 *   CF_DATABASE_ID
 *   CF_API_TOKEN       (D1 Edit permission; keep only in Script Properties)
 *   DRIVE_FOLDER_ID    (optional; created automatically when omitted)
 *
 * The export endpoint temporarily blocks D1 queries while an export runs.
 * Schedule this during the quietest period. This script NEVER deletes D1 rows
 * and NEVER deletes older Drive backups.
 */

const BACKUP_CONFIG = {
  apiBase: 'https://api.cloudflare.com/client/v4',
  folderName: 'Restaurant Platform Backups',
  dailyHour: 2,
  dailyMinute: 20,
  timezone: 'Asia/Kolkata',
  pollEveryMs: 5000,
  maxRunMs: 4 * 60 * 1000,
  maxDownloadBytes: 50 * 1024 * 1024
};

function setupDailyBackup() {
  const cfg = getConfig_();
  const folder = getBackupFolder_();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  removeTriggers_('runDailyBackup');
  ScriptApp.newTrigger('runDailyBackup')
    .timeBased()
    .everyDays(1)
    .atHour(BACKUP_CONFIG.dailyHour)
    .nearMinute(BACKUP_CONFIG.dailyMinute)
    .inTimezone(BACKUP_CONFIG.timezone)
    .create();
  Logger.log('Daily backup trigger configured. Folder: ' + folder.getName());
}

function runDailyBackup() {
  runWithLock_(function () {
    getConfig_();
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('PENDING_SIGNED_URL')) {
      deliverPendingBackup_();
      return;
    }
    const bookmark = props.getProperty('BACKUP_BOOKMARK');
    if (bookmark) {
      pollExport_(bookmark);
      return;
    }
    const response = cloudflarePost_({ output_format: 'polling' });
    processExportResponse_(response);
    const activeBookmark = props.getProperty('BACKUP_BOOKMARK');
    if (activeBookmark) pollExport_(activeBookmark);
  });
}

function continueDailyBackup() {
  runWithLock_(function () {
    getConfig_();
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('PENDING_SIGNED_URL')) {
      deliverPendingBackup_();
      return;
    }
    const bookmark = props.getProperty('BACKUP_BOOKMARK');
    if (!bookmark) return;
    pollExport_(bookmark);
  });
}

function testBackupConfiguration() {
  const cfg = getConfig_();
  const response = UrlFetchApp.fetch(
    BACKUP_CONFIG.apiBase + '/accounts/' + encodeURIComponent(cfg.accountId) +
      '/d1/database/' + encodeURIComponent(cfg.databaseId),
    { method: 'get', headers: { Authorization: 'Bearer ' + cfg.apiToken }, muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) {
    throw new Error('Cloudflare D1 configuration check failed (HTTP ' + response.getResponseCode() + '). Check token permissions and database identifiers.');
  }
  const payload = JSON.parse(response.getContentText());
  if (!payload.success || !payload.result || payload.result.uuid !== cfg.databaseId) {
    throw new Error('Cloudflare returned an unexpected database identity.');
  }
  const folder = getBackupFolder_();
  Logger.log('Configuration passed. Target database: ' + payload.result.name + '; Drive folder: ' + folder.getName());
}

function pollExport_(bookmark) {
  const started = Date.now();
  let current = bookmark;
  while (Date.now() - started < BACKUP_CONFIG.maxRunMs) {
    Utilities.sleep(BACKUP_CONFIG.pollEveryMs);
    const response = cloudflarePost_({ output_format: 'polling', current_bookmark: current });
    const result = response.result || {};
    if (result.at_bookmark) current = result.at_bookmark;
    processExportResponse_(response);
    if (!PropertiesService.getScriptProperties().getProperty('BACKUP_BOOKMARK')) return;
  }
  PropertiesService.getScriptProperties().setProperty('BACKUP_BOOKMARK', current);
  scheduleContinuation_();
  Logger.log('Export remains active; a continuation trigger has been scheduled.');
}

function processExportResponse_(payload) {
  if (!payload || payload.success !== true || !payload.result) {
    throw new Error('Cloudflare D1 export request failed. Check Apps Script execution logs.');
  }
  const result = payload.result;
  if (result.status === 'active') {
    if (!result.at_bookmark) throw new Error('D1 export is active but no polling bookmark was returned.');
    PropertiesService.getScriptProperties().setProperty('BACKUP_BOOKMARK', result.at_bookmark);
    return;
  }
  if (result.status === 'error') {
    PropertiesService.getScriptProperties().deleteProperty('BACKUP_BOOKMARK');
    throw new Error('Cloudflare D1 export failed: ' + String(result.error || 'unknown error'));
  }
  if (result.status === 'complete' && result.result && result.result.signed_url) {
    const props = PropertiesService.getScriptProperties();
    props.setProperties({
      PENDING_SIGNED_URL: result.result.signed_url,
      PENDING_FILENAME: result.result.filename || ('restaurant-platform-' + timestamp_() + '.sql'),
      PENDING_EXPIRES_AT: String(Date.now() + 50 * 60 * 1000)
    });
    props.deleteProperty('BACKUP_BOOKMARK');
    deliverPendingBackup_();
    return;
  }
  throw new Error('Cloudflare returned an unrecognized D1 export state.');
}

function deliverPendingBackup_() {
  const props = PropertiesService.getScriptProperties();
  const signedUrl = props.getProperty('PENDING_SIGNED_URL');
  const sourceName = props.getProperty('PENDING_FILENAME') || ('restaurant-platform-' + timestamp_() + '.sql');
  const expiresAt = Number(props.getProperty('PENDING_EXPIRES_AT') || 0);
  if (!signedUrl) return;
  if (expiresAt && Date.now() > expiresAt) {
    clearPending_();
    throw new Error('The temporary D1 download link expired. No backup was recorded; run a fresh backup.');
  }

  const folder = getBackupFolder_();
  const stamp = timestamp_();
  const outputName = props.getProperty('PENDING_DRIVE_NAME') || ('restaurant-platform-' + stamp + '.sql.gz');
  props.setProperty('PENDING_DRIVE_NAME', outputName);
  const existing = folder.getFilesByName(outputName);
  if (existing.hasNext()) {
    const file = existing.next();
    const manifestName = outputName + '.manifest.json';
    const manifests = folder.getFilesByName(manifestName);
    if (!manifests.hasNext()) {
      const description = file.getDescription() || '';
      const match = description.match(/SHA-256=([a-f0-9]{64})/);
      const manifest = {
        format: 'restaurant-platform-d1-drive-backup', version: 1,
        created_at: new Date().toISOString(), cloudflare_database_id: getConfig_().databaseId,
        source_filename: sourceName, drive_filename: outputName, drive_file_id: file.getId(),
        compressed_bytes: file.getSize(), sha256_compressed: match ? match[1] : null,
        verification: 'Existing Drive file size confirmed; checksum is recorded in the file description when available',
        retention: 'No automatic deletion of backups or D1 rows'
      };
      folder.createFile(manifestName, JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT);
    }
    props.setProperties({ LAST_SUCCESS_AT: new Date().toISOString(), LAST_FILE_ID: file.getId(), LAST_FILE_NAME: file.getName() });
    clearPending_();
    removeTriggers_('continueDailyBackup');
    return;
  }

  const download = UrlFetchApp.fetch(signedUrl, { method: 'get', muteHttpExceptions: true, followRedirects: true });
  if (download.getResponseCode() !== 200) {
    scheduleContinuation_();
    throw new Error('D1 backup download failed (HTTP ' + download.getResponseCode() + '). A retry has been scheduled.');
  }
  const sqlBlob = download.getBlob().setName(sourceName);
  const sqlBytes = sqlBlob.getBytes();
  if (!sqlBytes.length) throw new Error('The D1 export was empty; refusing to save it as a backup.');
  if (sqlBytes.length > BACKUP_CONFIG.maxDownloadBytes) {
    throw new Error('The SQL export exceeds the 50 MB Apps Script UrlFetch per-call safety limit. No D1 data was deleted. A chunked Drive upload path is required before this database grows further.');
  }

  const compressed = Utilities.gzip(sqlBlob, outputName);
  const compressedBytes = compressed.getBytes();
  const sha256 = digestHex_(compressedBytes);
  const file = folder.createFile(compressed.setName(outputName));
  file.setDescription('Verified upload size=' + compressedBytes.length + ' bytes; SHA-256=' + sha256 + '; source=' + sourceName);
  if (file.getSize() !== compressedBytes.length) {
    throw new Error('Drive file size verification failed. The backup is not marked successful.');
  }

  const manifest = {
    format: 'restaurant-platform-d1-drive-backup',
    version: 1,
    created_at: new Date().toISOString(),
    cloudflare_database_id: getConfig_().databaseId,
    source_filename: sourceName,
    drive_filename: outputName,
    drive_file_id: file.getId(),
    compressed_bytes: compressedBytes.length,
    source_sql_bytes: sqlBytes.length,
    sha256_compressed: sha256,
    verification: 'Drive file size matches uploaded compressed payload; checksum recorded before upload',
    retention: 'No automatic deletion of backups or D1 rows'
  };
  const manifestName = outputName + '.manifest.json';
  folder.createFile(manifestName, JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT);

  props.setProperties({
    LAST_SUCCESS_AT: new Date().toISOString(),
    LAST_FILE_ID: file.getId(),
    LAST_FILE_NAME: outputName,
    LAST_SHA256: sha256,
    LAST_COMPRESSED_BYTES: String(compressedBytes.length)
  });
  clearPending_();
  removeTriggers_('continueDailyBackup');
  Logger.log('D1 backup saved to Drive: ' + outputName + ' (' + compressedBytes.length + ' bytes).');
}

function cloudflarePost_(body) {
  const cfg = getConfig_();
  const url = BACKUP_CONFIG.apiBase + '/accounts/' + encodeURIComponent(cfg.accountId) +
    '/d1/database/' + encodeURIComponent(cfg.databaseId) + '/export';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.apiToken },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  let payload;
  try { payload = JSON.parse(response.getContentText()); }
  catch (error) { throw new Error('Cloudflare export API returned invalid JSON (HTTP ' + status + ').'); }
  if (status !== 200 && status !== 202) {
    const message = payload.errors && payload.errors.length ? payload.errors.map(function (item) { return item.message; }).join('; ') : 'HTTP ' + status;
    throw new Error('Cloudflare export API rejected the request: ' + message);
  }
  return payload;
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const config = {
    accountId: props.getProperty('CF_ACCOUNT_ID'),
    databaseId: props.getProperty('CF_DATABASE_ID'),
    apiToken: props.getProperty('CF_API_TOKEN')
  };
  if (!config.accountId || !config.databaseId || !config.apiToken) {
    throw new Error('Set CF_ACCOUNT_ID, CF_DATABASE_ID and CF_API_TOKEN in Apps Script Project Settings > Script Properties.');
  }
  return config;
}

function getBackupFolder_() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('DRIVE_FOLDER_ID');
  if (folderId) return DriveApp.getFolderById(folderId);
  const folders = DriveApp.getRootFolder().getFoldersByName(BACKUP_CONFIG.folderName);
  const folder = folders.hasNext() ? folders.next() : DriveApp.getRootFolder().createFolder(BACKUP_CONFIG.folderName);
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function runWithLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another backup execution is already running; this invocation will exit.');
    return;
  }
  try { callback(); }
  finally { lock.releaseLock(); }
}

function scheduleContinuation_() {
  removeTriggers_('continueDailyBackup');
  ScriptApp.newTrigger('continueDailyBackup').timeBased().after(60 * 1000).create();
}

function removeTriggers_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(trigger);
  });
}

function clearPending_() {
  const props = PropertiesService.getScriptProperties();
  ['PENDING_SIGNED_URL', 'PENDING_FILENAME', 'PENDING_EXPIRES_AT', 'PENDING_DRIVE_NAME'].forEach(function (key) { props.deleteProperty(key); });
}

function timestamp_() {
  return Utilities.formatDate(new Date(), BACKUP_CONFIG.timezone, 'yyyy-MM-dd_HHmmss');
}

function digestHex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (value) { return (value < 0 ? value + 256 : value).toString(16).padStart(2, '0'); })
    .join('');
}


/**
 * Transactional email bridge for Platform Core.
 *
 * Deploy this same Apps Script project as a Web App (execute as the owner).
 * Add EMAIL_BRIDGE_SECRET to Script Properties. The Worker sends the secret
 * in the JSON body; it is never placed in a URL or logged.
 */
function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
    if (!raw || raw.length > 24000) return emailJson_({ ok: false, error: 'invalid_request' });
    const body = JSON.parse(raw);
    const configuredSecret = PropertiesService.getScriptProperties().getProperty('EMAIL_BRIDGE_SECRET') || '';
    if (!configuredSecret || !constantTimeEqual_(String(body.secret || ''), configuredSecret)) {
      return emailJson_({ ok: false, error: 'unauthorized' });
    }
    const to = String(body.to || '').trim().toLowerCase();
    const subject = String(body.subject || '').trim();
    const textBody = String(body.text || '');
    const htmlBody = String(body.html || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 320 ||
        !subject || subject.length > 180 || !textBody || textBody.length > 12000 ||
        htmlBody.length > 16000) {
      return emailJson_({ ok: false, error: 'invalid_message' });
    }
    MailApp.sendEmail({
      to: to,
      subject: subject,
      body: textBody,
      htmlBody: htmlBody || undefined,
      name: 'Platform Core'
    });
    return emailJson_({ ok: true });
  } catch (err) {
    // Never log message contents, tokens, recipients, or secrets.
    console.error('platform_email_delivery_failed: ' + (err && err.name ? err.name : 'Error'));
    return emailJson_({ ok: false, error: 'delivery_failed' });
  }
}

function emailJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function constantTimeEqual_(left, right) {
  left = String(left);
  right = String(right);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}
