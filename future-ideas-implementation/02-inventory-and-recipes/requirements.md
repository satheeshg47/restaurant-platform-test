# Inventory, ingredients and recipes

## Why this is a foundation
The current inspected platform has basic menu-item stock quantity and stock-event concepts. Dish-level food cost and ingredient-level consumption require a separate ingredient/recipe model; do not treat the existing menu stock field as a full inventory system.

## Proposed capabilities
- Ingredient catalogue: name, SKU, base unit, category, active state and optional storage/expiry settings.
- Units: mass, volume and count; explicit conversion factors. Do not convert mass to volume without an ingredient-specific density.
- Recipes: menu item to ingredient quantities; support sub-recipes, yield quantity, yield unit, preparation loss and version/effective date.
- Stock ledger: append-only movements for receipt, sale consumption, waste, adjustment, transfer and reversal.
- Stock balance: derived or transactionally maintained from ledger; reconciliation job detects drift.
- Waste: reason, quantity, unit, time, actor and optional photo/reference.
- Alerts: reorder point, low stock, expiry and unusual consumption.

## Accounting rules
- Keep quantity precision suitable for grams/ml and the ingredient's unit.
- Use a documented costing method (e.g. weighted average) and preserve cost snapshots on historical calculations.
- A completed sale consumes recipe quantities according to the chosen fulfilment event. Refunds/voids require explicit compensating movements; never erase ledger history.
- All movements must be idempotent and auditable.
- Multi-outlet transfers require paired dispatch/receipt records.

## Acceptance tests
- Unit conversion is deterministic and rejects incompatible units.
- Recipe version changes do not rewrite historic order cost snapshots.
- Duplicate event retries do not double-consume stock.
- Tenant A cannot read or mutate Tenant B ingredients, recipes or stock.
- Stock ledger reconciliation can reproduce the displayed balance.
