# Restaurant Operations Autopilot — product specification

## Goal
Give an owner a concise, evidence-backed list of operational exceptions and practical next actions. The differentiator to validate is a low-friction exception workflow embedded in the existing restaurant platform, not another generic analytics dashboard.

## Users
- Restaurant owner/manager: sees outlet-level exceptions and approves actions.
- Authorized inventory/purchase staff: resolves assigned stock and receiving exceptions.
- Platform administrator: manages feature availability, not restaurant business decisions.

## Initial signals
1. Low-stock item based on configured reorder threshold.
2. Supplier price increase compared with the last accepted purchase price.
3. Ordered vs received quantity mismatch.
4. Wastage spike by ingredient or category.
5. Theoretical recipe consumption vs recorded stock usage.
6. Dish contribution margin below owner-defined threshold.
7. Unusual order volume by daypart after sufficient history exists.

## Recommendation record
Each recommendation must include: tenant/outlet, type, severity, title, evidence references, calculation window, estimated impact (optional), confidence, suggested action, status, assigned user, created/updated timestamps and resolution note.

## UX
- Mobile-first owner inbox: Critical / Needs attention / Informational.
- Each card explains *why* it appeared and links to the underlying records.
- Actions: acknowledge, assign, snooze, resolve, dismiss with reason.
- Never present an estimate as an actual saving.
- Show data freshness and missing-data warnings.
- No automatic purchase order, supplier message, price change or menu update in v1.

## MVP boundaries
Start with deterministic rules using trusted data. No LLM is required. AI can later summarize evidence, but must not invent metrics or execute financial actions. Recommendations must be reproducible from stored inputs and rule version.

## Success measures
- Time taken to notice and resolve a stock/receiving issue.
- Percentage of recommendations acknowledged and resolved.
- False-positive rate.
- Owner-reported usefulness.
- No cross-tenant data exposure.
