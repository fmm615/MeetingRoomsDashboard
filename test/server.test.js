"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createApp, createDatabase, hashToken } = require("../server");

const FIXED_NOW = new Date("2026-07-27T08:00:00+03:00");
const BASE_BOOKING = {
  date: "2026-07-28",
  room: "boardroom",
  start: 8,
  end: 12,
  name: "Mahmood",
  title: "Product review",
  notes: "Bring the latest plan."
};

async function fixture(options = {}) {
  const { server, db } = createApp({
    databasePath: ":memory:",
    now: () => new Date(FIXED_NOW),
    ...options
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function request(requestPath, requestOptions = {}) {
    const response = await fetch(`${origin}${requestPath}`, {
      ...requestOptions,
      headers: {
        ...(requestOptions.body ? { "Content-Type": "application/json" } : {}),
        ...requestOptions.headers
      }
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    return { response, body };
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }

  return { db, origin, request, close };
}

async function createBooking(app, payload = BASE_BOOKING) {
  return app.request("/api/bookings", { method: "POST", body: JSON.stringify(payload) });
}

test("legacy migration preserves booking identity and wall-clock time, then remains idempotent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-room-migration-"));
  const databasePath = path.join(directory, "legacy.sqlite");
  const token = "a".repeat(48);
  let db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity INTEGER NOT NULL CHECK (capacity > 0),
      location TEXT NOT NULL, equipment TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
    );
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
      reference TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL REFERENCES rooms(id),
      booking_date TEXT NOT NULL, start_slot INTEGER NOT NULL CHECK (start_slot >= 0 AND start_slot < 20),
      end_slot INTEGER NOT NULL CHECK (end_slot > start_slot AND end_slot <= 20),
      name TEXT NOT NULL, title TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO rooms VALUES
      ('boardroom', 'Boardroom', 12, 'Floor 16', 'TV', 1),
      ('meeting-a', 'Meeting Room A', 8, 'Floor 16', 'TV', 1),
      ('meeting-b', 'Meeting Room B', 6, 'Floor 15', 'TV', 1);
  `);
  db.prepare(`
    INSERT INTO bookings (
      id, token_hash, reference, room_id, booking_date, start_slot, end_slot,
      name, title, email, notes, status, created_at, updated_at
    ) VALUES (7, ?, 'PB-LEGACY', 'boardroom', '2026-07-30', 4, 6,
      'Legacy User', 'Legacy Meeting', 'old@example.com', 'Keep me',
      'confirmed', '2026-01-01', '2026-01-02')
  `).run(hashToken(token));
  db.close();

  db = createDatabase(databasePath);
  const migrated = db.prepare("SELECT * FROM bookings WHERE id = 7").get();
  assert.equal(migrated.reference, "PB-LEGACY");
  assert.equal(migrated.token_hash, hashToken(token));
  assert.equal(migrated.room_id, "boardroom");
  assert.equal(migrated.start_slot, 8);
  assert.equal(migrated.end_slot, 12);
  assert.equal(migrated.email, "old@example.com");
  assert.equal(migrated.notes, "Keep me");
  assert.equal(migrated.created_at, "2026-01-01");
  assert.equal(migrated.updated_at, "2026-01-02");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("SELECT count(*) count FROM rooms WHERE enabled = 1").get().count, 4);
  db.close();
  assert.equal(fs.existsSync(`${databasePath}.pre-room-rules-v0.backup`), true);

  db = createDatabase(databasePath);
  assert.equal(db.prepare("SELECT count(*) count FROM rooms WHERE enabled = 1").get().count, 4);
  assert.deepEqual(
    { ...db.prepare("SELECT start_slot, end_slot FROM bookings WHERE id = 7").get() },
    { start_slot: 8, end_slot: 12 }
  );
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("serves exactly the four canonical room configurations and application routes", async t => {
  const app = await fixture();
  t.after(app.close);

  const result = await app.request("/api/rooms");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.rooms.map(room => room.name), [
    "Meeting Room", "Standing Workstations", "Innovation Hub", "Quiet Pods"
  ]);
  assert.equal(result.body.rooms.some(room => /Quite Pods|Boardroom|Meeting Room A|Meeting Room B/.test(room.name)), false);

  const [meeting, standing, innovation, quiet] = result.body.rooms;
  assert.equal(meeting.maximumDurationMinutes, 120);
  assert.equal(meeting.capacityLabel, "2–7 people");
  assert.equal(standing.location, "Middle Meeting Room");
  assert.deepEqual(standing.allowedDurationsMinutes, [15, 30, 45, 60]);
  assert.equal(innovation.maximumDurationMinutes, 120);
  assert.deepEqual(quiet.allowedDurationsMinutes, [30, 45]);
  assert.equal(quiet.capacityLabel, "Up to 3 people");
  for (const room of result.body.rooms) {
    assert.equal(room.bookingIncrementMinutes, 15);
    assert.ok(room.purpose);
    assert.ok(room.compactDescription);
    assert.ok(room.recommendedUses.length);
    assert.ok(room.guidelines.length);
  }

  for (const route of ["/", "/book", "/book/details", `/booking/${"a".repeat(48)}`]) {
    const page = await app.request(route);
    assert.equal(page.response.status, 200, route);
    assert.match(page.body, /Playbook Office Rooms/);
  }
  assert.equal((await app.request("/manage")).response.status, 404);
});

test("accepts every valid room duration and rejects room-specific invalid durations", async t => {
  const app = await fixture();
  t.after(app.close);

  const validCases = [
    { room: "boardroom", start: 0, end: 1 },
    { room: "boardroom", start: 2, end: 10 },
    { room: "meeting-a", start: 0, end: 1 },
    { room: "meeting-a", start: 2, end: 6 },
    { room: "meeting-b", start: 0, end: 8 },
    { room: "quiet-pods", start: 0, end: 2 },
    { room: "quiet-pods", start: 3, end: 6 }
  ];
  for (let index = 0; index < validCases.length; index += 1) {
    const item = validCases[index];
    const created = await createBooking(app, {
      ...BASE_BOOKING,
      ...item,
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      name: `Valid ${index}`
    });
    assert.equal(created.response.status, 201, JSON.stringify(item));
  }

  const invalidCases = [
    [{ room: "boardroom", start: 0, end: 9 }, "The Meeting Room can be booked for a maximum of 2 hours."],
    [{ room: "meeting-a", start: 0, end: 5 }, "Standing Workstations can only be booked for 15–60 minutes."],
    [{ room: "meeting-b", start: 0, end: 9 }, "The Innovation Hub can be booked for a maximum of 2 hours."],
    [{ room: "quiet-pods", start: 0, end: 1 }, "Quiet Pods can only be booked for 30 or 45 minutes."],
    [{ room: "quiet-pods", start: 0, end: 4 }, "Quiet Pods can only be booked for 30 or 45 minutes."]
  ];
  for (const [item, message] of invalidCases) {
    const rejected = await createBooking(app, { ...BASE_BOOKING, ...item });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error, message);
  }
});

test("rejects tampered fields, inactive rooms, past times, and after-hours bookings", async t => {
  const app = await fixture();
  t.after(app.close);

  const invalidCases = [
    [{ name: " " }, /booked-by name/i],
    [{ title: "" }, /meeting title/i],
    [{ date: "2026-07-26" }, /between/i],
    [{ date: "2026-08-11" }, /between/i],
    [{ date: "2026-02-30" }, /valid booking date/i],
    [{ room: "missing-room" }, /active room/i],
    [{ start: -1 }, /between/i],
    [{ start: 39, end: 41 }, /between/i],
    [{ start: 2.5, end: 4 }, /between/i],
    [{ start: 4, end: 4 }, /between/i],
    [{ date: "2026-07-27", start: 0, end: 1 }, /past/i]
  ];
  for (const [change, expected] of invalidCases) {
    const result = await createBooking(app, { ...BASE_BOOKING, ...change });
    assert.equal(result.response.status, 400, JSON.stringify(change));
    assert.match(result.body.error, expected);
  }

  app.db.prepare("UPDATE rooms SET enabled = 0 WHERE id = 'boardroom'").run();
  const inactive = await createBooking(app);
  assert.equal(inactive.response.status, 400);
  assert.match(inactive.body.error, /active room/i);
  assert.equal(app.db.prepare("SELECT count(*) count FROM bookings").get().count, 0);

  const oversized = await createBooking(app, { ...BASE_BOOKING, notes: "x".repeat(70_000) });
  assert.equal(oversized.response.status, 413);
});

test("strict overlap boundaries and concurrency are protected by the database", async t => {
  const app = await fixture();
  t.after(app.close);

  const first = await createBooking(app, { ...BASE_BOOKING, start: 4, end: 6 });
  assert.equal(first.response.status, 201);
  for (const [start, end] of [[3, 5], [5, 7], [4, 6], [4, 5], [3, 7]]) {
    const overlap = await createBooking(app, { ...BASE_BOOKING, start, end, name: `${start}-${end}` });
    assert.equal(overlap.response.status, 409, `${start}-${end}`);
  }
  assert.equal((await createBooking(app, { ...BASE_BOOKING, start: 2, end: 4, name: "Before" })).response.status, 201);
  assert.equal((await createBooking(app, { ...BASE_BOOKING, start: 6, end: 7, name: "After" })).response.status, 201);
  assert.equal((await createBooking(app, { ...BASE_BOOKING, room: "meeting-b", start: 4, end: 6 })).response.status, 201);

  const concurrentDate = "2026-07-29";
  const attempts = await Promise.all([
    createBooking(app, { ...BASE_BOOKING, date: concurrentDate, name: "First" }),
    createBooking(app, { ...BASE_BOOKING, date: concurrentDate, name: "Second" })
  ]);
  assert.deepEqual(attempts.map(item => item.response.status).sort(), [201, 409]);

  assert.throws(() => {
    app.db.prepare(`
      INSERT INTO bookings (
        token_hash, reference, room_id, booking_date, start_slot, end_slot,
        name, title, email, notes, status, created_at, updated_at
      ) VALUES (?, 'PB-DIRECT', 'boardroom', '2026-07-28', 5, 6,
        'Direct', 'Conflict', '', '', 'confirmed', 'now', 'now')
    `).run(hashToken("b".repeat(48)));
  }, /BOOKING_CONFLICT/);
});

test("blocked periods appear as unavailable and are enforced in both directions", async t => {
  const app = await fixture();
  t.after(app.close);

  app.db.prepare(`
    INSERT INTO room_blocks (room_id, block_date, start_slot, end_slot, reason)
    VALUES ('boardroom', '2026-07-28', 10, 12, 'Maintenance')
  `).run();
  const blocked = await createBooking(app, { ...BASE_BOOKING, start: 9, end: 11 });
  assert.equal(blocked.response.status, 409);
  assert.match(blocked.body.error, /unavailable/i);

  const availability = await app.request("/api/availability?date=2026-07-28");
  assert.deepEqual(availability.body.busy, [
    { room: "boardroom", start: 10, end: 12, type: "blocked" }
  ]);

  const booking = await createBooking(app, { ...BASE_BOOKING, start: 4, end: 6 });
  assert.equal(booking.response.status, 201);
  assert.throws(() => {
    app.db.prepare(`
      INSERT INTO room_blocks (room_id, block_date, start_slot, end_slot, reason)
      VALUES ('boardroom', '2026-07-28', 5, 7, 'Maintenance')
    `).run();
  }, /BLOCK_CONFLICT/);
});

test("booking responses are Slack-ready and availability never exposes PII", async t => {
  const app = await fixture();
  t.after(app.close);

  const created = await createBooking(app, {
    ...BASE_BOOKING,
    room: "meeting-a",
    start: 5,
    end: 8,
    name: "Sara",
    title: "Quick planning",
    notes: "Bring notes"
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.token, /^[a-f0-9]{48}$/);
  assert.match(created.body.booking.reference, /^PB-[A-F0-9]{16}$/);
  assert.deepEqual(
    {
      roomName: created.body.booking.roomName,
      location: created.body.booking.location,
      date: created.body.booking.date,
      startTime: created.body.booking.startTime,
      endTime: created.body.booking.endTime,
      durationMinutes: created.body.booking.durationMinutes,
      bookedBy: created.body.booking.bookedBy,
      meetingTitle: created.body.booking.meetingTitle,
      notes: created.body.booking.notes
    },
    {
      roomName: "Standing Workstations",
      location: "Middle Meeting Room",
      date: "2026-07-28",
      startTime: "9:15 AM",
      endTime: "10:00 AM",
      durationMinutes: 45,
      bookedBy: "Sara",
      meetingTitle: "Quick planning",
      notes: "Bring notes"
    }
  );

  const row = app.db.prepare("SELECT token_hash FROM bookings").get();
  assert.equal(row.token_hash, hashToken(created.body.token));
  assert.notEqual(row.token_hash, created.body.token);

  const availability = await app.request("/api/availability?date=2026-07-28");
  assert.deepEqual(availability.body.busy, [
    { room: "meeting-a", start: 5, end: 8, type: "booked" }
  ]);
  assert.doesNotMatch(JSON.stringify(availability.body), /Sara|Quick planning|Bring notes|PB-/);
});

test("private links edit safely, preserve legacy email, and cancellation frees the period", async t => {
  const app = await fixture();
  t.after(app.close);

  const created = await createBooking(app, { ...BASE_BOOKING, email: "legacy@example.com" });
  const token = created.body.token;
  const reference = created.body.booking.reference;
  const occupied = await createBooking(app, {
    ...BASE_BOOKING,
    date: "2026-07-29",
    room: "quiet-pods",
    start: 8,
    end: 10,
    name: "Another team"
  });
  assert.equal(occupied.response.status, 201);

  const updated = await app.request(`/api/bookings/${token}`, {
    method: "PUT",
    body: JSON.stringify({
      ...BASE_BOOKING,
      date: "2026-07-29",
      room: "quiet-pods",
      start: 4,
      end: 7,
      title: "Focused update"
    })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.booking.roomName, "Quiet Pods");
  assert.equal(updated.body.booking.date, "2026-07-29");
  assert.equal(updated.body.booking.start, 4);
  assert.equal(updated.body.booking.end, 7);
  assert.equal(updated.body.booking.durationMinutes, 45);
  assert.equal(updated.body.booking.reference, reference);
  assert.equal(updated.body.booking.email, "legacy@example.com");

  assert.deepEqual(
    (await app.request("/api/availability?date=2026-07-28&room=boardroom")).body.busy,
    []
  );
  assert.deepEqual(
    (await app.request("/api/availability?date=2026-07-29&room=quiet-pods")).body.busy,
    [
      { room: "quiet-pods", start: 4, end: 7, type: "booked" },
      { room: "quiet-pods", start: 8, end: 10, type: "booked" }
    ]
  );
  assert.deepEqual(
    (await app.request(
      `/api/availability?date=2026-07-29&room=quiet-pods&token=${token}`
    )).body.busy,
    [{ room: "quiet-pods", start: 8, end: 10, type: "booked" }]
  );

  const conflictingEdit = await app.request(`/api/bookings/${token}`, {
    method: "PUT",
    body: JSON.stringify({
      ...BASE_BOOKING,
      date: "2026-07-29",
      room: "quiet-pods",
      start: 8,
      end: 10
    })
  });
  assert.equal(conflictingEdit.response.status, 409);
  assert.match(conflictingEdit.body.error, /already booked/i);

  const invalidEdit = await app.request(`/api/bookings/${token}`, {
    method: "PUT",
    body: JSON.stringify({
      ...BASE_BOOKING,
      date: "2026-07-29",
      room: "quiet-pods",
      start: 4,
      end: 8
    })
  });
  assert.equal(invalidEdit.response.status, 400);
  const unchanged = await app.request(`/api/bookings/${token}`);
  assert.equal(unchanged.body.booking.date, "2026-07-29");
  assert.equal(unchanged.body.booking.start, 4);
  assert.equal(unchanged.body.booking.end, 7);
  assert.equal(unchanged.body.booking.durationMinutes, 45);

  const cancelled = await app.request(`/api/bookings/${token}`, { method: "DELETE" });
  assert.equal(cancelled.body.booking.status, "cancelled");
  const again = await app.request(`/api/bookings/${token}`, { method: "DELETE" });
  assert.equal(again.body.booking.status, "cancelled");
  assert.equal((await app.request(`/api/bookings/${token}`, {
    method: "PUT", body: JSON.stringify(BASE_BOOKING)
  })).response.status, 409);

  const replacement = await createBooking(app, {
    ...BASE_BOOKING,
    date: "2026-07-29",
    room: "quiet-pods",
    start: 4,
    end: 7,
    name: "Replacement"
  });
  assert.equal(replacement.response.status, 201);
});

test("past bookings cannot be recycled through a private edit link", async t => {
  let clock = new Date("2026-07-27T08:00:00+03:00");
  const app = await fixture({ now: () => new Date(clock) });
  t.after(app.close);

  const created = await createBooking(app);
  assert.equal(created.response.status, 201);
  clock = new Date("2026-07-28T10:01:00+03:00");

  const recycled = await app.request(`/api/bookings/${created.body.token}`, {
    method: "PUT",
    body: JSON.stringify({
      ...BASE_BOOKING,
      date: "2026-07-29",
      start: 16,
      end: 20
    })
  });
  assert.equal(recycled.response.status, 409);
  assert.match(recycled.body.error, /past bookings/i);

  const unchanged = await app.request(`/api/bookings/${created.body.token}`);
  assert.equal(unchanged.body.booking.date, BASE_BOOKING.date);
  assert.equal(unchanged.body.booking.start, BASE_BOOKING.start);
  assert.equal(unchanged.body.booking.end, BASE_BOOKING.end);
});

test("booking dates and past-time validation use Bahrain office time", async t => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "UTC";
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });

  const app = await fixture({
    now: () => new Date("2026-07-27T21:30:00Z")
  });
  t.after(app.close);

  const previousOfficeDate = await createBooking(app, {
    ...BASE_BOOKING,
    date: "2026-07-27"
  });
  assert.equal(previousOfficeDate.response.status, 400);
  assert.match(previousOfficeDate.body.error, /between 2026-07-28/i);

  const BahrainToday = await createBooking(app, {
    ...BASE_BOOKING,
    date: "2026-07-28",
    start: 0,
    end: 4
  });
  assert.equal(BahrainToday.response.status, 201);
});
