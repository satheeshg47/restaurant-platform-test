-- Per-item lifecycle timestamps used by kitchen and waiter timing reports.
ALTER TABLE restaurant_order_items ADD COLUMN preparation_started_at TEXT;
ALTER TABLE restaurant_order_items ADD COLUMN ready_at TEXT;
ALTER TABLE restaurant_order_items ADD COLUMN served_at TEXT;
ALTER TABLE restaurant_order_items ADD COLUMN unavailable_at TEXT;
ALTER TABLE restaurant_order_items ADD COLUMN cancelled_at TEXT;
