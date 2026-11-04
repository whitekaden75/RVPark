-- Adds an office charge ledger. Does not change any booking balance or collect money.
BEGIN;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS manual_charges jsonb;
COMMIT;
