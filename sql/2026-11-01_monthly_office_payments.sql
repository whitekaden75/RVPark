-- Adds payment details to the existing ledger. This creates no payments and sends no texts.
BEGIN;
ALTER TABLE reservation_payment_events
  ADD COLUMN IF NOT EXISTS office_tender_type text CHECK (office_tender_type IN ('cash', 'check')),
  ADD COLUMN IF NOT EXISTS office_check_number text,
  ADD COLUMN IF NOT EXISTS billing_month date CHECK (EXTRACT(DAY FROM billing_month) = 1),
  ADD COLUMN IF NOT EXISTS office_recording_request_id uuid,
  ADD COLUMN IF NOT EXISTS recorded_by_admin_user_id bigint REFERENCES admin_users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reservation_office_recording_request_idx
  ON reservation_payment_events (office_recording_request_id)
  WHERE office_recording_request_id IS NOT NULL;
COMMIT;
