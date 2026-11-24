# AI and automation add-ons

## Principle
Core ordering, payments, kitchen flow, stock ledger and reporting must work without an AI provider. AI is an optional assistant layer.

## Suitable future use cases
- Summarize already-computed daily exceptions for an owner.
- Search approved restaurant SOPs and help staff answer operational questions.
- Translate menu descriptions or staff-facing instructions with human review.
- Draft a supplier variance explanation from verified purchase records.

## Guardrails
- Never let a model invent prices, tax values, stock quantities or order status.
- Include source record references and timestamps for factual summaries.
- Require human approval for purchases, refunds, menu price changes and outbound customer/supplier messages.
- Do not send customer personal data to a third-party model unless the tenant has explicitly enabled and consented to the integration.
- Use provider adapters, timeouts, budget limits, redaction and audit logs.
- If provider unavailable or quota exhausted, show a graceful fallback and preserve manual workflow.
