-- Historical order-item snapshots must remain linked to their catalog rows.
-- Catalog records are retired with active=false; hard deletion is restricted so
-- composite tenant keys can never be nulled as a side effect of ON DELETE SET NULL.

ALTER TABLE restaurant_order_items
  DROP CONSTRAINT restaurant_order_items_tenant_id_item_id_fkey,
  DROP CONSTRAINT restaurant_order_items_tenant_id_variant_id_fkey,
  DROP CONSTRAINT restaurant_order_items_tenant_id_category_id_fkey;

ALTER TABLE restaurant_order_items
  ADD CONSTRAINT restaurant_order_items_item_tenant_fk
    FOREIGN KEY (tenant_id, item_id)
    REFERENCES restaurant_menu_items(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT restaurant_order_items_variant_tenant_fk
    FOREIGN KEY (tenant_id, variant_id)
    REFERENCES restaurant_menu_variants(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT restaurant_order_items_category_tenant_fk
    FOREIGN KEY (tenant_id, category_id)
    REFERENCES restaurant_menu_categories(tenant_id, id) ON DELETE RESTRICT;
