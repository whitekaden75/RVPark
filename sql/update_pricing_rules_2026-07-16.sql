BEGIN;

DELETE FROM pricing_rules
WHERE site_category IN (
  'prime_river',
  'normal_river',
  'off_river_big_rig',
  'off_river_small_rig'
);

INSERT INTO pricing_rules (
  site_category,
  number_of_days,
  normal_price,
  discount_price
)
VALUES
  ('prime_river', 1, 75, 70),
  ('normal_river', 1, 65, 60),
  ('off_river_big_rig', 1, 55, 50),
  ('off_river_small_rig', 1, 50, 45);

COMMIT;
