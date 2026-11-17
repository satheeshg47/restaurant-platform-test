-- Track acceptance separately from preparation for each order-item allocation.
ALTER TABLE restaurant_batch_allocations
  DROP CONSTRAINT restaurant_batch_allocations_status_check;

ALTER TABLE restaurant_batch_allocations
  ADD CONSTRAINT restaurant_batch_allocations_status_check
  CHECK (status IN ('new','accepted','preparing','ready','served','unavailable','cancelled'));
