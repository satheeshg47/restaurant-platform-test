# Operations Autopilot API contract — draft only

All endpoints require authenticated identity, active tenant membership and server-derived tenant scope. These are proposed routes, not current API routes.

- `GET /api/restaurant/operations/recommendations?status=open&limit=25`
  - Returns paginated recommendations for the authorized tenant/outlet.
- `GET /api/restaurant/operations/recommendations/:id`
  - Returns details and evidence references after tenant-scoped lookup.
- `POST /api/restaurant/operations/recommendations/:id/acknowledge`
- `POST /api/restaurant/operations/recommendations/:id/assign`
  - Body: `{ "userId": "..." }`; verify that the user is an active member with the required role.
- `POST /api/restaurant/operations/recommendations/:id/snooze`
  - Body: `{ "until": "ISO-8601 timestamp" }`; validate a bounded future time.
- `POST /api/restaurant/operations/recommendations/:id/resolve`
  - Body: `{ "note": "..." }`.
- `POST /api/restaurant/operations/recommendations/:id/dismiss`
  - Body: `{ "reason": "..." }`.

## Requirements
- Use the repository's existing response/error conventions after inspecting them.
- Validate JSON schemas and reject unknown or oversized fields.
- Use idempotency keys for commands that may be retried.
- Record actor, tenant, action, target, timestamp and before/after status in the existing audit mechanism.
- Return 404 for records outside the authorized tenant to avoid disclosing their existence.
- Rate-limit rule evaluation and bound query sizes.
- Do not expose raw SQL, internal stack traces or secrets.
