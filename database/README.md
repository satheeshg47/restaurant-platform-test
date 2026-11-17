# Database foundation

- Engine: PostgreSQL (portable; no provider-specific SQL required).
- Apply migrations using a dedicated migration/owner account.
- The API runtime account must be a separate non-owner role with no
  `BYPASSRLS` privilege.
- For every tenant-scoped transaction, the server must authenticate the user,
  authorize tenant membership, then run `SET LOCAL app.tenant_id = '<uuid>'`
  inside that same transaction before querying tenant-scoped tables.
- Never accept a tenant ID from an untrusted request as authorization.
- Do not expose a database connection string to the browser.
- Platform-wide Super Admin access needs a separate, explicitly audited
  authorization path. Do not solve it by giving the normal API role
  `BYPASSRLS`.
- This migration is a schema foundation, not a complete authentication or
  production authorization implementation.
