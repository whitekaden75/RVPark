ALTER TABLE rv_sites
  ADD COLUMN IF NOT EXISTS river_category TEXT,
  ADD COLUMN IF NOT EXISTS is_big_rig BOOLEAN;

ALTER TABLE rv_sites
  ALTER COLUMN is_big_rig SET DEFAULT FALSE;

UPDATE rv_sites
SET river_category = 'off_river'
WHERE site_number IN ('25', '26', '27', '28', '29', '30');

UPDATE rv_sites
SET river_category = 'prime_river'
WHERE site_number IN ('24', '21', '20', '12', '11', '10', '9', '8', '6', '5');

UPDATE rv_sites
SET river_category = 'normal_river'
WHERE is_on_river = TRUE
  AND COALESCE(river_category, '') NOT IN ('prime_river');

UPDATE rv_sites
SET river_category = 'off_river'
WHERE is_on_river = FALSE
  AND COALESCE(river_category, '') = '';

UPDATE rv_sites
SET is_big_rig = TRUE
WHERE size_feet < 50;

UPDATE rv_sites
SET is_big_rig = FALSE
WHERE is_big_rig IS NULL;

ALTER TABLE rv_sites
  DROP CONSTRAINT IF EXISTS rv_sites_river_category_check;

ALTER TABLE rv_sites
  ADD CONSTRAINT rv_sites_river_category_check
  CHECK (river_category IN ('off_river', 'normal_river', 'prime_river'));

CREATE TABLE IF NOT EXISTS pricing_rules (
  id BIGSERIAL PRIMARY KEY,
  site_category TEXT NOT NULL,
  number_of_days INTEGER NOT NULL CHECK (number_of_days BETWEEN 1 AND 6),
  normal_price NUMERIC(10, 2) NOT NULL CHECK (normal_price >= 0),
  discount_price NUMERIC(10, 2) NOT NULL CHECK (discount_price >= 0)
);

ALTER TABLE pricing_rules
  DROP CONSTRAINT IF EXISTS pricing_rules_site_category_check;

ALTER TABLE pricing_rules
  ADD CONSTRAINT pricing_rules_site_category_check
  CHECK (
    site_category IN (
      'prime_river',
      'normal_river',
      'off_river_big_rig',
      'off_river_small_rig'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rules_site_category_days
  ON pricing_rules(site_category, number_of_days);
