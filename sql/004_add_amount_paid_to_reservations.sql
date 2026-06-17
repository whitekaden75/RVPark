ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE reservations
  DROP CONSTRAINT IF EXISTS reservations_amount_paid_check;

ALTER TABLE reservations
  ADD CONSTRAINT reservations_amount_paid_check
  CHECK (amount_paid >= 0);
