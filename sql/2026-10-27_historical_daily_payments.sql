-- Enables the reviewed historical DAILY payment backfill in Bookkeeping > Lodging tax.
-- This migration alone creates no payments, charges no cards, and sends no messages.
BEGIN;
ALTER TABLE reservation_payment_events
  ADD COLUMN IF NOT EXISTS historical_assumption boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS historical_date_assumed boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS bookkeeping_historical_payment_backfills (
  id bigserial PRIMARY KEY,
  batch_id text NOT NULL,
  backfill_key text NOT NULL UNIQUE,
  reservation_id bigint NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  payment_event_id bigint UNIQUE REFERENCES reservation_payment_events(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK(kind IN ('assumed_cash','stripe_record')),
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  previous_amount_paid numeric(14,2),
  updated_amount_paid numeric(14,2) NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  payment_date_assumed boolean NOT NULL,
  proposal jsonb NOT NULL,
  created_by_admin_user_id bigint NOT NULL REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS historical_payment_backfill_batch_idx ON bookkeeping_historical_payment_backfills(batch_id);
COMMIT;
