"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createApp, hashToken } = require("../server");
const { ROOM_CONFIGURATIONS } = require("../room-config");
const {
  createSupabaseClientFromEnv,
  normalizeBookingRow
} = require("../lib/supabase-store");

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

function storeFailure(message, code = "P0001") {
  const error = new Error(message);
  error.code = code;
  return error;
}

class MemoryStore {
  constructor() {
    this.rooms = ROOM_CONFIGURATIONS.map((room, index) => ({
      id: room.id,
      slug: room.slug,
      name: room.name,
      location: room.location,
      enabled: room.isActive,
      purpose: room.purpose,
      compact_description: room.compactDescription,
      recommended_uses: room.recommendedUses,
      guidelines: room.guidelines,
      booking_increment_minutes: room.bookingIncrementMinutes,
      minimum_duration_minutes:
        room.minimumDurationMinutes || room.bookingIncrementMinutes,
      maximum_duration_minutes: room.maximumDurationMinutes,
      allowed_durations_minutes: room.allowedDurationsMinutes || null,
      capacity_label: room.capacityLabel,
      display_order: index + 1
    }));
    this.bookings = [];
    this.blocks = [];
    this.nextId = 1;
  }

  async listRooms() {
    return this.rooms
      .filter(room => room.enabled)
      .sort((left, right) => left.display_order - right.display_order);
  }

  async getRoom(id, activeOnly = false) {
    return (
      this.rooms.find(
        room => room.id === id && (!activeOnly || room.enabled)
      ) || null
    );
  }

  bookingWithRoom(booking) {
    if (!booking) return null;
    const room = this.rooms.find(candidate => candidate.id === booking.room_id);
    return {
      ...booking,
      room_name: room?.name || "",
      room_location: room?.location || "",
      room_slug: room?.slug || ""
    };
  }

  async findBookingByTokenHash(tokenHash) {
    return this.bookingWithRoom(
      this.bookings.find(booking => booking.token_hash === tokenHash)
    );
  }

  async getAvailability(date, roomId = "", excludedHash = "") {
    return [
      ...this.bookings
        .filter(
          booking =>
            booking.status === "confirmed" &&
            booking.booking_date === date &&
            (!roomId || booking.room_id === roomId) &&
            (!excludedHash || booking.token_hash !== excludedHash)
        )
        .map(booking => ({
          room: booking.room_id,
          start: booking.start_slot,
          end: booking.end_slot,
          type: "booked"
        })),
      ...this.blocks
        .filter(
          block =>
            block.active &&
            block.block_date === date &&
            (!roomId || block.room_id === roomId)
        )
        .map(block => ({
          room: block.room_id,
          start: block.start_slot,
          end: block.end_slot,
          type: "blocked"
        }))
    ].sort(
      (left, right) =>
        left.room.localeCompare(right.room) || left.start - right.start
    );
  }

  enforceRules(value, excludedId = null) {
    const day = new Date(`${value.date}T12:00:00Z`).getUTCDay();
    if (day === 5 || day === 6) throw storeFailure("WEEKEND_CLOSED");
    const room = this.rooms.find(
      candidate => candidate.id === value.room && candidate.enabled
    );
    if (!room) throw storeFailure("ROOM_INACTIVE");
    const duration = (value.end - value.start) * 15;
    const durationAllowed =
      duration >= room.minimum_duration_minutes &&
      duration <= room.maximum_duration_minutes &&
      duration % room.booking_increment_minutes === 0 &&
      (!room.allowed_durations_minutes ||
        room.allowed_durations_minutes.includes(duration));
    if (!durationAllowed) throw storeFailure("BOOKING_DURATION");
    if (
      this.blocks.some(
        block =>
          block.active &&
          block.block_date === value.date &&
          block.room_id === value.room &&
          value.start < block.end_slot &&
          value.end > block.start_slot
      )
    ) {
      throw storeFailure("ROOM_BLOCKED");
    }
    if (
      this.bookings.some(
        booking =>
          booking.id !== excludedId &&
          booking.status === "confirmed" &&
          booking.booking_date === value.date &&
          booking.room_id === value.room &&
          value.start < booking.end_slot &&
          value.end > booking.start_slot
      )
    ) {
      throw storeFailure(
        "conflicting key value violates exclusion constraint bookings_no_overlap",
        "23P01"
      );
    }
  }

  async createBooking(value) {
    this.enforceRules(value);
    if (
      this.bookings.some(
        booking =>
          booking.token_hash === value.tokenHash ||
          booking.reference === value.reference
      )
    ) {
      throw storeFailure("duplicate key value", "23505");
    }
    const booking = {
      id: this.nextId++,
      token_hash: value.tokenHash,
      reference: value.reference,
      room_id: value.room,
      booking_date: value.date,
      start_slot: value.start,
      end_slot: value.end,
      name: value.name,
      title: value.title,
      email: value.email,
      notes: value.notes,
      status: "confirmed",
      created_at: value.timestamp,
      updated_at: value.timestamp
    };
    this.bookings.push(booking);
    return booking.id;
  }

  async updateBooking(id, value) {
    const booking = this.bookings.find(candidate => candidate.id === id);
    if (!booking || booking.status !== "confirmed") {
      throw storeFailure("BOOKING_CANCELLED");
    }
    this.enforceRules(value, id);
    Object.assign(booking, {
      room_id: value.room,
      booking_date: value.date,
      start_slot: value.start,
      end_slot: value.end,
      name: value.name,
      title: value.title,
      email: value.email,
      notes: value.notes,
      updated_at: value.timestamp
    });
    return id;
  }

  async cancelBooking(id, timestamp) {
    const booking = this.bookings.find(candidate => candidate.id === id);
    if (!booking) throw storeFailure("BOOKING_NOT_FOUND");
    booking.status = "cancelled";
    booking.updated_at = timestamp;
    return id;
  }
}

async function fixture(options = {}) {
  const store = options.store || new MemoryStore();
  const { server } = createApp({
    store,
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
        ...(requestOptions.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...requestOptions.headers
      }
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return { response, body };
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
  }

  return { store, request, close };
}

async function createBooking(app, payload = BASE_BOOKING) {
  return app.request("/api/bookings", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

test("serves the four Supabase-backed room configurations and app routes", async t => {
  const app = await fixture();
  t.after(app.close);

  const result = await app.request("/api/rooms");
  assert.equal(result.response.status, 200);
  assert.deepEqual(
    result.body.rooms.map(room => room.name),
    [
      "Meeting Room",
      "Standing Workstations",
      "Innovation Hub",
      "Quiet Pods"
    ]
  );
  for (const room of result.body.rooms) {
    assert.equal(room.bookingIncrementMinutes, 15);
    assert.ok(room.purpose);
    assert.ok(room.recommendedUses.length);
    assert.ok(room.guidelines.length);
  }

  for (const route of [
    "/",
    "/book",
    "/book/details",
    `/booking/${"a".repeat(48)}`
  ]) {
    const page = await app.request(route);
    assert.equal(page.response.status, 200, route);
    assert.match(page.body, /Playbook Office Rooms/);
  }
});

test("validates durations, tampered fields, dates, office hours, and weekends", async t => {
  const app = await fixture();
  t.after(app.close);

  const validCases = [
    ["boardroom", 0, 1, "2026-07-30"],
    ["meeting-a", 2, 6, "2026-08-02"],
    ["meeting-b", 0, 8, "2026-08-03"],
    ["quiet-pods", 3, 6, "2026-08-04"]
  ];
  for (const [room, start, end, date] of validCases) {
    const created = await createBooking(app, {
      ...BASE_BOOKING,
      room,
      start,
      end,
      date,
      name: `${room}-${date}`
    });
    assert.equal(created.response.status, 201);
  }

  const invalidCases = [
    [{ name: " " }, /booked-by name/i],
    [{ title: "" }, /meeting title/i],
    [{ date: "2026-07-26" }, /between/i],
    [{ date: "2026-08-11" }, /between/i],
    [{ date: "2026-02-30" }, /valid booking date/i],
    [{ date: "2026-07-31" }, /Fridays and Saturdays/i],
    [{ date: "2026-08-01" }, /Fridays and Saturdays/i],
    [{ room: "missing-room" }, /active room/i],
    [{ start: -1 }, /between/i],
    [{ start: 39, end: 41 }, /between/i],
    [{ start: 4, end: 4 }, /between/i],
    [{ date: "2026-07-27", start: 0, end: 1 }, /past/i],
    [{ room: "quiet-pods", start: 0, end: 1 }, /30 or 45/i]
  ];
  for (const [change, expected] of invalidCases) {
    const result = await createBooking(app, {
      ...BASE_BOOKING,
      ...change
    });
    assert.equal(result.response.status, 400, JSON.stringify(change));
    assert.match(result.body.error, expected);
  }

  for (const date of ["2026-07-31", "2026-08-01"]) {
    const availability = await app.request(`/api/availability?date=${date}`);
    assert.equal(availability.response.status, 400);
    assert.match(availability.body.error, /Fridays and Saturdays/i);
  }
});

test("overlaps, back-to-back boundaries, and room blocks remain protected", async t => {
  const app = await fixture();
  t.after(app.close);

  const first = await createBooking(app, {
    ...BASE_BOOKING,
    start: 4,
    end: 6
  });
  assert.equal(first.response.status, 201);
  const overlap = await createBooking(app, {
    ...BASE_BOOKING,
    start: 5,
    end: 7,
    name: "Overlap"
  });
  assert.equal(overlap.response.status, 409);
  assert.match(overlap.body.error, /already booked/i);
  assert.equal(
    (
      await createBooking(app, {
        ...BASE_BOOKING,
        start: 2,
        end: 4,
        name: "Before"
      })
    ).response.status,
    201
  );
  assert.equal(
    (
      await createBooking(app, {
        ...BASE_BOOKING,
        start: 6,
        end: 7,
        name: "After"
      })
    ).response.status,
    201
  );

  const concurrentDate = "2026-07-29";
  const attempts = await Promise.all([
    createBooking(app, {
      ...BASE_BOOKING,
      date: concurrentDate,
      name: "First"
    }),
    createBooking(app, {
      ...BASE_BOOKING,
      date: concurrentDate,
      name: "Second"
    })
  ]);
  assert.deepEqual(
    attempts.map(item => item.response.status).sort(),
    [201, 409]
  );

  app.store.blocks.push({
    room_id: "boardroom",
    block_date: "2026-07-30",
    start_slot: 10,
    end_slot: 12,
    active: true
  });
  const blocked = await createBooking(app, {
    ...BASE_BOOKING,
    date: "2026-07-30",
    start: 9,
    end: 11
  });
  assert.equal(blocked.response.status, 409);
  assert.match(blocked.body.error, /unavailable/i);
});

test("private tokens protect edits, preserve email, and cancellation frees availability", async t => {
  const app = await fixture();
  t.after(app.close);

  const created = await createBooking(app, {
    ...BASE_BOOKING,
    email: "legacy@example.com"
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.token, /^[a-f0-9]{48}$/);
  assert.match(created.body.booking.reference, /^PB-[A-F0-9]{16}$/);
  assert.equal(
    app.store.bookings[0].token_hash,
    hashToken(created.body.token)
  );
  assert.notEqual(app.store.bookings[0].token_hash, created.body.token);

  const token = created.body.token;
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
  assert.equal(updated.body.booking.durationMinutes, 45);
  assert.equal(updated.body.booking.email, "legacy@example.com");

  const privateAvailability = await app.request(
    `/api/availability?date=2026-07-29&room=quiet-pods&token=${token}`
  );
  assert.deepEqual(privateAvailability.body.busy, []);

  const cancelled = await app.request(`/api/bookings/${token}`, {
    method: "DELETE"
  });
  assert.equal(cancelled.body.booking.status, "cancelled");
  const again = await app.request(`/api/bookings/${token}`, {
    method: "DELETE"
  });
  assert.equal(again.body.booking.status, "cancelled");
  assert.deepEqual(
    (
      await app.request(
        "/api/availability?date=2026-07-29&room=quiet-pods"
      )
    ).body.busy,
    []
  );
  assert.equal(
    (
      await app.request(`/api/bookings/${token}`, {
        method: "PUT",
        body: JSON.stringify(BASE_BOOKING)
      })
    ).response.status,
    409
  );
});

test("availability exposes intervals without booking PII", async t => {
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

  const availability = await app.request(
    "/api/availability?date=2026-07-28"
  );
  assert.deepEqual(availability.body.busy, [
    { room: "meeting-a", start: 5, end: 8, type: "booked" }
  ]);
  assert.doesNotMatch(
    JSON.stringify(availability.body),
    /Sara|Quick planning|Bring notes|PB-/
  );
});

test("past bookings cannot be recycled and Bahrain time controls validation", async t => {
  let clock = new Date("2026-07-27T08:00:00+03:00");
  const app = await fixture({ now: () => new Date(clock) });
  t.after(app.close);

  const created = await createBooking(app);
  assert.equal(created.response.status, 201);
  clock = new Date("2026-07-28T10:01:00+03:00");

  const recycled = await app.request(
    `/api/bookings/${created.body.token}`,
    {
      method: "PUT",
      body: JSON.stringify({
        ...BASE_BOOKING,
        date: "2026-07-29",
        start: 16,
        end: 20
      })
    }
  );
  assert.equal(recycled.response.status, 409);
  assert.match(recycled.body.error, /past bookings/i);

  const BahrainApp = await fixture({
    now: () => new Date("2026-07-27T21:30:00Z")
  });
  t.after(BahrainApp.close);
  const previousOfficeDate = await createBooking(BahrainApp, {
    ...BASE_BOOKING,
    date: "2026-07-27"
  });
  assert.equal(previousOfficeDate.response.status, 400);
  assert.match(previousOfficeDate.body.error, /between 2026-07-28/i);
});

test("Postgres migration enforces conflicts, workweek rules, and server-only access", () => {
  const sql = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "supabase",
      "migrations",
      "20260728000000_initial_booking_schema.sql"
    ),
    "utf8"
  );
  assert.match(sql, /exclude using gist/i);
  assert.match(sql, /bookings_no_overlap/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /WEEKEND_CLOSED/);
  assert.match(sql, /ROOM_BLOCKED/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all[\s\S]*from anon, authenticated/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
});

test("Supabase configuration requires server-side credentials and normalizes joins", () => {
  assert.throws(
    () => createSupabaseClientFromEnv({}),
    /SUPABASE_URL and SUPABASE_SECRET_KEY/
  );
  assert.deepEqual(
    normalizeBookingRow({
      id: 1,
      room: [{ name: "Meeting Room", location: "", slug: "meeting-room" }]
    }),
    {
      id: 1,
      room: [{ name: "Meeting Room", location: "", slug: "meeting-room" }],
      room_name: "Meeting Room",
      room_location: "",
      room_slug: "meeting-room"
    }
  );
});
