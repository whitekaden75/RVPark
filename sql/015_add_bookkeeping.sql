-- Riverpark bookkeeping documents, AI extraction, approvals, and reports.
-- Run this migration once against the Railway Postgres database.
--
-- Existing admin user IDs are stored as BIGINT values intentionally without a
-- foreign key so this migration works with either INTEGER or BIGINT admin IDs.
-- The application still validates the admin session before every write.

BEGIN;

CREATE TABLE IF NOT EXISTS bookkeeping_documents (
  id BIGSERIAL PRIMARY KEY,
  uploaded_by_admin_user_id BIGINT,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  sha256_hash TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'other'
    CHECK (document_type IN ('receipt', 'bank_statement', 'credit_card_statement', 'invoice', 'tax_document', 'other')),
  processing_status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (processing_status IN ('uploaded', 'queued', 'processing', 'needs_review', 'approved', 'rejected', 'failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS bookkeeping_documents_sha256_hash_idx
  ON bookkeeping_documents (sha256_hash);
CREATE INDEX IF NOT EXISTS bookkeeping_documents_status_idx
  ON bookkeeping_documents (processing_status, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS bookkeeping_documents_type_idx
  ON bookkeeping_documents (document_type, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS bookkeeping_extractions (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES bookkeeping_documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'openai',
  model TEXT,
  extracted_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  extraction_version TEXT,
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bookkeeping_extractions_document_idx
  ON bookkeeping_extractions (document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bookkeeping_transactions (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT REFERENCES bookkeeping_documents(id) ON DELETE SET NULL,
  uploaded_by_admin_user_id BIGINT,
  transaction_date DATE,
  vendor TEXT,
  description TEXT,
  subtotal NUMERIC(12,2) CHECK (subtotal IS NULL OR subtotal >= 0),
  tax NUMERIC(12,2) CHECK (tax IS NULL OR tax >= 0),
  total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  category TEXT,
  payment_account TEXT,
  reference_number TEXT,
  transaction_type TEXT NOT NULL DEFAULT 'expense'
    CHECK (transaction_type IN ('income', 'expense', 'transfer', 'refund', 'adjustment')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'void')),
  ai_confidence NUMERIC(5,4) CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
  notes TEXT,
  approved_by_admin_user_id BIGINT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bookkeeping_transactions_date_idx
  ON bookkeeping_transactions (transaction_date DESC);
CREATE INDEX IF NOT EXISTS bookkeeping_transactions_status_idx
  ON bookkeeping_transactions (status, transaction_date DESC);
CREATE INDEX IF NOT EXISTS bookkeeping_transactions_category_idx
  ON bookkeeping_transactions (category, transaction_date DESC);
CREATE INDEX IF NOT EXISTS bookkeeping_transactions_vendor_idx
  ON bookkeeping_transactions (vendor, transaction_date DESC);

CREATE TABLE IF NOT EXISTS bookkeeping_line_items (
  id BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES bookkeeping_transactions(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) CHECK (quantity IS NULL OR quantity >= 0),
  unit_price NUMERIC(12,2) CHECK (unit_price IS NULL OR unit_price >= 0),
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bookkeeping_line_items_transaction_idx
  ON bookkeeping_line_items (transaction_id);

CREATE TABLE IF NOT EXISTS bookkeeping_reports (
  id BIGSERIAL PRIMARY KEY,
  report_type TEXT NOT NULL
    CHECK (report_type IN ('profit_loss', 'cash_flow', 'expense_summary', 'reconciliation', 'tax_package', 'vendor_summary', 'custom')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_file_key TEXT,
  generated_mime_type TEXT,
  generated_by_admin_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed')),
  summary_json JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS bookkeeping_reports_period_idx
  ON bookkeeping_reports (period_start, period_end, created_at DESC);

CREATE TABLE IF NOT EXISTS bookkeeping_report_sources (
  report_id BIGINT NOT NULL REFERENCES bookkeeping_reports(id) ON DELETE CASCADE,
  transaction_id BIGINT NOT NULL REFERENCES bookkeeping_transactions(id) ON DELETE CASCADE,
  PRIMARY KEY (report_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS bookkeeping_report_sources_transaction_idx
  ON bookkeeping_report_sources (transaction_id);

CREATE TABLE IF NOT EXISTS bookkeeping_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id BIGINT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  message TEXT NOT NULL,
  referenced_document_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  referenced_transaction_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bookkeeping_chat_messages_admin_idx
  ON bookkeeping_chat_messages (admin_user_id, created_at);

CREATE OR REPLACE FUNCTION bookkeeping_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookkeeping_documents_updated_at ON bookkeeping_documents;
CREATE TRIGGER bookkeeping_documents_updated_at
  BEFORE UPDATE ON bookkeeping_documents
  FOR EACH ROW EXECUTE FUNCTION bookkeeping_set_updated_at();

DROP TRIGGER IF EXISTS bookkeeping_transactions_updated_at ON bookkeeping_transactions;
CREATE TRIGGER bookkeeping_transactions_updated_at
  BEFORE UPDATE ON bookkeeping_transactions
  FOR EACH ROW EXECUTE FUNCTION bookkeeping_set_updated_at();

COMMIT;
