-- Per-item lifecycle timestamps are required for kitchen and waiter timing reports.
ALTER TABLE restaurant_order_items
  ADD COLUMN preparation_started_at timestamptz,
  ADD COLUMN ready_at timestamptz,
  ADD COLUMN served_at timestamptz,
  ADD COLUMN unavailable_at timestamptz,
  ADD COLUMN cancelled_at timestamptz;
