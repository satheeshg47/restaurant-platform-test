# Implementation priority and release gates

| Priority | Module | Why / prerequisite | Status |
|---|---|---|---|
| 0 | Existing platform launch gates | Security, recovery and real pilot readiness | Not declared complete |
| 1 | Ingredients and units | Foundation for recipe cost and stock | Future |
| 2 | Recipes and sub-recipes | Connect menu sales to ingredient usage | Future |
| 3 | Stock movements and wastage | Actual usage and variance | Future |
| 4 | Suppliers and purchasing | Purchase prices and receiving evidence | Future |
| 5 | Operations Autopilot | Combines trusted signals into owner actions | Future |
| 6 | Profitability analytics | Requires cost and usage history | Future |
| 7 | Delivery routing / AI add-ons | Optional; isolate external engines/providers | Future |

## Non-negotiable checks
- [ ] Existing build and tests pass before and after change.
- [ ] Migration is additive, reviewed, reversible where possible and tested on a disposable D1 database.
- [ ] Tenant authorization is enforced in the Worker for every read and write.
- [ ] Role permissions and audit events are defined.
- [ ] Inputs are validated; money uses integer minor units (paise) or a documented decimal strategy.
- [ ] Idempotency protects retryable commands such as receiving, stock movements and payment-related workflows.
- [ ] No external provider is required for core ordering or restaurant operations.
- [ ] Free-tier limits and data retention are checked; no paid resources are enabled.
- [ ] Backup completed and isolated restore path tested before production schema changes.
- [ ] Feature flag, monitoring, support notes and rollback plan exist.

Do not infer production readiness from code being present in this folder.
