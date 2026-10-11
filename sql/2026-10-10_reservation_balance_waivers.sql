-- Apply before using the new Waive remaining balance / Restore balance controls.
-- Existing payment amounts, prices and bookings remain unchanged.
BEGIN;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS balance_waiver jsonb;
CREATE TABLE IF NOT EXISTS reservation_balance_waiver_events (
  id bigserial PRIMARY KEY,
  reservation_id bigint NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('waive','restore')),
  reason text NOT NULL DEFAULT '',
  scope jsonb NOT NULL,
  admin_user_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservation_balance_waiver_events_reservation_idx
  ON reservation_balance_waiver_events (reservation_id,created_at DESC,id DESC);
COMMIT;
