-- Apply before deploying manual monthly classification / Combine bookings.
BEGIN;
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS monthly_classification boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_pricing_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS merged_into_reservation_id bigint REFERENCES reservations(id);
CREATE INDEX IF NOT EXISTS reservations_merged_into_idx ON reservations(merged_into_reservation_id)
  WHERE merged_into_reservation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS reservation_merge_events (
  id bigserial PRIMARY KEY,
  primary_reservation_id bigint NOT NULL REFERENCES reservations(id),
  source_reservation_id bigint NOT NULL UNIQUE REFERENCES reservations(id),
  primary_before jsonb NOT NULL,
  source_before jsonb NOT NULL,
  admin_user_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (primary_reservation_id<>source_reservation_id)
);
COMMIT;
