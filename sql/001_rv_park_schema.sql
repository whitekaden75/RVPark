CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS rv_sites (
  id BIGSERIAL PRIMARY KEY,
  site_number TEXT NOT NULL UNIQUE,
  size_feet INTEGER NOT NULL CHECK (size_feet > 0),
  is_on_river BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone_number TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  booked_date DATE NOT NULL,
  rv_kind TEXT NOT NULL CHECK (
    rv_kind IN ('camper', 'van', '5th wheel', 'motor home', 'trailer')
  ),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservation_site_stays (
  id BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  site_id BIGINT NOT NULL REFERENCES rv_sites(id) ON DELETE RESTRICT,
  arrival_date DATE NOT NULL,
  leave_date DATE NOT NULL,
  CHECK (arrival_date < leave_date)
);

ALTER TABLE reservation_site_stays
  DROP CONSTRAINT IF EXISTS reservation_site_stays_no_overlap;

ALTER TABLE reservation_site_stays
  ADD CONSTRAINT reservation_site_stays_no_overlap
  EXCLUDE USING gist (
    site_id WITH =,
    daterange(arrival_date, leave_date, '[)') WITH &&
  );

CREATE INDEX IF NOT EXISTS idx_reservations_customer_id
  ON reservations(customer_id);

CREATE INDEX IF NOT EXISTS idx_reservation_site_stays_reservation_id
  ON reservation_site_stays(reservation_id);

CREATE INDEX IF NOT EXISTS idx_reservation_site_stays_site_id
  ON reservation_site_stays(site_id);

CREATE INDEX IF NOT EXISTS idx_reservation_site_stays_dates
  ON reservation_site_stays(arrival_date, leave_date);
