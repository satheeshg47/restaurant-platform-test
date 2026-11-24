# Future feature roadmap

## P0 — finish the existing platform before add-ons
- Complete and verify the launch gates documented in the root README.
- Reconcile authentication documentation with deployed behavior.
- Verify administrator MFA, owner onboarding/MFA, staff permission boundaries and tenant isolation.
- Monitor scheduled Google Drive backups and repeat isolated restore drills.
- Finish the Update Centre workflow: inspect, validate, backup, approve, deploy, health-check and rollback.
- Onboard a real pilot restaurant only after security and recovery checks pass.

## P1 — inventory and recipe foundations
1. Ingredient catalogue with base units and safe unit conversions.
2. Recipe and sub-recipe definitions with ingredient quantities and yield.
3. Recipe versioning and effective dates so historic costs remain explainable.
4. Stock movements: purchase receipt, consumption, wastage, adjustment and transfer.
5. Low-stock and expiry alerts.
6. Deduct ingredient consumption from completed/accepted order items according to an explicit business rule; never silently deduct on abandoned carts.

## P2 — suppliers and purchasing
- Supplier directory and item-specific supplier catalogue.
- Purchase requisitions and purchase orders.
- Goods receipt with ordered-vs-received quantity checks.
- Supplier invoice matching and price history.
- Approval thresholds and audit events.

## P3 — Restaurant Operations Autopilot
- Actionable exceptions: low stock, unusual usage, supplier price jumps, receiving variance, wastage spikes and menu margin erosion.
- Daily owner summary with evidence, impact estimate, confidence and suggested action.
- Explainable recommendations; no autonomous purchasing, menu price change or customer communication without approval.
- Begin with deterministic rules. Add forecasting only after enough clean history exists.

## P4 — analytics and profitability
- Ingredient-level theoretical food cost vs actual stock usage.
- Dish contribution margin and price-change simulation.
- Outlet, daypart and item performance.
- Waste and supplier variance trends.
- Exportable reports.

## P5 — optional advanced add-ons
- Delivery route optimization through an adapter to an independently deployable engine.
- Multilingual ordering assistance and staff knowledge assistant.
- Loyalty and customer retention tools.
- Multi-outlet benchmarking with strict tenant isolation.

## Dependencies
Recipe costing depends on ingredients, units, recipe versions and supplier costs. Actual-vs-theoretical usage depends on stock movement discipline and receiving/waste capture. Forecasting depends on sufficient clean order history and calendar/context signals. Route optimization depends on delivery addresses, service constraints and reliable geocoding; do not make a paid map API a hard dependency.

## Definition of ready
A feature is not ready to implement until its user problem, scope, data ownership, authorization, tenant boundaries, migration plan, API contract, test plan, cost envelope and rollback path are documented.
