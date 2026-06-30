ALTER TABLE stripe_payment_records
  ADD COLUMN IF NOT EXISTS checkout_status text,
  ADD COLUMN IF NOT EXISTS stripe_charge_id text,
  ADD COLUMN IF NOT EXISTS stripe_customer_email text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_type text,
  ADD COLUMN IF NOT EXISTS amount_received_cents integer,
  ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_event_id text,
  ADD COLUMN IF NOT EXISTS last_event_type text,
  ADD COLUMN IF NOT EXISTS last_event_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_message text;

CREATE INDEX IF NOT EXISTS stripe_payment_records_checkout_session_idx
  ON stripe_payment_records (stripe_checkout_session_id);

CREATE INDEX IF NOT EXISTS stripe_payment_records_payment_intent_idx
  ON stripe_payment_records (stripe_payment_intent_id);

CREATE INDEX IF NOT EXISTS stripe_payment_records_charge_idx
  ON stripe_payment_records (stripe_charge_id);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id bigserial PRIMARY KEY,
  stripe_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  api_version text,
  livemode boolean NOT NULL DEFAULT false,
  stripe_created_at timestamptz,
  stripe_object_id text,
  payload jsonb NOT NULL,
  processing_status text NOT NULL DEFAULT 'received',
  processing_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT stripe_webhook_events_processing_status_check
    CHECK (processing_status IN ('received', 'processed', 'failed'))
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_event_type_idx
  ON stripe_webhook_events (event_type);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_created_idx
  ON stripe_webhook_events (stripe_created_at DESC);
