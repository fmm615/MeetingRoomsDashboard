PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity > 0),
  location TEXT NOT NULL DEFAULT '',
  equipment TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  purpose TEXT NOT NULL,
  compact_description TEXT NOT NULL,
  recommended_uses TEXT NOT NULL CHECK (json_valid(recommended_uses)),
  guidelines TEXT NOT NULL CHECK (json_valid(guidelines)),
  booking_increment_minutes INTEGER NOT NULL CHECK (booking_increment_minutes > 0),
  minimum_duration_minutes INTEGER,
  maximum_duration_minutes INTEGER NOT NULL CHECK (maximum_duration_minutes > 0),
  allowed_durations_minutes TEXT CHECK (
    allowed_durations_minutes IS NULL OR json_valid(allowed_durations_minutes)
  ),
  capacity_label TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bookings (
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

CREATE TABLE IF NOT EXISTS room_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  block_date TEXT NOT NULL,
  start_slot INTEGER NOT NULL CHECK (start_slot >= 0 AND start_slot < 40),
  end_slot INTEGER NOT NULL CHECK (end_slot > start_slot AND end_slot <= 40),
  reason TEXT NOT NULL DEFAULT 'Unavailable',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS bookings_availability
  ON bookings (booking_date, room_id, status, start_slot, end_slot);
CREATE INDEX IF NOT EXISTS room_blocks_availability
  ON room_blocks (block_date, room_id, active, start_slot, end_slot);

CREATE TRIGGER IF NOT EXISTS bookings_require_active_room_insert
BEFORE INSERT ON bookings
WHEN NOT EXISTS (SELECT 1 FROM rooms WHERE id = NEW.room_id AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'ROOM_INACTIVE');
END;

CREATE TRIGGER IF NOT EXISTS bookings_require_active_room_update
BEFORE UPDATE OF room_id, status ON bookings
WHEN NEW.status = 'confirmed'
  AND NOT EXISTS (SELECT 1 FROM rooms WHERE id = NEW.room_id AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'ROOM_INACTIVE');
END;

CREATE TRIGGER IF NOT EXISTS bookings_validate_room_duration_insert
BEFORE INSERT ON bookings
WHEN NOT EXISTS (
  SELECT 1
  FROM rooms room
  WHERE room.id = NEW.room_id
    AND room.enabled = 1
    AND (NEW.end_slot - NEW.start_slot) * 15
      BETWEEN COALESCE(room.minimum_duration_minutes, room.booking_increment_minutes)
      AND room.maximum_duration_minutes
    AND ((NEW.end_slot - NEW.start_slot) * 15) % room.booking_increment_minutes = 0
    AND (
      room.allowed_durations_minutes IS NULL
      OR EXISTS (
        SELECT 1 FROM json_each(room.allowed_durations_minutes)
        WHERE CAST(value AS INTEGER) = (NEW.end_slot - NEW.start_slot) * 15
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_DURATION');
END;

CREATE TRIGGER IF NOT EXISTS bookings_validate_room_duration_update
BEFORE UPDATE OF room_id, start_slot, end_slot, status ON bookings
WHEN NEW.status = 'confirmed' AND NOT EXISTS (
  SELECT 1
  FROM rooms room
  WHERE room.id = NEW.room_id
    AND room.enabled = 1
    AND (NEW.end_slot - NEW.start_slot) * 15
      BETWEEN COALESCE(room.minimum_duration_minutes, room.booking_increment_minutes)
      AND room.maximum_duration_minutes
    AND ((NEW.end_slot - NEW.start_slot) * 15) % room.booking_increment_minutes = 0
    AND (
      room.allowed_durations_minutes IS NULL
      OR EXISTS (
        SELECT 1 FROM json_each(room.allowed_durations_minutes)
        WHERE CAST(value AS INTEGER) = (NEW.end_slot - NEW.start_slot) * 15
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_DURATION');
END;

CREATE TRIGGER IF NOT EXISTS bookings_prevent_overlap_insert
BEFORE INSERT ON bookings
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM bookings existing
  WHERE existing.status = 'confirmed'
    AND existing.booking_date = NEW.booking_date
    AND existing.room_id = NEW.room_id
    AND NEW.start_slot < existing.end_slot
    AND NEW.end_slot > existing.start_slot
)
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS bookings_prevent_overlap_update
BEFORE UPDATE OF booking_date, room_id, start_slot, end_slot, status ON bookings
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM bookings existing
  WHERE existing.id <> NEW.id
    AND existing.status = 'confirmed'
    AND existing.booking_date = NEW.booking_date
    AND existing.room_id = NEW.room_id
    AND NEW.start_slot < existing.end_slot
    AND NEW.end_slot > existing.start_slot
)
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS bookings_prevent_block_insert
BEFORE INSERT ON bookings
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM room_blocks blocked
  WHERE blocked.active = 1
    AND blocked.block_date = NEW.booking_date
    AND blocked.room_id = NEW.room_id
    AND NEW.start_slot < blocked.end_slot
    AND NEW.end_slot > blocked.start_slot
)
BEGIN
  SELECT RAISE(ABORT, 'ROOM_BLOCKED');
END;

CREATE TRIGGER IF NOT EXISTS bookings_prevent_block_update
BEFORE UPDATE OF booking_date, room_id, start_slot, end_slot, status ON bookings
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM room_blocks blocked
  WHERE blocked.active = 1
    AND blocked.block_date = NEW.booking_date
    AND blocked.room_id = NEW.room_id
    AND NEW.start_slot < blocked.end_slot
    AND NEW.end_slot > blocked.start_slot
)
BEGIN
  SELECT RAISE(ABORT, 'ROOM_BLOCKED');
END;

CREATE TRIGGER IF NOT EXISTS room_blocks_prevent_booking_insert
BEFORE INSERT ON room_blocks
WHEN NEW.active = 1 AND EXISTS (
  SELECT 1 FROM bookings existing
  WHERE existing.status = 'confirmed'
    AND existing.booking_date = NEW.block_date
    AND existing.room_id = NEW.room_id
    AND NEW.start_slot < existing.end_slot
    AND NEW.end_slot > existing.start_slot
)
BEGIN
  SELECT RAISE(ABORT, 'BLOCK_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS room_blocks_prevent_booking_update
BEFORE UPDATE OF room_id, block_date, start_slot, end_slot, active ON room_blocks
WHEN NEW.active = 1 AND EXISTS (
  SELECT 1 FROM bookings existing
  WHERE existing.status = 'confirmed'
    AND existing.booking_date = NEW.block_date
    AND existing.room_id = NEW.room_id
    AND NEW.start_slot < existing.end_slot
    AND NEW.end_slot > existing.start_slot
)
BEGIN
  SELECT RAISE(ABORT, 'BLOCK_CONFLICT');
END;

PRAGMA user_version = 1;
