-- Allow one signed check-in for each separate stay on a reservation.
-- Review and run this file once against the Riverpark PostgreSQL database.

BEGIN;

ALTER TABLE reservation_check_ins
  ADD COLUMN IF NOT EXISTS reservation_site_stay_id BIGINT;

-- Existing check-ins belong to the reservation's earliest stay.
UPDATE reservation_check_ins check_in
SET reservation_site_stay_id = (
  SELECT stay.id
  FROM reservation_site_stays stay
  WHERE stay.reservation_id = check_in.reservation_id
  ORDER BY stay.arrival_date, stay.id
  LIMIT 1
)
WHERE check_in.reservation_site_stay_id IS NULL;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_record.conname
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid = 'reservation_check_ins'::regclass
      AND constraint_record.contype = 'u'
      AND constraint_record.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_attribute attribute
          WHERE attribute.attrelid = 'reservation_check_ins'::regclass
            AND attribute.attname = 'reservation_id'
        )
      ]::SMALLINT[]
  LOOP
    EXECUTE format(
      'ALTER TABLE reservation_check_ins DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$$;

-- Covers the conventional name if reservation_id was protected by a standalone
-- unique index instead of a table constraint.
DROP INDEX IF EXISTS reservation_check_ins_reservation_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'reservation_check_ins'::regclass
      AND conname = 'reservation_check_ins_site_stay_fk'
  ) THEN
    ALTER TABLE reservation_check_ins
      ADD CONSTRAINT reservation_check_ins_site_stay_fk
      FOREIGN KEY (reservation_site_stay_id)
      REFERENCES reservation_site_stays(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS reservation_check_ins_site_stay_unique
  ON reservation_check_ins (reservation_site_stay_id);

CREATE INDEX IF NOT EXISTS reservation_check_ins_reservation_id_idx
  ON reservation_check_ins (reservation_id);

COMMIT;
