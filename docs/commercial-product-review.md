# Restaurant Platform — Commercial Product Review

## Executive assessment
QR menu and table ordering alone are crowded and price-sensitive in India. The stronger position is a **mobile-first operations layer for independent restaurants and high-throughput South Indian/QSR kitchens**, differentiated by multilingual onboarding, table-aware kitchen batching, and practical staff workflows. Do not market it as a full POS replacement until printing, billing, offline recovery, payments, compliance, and reliability are proven in pilots.

## Differentiators to validate
1. **Kitchen batching with table traceability:** aggregate identical dishes for prep totals while preserving each table's ticket and modifiers.
2. **Regional-language workflows:** English, Hindi, Kannada, Tamil, Telugu, and Malayalam can reduce friction; food names, allergens, and modifiers need human review.
3. **Owner-first mobile operations:** menu availability, table state, staff, delays, and daily sales managed from an Android phone.
4. **Fast onboarding:** QR setup and menu import are more valuable than a long feature checklist.

## Commercial blockers
- Complete guest → kitchen → preparing → waiter → served → session close → bill lifecycle.
- Dynamic/expiring table sessions, rate limits, staff confirmation where appropriate, and duplicate-order prevention. A static QR URL alone is not strong anti-prank protection.
- Offline/reconnect handling, idempotent retries, and visible connection state.
- Tested KOT/receipt printing on specific Bluetooth/network printer models and Android devices.
- Item cancellation/modification audit trail, discounts, split bills, configurable tax invoice fields, GSTIN/FSSAI details where applicable, and exportable records. Do not hard-code tax rates; validate current requirements with a qualified professional.
- Server-enforced tenant isolation, role authorization on every API, audit logs, and backup/restore drills.

## MVP priority
**P0 — Pilot safety:** complete order lifecycle; idempotency; reconnect/retry; table-session protection; tenant isolation; Cook/Waiter authorization tests; real Android/Wi-Fi trials.

**P1 — Daily essentials:** 58mm/80mm KOT and receipt printing on selected devices; item cancellation/modification; discounts and split bills; session close; daily sales/CSV; configurable invoice fields; kitchen alerts.

**P2 — Retention:** photo/PDF menu import with review before publish; direct out-of-stock toggles; opt-in WhatsApp digest after provider costs and templates are clear; multi-branch reporting.

Defer inventory, payroll, supplier procurement, and delivery fleet management until pilots repeatedly request them.

## Opportunity shortlist (hypotheses, not proven low-competition markets)
| Segment | Product wedge | Main risk |
|---|---|---|
| Food courts/shared cafeterias | One shared QR/cart, vendor-specific kitchen tickets | Vendor settlement, refunds, permissions |
| PGs, hostels, corporate canteens | Meal-slot preorders and headcount aggregation | Contract sales and recurring billing |
| Boutique hotels/homestays | Room-service QR routed to kitchen/housekeeping | Hotel PMS and guest identity integrations |
| High-volume tiffin/QSR | Kitchen batching and rapid reorder | POS incumbents and staff adoption |

Interview 10 operators in each shortlisted segment and obtain 2–3 measurable pilots before expanding.

## AI with measurable value
- Photo/PDF menu extraction for categories, items, portion prices, and dietary labels; uncertain OCR must be reviewed before publishing.
- Translation assistant with review flags for allergens and dish names.
- Daily sales digest from verified data: top items, peak windows, cancellations, prep delays.
- Cart upsell based on item pairings and margin data, with owner controls and conversion measurement.

Avoid an open-ended chatbot until the underlying data and workflows are reliable.

## Architecture and security
- Derive restaurant_id from authenticated membership, never trust arbitrary client-supplied tenant IDs.
- Enforce tenant boundaries in every API and test cross-tenant access explicitly.
- Use idempotency keys for order submission and retryable writes.
- Start with simple polling if it meets measured latency; introduce Durable Objects/WebSockets only when needed.
- Keep portable exports and routinely test restore, not just backup creation.
- Monitor Worker CPU, D1 queries, storage, messaging/translation spend; free tiers can change.

## Pricing hypotheses to test
Potential interview anchors: Starter ₹499–₹799/outlet/month; Pro ₹1,499–₹2,499/outlet/month; optional one-time onboarding/QR stand fee. These are not market-validated. Measure willingness to pay, support time, onboarding effort, printing costs, and monthly cost per active outlet before promising a permanent free tier.

## 90-day validation
1. **Weeks 1–3:** close lifecycle, tenant isolation, role boundaries, retry safety, mobile/desktop QA.
2. **Weeks 4–6:** pilot in 2–3 restaurants during real service; measure latency, missed/duplicate orders, prep time, table turnover, and paper/WhatsApp fallbacks.
3. **Weeks 7–10:** implement only repeatedly observed blockers: printing, billing, offline recovery, reporting.
4. **Weeks 11–13:** test paid conversion, onboarding fees, support load; choose one adjacent vertical only after restaurant operations are repeatable.

## Success metrics
Guest order completion and time-to-order; order-to-kitchen latency; missed/duplicate orders; prep and waiter handoff time; percentage of orders fulfilled without paper fallback; owner weekly activity and 30/60-day retention; setup time; support minutes/outlet; gross margin/outlet.
