-- Run after 2026-10-27_historical_daily_payments.sql.
-- Enables reviewed undo; this SQL does not add or remove any payments.
BEGIN;
ALTER TABLE bookkeeping_historical_payment_backfills
  ADD COLUMN IF NOT EXISTS undo_state jsonb,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by_admin_user_id bigint REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS reversal_snapshot jsonb;
ALTER TABLE bookkeeping_historical_payment_backfills
  DROP CONSTRAINT IF EXISTS bookkeeping_historical_payment_backfills_backfill_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS historical_payment_active_key_idx
  ON bookkeeping_historical_payment_backfills(backfill_key) WHERE reversed_at IS NULL;
COMMIT;
