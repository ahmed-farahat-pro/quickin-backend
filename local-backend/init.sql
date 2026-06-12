-- =============================================================================
-- QuickIn PRODUCTION DB INIT  (run once against your Vercel/Neon Postgres)
-- Creates all tables + seeds the demo listings. Users are created on sign-up.
--   psql "$DATABASE_URL" -f local-backend/init.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()

-- ---- Tables -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  description       text,
  location          text,
  country           text,
  price_per_night   numeric NOT NULL,
  currency          text DEFAULT 'USD',
  bedrooms          int DEFAULT 1,
  beds              int DEFAULT 1,
  bathrooms         int DEFAULT 1,
  max_guests        int DEFAULT 2,
  property_type     text,
  is_guest_favorite boolean DEFAULT false,
  is_published      boolean DEFAULT true,
  listing_code      text,
  lat               double precision,
  lng               double precision,
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listing_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url         text NOT NULL,
  "order"     int DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_listing_images_listing ON listing_images(listing_id);

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text UNIQUE NOT NULL,
  password_hash   text,
  full_name       text,
  provider        text NOT NULL DEFAULT 'email',
  avatar_url      text,
  role            text NOT NULL DEFAULT 'user',   -- 'user' | 'host' | 'admin'
  email_verified  boolean NOT NULL DEFAULT false,
  otp_code        text,
  otp_expires_at  timestamptz,
  created_at      timestamptz DEFAULT now()
);
-- Idempotent upgrades for databases created before these columns existed:
ALTER TABLE users ADD COLUMN IF NOT EXISTS role           text NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code       text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at timestamptz;

CREATE TABLE IF NOT EXISTS bookings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  check_in    date NOT NULL,
  check_out   date NOT NULL,
  guests      int NOT NULL DEFAULT 1,
  total_price numeric NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'confirmed',
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_listing ON bookings(listing_id);

-- Reservation lifecycle: hosts own listings; bookings go pending -> confirmed/rejected;
-- each booking carries a short reservation_code used for the QR / wallet pass.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS host_id uuid REFERENCES users(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reservation_code text;
ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_listings_host ON listings(host_id);

-- Per-booking chat between the guest and the listing's host.
CREATE TABLE IF NOT EXISTS messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        text NOT NULL,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_booking ON messages(booking_id, created_at);

-- ---- Seed listings (only if the table is empty) -----------------------------
DO $$
DECLARE
  v_id uuid;
  rows_arr text[][] := ARRAY[
    ARRAY['Stunning Ocean View Villa','Experience ultimate beachfront luxury in this Malibu villa. Wake to panoramic ocean views, floor-to-ceiling windows, a gourmet kitchen and a private sunset deck.','Malibu, California','United States','350','USD','4','5','3','8','Villa','true','QK-MALIBU1','34.0259','-118.7798'],
    ARRAY['Cozy Mountain Cabin','A charming retreat nestled in the heart of Aspen. Mountain views from the wrap-around deck, a stone fireplace, and ski slopes minutes away.','Aspen, Colorado','United States','275','USD','3','4','2','6','House','true','QK-ASPEN01','39.1911','-106.8175'],
    ARRAY['Modern Downtown Loft','City living at its finest — a sleek Manhattan loft with floor-to-ceiling windows, steps from world-class dining and entertainment.','New York City, New York','United States','420','USD','2','2','2','4','Apartment','true','QK-NYC0001','40.7128','-74.0060'],
    ARRAY['Tropical Paradise Bungalow','Your island escape — a beachfront bungalow steps from pristine white sand and crystal-clear water. Perfect for a romantic getaway.','Koh Samui','Thailand','180','USD','2','2','1','4','Guest House','false','QK-SAMUI01','9.5120','100.0136'],
    ARRAY['Historic Tuscan Farmhouse','A beautifully restored 18th-century farmhouse surrounded by olive groves and vineyards with breathtaking views of the Tuscan hills.','Florence','Italy','295','USD','5','6','4','10','House','false','QK-TUSCAN1','43.7696','11.2558'],
    ARRAY['Lakeside Retreat','Serenity by the lake — an elegant villa with private boat dock and stunning mountain views across the water.','Lake Como','Italy','450','USD','4','5','3','8','Villa','true','QK-COMO001','45.9844','9.2572'],
    ARRAY['Desert Oasis Home','Modern desert living with sunset views, a private pool and hot tub, and seamless indoor-outdoor living in the Sonoran Desert.','Scottsdale, Arizona','United States','225','USD','3','4','2','6','House','false','QK-SCOTTS1','33.4942','-111.9261'],
    ARRAY['Beachfront Cottage','Wake to ocean views in this charming cottage with direct beach access. Enjoy the laid-back Byron Bay surf lifestyle.','Byron Bay','Australia','320','USD','3','4','2','6','House','false','QK-BYRON01','-28.6474','153.6020']
  ];
  img_sets text[][] := ARRAY[
    ARRAY['photo-1499793983690-e29da59ef1c2','photo-1600596542815-ffad4c1539a9','photo-1600607687939-ce8a6c25118c','photo-1613977257363-707ba9348227'],
    ARRAY['photo-1518780664697-55e3ad937233','photo-1449158743715-0a90ebb6d2d8','photo-1551524559-8af4e6624178','photo-1564013799919-ab600027ffc6'],
    ARRAY['photo-1502672260266-1c1ef2d93688','photo-1560448204-e02f11c3d0e2','photo-1505691938895-1758d7feb511','photo-1493809842364-78817add7ffb'],
    ARRAY['photo-1540541338287-41700207dee6','photo-1582719508461-905c673771fd','photo-1571003123894-1f0594d2b5d9','photo-1520250497591-112f2f40a3f4'],
    ARRAY['photo-1523217582562-09d0def993a6','photo-1564501049412-61c2a3083791','photo-1576013551627-0cc20b96c2a7','photo-1505691938895-1758d7feb511'],
    ARRAY['photo-1564013799919-ab600027ffc6','photo-1502005229762-cf1b2da7c5d6','photo-1512917774080-9991f1c4c750','photo-1600585154340-be6161a56a0c'],
    ARRAY['photo-1613490493576-7fde63acd811','photo-1600047509807-ba8f99d2cdde','photo-1600566753086-00f18fb6b3ea','photo-1600210492493-0946911123ea'],
    ARRAY['photo-1600596542815-ffad4c1539a9','photo-1582268611958-ebfd161ef9cf','photo-1505693416388-ac5ce068fe85','photo-1502672260266-1c1ef2d93688']
  ];
  i int; j int;
BEGIN
  IF (SELECT count(*) FROM listings) > 0 THEN RAISE NOTICE 'listings already seeded; skipping'; RETURN; END IF;
  FOR i IN 1 .. array_length(rows_arr,1) LOOP
    INSERT INTO listings (title, description, location, country, price_per_night, currency,
                          bedrooms, beds, bathrooms, max_guests, property_type,
                          is_guest_favorite, listing_code, lat, lng)
    VALUES (rows_arr[i][1], rows_arr[i][2], rows_arr[i][3], rows_arr[i][4],
            rows_arr[i][5]::numeric, rows_arr[i][6],
            rows_arr[i][7]::int, rows_arr[i][8]::int, rows_arr[i][9]::int, rows_arr[i][10]::int,
            rows_arr[i][11], rows_arr[i][12]::boolean, rows_arr[i][13],
            rows_arr[i][14]::float8, rows_arr[i][15]::float8)
    RETURNING id INTO v_id;
    FOR j IN 1 .. array_length(img_sets,2) LOOP
      INSERT INTO listing_images (listing_id, url, "order")
      VALUES (v_id, 'https://images.unsplash.com/' || img_sets[i][j] || '?w=1200&q=80', j-1);
    END LOOP;
  END LOOP;
  RAISE NOTICE 'seeded % listings', array_length(rows_arr,1);
END $$;

-- Services: a host offers a standalone experience (jet ski, diving, tour …); a user
-- "subscribes"/requests it and, like a booking, it goes pending -> confirmed/rejected.
CREATE TABLE IF NOT EXISTS services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  category     text,
  location     text,
  price        numeric NOT NULL DEFAULT 0,
  currency     text DEFAULT 'USD',
  image_url    text,
  lat          double precision,
  lng          double precision,
  is_published boolean DEFAULT true,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_host ON services(host_id);

CREATE TABLE IF NOT EXISTS service_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id     uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending',
  preferred_date date,
  note           text,
  request_code   text,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_requests_user ON service_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_service_requests_service ON service_requests(service_id);
