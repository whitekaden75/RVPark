-- Run once in the existing Railway PostgreSQL database before deploying.
-- Existing bookkeeping documents, categories and transactions are preserved.
BEGIN;
-- Manual entries do not need an uploaded source document.
ALTER TABLE bookkeeping_transactions ALTER COLUMN document_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS bookkeeping_stripe_activity (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  available_at timestamptz,
  currency text NOT NULL,
  amount_cents bigint NOT NULL,
  fee_cents bigint NOT NULL,
  net_cents bigint NOT NULL,
  activity_type text NOT NULL,
  reporting_category text NOT NULL,
  description text,
  source_id text,
  payment_intent_id text,
  reservation_id bigint,
  balance_status text NOT NULL,
  livemode boolean NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookkeeping_stripe_activity_date_idx ON bookkeeping_stripe_activity (livemode, occurred_at);
CREATE INDEX IF NOT EXISTS bookkeeping_stripe_activity_source_idx ON bookkeeping_stripe_activity (source_id);

CREATE TABLE IF NOT EXISTS bookkeeping_finance_sync (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_synced_at timestamptz,
  period_start date,
  period_end date,
  imported_count integer NOT NULL DEFAULT 0,
  last_error text
);
ALTER TABLE bookkeeping_finance_sync ADD COLUMN IF NOT EXISTS available_cents bigint;
ALTER TABLE bookkeeping_finance_sync ADD COLUMN IF NOT EXISTS pending_cents bigint;
ALTER TABLE bookkeeping_finance_sync ADD COLUMN IF NOT EXISTS balance_retrieved_at timestamptz;
ALTER TABLE bookkeeping_finance_sync ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;
INSERT INTO bookkeeping_finance_sync (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Consolidation keeps the source records and a reversible audit trail.
CREATE TABLE IF NOT EXISTS bookkeeping_consolidations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  duplicate_transaction_id bigint NOT NULL UNIQUE REFERENCES bookkeeping_transactions(id) ON DELETE RESTRICT,
  keeper_transaction_id bigint REFERENCES bookkeeping_transactions(id) ON DELETE RESTRICT,
  stripe_activity_id text REFERENCES bookkeeping_stripe_activity(id) ON DELETE RESTRICT,
  previous_status text NOT NULL,
  reason text NOT NULL,
  created_by_admin_user_id bigint NOT NULL REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((keeper_transaction_id IS NOT NULL)::integer + (stripe_activity_id IS NOT NULL)::integer = 1),
  CHECK (keeper_transaction_id <> duplicate_transaction_id)
);
CREATE INDEX IF NOT EXISTS bookkeeping_consolidations_keeper_idx ON bookkeeping_consolidations (keeper_transaction_id);
CREATE INDEX IF NOT EXISTS bookkeeping_consolidations_stripe_idx ON bookkeeping_consolidations (stripe_activity_id);
CREATE INDEX IF NOT EXISTS bookkeeping_consolidations_admin_idx ON bookkeeping_consolidations (created_by_admin_user_id);

CREATE TABLE IF NOT EXISTS bookkeeping_bills (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor text NOT NULL,
  description text NOT NULL DEFAULT '',
  bill_date date NOT NULL,
  due_date date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  category text,
  document_id bigint REFERENCES bookkeeping_documents(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'void')),
  paid_transaction_id bigint REFERENCES bookkeeping_transactions(id) ON DELETE RESTRICT,
  created_by_admin_user_id bigint NOT NULL REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookkeeping_bills_due_idx ON bookkeeping_bills (due_date) WHERE status = 'unpaid';
CREATE INDEX IF NOT EXISTS bookkeeping_bills_document_idx ON bookkeeping_bills (document_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookkeeping_bills_transaction_idx ON bookkeeping_bills (paid_transaction_id) WHERE paid_transaction_id IS NOT NULL AND status='paid';
CREATE INDEX IF NOT EXISTS bookkeeping_bills_admin_idx ON bookkeeping_bills (created_by_admin_user_id);
CREATE INDEX IF NOT EXISTS bookkeeping_transactions_date_status_idx ON bookkeeping_transactions (transaction_date, status);
CREATE INDEX IF NOT EXISTS bookkeeping_transactions_pending_idx ON bookkeeping_transactions (id DESC) WHERE status='pending';

-- Guard linked financial records even when an older admin endpoint is used.
CREATE OR REPLACE FUNCTION protect_bookkeeping_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  amount_changed boolean := NEW.total IS DISTINCT FROM OLD.total OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type OR upper(COALESCE(NEW.currency,'USD')) IS DISTINCT FROM upper(COALESCE(OLD.currency,'USD'));
  excluding boolean := NEW.status='void' AND OLD.status<>'void';
BEGIN
  IF (amount_changed AND EXISTS (SELECT 1 FROM bookkeeping_consolidations WHERE keeper_transaction_id=OLD.id OR duplicate_transaction_id=OLD.id))
     OR (excluding AND EXISTS (SELECT 1 FROM bookkeeping_consolidations WHERE keeper_transaction_id=OLD.id))
     OR ((amount_changed OR excluding) AND EXISTS (SELECT 1 FROM bookkeeping_bills WHERE paid_transaction_id=OLD.id AND status='paid')) THEN
    RAISE EXCEPTION 'Restore the consolidation or unlink the paid bill before changing this financial entry.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bookkeeping_link_guard ON bookkeeping_transactions;
CREATE TRIGGER bookkeeping_link_guard BEFORE UPDATE ON bookkeeping_transactions FOR EACH ROW EXECUTE FUNCTION protect_bookkeeping_links();

COMMIT;
