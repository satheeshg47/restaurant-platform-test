# Suppliers and purchasing

## Scope
- Supplier profiles and contact details with restricted staff access.
- Supplier catalogue mapping supplier SKUs to internal ingredients and units.
- Purchase requisition, approval and purchase order lifecycle.
- Partial goods receipt and back-order tracking.
- Supplier invoice capture and three-way comparison: purchase order, goods receipt and invoice.
- Price history by supplier, item, unit and effective date.
- Supplier performance: delivery variance, quality/return events and price movement.

## Controls
- Purchase order approval thresholds configurable by tenant.
- No automatic order placement in the first release.
- Record who created, approved, amended, received and reconciled each document.
- Receiving is idempotent; repeated webhook or mobile retry must not duplicate stock.
- Invoice attachments must follow the platform's privacy, access and retention rules.
- Never store payment-card data in this module.

## Required links
Purchase receipt creates stock-ledger receipt movements. Accepted invoice lines update supplier price history. Variance records can generate Operations Autopilot recommendations.
