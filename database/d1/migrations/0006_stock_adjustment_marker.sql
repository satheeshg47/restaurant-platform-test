-- Internal optimistic-concurrency marker for atomic, audited D1 stock adjustments.
ALTER TABLE restaurant_menu_items ADD COLUMN last_stock_adjustment_id TEXT;
