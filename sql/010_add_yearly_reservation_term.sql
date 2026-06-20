ALTER TABLE reservations
ADD COLUMN IF NOT EXISTS reservation_term text NOT NULL DEFAULT 'standard';

ALTER TABLE reservations
DROP CONSTRAINT IF EXISTS reservations_reservation_term_check;

ALTER TABLE reservations
ADD CONSTRAINT reservations_reservation_term_check
CHECK (reservation_term IN ('standard', 'yearly'));

UPDATE reservations
SET reservation_term = COALESCE(NULLIF(reservation_term, ''), 'standard');
