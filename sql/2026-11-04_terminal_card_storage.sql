-- Opt-in evidence and durable recovery for cards remembered during a terminal payment.
-- This neither saves existing cards nor collects any payments.
BEGIN;
CREATE TABLE IF NOT EXISTS terminal_card_save_requests (
  stripe_payment_intent_id text PRIMARY KEY,
  reservation_id bigint NOT NULL REFERENCES reservations(id),
  customer_id bigint NOT NULL REFERENCES customers(id),
  stripe_customer_id text NOT NULL,
  consent_at timestamptz NOT NULL,
  consent_version text NOT NULL,
  consent_text text NOT NULL,
  admin_user_id bigint REFERENCES admin_users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','saved','unavailable')),
  stripe_payment_method_id text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terminal_card_save_pending_idx ON terminal_card_save_requests(customer_id,created_at) WHERE completed_at IS NULL;
COMMIT;
