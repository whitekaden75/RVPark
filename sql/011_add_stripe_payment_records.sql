CREATE TABLE IF NOT EXISTS stripe_payment_records (
  id BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  payment_status TEXT NOT NULL,
  activate_reservation_on_payment BOOLEAN NOT NULL DEFAULT FALSE,
  checkout_url TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stripe_payment_records_reservation_id_idx
  ON stripe_payment_records (reservation_id);
