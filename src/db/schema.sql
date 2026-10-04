CREATE TYPE reservation_status AS ENUM ('confirmed', 'cancelled');
CREATE TYPE seat_status AS ENUM ('available', 'confirmed');

CREATE TABLE IF NOT EXISTS shows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  price_paise BIGINT NOT NULL,
  per_user_limit INT NOT NULL DEFAULT 4,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id UUID NOT NULL REFERENCES shows(id),
  user_id VARCHAR(255) NOT NULL,
  status reservation_status NOT NULL DEFAULT 'confirmed',
  amount_paise BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS show_seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id UUID NOT NULL REFERENCES shows(id),
  seat_number VARCHAR(50) NOT NULL,
  status seat_status NOT NULL DEFAULT 'available',
  reservation_id UUID REFERENCES reservations(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (show_id, seat_number),
  CHECK (
    (status = 'available' AND reservation_id IS NULL) OR 
    (status = 'confirmed' AND reservation_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  show_id UUID NOT NULL REFERENCES shows(id),
  request_hash VARCHAR(64) NOT NULL,
  response_status INT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_show_seats_lookup ON show_seats(show_id, seat_number);
CREATE INDEX IF NOT EXISTS idx_reservations_user ON reservations(show_id, user_id);