# Analytics and profitability

## Planned metrics
- Theoretical ingredient cost per recipe and menu item.
- Actual stock usage vs theoretical usage.
- Gross contribution per item: net selling price less recipe cost, with tax/discount treatment explicitly defined.
- Supplier price movement and purchase variance.
- Waste value and waste rate.
- Sales mix by item, category, daypart and outlet.
- Margin simulation before an owner approves a menu price change.

## Data-quality rules
- Display calculation date, data coverage and missing-input warnings.
- Preserve the recipe/cost version used for each historical snapshot.
- Exclude cancelled/void orders according to explicit lifecycle rules.
- Separate GST/tax collected from revenue and define discounts, refunds and platform fees.
- Never call contribution margin "net profit" unless labour, rent, utilities, commissions and other operating costs are included.

## Initial approach
Use SQL aggregation and deterministic calculations first. Avoid adding a separate BI server until real users demonstrate a need that native reports cannot meet.
