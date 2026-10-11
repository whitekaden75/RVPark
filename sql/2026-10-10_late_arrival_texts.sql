-- Apply once to the existing database before deploying the automatic late-arrival texts.
-- Uses the existing reservations, customers, site stays, check-ins and text_messages tables.
BEGIN;
CREATE TABLE IF NOT EXISTS late_arrival_texts (
  reservation_id bigint NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  arrival_date date NOT NULL,
  state text NOT NULL CHECK (state IN ('sending', 'sent', 'failed', 'review')),
  automatic boolean NOT NULL DEFAULT true,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  retryable boolean NOT NULL DEFAULT false,
  message_sid text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, arrival_date)
);
CREATE INDEX IF NOT EXISTS late_arrival_texts_sending_idx
  ON late_arrival_texts (updated_at) WHERE state='sending';
CREATE INDEX IF NOT EXISTS reservations_late_arrival_created_idx
  ON reservations (created_at, id) WHERE status IN ('active', 'pending');
COMMIT;
