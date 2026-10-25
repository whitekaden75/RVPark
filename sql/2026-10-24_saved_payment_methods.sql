BEGIN;

ALTER TABLE public_booking_checkouts ALTER COLUMN payment_method_storage_consent_at DROP NOT NULL;

-- Stripe holds the sensitive payment details. Only reusable references and
-- consent evidence belong in this database.
CREATE TABLE IF NOT EXISTS reservation_saved_payment_methods (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  reservation_id BIGINT REFERENCES reservations(id) ON DELETE SET NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_payment_method_id TEXT NOT NULL,
  payment_method_type TEXT NOT NULL CHECK (payment_method_type IN ('card', 'us_bank_account')),
  brand TEXT,
  last4 TEXT,
  exp_month INTEGER,
  exp_year INTEGER,
  consent_at TIMESTAMPTZ NOT NULL,
  consent_version TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  source TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, stripe_payment_method_id)
);

CREATE TABLE IF NOT EXISTS payment_method_save_sessions (
  stripe_checkout_session_id TEXT PRIMARY KEY,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  stripe_customer_id TEXT NOT NULL,
  consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consent_version TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saved_payment_charge_requests (
  request_id UUID PRIMARY KEY,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id),
  saved_payment_method_id BIGINT NOT NULL REFERENCES reservation_saved_payment_methods(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT NOT NULL,
  approval_note TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing online bookings already captured explicit storage authorization.
-- Keep that original timestamp; do not manufacture consent for older payments.
INSERT INTO reservation_saved_payment_methods (
  customer_id, reservation_id, stripe_customer_id, stripe_payment_method_id,
  payment_method_type, brand, last4, exp_month, exp_year,
  consent_at, consent_version, consent_text, source
)
SELECT r.customer_id, p.reservation_id, p.stripe_customer_id, p.stripe_payment_method_id,
       p.stripe_payment_method_type, p.payment_method_brand, p.payment_method_last4,
       p.payment_method_exp_month, p.payment_method_exp_year,
       p.payment_method_storage_consent_at, '2026-08-15',
       'I authorize the secure saving of my payment method for future reservation-related payments. Saving it does not authorize a new charge without my separate approval.',
       'existing_online_booking'
FROM stripe_payment_records p JOIN reservations r ON r.id = p.reservation_id
WHERE p.payment_method_storage_consent_at IS NOT NULL
  AND p.stripe_customer_id IS NOT NULL AND p.stripe_payment_method_id IS NOT NULL
  AND p.stripe_payment_method_type IN ('card', 'us_bank_account')
ON CONFLICT (customer_id, stripe_payment_method_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS saved_methods_customer_idx ON reservation_saved_payment_methods(customer_id);
CREATE INDEX IF NOT EXISTS save_sessions_reservation_idx ON payment_method_save_sessions(reservation_id);
COMMIT;
