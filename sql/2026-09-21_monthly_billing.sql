-- Monthly billing defaults, per-site overrides, billing day, and meter history.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS monthly_billing_day integer,
  ADD COLUMN IF NOT EXISTS monthly_summer_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS monthly_winter_rate numeric(10,2);

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS monthly_summer_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS monthly_winter_rate numeric(10,2);

CREATE TABLE IF NOT EXISTS monthly_rate_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  on_river_summer_rate numeric(10,2) NOT NULL DEFAULT 1100,
  on_river_winter_rate numeric(10,2) NOT NULL DEFAULT 700,
  off_river_summer_rate numeric(10,2) NOT NULL DEFAULT 900,
  off_river_winter_rate numeric(10,2) NOT NULL DEFAULT 600,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO monthly_rate_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS monthly_meter_readings (
  id bigserial PRIMARY KEY,
  reservation_id bigint NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  reading numeric(12,2) NOT NULL CHECK (reading >= 0),
  reading_date date NOT NULL DEFAULT CURRENT_DATE,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monthly_meter_readings_reservation_date_idx
  ON monthly_meter_readings (reservation_id, reading_date DESC, id DESC);
