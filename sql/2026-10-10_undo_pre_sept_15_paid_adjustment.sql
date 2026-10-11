-- Optional undo for the historical paid-in-full adjustment.
-- Restores amount_paid, billing_mode and total_price if they still match the migration.
-- Rows with subsequent payments/edits are left alone and returned for review.
BEGIN;
LOCK TABLE reservations IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE historical_paid_undo_settings ON COMMIT DROP AS
SELECT DATE '2026-09-15' AS cutoff_date, 'arrival'::text AS cutoff_basis;

WITH restored AS (
  UPDATE reservations r SET amount_paid=a.old_amount_paid,
    billing_mode=coalesce(a.old_billing_mode,r.billing_mode),
    total_price=CASE WHEN a.new_billing_mode IS NOT NULL THEN a.old_total_price ELSE r.total_price END
  FROM historical_paid_adjustments a, historical_paid_undo_settings cfg
  WHERE r.id=a.reservation_id AND a.cutoff_date=cfg.cutoff_date AND a.cutoff_basis=cfg.cutoff_basis
    AND r.amount_paid IS NOT DISTINCT FROM a.new_amount_paid
    AND (a.new_billing_mode IS NULL OR (r.billing_mode::text IS NOT DISTINCT FROM a.new_billing_mode
      AND r.total_price IS NOT DISTINCT FROM a.new_total_price))
  RETURNING r.id
)
DELETE FROM historical_paid_adjustments a USING restored r,historical_paid_undo_settings cfg
WHERE a.reservation_id=r.id AND a.cutoff_date=cfg.cutoff_date AND a.cutoff_basis=cfg.cutoff_basis
RETURNING a.reservation_id,a.old_amount_paid;

SELECT a.reservation_id,a.new_amount_paid AS migration_amount,r.amount_paid AS current_amount,
  'Not undone: payment amount or billing details changed after the migration.' AS reason
FROM historical_paid_adjustments a JOIN reservations r ON r.id=a.reservation_id
CROSS JOIN historical_paid_undo_settings cfg
WHERE a.cutoff_date=cfg.cutoff_date AND a.cutoff_basis=cfg.cutoff_basis;
COMMIT;
