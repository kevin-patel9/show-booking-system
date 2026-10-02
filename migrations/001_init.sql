CREATE TABLE IF NOT EXISTS shows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  price_paise    bigint NOT NULL CHECK (price_paise >= 0),
  per_user_limit int NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
  total_seats    int NOT NULL CHECK (total_seats > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id      uuid NOT NULL REFERENCES shows(id),
  user_id      text NOT NULL,
  seat_names   text[] NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  status       text NOT NULL CHECK (status IN ('confirmed','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS reservations_user_idx ON reservations(user_id, show_id);

-- One row per physical seat. A seat belongs to at most one reservation at a time;
-- every transition is a guarded UPDATE under a row lock, so no double-sell.
CREATE TABLE IF NOT EXISTS seats (
  show_id        uuid NOT NULL REFERENCES shows(id),
  seat_name      text NOT NULL,
  status         text NOT NULL DEFAULT 'available' CHECK (status IN ('available','held','confirmed')),
  user_id        text,
  reservation_id uuid REFERENCES reservations(id),
  PRIMARY KEY (show_id, seat_name),
  CHECK ((status = 'available') = (reservation_id IS NULL AND user_id IS NULL))
);
CREATE INDEX IF NOT EXISTS seats_owner_idx ON seats(show_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS seats_reservation_idx ON seats(reservation_id) WHERE reservation_id IS NOT NULL;

-- Idempotency keys are scoped per user.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id        text NOT NULL,
  key            text NOT NULL,
  request_hash   text NOT NULL,
  reservation_id uuid REFERENCES reservations(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
