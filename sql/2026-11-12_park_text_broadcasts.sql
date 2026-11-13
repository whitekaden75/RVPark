-- Run before deploying the "Text everyone in the park" section.
-- This only creates announcement history; it does not send any messages.
BEGIN;
CREATE TABLE IF NOT EXISTS park_text_broadcasts (
  id uuid PRIMARY KEY,
  park_date date NOT NULL,
  fingerprint text NOT NULL,
  body text NOT NULL,
  state text NOT NULL CHECK (state IN ('sending', 'complete', 'review')),
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
