# Reference project research — selected from the 99-link review

This is a shortlist of projects and patterns to revisit, not a dependency list. Repository availability, maintenance, licence and security must be rechecked at implementation time.

| Project | Potential learning | Decision |
|---|---|---|
| TastyIgniter | Restaurant ordering and reservation workflows | Study selected workflows; do not import the whole Laravel application |
| Metabase | Embedded analytics and query exploration | Defer; prefer native reports until a real need is proven |
| GreaterWMS | Receiving, transfers and warehouse operations | Study workflow patterns; separate architecture, do not import wholesale |
| VROOM | Vehicle routing optimization | Optional adapter for a later delivery module |
| Invoice Ninja | Invoice workflow concepts | Do not integrate by default; current platform already has GST invoice foundations and licensing/white-label terms need review |
| Botpress | Conversational workflow concepts | Defer; additional hosting and AI/provider costs |
| Cal.com / Cal.diy | Appointment scheduling | Not a current core restaurant need |
| Apache Superset / Grafana | Advanced BI and observability | Consider only if native reporting/monitoring proves insufficient |

## Market/product hypothesis
A small-restaurant "Operations Autopilot" that turns verified stock, receiving, supplier-price and waste signals into clear, explainable owner actions may be worth validating. This is a product hypothesis, not a claim that the category has low competition. Broad food-cost and restaurant-profit analytics already have established competitors.

## Implementation rule
Recreate required behavior from documented requirements and independently written code. Do not copy source files, assets, schemas or branding from reference projects without verifying exact licence compatibility and attribution obligations.
