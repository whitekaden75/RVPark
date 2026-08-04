CREATE TABLE IF NOT EXISTS public_booking_checkouts (
  id BIGSERIAL PRIMARY KEY,
  checkout_token TEXT NOT NULL UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  payment_method_type TEXT NOT NULL
    CHECK (payment_method_type IN ('card', 'us_bank_account')),
  payment_status TEXT NOT NULL DEFAULT 'open'
    CHECK (payment_status IN (
      'open',
      'processing',
      'paid',
      'completed',
      'failed',
      'expired',
      'conflict'
    )),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  base_deposit_amount NUMERIC(10, 2) NOT NULL CHECK (base_deposit_amount > 0),
  site_id BIGINT NOT NULL REFERENCES rv_sites(id),
  arrival_date DATE NOT NULL,
  leave_date DATE NOT NULL,
  booking_payload JSONB NOT NULL,
  reservation_id BIGINT UNIQUE REFERENCES reservations(id) ON DELETE SET NULL,
  last_error_message TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (arrival_date < leave_date)
);

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'public_booking_checkouts_no_overlapping_holds'
  ) THEN
    ALTER TABLE public_booking_checkouts
      ADD CONSTRAINT public_booking_checkouts_no_overlapping_holds
      EXCLUDE USING gist (
        site_id WITH =,
        daterange(arrival_date, leave_date, '[)') WITH &&
      )
      WHERE (payment_status IN ('open', 'processing', 'paid'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS public_booking_checkouts_active_site_dates_idx
  ON public_booking_checkouts (site_id, arrival_date, leave_date)
  WHERE payment_status IN ('open', 'processing', 'paid');

CREATE INDEX IF NOT EXISTS public_booking_checkouts_expires_at_idx
  ON public_booking_checkouts (expires_at);
