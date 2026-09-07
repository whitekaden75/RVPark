ALTER TABLE reservations
ADD COLUMN IF NOT EXISTS pricing_category_override TEXT;

ALTER TABLE reservations
DROP CONSTRAINT IF EXISTS reservations_pricing_category_override_check;

ALTER TABLE reservations
ADD CONSTRAINT reservations_pricing_category_override_check
CHECK (
  pricing_category_override IS NULL
  OR pricing_category_override IN (
    'off_river_small_rig',
    'off_river_big_rig',
    'normal_river',
    'prime_river'
  )
);
