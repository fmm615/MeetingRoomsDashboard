"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createApp,
  hashToken,
  loadGoogleContactGroup
} = require("../server");
const { ROOM_CONFIGURATIONS } = require("../room-config");
const {
  createSupabaseClientFromEnv,
  normalizeBookingRow
} = require("../lib/supabase-store");

const FIXED_NOW = new Date("2026-07-27T08:00:00+03:00");
const TEST_ACCESS_TOKEN = "test-google-access-token";
const TEST_ENVIRONMENT = {
  SUPABASE_URL: "https://project-ref.supabase.co",
  SUPABASE_SECRET_KEY: "server-secret",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_browser-safe"
};
const TEST_GOOGLE_USER = {
  id: "google-user-1",
  email: "mahmood@playbook.test",
  email_confirmed_at: "2026-07-01T08:00:00.000Z",
  app_metadata: { provider: "google", providers: ["google"] },
  user_metadata: { full_name: "Mahmood" }
};
const BASE_BOOKING = {
  date: "2026-07-28",
  room: "boardroom",
  start: 8,
  end: 12,
  name: "Mahmood",
  organizerGroup: "PLAYBOOK",
  attendees: "sara@playbook.test, ahmed@oh.test",
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
      maximum_capacity: room.maximumCapacity,
      display_order: index + 1
    }));
    this.bookings = [];
    this.blocks = [];
    this.attendeeDirectory = [];
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

  async listAttendeeDirectory() {
    return this.attendeeDirectory
      .filter(contact => contact.enabled)
      .map(({ email, name, source }) => ({ email, name, source }))
      .sort((left, right) =>
        (left.name || left.email).localeCompare(right.name || right.email)
      );
  }

  async importAttendeeDirectory(contacts, timestamp) {
    for (const contact of contacts) {
      const existing = this.attendeeDirectory.find(
        candidate => candidate.email === contact.email
      );
      if (existing) {
        Object.assign(existing, {
          name: contact.name,
          source: "google",
          enabled: true,
          updated_at: timestamp
        });
      } else {
        this.attendeeDirectory.push({
          ...contact,
          source: "google",
          enabled: true,
          created_at: timestamp,
          updated_at: timestamp
        });
      }
    }
  }

  async rememberAttendeeEmails(emails, timestamp) {
    for (const email of emails) {
      if (
        !this.attendeeDirectory.some(contact => contact.email === email)
      ) {
        this.attendeeDirectory.push({
          email,
          name: "",
          source: "manual",
          enabled: true,
          created_at: timestamp,
          updated_at: timestamp
        });
      }
    }
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
    const attendees = String(value.attendees || "")
      .split(/[,;\n]+/)
      .map(email => email.trim())
      .filter(Boolean);
    if (
      room.maximum_capacity !== null &&
      attendees.length + 1 > room.maximum_capacity
    ) {
      throw storeFailure("BOOKING_CAPACITY");
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
      organizer_group: value.organizerGroup,
      attendees: value.attendees,
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
      organizer_group: value.organizerGroup,
      attendees: value.attendees,
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
  const authUser = options.authUser || TEST_GOOGLE_USER;
  const authenticateRequest =
    options.authenticateRequest ||
    (async token => (token === TEST_ACCESS_TOKEN ? authUser : null));
  const { server } = createApp({
    store,
    now: () => new Date(FIXED_NOW),
    ...options,
    environment: options.environment || TEST_ENVIRONMENT,
    authenticateRequest
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function request(requestPath, requestOptions = {}) {
    const {
      authenticated = true,
      headers = {},
      ...fetchOptions
    } = requestOptions;
    const response = await fetch(`${origin}${requestPath}`, {
      ...fetchOptions,
      headers: {
        ...(fetchOptions.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...(authenticated
          ? { Authorization: `Bearer ${TEST_ACCESS_TOKEN}` }
          : {}),
        ...headers
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
  assert.deepEqual(
    result.body.rooms.map(room => room.maximumCapacity),
    [7, 2, null, 3]
  );

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
    ["quiet-pods", 4, 7, "2026-08-04"]
  ];
  for (const [room, start, end, date] of validCases) {
    const created = await createBooking(app, {
      ...BASE_BOOKING,
      room,
      start,
      end,
      date,
      name: `${room}-${date}`,
      attendees: room === "meeting-a" ? "sara@playbook.test" : BASE_BOOKING.attendees
    });
    assert.equal(created.response.status, 201);
  }

  const invalidCases = [
    [{ organizerGroup: "" }, /PLAYBOOK, O&H, or both/i],
    [{ organizerGroup: "Another team" }, /PLAYBOOK, O&H, or both/i],
    [{ attendees: "x".repeat(501) }, /500 characters/i],
    [{ attendees: "not-an-email" }, /complete attendee email/i],
    [{ title: "" }, /meeting title/i],
    [{ date: "2026-07-26" }, /between/i],
    [{ date: "2026-08-11" }, /between/i],
    [{ date: "2026-02-30" }, /valid booking date/i],
    [{ date: "2026-07-31" }, /Fridays and Saturdays/i],
    [{ date: "2026-08-01" }, /Fridays and Saturdays/i],
    [{ room: "missing-room" }, /active room/i],
    [{ start: -1 }, /between/i],
    [{ start: 39, end: 41 }, /between/i],
    [{ start: 1, end: 3 }, /30-minute intervals/i],
    [{ start: 4, end: 4 }, /between/i],
    [{ date: "2026-07-27", start: 0, end: 1 }, /past/i],
    [{ room: "quiet-pods", start: 0, end: 1 }, /30 or 45/i],
    [
      {
        attendees:
          "a@test.com,b@test.com,c@test.com,d@test.com,e@test.com,f@test.com,g@test.com"
      },
      /up to 7 people including the organizer/i
    ],
    [
      {
        room: "meeting-a",
        attendees: "a@test.com,b@test.com"
      },
      /up to 2 people including the organizer/i
    ],
    [
      {
        room: "quiet-pods",
        attendees: "a@test.com,b@test.com,c@test.com"
      },
      /up to 3 people including the organizer/i
    ]
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

  const solo = await createBooking(app, {
    ...BASE_BOOKING,
    date: "2026-08-05",
    attendees: ""
  });
  assert.equal(solo.response.status, 201);
  assert.equal(solo.body.booking.attendees, "");

  const unlimited = await createBooking(app, {
    ...BASE_BOOKING,
    room: "meeting-b",
    date: "2026-08-05",
    start: 16,
    end: 20,
    attendees: Array.from(
      { length: 10 },
      (_, index) => `person${index + 1}@test.com`
    ).join(",")
  });
  assert.equal(unlimited.response.status, 201);
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
    start: 4,
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
    start: 10,
    end: 12
  });
  assert.equal(blocked.response.status, 409);
  assert.match(blocked.body.error, /unavailable/i);
});

test("private tokens protect edits, preserve email, and cancellation frees availability", async t => {
  const app = await fixture();
  t.after(app.close);

  const created = await createBooking(app, {
    ...BASE_BOOKING,
    organizerGroup: "Joint",
    attendees: "mahmood@playbook.test, sara@playbook.test, ahmed@oh.test",
    email: "legacy@example.com"
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.booking.organizerGroup, "Joint");
  assert.equal(
    created.body.booking.attendees,
    "mahmood@playbook.test, sara@playbook.test, ahmed@oh.test"
  );
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
  assert.equal(updated.body.booking.organizerGroup, "PLAYBOOK");
  assert.equal(
    updated.body.booking.attendees,
    "sara@playbook.test, ahmed@oh.test"
  );
  assert.equal(updated.body.booking.email, TEST_GOOGLE_USER.email);

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
    start: 6,
    end: 9,
    name: "Sara",
    attendees: "ahmed@oh.test",
    title: "Quick planning",
    notes: "Bring notes"
  });
  assert.equal(created.response.status, 201);

  const availability = await app.request(
    "/api/availability?date=2026-07-28"
  );
  assert.deepEqual(availability.body.busy, [
    { room: "meeting-a", start: 6, end: 9, type: "booked" }
  ]);
  assert.doesNotMatch(
    JSON.stringify(availability.body),
    /Sara|ahmed@oh\.test|Quick planning|Bring notes|PB-/
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
  assert.match(sql, /organizer_group/);
  assert.match(sql, /attendees/);

  const participantUpgrade = fs.readFileSync(
    path.join(
      __dirname, "..", "supabase", "migrations",
      "20260728010000_add_booking_participants.sql"
    ),
    "utf8"
  );
  assert.match(participantUpgrade, /drop function if exists public\.create_booking/i);
  assert.match(participantUpgrade, /bookings_attendees_check/i);

  const realtimeUpgrade = fs.readFileSync(
    path.join(
      __dirname, "..", "supabase", "migrations",
      "20260728020000_add_availability_broadcast.sql"
    ),
    "utf8"
  );
  assert.match(realtimeUpgrade, /realtime\.send/i);
  assert.match(realtimeUpgrade, /availability_changed/);
  assert.match(realtimeUpgrade, /bookings_broadcast_availability/);
  assert.match(realtimeUpgrade, /room_blocks_broadcast_availability/);
  assert.match(
    realtimeUpgrade,
    /jsonb_build_object\(\s*'date'[\s\S]*'room'/i
  );
  assert.doesNotMatch(
    realtimeUpgrade,
    /\b(name|email|attendees|notes|token_hash|reference)\b/i
  );
  assert.doesNotMatch(realtimeUpgrade, /\bcurrent_date\b/i);

  const startIntervalUpgrade = fs.readFileSync(
    path.join(
      __dirname, "..", "supabase", "migrations",
      "20260728030000_add_30_minute_start_times.sql"
    ),
    "utf8"
  );
  assert.match(startIntervalUpgrade, /START_TIME_INTERVAL/);
  assert.match(startIntervalUpgrade, /mod\(new\.start_slot,\s*2\)/i);
  assert.doesNotMatch(startIntervalUpgrade, /alter table[\s\S]*add constraint/i);

  const attendeeUpgrade = fs.readFileSync(
    path.join(
      __dirname, "..", "supabase", "migrations",
      "20260728040000_add_optional_attendee_directory.sql"
    ),
    "utf8"
  );
  assert.match(
    attendeeUpgrade,
    /check\s*\(length\(btrim\(attendees\)\)\s*<=\s*500\)/i
  );
  assert.match(attendeeUpgrade, /create table if not exists public\.attendee_directory/i);
  assert.match(attendeeUpgrade, /enable row level security/i);
  assert.match(
    attendeeUpgrade,
    /revoke all[\s\S]*from public, anon, authenticated/i
  );
  assert.match(
    attendeeUpgrade,
    /grant select, insert, update[\s\S]*to service_role/i
  );
  assert.match(attendeeUpgrade, /source in \('google', 'manual'\)/i);

  const capacityUpgrade = fs.readFileSync(
    path.join(
      __dirname, "..", "supabase", "migrations",
      "20260728050000_enforce_room_capacity.sql"
    ),
    "utf8"
  );
  assert.match(capacityUpgrade, /maximum_capacity integer/i);
  assert.match(capacityUpgrade, /when 'boardroom' then 7/i);
  assert.match(capacityUpgrade, /when 'meeting-a' then 2/i);
  assert.match(capacityUpgrade, /when 'meeting-b' then null/i);
  assert.match(capacityUpgrade, /when 'quiet-pods' then 3/i);
  assert.match(
    capacityUpgrade,
    /attendee_count \+ 1 > configured_capacity/i
  );
  assert.match(capacityUpgrade, /BOOKING_CAPACITY/);
  assert.match(
    capacityUpgrade,
    /before insert or update of room_id, attendees/i
  );
});

test("Google Contacts loader imports only valid Enrollment members", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const value = String(url);
    requests.push({ url: value, authorization: options.headers.Authorization });
    let payload;
    if (value.includes("openidconnect.googleapis.com")) {
      payload = { email: TEST_GOOGLE_USER.email };
    } else if (
      value.includes("/contactGroups?") &&
      !value.includes("/contactGroups/enrollment")
    ) {
      payload = {
        contactGroups: [
          {
            name: "Enrollment",
            resourceName: "contactGroups/enrollment",
            memberCount: 3
          }
        ]
      };
    } else if (value.includes("/contactGroups/enrollment")) {
      payload = {
        memberResourceNames: [
          "people/sara",
          "people/self",
          "people/invalid"
        ]
      };
    } else {
      payload = {
        responses: [
          {
            person: {
              names: [{ displayName: "Sara" }],
              emailAddresses: [
                { value: "Sara@Playbook.test", metadata: { primary: true } }
              ]
            }
          },
          {
            person: {
              names: [{ displayName: "Mahmood" }],
              emailAddresses: [{ value: TEST_GOOGLE_USER.email }]
            }
          },
          {
            person: {
              names: [{ displayName: "Missing Email" }],
              emailAddresses: [{ value: "not-an-email" }]
            }
          }
        ]
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
      }
    };
  };

  const contacts = await loadGoogleContactGroup(
    "google-provider-token-with-contacts-scope",
    { email: TEST_GOOGLE_USER.email },
    { fetchImpl }
  );
  assert.deepEqual(contacts, [
    { name: "Sara", email: "sara@playbook.test" }
  ]);
  assert.equal(requests.length, 4);
  assert.ok(
    requests.every(
      request =>
        request.authorization ===
        "Bearer google-provider-token-with-contacts-scope"
    )
  );
});

test("attendee directory supports solo bookings, remembered emails, and Enrollment imports", async t => {
  const googleContactsLoader = async (providerToken, signedInUser) => {
    assert.equal(providerToken, "google-provider-token-with-contacts-scope");
    assert.equal(signedInUser.email, TEST_GOOGLE_USER.email);
    return [
      { name: "Sara", email: "sara@playbook.test" },
      { name: "Fatima", email: "fatima@oh.test" }
    ];
  };
  const app = await fixture({ googleContactsLoader });
  t.after(app.close);

  const initial = await app.request("/api/attendees");
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body.contacts, []);

  const solo = await createBooking(app, {
    ...BASE_BOOKING,
    attendees: ""
  });
  assert.equal(solo.response.status, 201);
  assert.deepEqual((await app.request("/api/attendees")).body.contacts, []);

  const teamBooking = await createBooking(app, {
    ...BASE_BOOKING,
    date: "2026-07-29",
    attendees: "sara@playbook.test, ahmed@oh.test"
  });
  assert.equal(teamBooking.response.status, 201);
  assert.equal(
    (await app.request("/api/attendees")).body.contacts.length,
    2
  );

  const imported = await app.request("/api/attendees/import-google", {
    method: "POST",
    body: JSON.stringify({
      providerToken: "google-provider-token-with-contacts-scope"
    })
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.group, "Enrollment");
  assert.equal(imported.body.imported, 2);

  const directory = (await app.request("/api/attendees")).body.contacts;
  assert.deepEqual(
    directory.map(contact => contact.email),
    ["ahmed@oh.test", "fatima@oh.test", "sara@playbook.test"]
  );
  assert.deepEqual(
    directory.find(contact => contact.email === "sara@playbook.test"),
    {
      email: "sara@playbook.test",
      name: "Sara",
      source: "google"
    }
  );

  const anonymous = await app.request("/api/attendees", {
    authenticated: false
  });
  assert.equal(anonymous.response.status, 401);
});

test("Google authentication protects booking APIs and supplies owner identity", async t => {
  const app = await fixture();
  t.after(app.close);

  const authConfig = await app.request("/api/auth-config", {
    authenticated: false
  });
  assert.equal(authConfig.response.status, 200);
  assert.deepEqual(authConfig.body, {
    enabled: true,
    url: TEST_ENVIRONMENT.SUPABASE_URL,
    publishableKey: TEST_ENVIRONMENT.SUPABASE_PUBLISHABLE_KEY
  });
  assert.doesNotMatch(JSON.stringify(authConfig.body), /server-secret/);

  const anonymous = await app.request("/api/rooms", {
    authenticated: false
  });
  assert.equal(anonymous.response.status, 401);
  assert.match(anonymous.body.error, /sign in with Google/i);

  const expired = await app.request("/api/rooms", {
    headers: { Authorization: "Bearer expired-token" }
  });
  assert.equal(expired.response.status, 401);
  assert.match(expired.body.error, /expired/i);

  const created = await createBooking(app, {
    ...BASE_BOOKING,
    name: "Impersonated name",
    email: "another-person@example.com"
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.booking.bookedBy, TEST_GOOGLE_USER.user_metadata.full_name);
  assert.equal(created.body.booking.email, TEST_GOOGLE_USER.email);
});

test("Google authentication rejects non-Google and unapproved-domain users", async t => {
  const passwordApp = await fixture({
    authUser: {
      ...TEST_GOOGLE_USER,
      app_metadata: { provider: "email", providers: ["email"] }
    }
  });
  t.after(passwordApp.close);
  const passwordResult = await passwordApp.request("/api/rooms");
  assert.equal(passwordResult.response.status, 403);
  assert.match(passwordResult.body.error, /Google account/i);

  const domainApp = await fixture({
    environment: {
      ...TEST_ENVIRONMENT,
      GOOGLE_ALLOWED_DOMAINS: "playbook.example,oh.example"
    },
    authUser: {
      ...TEST_GOOGLE_USER,
      email: "mahmood@outside.example"
    }
  });
  t.after(domainApp.close);
  const domainResult = await domainApp.request("/api/rooms");
  assert.equal(domainResult.response.status, 403);
  assert.match(domainResult.body.error, /approved company Google account/i);

  const approvedApp = await fixture({
    environment: {
      ...TEST_ENVIRONMENT,
      GOOGLE_ALLOWED_DOMAINS: "playbook.test"
    }
  });
  t.after(approvedApp.close);
  const approvedResult = await approvedApp.request("/api/rooms");
  assert.equal(approvedResult.response.status, 200);
});

test("Realtime exposes only browser-safe configuration and CSP origins", async t => {
  const disabled = await fixture({
    environment: {
      SUPABASE_URL: "https://project-ref.supabase.co",
      SUPABASE_SECRET_KEY: "server-secret"
    }
  });
  t.after(disabled.close);
  const disabledResult = await disabled.request("/api/realtime-config");
  assert.deepEqual(disabledResult.body, { enabled: false });

  const app = await fixture({
    environment: {
      SUPABASE_URL: "https://project-ref.supabase.co",
      SUPABASE_SECRET_KEY: "server-secret",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_browser-safe"
    }
  });
  t.after(app.close);
  const result = await app.request("/api/realtime-config");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    enabled: true,
    url: "https://project-ref.supabase.co",
    publishableKey: "sb_publishable_browser-safe"
  });
  assert.doesNotMatch(JSON.stringify(result.body), /server-secret/);
  assert.match(
    result.response.headers.get("content-security-policy"),
    /connect-src 'self' https:\/\/project-ref\.supabase\.co wss:\/\/project-ref\.supabase\.co/
  );
  assert.equal(result.response.headers.get("cache-control"), "no-store");
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
