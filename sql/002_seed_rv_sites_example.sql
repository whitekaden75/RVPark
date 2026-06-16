INSERT INTO rv_sites (site_number, size_feet, is_on_river)
VALUES
  ('1', 30, FALSE),
  ('2', 30, FALSE),
  ('3', 35, FALSE),
  ('4', 35, TRUE),
  ('5', 40, FALSE),
  ('6', 40, TRUE),
  ('7', 45, FALSE),
  ('8', 45, TRUE),
  ('9', 50, FALSE),
  ('10', 50, TRUE)
ON CONFLICT (site_number) DO NOTHING;
