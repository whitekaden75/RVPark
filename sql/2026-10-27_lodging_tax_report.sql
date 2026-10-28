-- Supporting data for monthly charge estimates. Does not create payments,
-- bookkeeping income, tax liabilities, or change agreed rent amounts.
BEGIN;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS monthly_classification boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS bookkeeping_monthly_utility_sources (
  id bigserial PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  source_filename text NOT NULL,
  source_sheet text NOT NULL,
  source_row integer NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('rv_meter','cabin_bill','deposit_note')),
  site_number text NOT NULL,
  guest_name text NOT NULL,
  billing_month date NOT NULL CHECK (extract(day FROM billing_month)=1),
  reading_day integer,
  reading_date date,
  meter_reading numeric(14,3) CHECK (meter_reading>=0),
  usage_kwh numeric(14,3) CHECK (usage_kwh>=0),
  electric_amount numeric(14,2) CHECK (electric_amount>=0),
  power_amount numeric(14,2),
  gas_amount numeric(14,2),
  reservation_id bigint REFERENCES reservations(id) ON DELETE RESTRICT,
  rent_override numeric(14,2) CHECK (rent_override>=0),
  source_note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookkeeping_monthly_utility_month_idx ON bookkeeping_monthly_utility_sources(billing_month,reservation_id);
ALTER TABLE monthly_meter_readings ADD COLUMN IF NOT EXISTS import_source_key text;
CREATE UNIQUE INDEX IF NOT EXISTS monthly_meter_import_source_idx ON monthly_meter_readings(import_source_key);

-- Called by the import and when an unmatched spreadsheet row is assigned.
-- Never duplicates a manual reading with the same date and value.
CREATE OR REPLACE FUNCTION sync_imported_monthly_meters(p_reservation_id bigint DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE park_today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  INSERT INTO monthly_meter_readings(reservation_id,reading,reading_date,note,import_source_key)
    SELECT u.reservation_id,u.meter_reading,u.reading_date,
      concat('Imported from ',u.source_filename,' / ',u.source_sheet,' row ',u.source_row,'. ',u.source_note),u.source_key
    FROM bookkeeping_monthly_utility_sources u
    WHERE u.reservation_id IS NOT NULL AND u.meter_reading IS NOT NULL AND u.reading_date IS NOT NULL AND u.reading_date<=park_today
      AND (p_reservation_id IS NULL OR u.reservation_id=p_reservation_id)
      AND NOT EXISTS (SELECT 1 FROM monthly_meter_readings m WHERE m.reservation_id=u.reservation_id AND m.reading_date=u.reading_date AND m.reading=u.meter_reading)
    ON CONFLICT(import_source_key) DO NOTHING;

  UPDATE reservations r SET monthly_classification=true
    WHERE EXISTS (SELECT 1 FROM bookkeeping_monthly_utility_sources u WHERE u.reservation_id=r.id)
      AND (p_reservation_id IS NULL OR r.id=p_reservation_id);
  -- A future reading must not replace today's current meter. Existing newer
  -- manual readings take priority by date, regardless of the import order.
  UPDATE reservations r SET electric_meter_reading=latest.reading
    FROM (SELECT DISTINCT ON (m.reservation_id) m.reservation_id,m.reading
      FROM monthly_meter_readings m WHERE m.reading_date<=park_today
        AND (p_reservation_id IS NULL OR m.reservation_id=p_reservation_id)
        AND EXISTS (SELECT 1 FROM bookkeeping_monthly_utility_sources u WHERE u.reservation_id=m.reservation_id)
      ORDER BY m.reservation_id,m.reading_date DESC,m.id DESC) latest
    WHERE r.id=latest.reservation_id;
END;
$$;
COMMIT;
