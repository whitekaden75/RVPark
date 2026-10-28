"""Extract the supplied workbook without editing it; write an idempotent SQL import.

Run with the bundled Python runtime (openpyxl). The output includes the schema
migration so the office can run one file in its SQL console.
"""
import calendar
import datetime as dt
import json
import math
import re
import sys
from pathlib import Path

import openpyxl

source = Path(sys.argv[1])
root = Path(__file__).resolve().parents[2]
destination = root / 'sql/2026-10-27_import_meter_readings_2026.sql'
values = openpyxl.load_workbook(source, data_only=True, read_only=True)
formulas = openpyxl.load_workbook(source, data_only=False, read_only=True)
records = []


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) and value >= 0 else None
    except (TypeError, ValueError):
        return None


def text(value):
    return str(int(value)) if isinstance(value, (int, float)) else str(value or '').strip()


for sheet in values:
    month = sheet['A1'].value
    if not isinstance(month, dt.datetime):
        raise ValueError(f'Missing month on {sheet.title}')
    for section, offset in [('A', 0), ('H', 7)]:
        for row_number, cells in enumerate(sheet.iter_rows(min_row=4, max_col=19), 4):
            row = [cell.value for cell in cells]
            site, day, guest, electric, meter, usage = row[offset:offset+6]
            if not guest or not re.fullmatch(r'(?:\d+|[A-Z])', text(site)):
                continue
            meter, usage, electric = number(meter), number(usage), number(electric)
            # Empty November formulas cache zero/negative values; these are not readings.
            if month.month == 11 and meter is None and electric in (None, 0):
                continue
            notes = []
            day = int(day) if number(day) is not None else None
            date = None
            if day and 1 <= day <= calendar.monthrange(month.year, month.month)[1]:
                date = month.replace(day=day).date().isoformat()
            else:
                notes.append(f'Source day {day} is not a valid date in {sheet.title}; verify before recording a meter date.')
            electric_cell = f'{openpyxl.utils.get_column_letter(offset+4)}{row_number}'
            electric_formula = formulas[sheet.title][electric_cell].value
            if isinstance(electric_formula, str) and electric_formula.startswith('=') and usage is None:
                electric = None
                notes.append('Electric formula has no usage input; cached zero is not a confirmed bill.')
            kind = 'deposit_note' if row_number >= 14 and section == 'H' and sheet.title in ('September', 'October') else 'rv_meter'
            if kind == 'deposit_note':
                electric = None
                notes.append('Deposit note: workbook says $200 deposit went toward last month electric. This is not another current-month charge.')
                if sheet.title == 'October':
                    notes.append('Same meter and usage repeated from September; verify the reading date.')
                    date = None
            if meter is not None and usage is not None and usage > meter:
                notes.append('Usage exceeds current meter: possible rollover/replacement. Listed bill preserved; verify meter baseline.')
            if electric is not None and usage is not None and abs(electric-max(usage*.17-75, 0)) > .011:
                notes.append('Spreadsheet uses an adjusted electric allowance; listed charge preserved.')
            records.append(dict(source_key=f'meter-readings-2026:{sheet.title.lower()}:{section}{row_number}', source_filename=source.name,
                source_sheet=sheet.title, source_row=row_number, source_kind=kind, site_number=text(site), guest_name=str(guest),
                billing_month=month.date().isoformat(), reading_day=day, reading_date=date, meter_reading=meter, usage_kwh=usage,
                electric_amount=electric, power_amount=None, gas_amount=None, source_note=' '.join(notes)))
    # The cabin lists utility bills, not a cumulative meter. Keep each component.
    power, gas = number(sheet['Q4'].value), number(sheet['R4'].value)
    if power is not None or gas is not None:
        records.append(dict(source_key=f'meter-readings-2026:{sheet.title.lower()}:O4', source_filename=source.name,
            source_sheet=sheet.title, source_row=4, source_kind='cabin_bill', site_number='Cabin', guest_name=str(sheet['P4'].value),
            billing_month=month.date().isoformat(), reading_day=1, reading_date=month.date().isoformat(), meter_reading=None, usage_kwh=None,
            electric_amount=round(power+gas, 2) if power is not None and gas is not None else None, power_amount=power, gas_amount=gas,
            source_note='Cabin utility bills: Pacific Power plus Avista. Original bill images are not in this workbook.'))


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


columns = list(records[0])
migration = (root / 'sql/2026-10-27_lodging_tax_report.sql').read_text()
sql = '-- Generated from Meter Readings 2026.xlsx; August–October only.\n'
sql += '-- Both worksheet groups are monthly. November has no entered readings.\n'
sql += '-- Run this entire file. Review unmatched rows in Bookkeeping > Lodging tax.\n'
sql += '-- Re-running preserves reservation assignments and rent overrides.\n\n' + migration.replace('COMMIT;\n', '')
sql = sql.replace('-- Both worksheet groups are monthly.', '-- Future-dated rows are retained for review; rerun after their dates to add them to meter history.\n-- Both worksheet groups are monthly.')
sql += '\nINSERT INTO bookkeeping_monthly_utility_sources (' + ','.join(columns) + ') VALUES\n'
sql += ',\n'.join('  (' + ','.join(literal(row[key]) for key in columns) + ')' for row in records)
sql += '\nON CONFLICT(source_key) DO NOTHING;\n\n'
sql += '''-- Auto-link only a unique surname + site + occupancy match. Never guess
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
'''
destination.write_text(sql)
Path('/private/tmp/rvpark-meter-import-records.json').write_text(json.dumps(records, indent=2))
print(json.dumps(dict(output=str(destination), records=len(records), meter_rows=sum(r['meter_reading'] is not None and r['reading_date'] is not None for r in records),
    sources_by_sheet={name:sum(r['source_sheet']==name for r in records) for name in values.sheetnames},
    review_rows=sum(bool(r['source_note']) for r in records)), indent=2))
