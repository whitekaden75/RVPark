-- Generated from Meter Readings 2026.xlsx; August–October only.
-- Future-dated rows are retained for review; rerun after their dates to add them to meter history.
-- Both worksheet groups are monthly. November has no entered readings.
-- Run this entire file. Review unmatched rows in Bookkeeping > Lodging tax.
-- Re-running preserves reservation assignments and rent overrides.

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

INSERT INTO bookkeeping_monthly_utility_sources (source_key,source_filename,source_sheet,source_row,source_kind,site_number,guest_name,billing_month,reading_day,reading_date,meter_reading,usage_kwh,electric_amount,power_amount,gas_amount,source_note) VALUES
  ('meter-readings-2026:august:A4','Meter Readings 2026.xlsx','August',4,'rv_meter','1','Amparan/Edwards','2026-08-01',1,'2026-08-01',2048.0,1594.0,195.98,NULL,NULL,''),
  ('meter-readings-2026:august:A5','Meter Readings 2026.xlsx','August',5,'rv_meter','3','Huffman','2026-08-01',1,'2026-08-01',54107.0,601.0,27.17,NULL,NULL,''),
  ('meter-readings-2026:august:A6','Meter Readings 2026.xlsx','August',6,'rv_meter','7','Townsend','2026-08-01',1,'2026-08-01',68553.0,449.0,1.33,NULL,NULL,''),
  ('meter-readings-2026:august:A7','Meter Readings 2026.xlsx','August',7,'rv_meter','26','Sandiford','2026-08-01',1,'2026-08-01',15585.0,498.0,9.66,NULL,NULL,''),
  ('meter-readings-2026:august:A8','Meter Readings 2026.xlsx','August',8,'rv_meter','28','Moodie','2026-08-01',1,'2026-08-01',7012.0,879.0,74.43,NULL,NULL,''),
  ('meter-readings-2026:august:A9','Meter Readings 2026.xlsx','August',9,'rv_meter','30','Hodgson','2026-08-01',1,'2026-08-01',95854.0,300.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:august:A10','Meter Readings 2026.xlsx','August',10,'rv_meter','C','Weidner/Black','2026-08-01',1,'2026-08-01',33807.0,729.0,48.93,NULL,NULL,''),
  ('meter-readings-2026:august:A11','Meter Readings 2026.xlsx','August',11,'rv_meter','D','White','2026-08-01',1,'2026-08-01',5999.0,386.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:august:A12','Meter Readings 2026.xlsx','August',12,'rv_meter','L','Nollette','2026-08-01',1,'2026-08-01',39675.0,750.0,52.5,NULL,NULL,''),
  ('meter-readings-2026:august:A13','Meter Readings 2026.xlsx','August',13,'rv_meter','O','Morse','2026-08-01',1,'2026-08-01',39047.0,186.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:august:H4','Meter Readings 2026.xlsx','August',4,'rv_meter','2','Haag','2026-08-01',16,'2026-08-16',91140.0,636.0,33.12,NULL,NULL,''),
  ('meter-readings-2026:august:H5','Meter Readings 2026.xlsx','August',5,'rv_meter','5','Stempson','2026-08-01',14,'2026-08-14',77105.0,649.0,35.33,NULL,NULL,''),
  ('meter-readings-2026:august:H6','Meter Readings 2026.xlsx','August',6,'rv_meter','6','Brown','2026-08-01',24,'2026-08-24',44836.0,1055.0,104.35,NULL,NULL,''),
  ('meter-readings-2026:august:H7','Meter Readings 2026.xlsx','August',7,'rv_meter','16','Morton','2026-08-01',5,'2026-08-05',78249.0,629.0,31.93,NULL,NULL,''),
  ('meter-readings-2026:august:H8','Meter Readings 2026.xlsx','August',8,'rv_meter','29','Wolvers','2026-08-01',1,'2026-08-01',28594.0,680.0,40.6,NULL,NULL,''),
  ('meter-readings-2026:august:H9','Meter Readings 2026.xlsx','August',9,'rv_meter','G','Horvath/Jessup','2026-08-01',19,'2026-08-19',34119.0,669.0,38.73,NULL,NULL,''),
  ('meter-readings-2026:august:H10','Meter Readings 2026.xlsx','August',10,'rv_meter','H','Shura','2026-08-01',22,'2026-08-22',60352.0,564.0,20.88,NULL,NULL,''),
  ('meter-readings-2026:august:H11','Meter Readings 2026.xlsx','August',11,'rv_meter','I','Churchill','2026-08-01',30,'2026-08-30',7121.0,912.0,80.04,NULL,NULL,''),
  ('meter-readings-2026:august:H12','Meter Readings 2026.xlsx','August',12,'rv_meter','P','Touvell','2026-08-01',1,'2026-08-01',49602.0,688.0,41.96,NULL,NULL,''),
  ('meter-readings-2026:august:O4','Meter Readings 2026.xlsx','August',4,'cabin_bill','Cabin','Voss','2026-08-01',1,'2026-08-01',NULL,NULL,68.0,44.0,24.0,'Cabin utility bills: Pacific Power plus Avista. Original bill images are not in this workbook.'),
  ('meter-readings-2026:september:A4','Meter Readings 2026.xlsx','September',4,'rv_meter','1','Amparan/Edwards','2026-09-01',1,'2026-09-01',3626.0,1578.0,193.26,NULL,NULL,''),
  ('meter-readings-2026:september:A5','Meter Readings 2026.xlsx','September',5,'rv_meter','3','Huffman','2026-09-01',1,'2026-09-01',54732.0,625.0,31.25,NULL,NULL,''),
  ('meter-readings-2026:september:A6','Meter Readings 2026.xlsx','September',6,'rv_meter','7','Townsend','2026-09-01',1,'2026-09-01',69003.0,450.0,1.5,NULL,NULL,''),
  ('meter-readings-2026:september:A7','Meter Readings 2026.xlsx','September',7,'rv_meter','24','Booker','2026-09-01',7,'2026-09-07',8639.0,493.0,8.81,NULL,NULL,''),
  ('meter-readings-2026:september:A8','Meter Readings 2026.xlsx','September',8,'rv_meter','26','Sandiford','2026-09-01',1,'2026-09-01',16069.0,484.0,7.28,NULL,NULL,''),
  ('meter-readings-2026:september:A9','Meter Readings 2026.xlsx','September',9,'rv_meter','28','Moodie','2026-09-01',1,'2026-09-01',7885.0,873.0,73.41,NULL,NULL,''),
  ('meter-readings-2026:september:A10','Meter Readings 2026.xlsx','September',10,'rv_meter','30','Hodgson','2026-09-01',1,'2026-09-01',96144.0,290.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:september:A11','Meter Readings 2026.xlsx','September',11,'rv_meter','C','Weidner/Black','2026-09-01',1,'2026-09-01',34609.0,802.0,61.34,NULL,NULL,''),
  ('meter-readings-2026:september:A12','Meter Readings 2026.xlsx','September',12,'rv_meter','D','White','2026-09-01',1,'2026-09-01',6486.0,487.0,7.79,NULL,NULL,''),
  ('meter-readings-2026:september:A13','Meter Readings 2026.xlsx','September',13,'rv_meter','L','Nollette','2026-09-01',1,'2026-09-01',40445.0,770.0,55.9,NULL,NULL,''),
  ('meter-readings-2026:september:A14','Meter Readings 2026.xlsx','September',14,'rv_meter','O','Morse','2026-09-01',1,'2026-09-01',39379.0,332.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:september:H4','Meter Readings 2026.xlsx','September',4,'rv_meter','2','Haag','2026-09-01',16,'2026-09-16',91690.0,550.0,18.5,NULL,NULL,''),
  ('meter-readings-2026:september:H5','Meter Readings 2026.xlsx','September',5,'rv_meter','16','Peterson','2026-09-01',31,NULL,NULL,NULL,NULL,NULL,NULL,'Source day 31 is not a valid date in September; verify before recording a meter date. Electric formula has no usage input; cached zero is not a confirmed bill.'),
  ('meter-readings-2026:september:H6','Meter Readings 2026.xlsx','September',6,'rv_meter','29','Wolvers','2026-09-01',1,'2026-09-01',29425.0,831.0,66.27,NULL,NULL,''),
  ('meter-readings-2026:september:H7','Meter Readings 2026.xlsx','September',7,'rv_meter','G','Horvath/Jessup','2026-09-01',19,'2026-09-19',34694.0,575.0,22.75,NULL,NULL,''),
  ('meter-readings-2026:september:H8','Meter Readings 2026.xlsx','September',8,'rv_meter','P','Touvell','2026-09-01',1,'2026-09-01',51462.0,1860.0,241.2,NULL,NULL,''),
  ('meter-readings-2026:september:H9','Meter Readings 2026.xlsx','September',9,'rv_meter','Q','Wagner','2026-09-01',1,'2026-09-01',73758.0,NULL,NULL,NULL,NULL,''),
  ('meter-readings-2026:september:H10','Meter Readings 2026.xlsx','September',10,'rv_meter','E','Cummings','2026-09-01',19,'2026-09-19',49181.0,NULL,NULL,NULL,NULL,''),
  ('meter-readings-2026:september:H11','Meter Readings 2026.xlsx','September',11,'rv_meter','M','Leson','2026-09-01',21,'2026-09-21',6664.0,NULL,NULL,NULL,NULL,''),
  ('meter-readings-2026:september:H14','Meter Readings 2026.xlsx','September',14,'deposit_note','25','Corrales','2026-09-01',12,'2026-09-12',10079.0,484.0,NULL,NULL,NULL,'Deposit note: workbook says $200 deposit went toward last month electric. This is not another current-month charge.'),
  ('meter-readings-2026:september:O4','Meter Readings 2026.xlsx','September',4,'cabin_bill','Cabin','Voss','2026-09-01',1,'2026-09-01',NULL,NULL,60.0,42.0,18.0,'Cabin utility bills: Pacific Power plus Avista. Original bill images are not in this workbook.'),
  ('meter-readings-2026:october:A4','Meter Readings 2026.xlsx','October',4,'rv_meter','1','Amparan/Edwards','2026-10-01',1,'2026-10-01',4571.0,945.0,85.65,NULL,NULL,''),
  ('meter-readings-2026:october:A5','Meter Readings 2026.xlsx','October',5,'rv_meter','3','Huffman','2026-10-01',1,'2026-10-01',55067.0,335.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:A6','Meter Readings 2026.xlsx','October',6,'rv_meter','7','Townsend','2026-10-01',1,'2026-10-01',69472.0,469.0,4.73,NULL,NULL,''),
  ('meter-readings-2026:october:A7','Meter Readings 2026.xlsx','October',7,'rv_meter','24','Booker','2026-10-01',7,'2026-10-07',9042.0,403.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:A8','Meter Readings 2026.xlsx','October',8,'rv_meter','26','Sandiford','2026-10-01',1,'2026-10-01',16251.0,182.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:A9','Meter Readings 2026.xlsx','October',9,'rv_meter','28','Moodie','2026-10-01',1,'2026-10-01',8597.0,712.0,46.04,NULL,NULL,''),
  ('meter-readings-2026:october:A10','Meter Readings 2026.xlsx','October',10,'rv_meter','30','Hodgson','2026-10-01',1,'2026-10-01',96549.0,405.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:A11','Meter Readings 2026.xlsx','October',11,'rv_meter','C','Weidner/Black','2026-10-01',1,'2026-10-01',34879.0,270.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:A12','Meter Readings 2026.xlsx','October',12,'rv_meter','D','White','2026-10-01',1,'2026-10-01',6825.0,339.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:A13','Meter Readings 2026.xlsx','October',13,'rv_meter','L','Nollette','2026-10-01',1,'2026-10-01',41202.0,757.0,53.69,NULL,NULL,''),
  ('meter-readings-2026:october:A14','Meter Readings 2026.xlsx','October',14,'rv_meter','O','Morse','2026-10-01',1,'2026-10-01',39537.0,158.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:H4','Meter Readings 2026.xlsx','October',4,'rv_meter','29','Wolvers','2026-10-01',1,'2026-10-01',29874.0,449.0,1.33,NULL,NULL,''),
  ('meter-readings-2026:october:H5','Meter Readings 2026.xlsx','October',5,'rv_meter','9','Gong','2026-10-01',14,'2026-10-14',3964.0,4322.0,659.74,NULL,NULL,'Usage exceeds current meter: possible rollover/replacement. Listed bill preserved; verify meter baseline.'),
  ('meter-readings-2026:october:H6','Meter Readings 2026.xlsx','October',6,'rv_meter','16','Peterson','2026-10-01',30,'2026-10-30',78882.0,NULL,NULL,NULL,NULL,'Electric formula has no usage input; cached zero is not a confirmed bill.'),
  ('meter-readings-2026:october:H7','Meter Readings 2026.xlsx','October',7,'rv_meter','E','Cummings','2026-10-01',1,'2026-10-01',49529.0,348.0,29.16,NULL,NULL,'Spreadsheet uses an adjusted electric allowance; listed charge preserved.'),
  ('meter-readings-2026:october:H8','Meter Readings 2026.xlsx','October',8,'rv_meter','F','Swartzendruber','2026-10-01',1,'2026-10-01',4508.0,71.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:H9','Meter Readings 2026.xlsx','October',9,'rv_meter','P','Touvell','2026-10-01',1,'2026-10-01',52463.0,1001.0,95.17,NULL,NULL,''),
  ('meter-readings-2026:october:H10','Meter Readings 2026.xlsx','October',10,'rv_meter','Q','Wagner','2026-10-01',1,'2026-10-01',74125.0,367.0,39.89,NULL,NULL,'Spreadsheet uses an adjusted electric allowance; listed charge preserved.'),
  ('meter-readings-2026:october:H11','Meter Readings 2026.xlsx','October',11,'rv_meter','M','Leson','2026-10-01',1,'2026-10-01',6686.0,22.0,0.0,NULL,NULL,''),
  ('meter-readings-2026:october:H14','Meter Readings 2026.xlsx','October',14,'deposit_note','25','Corrales','2026-10-01',12,NULL,10079.0,484.0,NULL,NULL,NULL,'Deposit note: workbook says $200 deposit went toward last month electric. This is not another current-month charge. Same meter and usage repeated from September; verify the reading date.'),
  ('meter-readings-2026:october:O4','Meter Readings 2026.xlsx','October',4,'cabin_bill','Cabin','Voss','2026-10-01',1,'2026-10-01',NULL,NULL,56.0,35.0,21.0,'Cabin utility bills: Pacific Power plus Avista. Original bill images are not in this workbook.')
ON CONFLICT(source_key) DO NOTHING;

-- Auto-link only a unique surname + site + occupancy match. Never guess
-- between two bookings, create guests, or assign by site number alone.
WITH candidates AS (
  SELECT u.id,array_agg(DISTINCT r.id) AS ids
  FROM bookkeeping_monthly_utility_sources u
  JOIN rv_sites site ON upper(trim(site.site_number::text))=upper(trim(u.site_number))
  JOIN reservation_site_stays st ON st.site_id=site.id
    AND st.arrival_date < (u.billing_month+interval '1 month')::date AND st.leave_date>u.billing_month
    AND (u.reading_date IS NULL OR (st.arrival_date<=u.reading_date AND st.leave_date>=u.reading_date))
  JOIN reservations r ON r.id=st.reservation_id AND to_jsonb(r)->>'merged_into_reservation_id' IS NULL
  JOIN customers c ON c.id=r.customer_id
    AND regexp_replace(lower(c.last_name),'[^a-z0-9]','','g')=ANY(
      regexp_split_to_array(regexp_replace(lower(u.guest_name),'[^a-z0-9/ ]','','g'),'[/ ]+'))
  WHERE u.reservation_id IS NULL
  GROUP BY u.id HAVING count(DISTINCT r.id)=1
)
UPDATE bookkeeping_monthly_utility_sources u SET reservation_id=c.ids[1],updated_at=now()
  FROM candidates c WHERE u.id=c.id;

SELECT sync_imported_monthly_meters();
COMMIT;

-- Import results. Unmatched names/sites remain visible for manual assignment.
SELECT source_sheet,source_kind,count(*) AS source_rows,
  count(reservation_id) AS linked_rows,count(*) FILTER(WHERE reservation_id IS NULL) AS needs_assignment,
  count(*) FILTER(WHERE meter_reading IS NOT NULL AND reading_date IS NOT NULL) AS dated_meter_rows,
  sum(electric_amount) AS listed_utility_charges
FROM bookkeeping_monthly_utility_sources WHERE source_filename='Meter Readings 2026.xlsx'
GROUP BY source_sheet,source_kind ORDER BY min(billing_month),source_kind;

SELECT id,source_sheet,site_number,guest_name,reading_day,meter_reading,electric_amount,source_note
FROM bookkeeping_monthly_utility_sources
WHERE reservation_id IS NULL OR source_note<>'' ORDER BY billing_month,source_kind,site_number;
