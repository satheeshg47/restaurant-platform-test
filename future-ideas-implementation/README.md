# Future Ideas & Implementation Library

This directory is the platform's long-term product and engineering knowledge base. It preserves feature requirements, architecture, schemas, contracts, reusable code and third-party project research so future add-ons do not depend on external repositories remaining available.

## Ground rules
- This is a **planning/reference area**. Nothing here is wired into production routes or deployed automatically.
- Do not apply SQL drafts in production. Convert them into reviewed, numbered migrations only after schema, tenant isolation, authorization, backup and rollback reviews.
- Prefer native modules that fit the existing React + TypeScript + Cloudflare Workers + D1 architecture.
- Do not copy third-party code unless its exact licence, version, notices and obligations have been reviewed. A public GitHub repository is not automatically open source.
- Keep the existing zero-cost operating rule: no paid service, plan upgrade, trial conversion or automatic billing without explicit approval. Check current free-tier limits before selecting infrastructure.
- Every tenant-owned record must be scoped and authorized server-side. Never trust a tenant ID from the browser.
- Add features behind flags and preserve the existing customer app and Platform Core boundaries.

## Contents
| Area | Purpose |
|---|---|
| `00-roadmap` | Priority, dependencies and delivery gates |
| `01-operations-autopilot` | Exception-led restaurant operations and profit recommendations |
| `02-inventory-and-recipes` | Ingredients, units, recipes, stock movements and wastage |
| `03-suppliers-and-purchasing` | Vendors, purchase orders, receiving and price history |
| `04-analytics-and-profitability` | Dish margins, cost trends and management reporting |
| `05-delivery-route-optimization` | Optional route-optimization adapter |
| `06-ai-and-automation` | Safe automation ideas and provider-independent interfaces |
| `07-reference-projects` | Research notes, links and licensing checklist |
| `08-reusable-components` | Shared contracts and starter code |

## Current platform context
The inspected repository documents a React/TypeScript frontend, Cloudflare Worker API and Cloudflare D1 database. Existing product areas include tenant/admin management, menu, tables, QR ordering, orders, kitchen, payments/refunds, GST invoices, reviews, reporting and basic stock events. The repository README marks the platform pre-launch and lists remaining launch gates. This folder does not change that status.

## How to add an idea
1. Add a short problem statement and target user.
2. Record the current platform gap and dependencies.
3. Add a data model draft and API contract.
4. Add provider-independent implementation code where useful.
5. Record privacy, security, cost, licence and failure-mode considerations.
6. Add acceptance tests and rollout/rollback steps.
7. Only then propose a migration or production integration.
