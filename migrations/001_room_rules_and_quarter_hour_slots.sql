PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE rooms ADD COLUMN slug TEXT;
ALTER TABLE rooms ADD COLUMN purpose TEXT;
ALTER TABLE rooms ADD COLUMN compact_description TEXT;
ALTER TABLE rooms ADD COLUMN recommended_uses TEXT;
ALTER TABLE rooms ADD COLUMN guidelines TEXT;
ALTER TABLE rooms ADD COLUMN booking_increment_minutes INTEGER;
ALTER TABLE rooms ADD COLUMN minimum_duration_minutes INTEGER;
ALTER TABLE rooms ADD COLUMN maximum_duration_minutes INTEGER;
ALTER TABLE rooms ADD COLUMN allowed_durations_minutes TEXT;
ALTER TABLE rooms ADD COLUMN capacity_label TEXT;

UPDATE rooms SET
  slug = id,
  purpose = name,
  compact_description = name,
  recommended_uses = '[]',
  guidelines = '[]',
  booking_increment_minutes = 15,
  minimum_duration_minutes = 15,
  maximum_duration_minutes = 120,
  allowed_durations_minutes = NULL,
  capacity_label = '',
  enabled = 0;

CREATE UNIQUE INDEX rooms_slug_unique ON rooms(slug);

DROP INDEX IF EXISTS bookings_availability;
DROP TRIGGER IF EXISTS bookings_prevent_overlap_insert;
DROP TRIGGER IF EXISTS bookings_prevent_overlap_update;
DROP TRIGGER IF EXISTS bookings_validate_duration_insert;
DROP TRIGGER IF EXISTS bookings_validate_duration_update;

ALTER TABLE bookings RENAME TO bookings_v0;

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  booking_date TEXT NOT NULL,
  start_slot INTEGER NOT NULL CHECK (start_slot >= 0 AND start_slot < 40),
  end_slot INTEGER NOT NULL CHECK (end_slot > start_slot AND end_slot <= 40),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
  email TEXT NOT NULL DEFAULT '' CHECK (length(email) <= 120),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO bookings (
  id, token_hash, reference, room_id, booking_date, start_slot, end_slot,
  name, title, email, notes, status, created_at, updated_at
)
SELECT
  id, token_hash, reference, room_id, booking_date, start_slot * 2, end_slot * 2,
  name, title, email, notes, status, created_at, updated_at
FROM bookings_v0;

DROP TABLE bookings_v0;

CREATE TABLE room_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  block_date TEXT NOT NULL,
  start_slot INTEGER NOT NULL CHECK (start_slot >= 0 AND start_slot < 40),
  end_slot INTEGER NOT NULL CHECK (end_slot > start_slot AND end_slot <= 40),
  reason TEXT NOT NULL DEFAULT 'Unavailable',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX bookings_availability
  ON bookings (booking_date, room_id, status, start_slot, end_slot);
CREATE INDEX room_blocks_availability
  ON room_blocks (block_date, room_id, active, start_slot, end_slot);

PRAGMA user_version = 1;
