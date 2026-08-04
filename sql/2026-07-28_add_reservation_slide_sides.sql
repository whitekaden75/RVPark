ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS slide_driver_side boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS slide_passenger_side boolean NOT NULL DEFAULT false;
