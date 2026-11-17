# Backend Database Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Platform Core distinguish API liveness from PostgreSQL readiness and close its database pool cleanly.

**Architecture:** Inject an optional PostgreSQL pool into the HTTP server. Keep `/health` process-only and add `/ready` that executes a harmless database probe. The entry point owns pool creation and graceful shutdown.

**Tech Stack:** Node.js 20, ESM, node:http, node:test, pg.

**Spec:** `docs/superpowers/specs/2026-11-17-backend-database-readiness-design.md`

## Global Constraints
- Preserve `/health` as process liveness.
- Missing or unreachable PostgreSQL must never be reported as ready.
- Never expose connection strings, query errors, or secrets in HTTP responses.
- Do not add admin or tenant data routes before authentication and authorization are implemented.
- Use the existing `pg` dependency; add no dependencies.

## Review Focus
- Missing DATABASE_URL: readiness must be 503 and liveness must remain 200.
- PostgreSQL query rejection: readiness must be 503 with no internal error detail.
- Slow or failed database probe: request handler must not crash the server.
- Pool shutdown: pool is closed after the HTTP server stops accepting requests.
- Existing health headers and 404 behavior remain unchanged.

---

### Task 1: HTTP readiness endpoint

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/app.test.mjs`

**Interfaces:**
- Consumes: `createApiServer(config, { database } = {})`
- Produces: `GET /ready` returning 200 only when database probe succeeds; otherwise 503.

- [ ] **Step 1: Add tests** for no database (503), successful `SELECT 1` (200), and failed probe (503 without leaked error text).
- [ ] **Step 2: Verify RED** through GitHub Actions after the test-only commit.
- [ ] **Step 3: Implement** the optional database dependency and readiness response.
- [ ] **Step 4: Verify GREEN** through GitHub Actions and run the full test suite.
- [ ] **Step 5: Commit** the implementation.

### Task 2: Runtime pool lifecycle

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/config.mjs` only if needed
- Test: `server/index.test.mjs` only if the entry point can be tested without process side effects.

**Interfaces:**
- Consumes: `createDatabasePool(env)` from `server/db/pool.mjs`.
- Produces: one optional pool passed to `createApiServer`, closed during graceful shutdown.

- [ ] **Step 1: Add a testable lifecycle helper** only if needed to verify pool closure.
- [ ] **Step 2: Verify RED** through the existing test runner.
- [ ] **Step 3: Wire pool creation when DATABASE_URL exists** and close it after HTTP shutdown.
- [ ] **Step 4: Verify GREEN** with the full test suite and CI build.
- [ ] **Step 5: Commit** the implementation.

### Task 3: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document** DATABASE_URL, optional DATABASE_SSL, DB_POOL_MAX, `/health`, and `/ready`.
- [ ] **Step 2: Verify** documentation matches implemented behavior.
- [ ] **Step 3: Commit** documentation.
