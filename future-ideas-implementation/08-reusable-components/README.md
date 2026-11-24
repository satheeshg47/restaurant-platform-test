# Reusable components

This folder holds small, framework-neutral code and contracts that can later be integrated into the Worker or frontend after review.

Current starter:
- `operations-rules.ts`: deterministic low-stock and receiving-variance helpers.

Rules:
- Do not import these files into production until unit tests, tenant-scoped data access and API integration are complete.
- Keep business calculations pure where possible.
- Use integer minor units for money; do not use binary floating point for financial totals.
- Keep external integrations behind interfaces.
- Add tests for boundaries, invalid input, retries and tenant authorization at integration boundaries.
