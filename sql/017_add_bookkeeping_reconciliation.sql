BEGIN;

CREATE TABLE IF NOT EXISTS bookkeeping_reconciliation_runs (
  id BIGSERIAL PRIMARY KEY,
  statement_document_id BIGINT NOT NULL REFERENCES bookkeeping_documents(id) ON DELETE CASCADE,
  created_by_admin_user_id BIGINT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookkeeping_reconciliation_matches (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES bookkeeping_reconciliation_runs(id) ON DELETE CASCADE,
  statement_transaction_id BIGINT NOT NULL REFERENCES bookkeeping_transactions(id) ON DELETE CASCADE,
  receipt_transaction_id BIGINT REFERENCES bookkeeping_transactions(id) ON DELETE SET NULL,
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'unmatched_statement', 'unmatched_receipt', 'possible_match')),
  match_score NUMERIC(5,4),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bookkeeping_reconciliation_runs_statement_idx
  ON bookkeeping_reconciliation_runs (statement_document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookkeeping_reconciliation_matches_run_idx
  ON bookkeeping_reconciliation_matches (run_id, match_status);

COMMIT;
