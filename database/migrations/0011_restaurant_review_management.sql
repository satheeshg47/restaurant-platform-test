ALTER TABLE restaurant_reviews
  ADD COLUMN visibility text NOT NULL DEFAULT 'published'
    CHECK (visibility IN ('published','hidden')),
  ADD COLUMN owner_response text,
  ADD COLUMN responded_at timestamptz,
  ADD COLUMN responded_by uuid,
  ADD CONSTRAINT restaurant_reviews_responded_by_fk
    FOREIGN KEY (tenant_id,responded_by)
    REFERENCES restaurant_staff(tenant_id,id);

CREATE INDEX restaurant_reviews_created_idx
  ON restaurant_reviews(tenant_id,created_at DESC);
