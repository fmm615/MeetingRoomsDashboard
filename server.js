"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { randomBytes, createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { ROOM_CONFIGURATIONS } = require("./room-config");

const ROOT = __dirname;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 18;
const SLOT_MINUTES = 15;
const TOTAL_SLOTS = ((CLOSE_HOUR - OPEN_HOUR) * 60) / SLOT_MINUTES;
const BOOKING_WINDOW_DAYS = 14;
const OFFICE_UTC_OFFSET_MINUTES = 3 * 60;
const SCHEMA_VERSION = 1;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
const ROOM_ALIASES = {
  "meeting-room": ["boardroom", "meeting-room", "Boardroom", "Meeting Room"],
  "standing-workstations": [
    "meeting-a",
    "standing-workstations",
    "Standing Workstations",
    "Standing workstations (middle meeting room)"
  ],
  "innovation-hub": ["meeting-b", "innovation-hub", "Meeting Room B", "Innovation Hub"],
  "quiet-pods": ["quiet-pods", "quite-pods", "Quiet Pods", "Quite Pods"]
};

function localISO(date) {
  return new Date(date.getTime() + OFFICE_UTC_OFFSET_MINUTES * 60000)
    .toISOString()
    .slice(0, 10);
}

function addDays(date, amount) {
  const next = new Date(`${localISO(date)}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function isRealISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && localISO(parsed) === value;
}

function bookingStartTime(date, startSlot) {
  const [year, month, day] = date.split("-").map(Number);
  const officeMidnightUTC =
    Date.UTC(year, month - 1, day) - OFFICE_UTC_OFFSET_MINUTES * 60000;
  const startMinutes = OPEN_HOUR * 60 + startSlot * SLOT_MINUTES;
  return new Date(officeMidnightUTC + startMinutes * 60000);
}

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function readMigration(filename) {
  return fs.readFileSync(path.join(ROOT, "migrations", filename), "utf8");
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
}

function backupBeforeMigration(db, databasePath) {
  if (databasePath === ":memory:") return;
  const backupPath = `${databasePath}.pre-room-rules-v0.backup`;
  if (fs.existsSync(backupPath)) return;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  fs.copyFileSync(databasePath, backupPath, fs.constants.COPYFILE_EXCL);
}

function seedRoomConfigurations(db, { forceActive = false } = {}) {
  const findById = db.prepare("SELECT * FROM rooms WHERE id = ?");
  const findCandidates = db.prepare("SELECT * FROM rooms");
  const insert = db.prepare(`
    INSERT INTO rooms (
      id, slug, name, capacity, location, equipment, enabled, purpose,
      compact_description, recommended_uses, guidelines, booking_increment_minutes,
      minimum_duration_minutes, maximum_duration_minutes, allowed_durations_minutes,
      capacity_label
    ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateWithActive = db.prepare(`
    UPDATE rooms SET
      slug = ?, name = ?, location = ?, enabled = ?, purpose = ?,
      compact_description = ?, recommended_uses = ?, guidelines = ?,
      booking_increment_minutes = ?, minimum_duration_minutes = ?,
      maximum_duration_minutes = ?, allowed_durations_minutes = ?, capacity_label = ?
    WHERE id = ?
  `);
  const updatePreservingActive = db.prepare(`
    UPDATE rooms SET
      slug = ?, name = ?, location = ?, purpose = ?, compact_description = ?,
      recommended_uses = ?, guidelines = ?, booking_increment_minutes = ?,
      minimum_duration_minutes = ?, maximum_duration_minutes = ?,
      allowed_durations_minutes = ?, capacity_label = ?
    WHERE id = ?
  `);

  for (const config of ROOM_CONFIGURATIONS) {
    let existing = findById.get(config.id);
    if (!existing) {
      const aliases = new Set((ROOM_ALIASES[config.slug] || []).map(value => value.toLowerCase()));
      existing = findCandidates.all().find(room =>
        room.slug === config.slug ||
        aliases.has(String(room.id).toLowerCase()) ||
        aliases.has(String(room.name).toLowerCase())
      );
    }

    const recommendedUses = JSON.stringify(config.recommendedUses);
    const guidelines = JSON.stringify(config.guidelines);
    const allowedDurations = config.allowedDurationsMinutes
      ? JSON.stringify(config.allowedDurationsMinutes)
      : null;
    const legacyCapacity = config.capacityLabel === "2–7 people"
      ? 7
      : config.capacityLabel === "Up to 3 people" ? 3 : 1;

    if (!existing) {
      insert.run(
        config.id, config.slug, config.name, legacyCapacity, config.location,
        config.isActive ? 1 : 0, config.purpose, config.compactDescription,
        recommendedUses, guidelines, config.bookingIncrementMinutes,
        config.minimumDurationMinutes || config.bookingIncrementMinutes,
        config.maximumDurationMinutes, allowedDurations, config.capacityLabel
      );
      continue;
    }

    const values = [
      config.slug, config.name, config.location, config.purpose,
      config.compactDescription, recommendedUses, guidelines,
      config.bookingIncrementMinutes,
      config.minimumDurationMinutes || config.bookingIncrementMinutes,
      config.maximumDurationMinutes, allowedDurations, config.capacityLabel,
      existing.id
    ];
    if (forceActive) {
      updateWithActive.run(
        config.slug, config.name, config.location, config.isActive ? 1 : 0,
        config.purpose, config.compactDescription, recommendedUses, guidelines,
        config.bookingIncrementMinutes,
        config.minimumDurationMinutes || config.bookingIncrementMinutes,
        config.maximumDurationMinutes, allowedDurations, config.capacityLabel,
        existing.id
      );
    } else {
      updatePreservingActive.run(...values);
    }
  }
}

function migrateLegacyDatabase(db, databasePath) {
  const legacyBookings = db.prepare(`
    SELECT id, token_hash, reference, room_id, booking_date, start_slot, end_slot,
      name, title, email, notes, status, created_at, updated_at
    FROM bookings ORDER BY id
  `).all();
  backupBeforeMigration(db, databasePath);
  try {
    db.exec(readMigration("001_room_rules_and_quarter_hour_slots.sql"));
    seedRoomConfigurations(db, { forceActive: true });
    db.exec(readMigration("000_latest_schema.sql"));

    const migratedBookings = db.prepare(`
      SELECT id, token_hash, reference, room_id, booking_date, start_slot, end_slot,
        name, title, email, notes, status, created_at, updated_at
      FROM bookings ORDER BY id
    `).all();
    if (migratedBookings.length !== legacyBookings.length) {
      throw new Error("Room migration failed: booking count changed.");
    }
    for (let index = 0; index < legacyBookings.length; index += 1) {
      const before = legacyBookings[index];
      const after = migratedBookings[index];
      const preserved = [
        "id", "token_hash", "reference", "room_id", "booking_date", "name", "title",
        "email", "notes", "status", "created_at", "updated_at"
      ].every(field => before[field] === after[field]);
      if (!preserved || after.start_slot !== before.start_slot * 2 || after.end_slot !== before.end_slot * 2) {
        throw new Error(`Room migration failed while preserving booking ${before.id}.`);
      }
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) {
      throw new Error("Room migration failed foreign-key verification.");
    }
    db.exec("COMMIT; PRAGMA foreign_keys = ON;");
  } catch (error) {
    try {
      db.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
    } catch {
      // The migration may have failed before its transaction began.
    }
    throw error;
  }
}

function verifyDatabase(db) {
  const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length) throw new Error("Database foreign-key verification failed.");
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") throw new Error("Database integrity verification failed.");
  const configuredRooms = db.prepare(`
    SELECT count(*) AS count FROM rooms
    WHERE slug IN ('meeting-room', 'standing-workstations', 'innovation-hub', 'quiet-pods')
  `).get().count;
  if (configuredRooms !== ROOM_CONFIGURATIONS.length) {
    throw new Error(`Expected ${ROOM_CONFIGURATIONS.length} canonical room configurations, found ${configuredRooms}.`);
  }
}

function createDatabase(databasePath) {
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

  if (!tableExists(db, "rooms")) {
    db.exec(readMigration("000_latest_schema.sql"));
    seedRoomConfigurations(db, { forceActive: true });
  } else {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < SCHEMA_VERSION || !columnExists(db, "rooms", "booking_increment_minutes")) {
      migrateLegacyDatabase(db, databasePath);
    } else {
      db.exec(readMigration("000_latest_schema.sql"));
      seedRoomConfigurations(db);
    }
  }
  verifyDatabase(db);
  return db;
}

function parseJSONList(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicRoom(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    location: row.location || "",
    purpose: row.purpose,
    compactDescription: row.compact_description,
    recommendedUses: parseJSONList(row.recommended_uses) || [],
    guidelines: parseJSONList(row.guidelines) || [],
    bookingIncrementMinutes: row.booking_increment_minutes,
    minimumDurationMinutes: row.minimum_duration_minutes || row.booking_increment_minutes,
    maximumDurationMinutes: row.maximum_duration_minutes,
    allowedDurationsMinutes: parseJSONList(row.allowed_durations_minutes),
    capacityLabel: row.capacity_label || "",
    isActive: Boolean(row.enabled)
  };
}

function getRoomRow(db, id, activeOnly = false) {
  return db.prepare(`SELECT * FROM rooms WHERE id = ?${activeOnly ? " AND enabled = 1" : ""}`).get(id);
}

function durationOptions(room) {
  if (room.allowedDurationsMinutes?.length) return room.allowedDurationsMinutes;
  const durations = [];
  const minimum = room.minimumDurationMinutes || room.bookingIncrementMinutes;
  for (let duration = minimum; duration <= room.maximumDurationMinutes; duration += room.bookingIncrementMinutes) {
    durations.push(duration);
  }
  return durations;
}

function durationError(room) {
  if (room.slug === "meeting-room") return "The Meeting Room can be booked for a maximum of 2 hours.";
  if (room.slug === "standing-workstations") return "Standing Workstations can only be booked for 15–60 minutes.";
  if (room.slug === "innovation-hub") return "The Innovation Hub can be booked for a maximum of 2 hours.";
  if (room.slug === "quiet-pods") return "Quiet Pods can only be booked for 30 or 45 minutes.";
  return `${room.name} cannot be booked for the selected duration.`;
}

function slotToTime(slot) {
  const minutes = OPEN_HOUR * 60 + slot * SLOT_MINUTES;
  const date = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function bookingSelect() {
  return `
    SELECT booking.*, room.name AS room_name, room.location AS room_location,
      room.slug AS room_slug
    FROM bookings booking
    JOIN rooms room ON room.id = booking.room_id
  `;
}

function publicBooking(row) {
  const durationMinutes = (row.end_slot - row.start_slot) * SLOT_MINUTES;
  return {
    reference: row.reference,
    room: row.room_id,
    roomName: row.room_name,
    roomSlug: row.room_slug,
    location: row.room_location || "",
    date: row.booking_date,
    start: row.start_slot,
    end: row.end_slot,
    startTime: slotToTime(row.start_slot),
    endTime: slotToTime(row.end_slot),
    durationMinutes,
    name: row.name,
    bookedBy: row.name,
    title: row.title,
    meetingTitle: row.title,
    email: row.email,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateBooking(input, db, now = new Date(), { fallbackEmail = "" } = {}) {
  const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const email = typeof data.email === "string" ? data.email.trim() : fallbackEmail;
  const notes = typeof data.notes === "string" ? data.notes.trim() : "";
  const date = typeof data.date === "string" ? data.date : "";
  const roomId = typeof data.room === "string" ? data.room : "";
  const start = data.start;
  const end = data.end;

  if (!name || name.length > 80) return { error: "Enter a booked-by name of 80 characters or fewer." };
  if (!title || title.length > 100) return { error: "Enter a meeting title or booking purpose of 100 characters or fewer." };
  if (email.length > 120) return { error: "The saved email value is too long." };
  if (notes.length > 500) return { error: "Notes cannot be longer than 500 characters." };
  if (!isRealISODate(date)) return { error: "Select a valid booking date." };

  const minimumDate = localISO(now);
  const maximumDate = localISO(addDays(now, BOOKING_WINDOW_DAYS));
  if (date < minimumDate || date > maximumDate) {
    return { error: `Bookings must be between ${minimumDate} and ${maximumDate}.` };
  }

  const roomRow = getRoomRow(db, roomId, true);
  if (!roomRow) return { error: "Select an active room or workspace." };
  const room = publicRoom(roomRow);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > TOTAL_SLOTS) {
    return { error: `Select a time between ${OPEN_HOUR}:00 and ${CLOSE_HOUR}:00.` };
  }

  const durationMinutes = (end - start) * SLOT_MINUTES;
  const validDurations = durationOptions(room);
  const startsOnIncrement = (start * SLOT_MINUTES) % room.bookingIncrementMinutes === 0;
  if (!startsOnIncrement || !validDurations.includes(durationMinutes)) {
    return { error: durationError(room) };
  }

  const startTime = bookingStartTime(date, start);
  if (startTime <= now) return { error: "The selected start time is in the past. Choose another time." };

  return {
    value: {
      name, title, email, notes, date, room: roomId, start, end,
      durationMinutes, roomConfiguration: room
    }
  };
}

function readJSON(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        if (!settled) {
          settled = true;
          reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        }
        return;
      }
      if (!settled) body += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      try {
        settled = true;
        resolve(body ? JSON.parse(body) : {});
      } catch {
        settled = true;
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    req.on("error", error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function sendJSON(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

function tokenFromPath(pathname) {
  const match = pathname.match(/^\/api\/bookings\/([a-f0-9]{48})$/);
  return match?.[1] || null;
}

function bookingByToken(db, token) {
  return db.prepare(`${bookingSelect()} WHERE booking.token_hash = ?`).get(hashToken(token));
}

function databaseError(error, room) {
  const message = String(error?.message || "");
  if (message.includes("BOOKING_CONFLICT")) {
    return { status: 409, message: "This room is already booked during the selected time. Select another time or room." };
  }
  if (message.includes("ROOM_BLOCKED")) {
    return { status: 409, message: "This room is unavailable during the selected time. Select another time or room." };
  }
  if (message.includes("BOOKING_DURATION")) return { status: 400, message: durationError(room) };
  if (message.includes("ROOM_INACTIVE")) return { status: 400, message: "Select an active room or workspace." };
  return null;
}

function generateReference(db) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = `PB-${randomBytes(8).toString("hex").toUpperCase()}`;
    if (!db.prepare("SELECT 1 FROM bookings WHERE reference = ?").get(reference)) return reference;
  }
  throw new Error("Unable to generate a unique booking reference.");
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function availabilityRows(db, date, roomId, excludedHash) {
  const conditions = ["booking.booking_date = ?", "booking.status = 'confirmed'"];
  const values = [date];
  if (roomId) {
    conditions.push("booking.room_id = ?");
    values.push(roomId);
  }
  if (excludedHash) {
    conditions.push("booking.token_hash <> ?");
    values.push(excludedHash);
  }
  const bookings = db.prepare(`
    SELECT booking.room_id AS room, booking.start_slot AS start,
      booking.end_slot AS end, 'booked' AS type
    FROM bookings booking
    WHERE ${conditions.join(" AND ")}
  `).all(...values);

  const blockConditions = ["block.block_date = ?", "block.active = 1"];
  const blockValues = [date];
  if (roomId) {
    blockConditions.push("block.room_id = ?");
    blockValues.push(roomId);
  }
  const blocks = db.prepare(`
    SELECT block.room_id AS room, block.start_slot AS start,
      block.end_slot AS end, 'blocked' AS type
    FROM room_blocks block
    WHERE ${blockConditions.join(" AND ")}
  `).all(...blockValues);
  return [...bookings, ...blocks].sort((a, b) => a.room.localeCompare(b.room) || a.start - b.start);
}

function createRequestHandler({ db, now = () => new Date(), root = ROOT }) {
  return async function requestHandler(req, res) {
    applySecurityHeaders(res);
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    try {
      if (pathname === "/api/rooms" && req.method === "GET") {
        const rows = db.prepare("SELECT * FROM rooms WHERE enabled = 1 ORDER BY rowid").all();
        return sendJSON(res, 200, { rooms: rows.map(publicRoom) });
      }

      if (pathname === "/api/availability" && req.method === "GET") {
        const date = url.searchParams.get("date") || "";
        const roomId = url.searchParams.get("room") || "";
        const managementToken = url.searchParams.get("token") || "";
        if (!isRealISODate(date)) return sendError(res, 400, "Select a valid booking date.");
        if (roomId && !getRoomRow(db, roomId, true)) return sendError(res, 404, "Room or workspace not found.");
        const excludedHash = /^[a-f0-9]{48}$/.test(managementToken) && bookingByToken(db, managementToken)
          ? hashToken(managementToken)
          : "";
        return sendJSON(res, 200, { busy: availabilityRows(db, date, roomId, excludedHash) });
      }

      if (pathname === "/api/bookings" && req.method === "POST") {
        const input = await readJSON(req);
        const checked = validateBooking(input, db, now());
        if (checked.error) return sendError(res, 400, checked.error);
        const value = checked.value;
        const token = randomBytes(24).toString("hex");
        const reference = generateReference(db);
        const timestamp = now().toISOString();
        try {
          db.prepare(`
            INSERT INTO bookings (
              token_hash, reference, room_id, booking_date, start_slot, end_slot,
              name, title, email, notes, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
          `).run(
            hashToken(token), reference, value.room, value.date, value.start, value.end,
            value.name, value.title, value.email, value.notes, timestamp, timestamp
          );
        } catch (error) {
          const known = databaseError(error, value.roomConfiguration);
          if (known) return sendError(res, known.status, known.message);
          throw error;
        }
        const row = bookingByToken(db, token);
        return sendJSON(res, 201, { token, booking: publicBooking(row) });
      }

      const token = tokenFromPath(pathname);
      if (token && req.method === "GET") {
        const row = bookingByToken(db, token);
        if (!row) return sendError(res, 404, "Booking not found.");
        return sendJSON(res, 200, { booking: publicBooking(row) });
      }

      if (token && req.method === "PUT") {
        const existing = bookingByToken(db, token);
        if (!existing) return sendError(res, 404, "Booking not found.");
        if (existing.status === "cancelled") return sendError(res, 409, "A cancelled booking cannot be edited.");
        const input = await readJSON(req);
        const timestamp = now();
        if (bookingStartTime(existing.booking_date, existing.start_slot) <= timestamp) {
          return sendError(res, 409, "Past bookings can no longer be edited.");
        }
        const checked = validateBooking(input, db, timestamp, { fallbackEmail: existing.email });
        if (checked.error) return sendError(res, 400, checked.error);
        const value = checked.value;
        try {
          const updated = db.prepare(`
            UPDATE bookings SET
              room_id = ?, booking_date = ?, start_slot = ?, end_slot = ?,
              name = ?, title = ?, email = ?, notes = ?, updated_at = ?
            WHERE id = ? AND status = 'confirmed'
          `).run(
            value.room, value.date, value.start, value.end, value.name,
            value.title, value.email, value.notes, timestamp.toISOString(), existing.id
          );
          if (updated.changes !== 1) {
            return sendError(res, 409, "A cancelled booking cannot be edited.");
          }
        } catch (error) {
          const known = databaseError(error, value.roomConfiguration);
          if (known) return sendError(res, known.status, known.message);
          throw error;
        }
        return sendJSON(res, 200, { booking: publicBooking(bookingByToken(db, token)) });
      }

      if (token && req.method === "DELETE") {
        const existing = bookingByToken(db, token);
        if (!existing) return sendError(res, 404, "Booking not found.");
        if (existing.status !== "cancelled") {
          db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ?")
            .run(now().toISOString(), existing.id);
        }
        return sendJSON(res, 200, { booking: publicBooking(bookingByToken(db, token)) });
      }

      if (pathname.startsWith("/api/")) return sendError(res, 404, "API endpoint not found.");
      if (!["GET", "HEAD"].includes(req.method)) return sendError(res, 405, "Method not allowed.");

      const staticRoutes = new Set(["/", "/book", "/book/details"]);
      const relativePath = staticRoutes.has(pathname) || /^\/booking\/[a-f0-9]{48}$/.test(pathname)
        ? "index.html"
        : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(root, relativePath);
      if (!filePath.startsWith(`${path.resolve(root)}${path.sep}`) && filePath !== path.resolve(root, "index.html")) {
        return sendError(res, 403, "Forbidden.");
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendError(res, 404, "Page not found.");
      const extension = path.extname(filePath);
      const stats = fs.statSync(filePath);
      const shouldRevalidate = [".html", ".css", ".js"].includes(extension);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
        "Cache-Control": shouldRevalidate ? "no-cache" : "public, max-age=3600",
        "Content-Length": stats.size
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, error.status || 500, error.status ? error.message : "The server could not complete this request.");
      } else {
        res.destroy();
      }
      if (!error.status) console.error(error);
    }
  };
}

function createApp(options = {}) {
  const databasePath = options.databasePath || path.join(ROOT, "data", "meeting-rooms.sqlite");
  const db = options.db || createDatabase(databasePath);
  const handler = createRequestHandler({ db, now: options.now, root: options.root || ROOT });
  return { server: http.createServer(handler), db };
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  const host = process.env.HOST || "127.0.0.1";
  const { server } = createApp({
    databasePath: process.env.DATABASE_PATH || path.join(ROOT, "data", "meeting-rooms.sqlite")
  });
  server.listen(port, host, () => {
    console.log(`Playbook Office Rooms is running at http://${host}:${port}`);
  });
}

module.exports = {
  createApp,
  createDatabase,
  createRequestHandler,
  validateBooking,
  hashToken,
  localISO,
  publicRoom,
  publicBooking,
  durationOptions,
  constants: {
    OPEN_HOUR, CLOSE_HOUR, SLOT_MINUTES, TOTAL_SLOTS, BOOKING_WINDOW_DAYS, SCHEMA_VERSION
  }
};
