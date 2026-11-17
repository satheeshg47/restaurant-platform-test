-- Link customer service/cancellation requests to their order and optional item.
ALTER TABLE restaurant_service_requests
  ADD COLUMN order_id uuid,
  ADD COLUMN order_item_id uuid,
  ADD CONSTRAINT restaurant_service_requests_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES restaurant_orders(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT restaurant_service_requests_order_item_fk
    FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES restaurant_order_items(tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX restaurant_service_requests_order_idx
  ON restaurant_service_requests(tenant_id, order_id, created_at DESC);
