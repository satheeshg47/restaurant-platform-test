-- Idempotency keys are scoped to a table session so a reused key from
-- another table cannot reveal an unrelated customer's prior order.
ALTER TABLE restaurant_orders
  DROP CONSTRAINT restaurant_orders_tenant_id_idempotency_key_key;

ALTER TABLE restaurant_orders
  ADD CONSTRAINT restaurant_orders_session_idempotency_unique
  UNIQUE (tenant_id, session_id, idempotency_key);
