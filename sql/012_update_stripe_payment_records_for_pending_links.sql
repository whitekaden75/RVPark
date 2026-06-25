ALTER TABLE stripe_payment_records
  ADD COLUMN IF NOT EXISTS activate_reservation_on_payment BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE stripe_payment_records
  ADD COLUMN IF NOT EXISTS checkout_url TEXT;
