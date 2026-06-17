ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS rig_length_feet INTEGER;

ALTER TABLE reservations
  DROP CONSTRAINT IF EXISTS reservations_rig_length_feet_check;

ALTER TABLE reservations
  ADD CONSTRAINT reservations_rig_length_feet_check
  CHECK (rig_length_feet IS NULL OR rig_length_feet > 0);
