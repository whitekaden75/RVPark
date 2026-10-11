-- Apply before deploying Overview's Received cash action. Safe to rerun.
BEGIN;
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS after_hours_cash_received jsonb,
  ADD COLUMN IF NOT EXISTS manual_pricing_override boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN reservations.after_hours_cash_received IS
  'Office receipt for an after-hours cash envelope: actual amount, credited amount, timestamp and admin ID. Money is recorded in reservation_payment_events.';
COMMIT;
