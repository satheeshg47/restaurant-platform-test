-- A tenant restore is allowed only inside one atomic D1 batch. The guard row
-- is visible to write triggers during that batch and is removed before commit.
CREATE TABLE restaurant_tenant_controls (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  maintenance_mode INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_mode IN (0,1)),
  restore_mode INTEGER NOT NULL DEFAULT 0 CHECK (restore_mode IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER restaurant_tenant_controls_empty_guard
BEFORE INSERT ON restaurant_tenant_controls
WHEN NEW.maintenance_mode=1 AND NEW.restore_mode=1
BEGIN
  SELECT CASE WHEN
       EXISTS(SELECT 1 FROM restaurant_activity_events WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_addon_groups WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_addons WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_batch_allocations WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_daily_summaries WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_invoice_counters WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_invoices WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_item_addon_groups WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_kitchen_batches WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_menu_categories WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_menu_items WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_menu_variants WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_order_items WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_payments WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_profiles WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_refunds WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_reviews WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_service_requests WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_settings WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_staff WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_staff_assignments WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_stock_events WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_table_sessions WHERE tenant_id=NEW.tenant_id)
       OR EXISTS(SELECT 1 FROM restaurant_tables WHERE tenant_id=NEW.tenant_id)
    THEN RAISE(ABORT,'restore_target_not_empty')
  END;
END;

CREATE TRIGGER restaurant_activity_events_maintenance_insert_guard
BEFORE INSERT ON restaurant_activity_events
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_activity_events_maintenance_update_guard
BEFORE UPDATE ON restaurant_activity_events
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_activity_events_maintenance_delete_guard
BEFORE DELETE ON restaurant_activity_events
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_addon_groups_maintenance_insert_guard
BEFORE INSERT ON restaurant_addon_groups
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_addon_groups_maintenance_update_guard
BEFORE UPDATE ON restaurant_addon_groups
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_addon_groups_maintenance_delete_guard
BEFORE DELETE ON restaurant_addon_groups
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_addons_maintenance_insert_guard
BEFORE INSERT ON restaurant_addons
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_addons_maintenance_update_guard
BEFORE UPDATE ON restaurant_addons
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_addons_maintenance_delete_guard
BEFORE DELETE ON restaurant_addons
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_batch_allocations_maintenance_insert_guard
BEFORE INSERT ON restaurant_batch_allocations
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_batch_allocations_maintenance_update_guard
BEFORE UPDATE ON restaurant_batch_allocations
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_batch_allocations_maintenance_delete_guard
BEFORE DELETE ON restaurant_batch_allocations
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_daily_summaries_maintenance_insert_guard
BEFORE INSERT ON restaurant_daily_summaries
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_daily_summaries_maintenance_update_guard
BEFORE UPDATE ON restaurant_daily_summaries
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_daily_summaries_maintenance_delete_guard
BEFORE DELETE ON restaurant_daily_summaries
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_invoice_counters_maintenance_insert_guard
BEFORE INSERT ON restaurant_invoice_counters
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_invoice_counters_maintenance_update_guard
BEFORE UPDATE ON restaurant_invoice_counters
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_invoice_counters_maintenance_delete_guard
BEFORE DELETE ON restaurant_invoice_counters
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_invoices_maintenance_insert_guard
BEFORE INSERT ON restaurant_invoices
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_invoices_maintenance_update_guard
BEFORE UPDATE ON restaurant_invoices
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_invoices_maintenance_delete_guard
BEFORE DELETE ON restaurant_invoices
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_item_addon_groups_maintenance_insert_guard
BEFORE INSERT ON restaurant_item_addon_groups
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_item_addon_groups_maintenance_update_guard
BEFORE UPDATE ON restaurant_item_addon_groups
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_item_addon_groups_maintenance_delete_guard
BEFORE DELETE ON restaurant_item_addon_groups
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_kitchen_batches_maintenance_insert_guard
BEFORE INSERT ON restaurant_kitchen_batches
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_kitchen_batches_maintenance_update_guard
BEFORE UPDATE ON restaurant_kitchen_batches
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_kitchen_batches_maintenance_delete_guard
BEFORE DELETE ON restaurant_kitchen_batches
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_categories_maintenance_insert_guard
BEFORE INSERT ON restaurant_menu_categories
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_categories_maintenance_update_guard
BEFORE UPDATE ON restaurant_menu_categories
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_categories_maintenance_delete_guard
BEFORE DELETE ON restaurant_menu_categories
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_items_maintenance_insert_guard
BEFORE INSERT ON restaurant_menu_items
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_items_maintenance_update_guard
BEFORE UPDATE ON restaurant_menu_items
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_items_maintenance_delete_guard
BEFORE DELETE ON restaurant_menu_items
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_variants_maintenance_insert_guard
BEFORE INSERT ON restaurant_menu_variants
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_variants_maintenance_update_guard
BEFORE UPDATE ON restaurant_menu_variants
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_menu_variants_maintenance_delete_guard
BEFORE DELETE ON restaurant_menu_variants
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_order_items_maintenance_insert_guard
BEFORE INSERT ON restaurant_order_items
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_order_items_maintenance_update_guard
BEFORE UPDATE ON restaurant_order_items
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_order_items_maintenance_delete_guard
BEFORE DELETE ON restaurant_order_items
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_orders_maintenance_insert_guard
BEFORE INSERT ON restaurant_orders
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_orders_maintenance_update_guard
BEFORE UPDATE ON restaurant_orders
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_orders_maintenance_delete_guard
BEFORE DELETE ON restaurant_orders
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_payments_maintenance_insert_guard
BEFORE INSERT ON restaurant_payments
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_payments_maintenance_update_guard
BEFORE UPDATE ON restaurant_payments
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_payments_maintenance_delete_guard
BEFORE DELETE ON restaurant_payments
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_profiles_maintenance_insert_guard
BEFORE INSERT ON restaurant_profiles
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_profiles_maintenance_update_guard
BEFORE UPDATE ON restaurant_profiles
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_profiles_maintenance_delete_guard
BEFORE DELETE ON restaurant_profiles
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_refunds_maintenance_insert_guard
BEFORE INSERT ON restaurant_refunds
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_refunds_maintenance_update_guard
BEFORE UPDATE ON restaurant_refunds
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_refunds_maintenance_delete_guard
BEFORE DELETE ON restaurant_refunds
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_reviews_maintenance_insert_guard
BEFORE INSERT ON restaurant_reviews
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_reviews_maintenance_update_guard
BEFORE UPDATE ON restaurant_reviews
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_reviews_maintenance_delete_guard
BEFORE DELETE ON restaurant_reviews
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_service_requests_maintenance_insert_guard
BEFORE INSERT ON restaurant_service_requests
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_service_requests_maintenance_update_guard
BEFORE UPDATE ON restaurant_service_requests
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_service_requests_maintenance_delete_guard
BEFORE DELETE ON restaurant_service_requests
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_settings_maintenance_insert_guard
BEFORE INSERT ON restaurant_settings
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_settings_maintenance_update_guard
BEFORE UPDATE ON restaurant_settings
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_settings_maintenance_delete_guard
BEFORE DELETE ON restaurant_settings
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_staff_maintenance_insert_guard
BEFORE INSERT ON restaurant_staff
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_staff_maintenance_update_guard
BEFORE UPDATE ON restaurant_staff
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_staff_maintenance_delete_guard
BEFORE DELETE ON restaurant_staff
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_staff_assignments_maintenance_insert_guard
BEFORE INSERT ON restaurant_staff_assignments
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_staff_assignments_maintenance_update_guard
BEFORE UPDATE ON restaurant_staff_assignments
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_staff_assignments_maintenance_delete_guard
BEFORE DELETE ON restaurant_staff_assignments
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_stock_events_maintenance_insert_guard
BEFORE INSERT ON restaurant_stock_events
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_stock_events_maintenance_update_guard
BEFORE UPDATE ON restaurant_stock_events
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_stock_events_maintenance_delete_guard
BEFORE DELETE ON restaurant_stock_events
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_table_sessions_maintenance_insert_guard
BEFORE INSERT ON restaurant_table_sessions
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_table_sessions_maintenance_update_guard
BEFORE UPDATE ON restaurant_table_sessions
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_table_sessions_maintenance_delete_guard
BEFORE DELETE ON restaurant_table_sessions
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_tables_maintenance_insert_guard
BEFORE INSERT ON restaurant_tables
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_tables_maintenance_update_guard
BEFORE UPDATE ON restaurant_tables
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
  OR EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=NEW.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

CREATE TRIGGER restaurant_tables_maintenance_delete_guard
BEFORE DELETE ON restaurant_tables
WHEN EXISTS(SELECT 1 FROM restaurant_tenant_controls WHERE tenant_id=OLD.tenant_id AND maintenance_mode=1 AND restore_mode=0)
BEGIN SELECT RAISE(ABORT,'tenant_maintenance_locked'); END;

