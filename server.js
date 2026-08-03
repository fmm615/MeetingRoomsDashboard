"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { randomBytes, createHash } = require("node:crypto");
const {
  createSupabaseClientFromEnv,
  createSupabaseStoreFromEnv
} = require("./lib/supabase-store");
const { createGoogleCalendarSync } = require("./lib/google-calendar");

const ROOT = __dirname;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 18;
const SLOT_MINUTES = 15;
const TOTAL_SLOTS = ((CLOSE_HOUR - OPEN_HOUR) * 60) / SLOT_MINUTES;
const START_TIME_INTERVAL_MINUTES = 30;
const START_SLOT_STEP = START_TIME_INTERVAL_MINUTES / SLOT_MINUTES;
const BOOKING_WINDOW_DAYS = 14;
const OFFICE_UTC_OFFSET_MINUTES = 3 * 60;
const WEEKEND_CLOSED_MESSAGE =
  "Bookings are unavailable on Fridays and Saturdays.";
const DEFAULT_GOOGLE_CONTACT_GROUP = "Enrollment";
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
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

function isWeekendDate(value) {
  const day = new Date(`${value}T12:00:00Z`).getUTCDay();
  return day === 5 || day === 6;
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

function arrayValue(value) {
  if (Array.isArray(value)) return value;
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
    recommendedUses: arrayValue(row.recommended_uses) || [],
    guidelines: arrayValue(row.guidelines) || [],
    bookingIncrementMinutes: row.booking_increment_minutes,
    minimumDurationMinutes:
      row.minimum_duration_minutes || row.booking_increment_minutes,
    maximumDurationMinutes: row.maximum_duration_minutes,
    allowedDurationsMinutes: arrayValue(row.allowed_durations_minutes),
    capacityLabel: row.capacity_label || "",
    maximumCapacity: Number.isInteger(row.maximum_capacity)
      ? row.maximum_capacity
      : null,
    isActive: Boolean(row.enabled)
  };
}

function durationOptions(room) {
  if (room.allowedDurationsMinutes?.length) {
    return room.allowedDurationsMinutes;
  }
  const durations = [];
  const minimum =
    room.minimumDurationMinutes || room.bookingIncrementMinutes;
  for (
    let duration = minimum;
    duration <= room.maximumDurationMinutes;
    duration += room.bookingIncrementMinutes
  ) {
    durations.push(duration);
  }
  return durations;
}

function durationError(room) {
  if (room.slug === "meeting-room") {
    return "The Meeting Room can be booked for a maximum of 2 hours.";
  }
  if (room.slug === "standing-workstations") {
    return "Standing Workstations can only be booked for 15–60 minutes.";
  }
  if (room.slug === "innovation-hub") {
    return "The Innovation Hub can be booked for a maximum of 2 hours.";
  }
  if (room.slug === "quiet-pods") {
    return "Quiet Pods can only be booked for 30 or 45 minutes.";
  }
  return `${room.name} cannot be booked for the selected duration.`;
}

function slotToTime(slot) {
  const minutes = OPEN_HOUR * 60 + slot * SLOT_MINUTES;
  const date = new Date(
    2000,
    0,
    1,
    Math.floor(minutes / 60),
    minutes % 60
  );
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
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
    organizerGroup: row.organizer_group,
    attendees: row.attendees,
    title: row.title,
    meetingTitle: row.title,
    email: row.email,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    calendarSync: row.calendar_sync_state || "not_configured"
  };
}

function parseAttendeeEmails(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > 500) {
    return { error: "Attendee emails cannot be longer than 500 characters." };
  }
  if (!text) return { emails: [], value: "" };
  const candidates = text
    .split(/[,;\n]+/)
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
  const emails = [...new Set(candidates)];
  if (emails.length > 30) {
    return { error: "Select no more than 30 attendees." };
  }
  const invalid = emails.find(
    email =>
      email.length > 120 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
  if (invalid) {
    return {
      error:
        "Enter complete attendee email addresses, separated by commas."
    };
  }
  return {
    emails,
    value: emails.join(", ")
  };
}

// Shared trust boundary for create and edit requests. The database repeats
// conflict protection, so browser values cannot bypass room-booking rules.
async function validateBooking(
  input,
  store,
  now = new Date(),
  { fallbackEmail = "" } = {}
) {
  const data =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const organizerGroup =
    typeof data.organizerGroup === "string"
      ? data.organizerGroup.trim()
      : "";
  const attendeeResult = parseAttendeeEmails(data.attendees);
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const email =
    typeof data.email === "string" ? data.email.trim() : fallbackEmail;
  const notes = typeof data.notes === "string" ? data.notes.trim() : "";
  const date = typeof data.date === "string" ? data.date : "";
  const roomId = typeof data.room === "string" ? data.room : "";
  const start = data.start;
  const end = data.end;

  if (!name || name.length > 80) {
    return {
      error: "Enter a booked-by name of 80 characters or fewer."
    };
  }
  if (!["PLAYBOOK", "O&H", "Joint"].includes(organizerGroup)) {
    return {
      error: "Select whether this booking is for PLAYBOOK, O&H, or both."
    };
  }
  if (attendeeResult.error) return { error: attendeeResult.error };
  if (!title || title.length > 100) {
    return {
      error:
        "Enter a meeting title or booking purpose of 100 characters or fewer."
    };
  }
  if (email.length > 120) {
    return { error: "The saved email value is too long." };
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      error:
        "Enter a valid organizer email address or leave it blank."
    };
  }
  if (notes.length > 500) {
    return { error: "Notes cannot be longer than 500 characters." };
  }
  if (!isRealISODate(date)) {
    return { error: "Select a valid booking date." };
  }

  const minimumDate = localISO(now);
  const maximumDate = localISO(addDays(now, BOOKING_WINDOW_DAYS));
  if (date < minimumDate || date > maximumDate) {
    return {
      error: `Bookings must be between ${minimumDate} and ${maximumDate}.`
    };
  }
  if (isWeekendDate(date)) {
    return { error: WEEKEND_CLOSED_MESSAGE };
  }

  const roomRow = await store.getRoom(roomId, true);
  if (!roomRow) {
    return { error: "Select an active room or workspace." };
  }
  const room = publicRoom(roomRow);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > TOTAL_SLOTS
  ) {
    return {
      error: `Select a time between ${OPEN_HOUR}:00 and ${CLOSE_HOUR}:00.`
    };
  }
  if (start % START_SLOT_STEP !== 0) {
    return {
      error:
        `Start times must use ${START_TIME_INTERVAL_MINUTES}-minute intervals.`
    };
  }

  const durationMinutes = (end - start) * SLOT_MINUTES;
  const startsOnIncrement =
    (start * SLOT_MINUTES) % room.bookingIncrementMinutes === 0;
  if (
    !startsOnIncrement ||
    !durationOptions(room).includes(durationMinutes)
  ) {
    return { error: durationError(room) };
  }

  if (bookingStartTime(date, start) <= now) {
    return {
      error: "The selected start time is in the past. Choose another time."
    };
  }

  return {
    value: {
      name,
      organizerGroup,
      attendees: attendeeResult.value,
      attendeeEmails: attendeeResult.emails,
      title,
      email,
      notes,
      date,
      room: roomId,
      start,
      end,
      durationMinutes,
      roomConfiguration: room
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
          reject(
            Object.assign(new Error("Request body is too large."), {
              status: 413
            })
          );
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
        reject(
          Object.assign(new Error("Request body must be valid JSON."), {
            status: 400
          })
        );
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

function databaseError(error, room) {
  const message = [
    error?.message,
    error?.details,
    error?.hint
  ]
    .filter(Boolean)
    .join(" ");
  if (message.includes("WEEKEND_CLOSED")) {
    return { status: 400, message: WEEKEND_CLOSED_MESSAGE };
  }
  if (message.includes("START_TIME_INTERVAL")) {
    return {
      status: 400,
      message: `Start times must use ${START_TIME_INTERVAL_MINUTES}-minute intervals.`
    };
  }
  if (
    error?.code === "23P01" ||
    message.includes("BOOKING_CONFLICT") ||
    message.includes("bookings_no_overlap")
  ) {
    return {
      status: 409,
      message:
        "This room is already booked during the selected time. Select another time or room."
    };
  }
  if (message.includes("ROOM_BLOCKED")) {
    return {
      status: 409,
      message:
        "This room is unavailable during the selected time. Select another time or room."
    };
  }
  if (message.includes("BOOKING_DURATION")) {
    return { status: 400, message: durationError(room) };
  }
  if (message.includes("ROOM_INACTIVE")) {
    return {
      status: 400,
      message: "Select an active room or workspace."
    };
  }
  if (message.includes("BOOKING_CANCELLED")) {
    return {
      status: 409,
      message: "A cancelled booking cannot be edited."
    };
  }
  return null;
}

function generateReference() {
  return `PB-${randomBytes(8).toString("hex").toUpperCase()}`;
}

function realtimeBrowserConfig(environment = process.env) {
  const url = environment.SUPABASE_URL || "";
  const publishableKey = environment.SUPABASE_PUBLISHABLE_KEY || "";
  if (!publishableKey.startsWith("sb_publishable_")) {
    return { enabled: false };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return { enabled: false };
    return {
      enabled: true,
      url: parsed.origin,
      publishableKey,
      websocketOrigin: `wss://${parsed.host}`
    };
  } catch {
    return { enabled: false };
  }
}

function allowedGoogleDomains(environment = process.env) {
  return String(environment.GOOGLE_ALLOWED_DOMAINS || "")
    .split(",")
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean);
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function googleIdentity(user) {
  const metadata =
    user?.user_metadata &&
    typeof user.user_metadata === "object" &&
    !Array.isArray(user.user_metadata)
      ? user.user_metadata
      : {};
  const email = typeof user?.email === "string"
    ? user.email.trim().toLowerCase()
    : "";
  const fallbackName = email.split("@")[0] || "Team member";
  const name = String(
    metadata.full_name || metadata.name || fallbackName
  ).trim();
  return {
    id: String(user?.id || ""),
    name: name.slice(0, 80),
    email
  };
}

function createAuthenticationVerifier(environment = process.env) {
  const client = createSupabaseClientFromEnv(environment);
  return async accessToken => {
    const { data, error } = await client.auth.getUser(accessToken);
    if (error) return null;
    return data.user || null;
  };
}

async function authenticatedGoogleUser(
  req,
  authenticateRequest,
  allowedDomains
) {
  const token = bearerToken(req);
  if (!token) {
    throw Object.assign(
      new Error("Sign in with Google to use the booking system."),
      { status: 401 }
    );
  }
  let user;
  try {
    user = await authenticateRequest(token);
  } catch {
    user = null;
  }
  if (!user) {
    throw Object.assign(
      new Error("Your sign-in session has expired. Sign in again."),
      { status: 401 }
    );
  }
  const providers = Array.isArray(user.app_metadata?.providers)
    ? user.app_metadata.providers
    : [];
  if (
    user.app_metadata?.provider !== "google" &&
    !providers.includes("google")
  ) {
    throw Object.assign(
      new Error("Use a Google account to access the booking system."),
      { status: 403 }
    );
  }
  const identity = googleIdentity(user);
  if (!identity.id || !identity.email || !user.email_confirmed_at) {
    throw Object.assign(
      new Error("A verified Google email address is required."),
      { status: 403 }
    );
  }
  const domain = identity.email.split("@")[1] || "";
  if (allowedDomains.length && !allowedDomains.includes(domain)) {
    throw Object.assign(
      new Error("Use an approved company Google account."),
      { status: 403 }
    );
  }
  return identity;
}

async function googleJSON(url, providerToken, fetchImpl, context) {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${providerToken}`,
      Accept: "application/json"
    }
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const providerMessage =
      typeof payload?.error?.message === "string"
        ? payload.error.message
        : "";
    const error = new Error(
      response.status === 401
        ? "Google Contacts access expired. Connect Google Contacts again."
        : providerMessage || `Google could not ${context}.`
    );
    error.status = response.status === 401 ? 401 : 502;
    throw error;
  }
  return payload;
}

async function loadGoogleContactGroup(
  providerToken,
  signedInUser,
  {
    fetchImpl = fetch,
    groupName = DEFAULT_GOOGLE_CONTACT_GROUP
  } = {}
) {
  if (
    typeof providerToken !== "string" ||
    providerToken.length < 20 ||
    providerToken.length > 4096
  ) {
    throw Object.assign(
      new Error("Connect Google Contacts before importing Enrollment."),
      { status: 400 }
    );
  }

  const profile = await googleJSON(
    "https://openidconnect.googleapis.com/v1/userinfo",
    providerToken,
    fetchImpl,
    "verify the Google account"
  );
  if (
    typeof profile.email !== "string" ||
    profile.email.trim().toLowerCase() !== signedInUser.email
  ) {
    throw Object.assign(
      new Error("Google Contacts must use the same signed-in account."),
      { status: 403 }
    );
  }

  const groupsURL = new URL(
    "https://people.googleapis.com/v1/contactGroups"
  );
  groupsURL.searchParams.set("pageSize", "1000");
  groupsURL.searchParams.set("groupFields", "name,memberCount");
  const groups = await googleJSON(
    groupsURL,
    providerToken,
    fetchImpl,
    "load contact labels"
  );
  const group = (groups.contactGroups || []).find(
    item =>
      typeof item?.name === "string" &&
      item.name.trim().toLowerCase() === groupName.toLowerCase()
  );
  if (!group || !/^contactGroups\/[^/]+$/.test(group.resourceName || "")) {
    throw Object.assign(
      new Error(`Google Contacts label “${groupName}” was not found.`),
      { status: 404 }
    );
  }

  const groupURL = new URL(
    `https://people.googleapis.com/v1/${group.resourceName}`
  );
  groupURL.searchParams.set("maxMembers", "1000");
  const populatedGroup = await googleJSON(
    groupURL,
    providerToken,
    fetchImpl,
    `load the ${groupName} label`
  );
  const resourceNames = Array.isArray(populatedGroup.memberResourceNames)
    ? populatedGroup.memberResourceNames.slice(0, 200)
    : [];
  if (!resourceNames.length) return [];

  const peopleURL = new URL(
    "https://people.googleapis.com/v1/people:batchGet"
  );
  peopleURL.searchParams.set("personFields", "names,emailAddresses");
  for (const resourceName of resourceNames) {
    peopleURL.searchParams.append("resourceNames", resourceName);
  }
  const people = await googleJSON(
    peopleURL,
    providerToken,
    fetchImpl,
    `load ${groupName} contacts`
  );
  const contacts = [];
  for (const response of people.responses || []) {
    const person = response?.person || {};
    const preferredEmail = (person.emailAddresses || []).find(
      item => item?.metadata?.primary
    ) || person.emailAddresses?.[0];
    const email =
      typeof preferredEmail?.value === "string"
        ? preferredEmail.value.trim().toLowerCase()
        : "";
    if (
      !email ||
      email === signedInUser.email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      continue;
    }
    const name =
      typeof person.names?.[0]?.displayName === "string"
        ? person.names[0].displayName.trim().slice(0, 120)
        : "";
    contacts.push({ name, email });
  }
  return [...new Map(contacts.map(contact => [contact.email, contact])).values()]
    .sort((left, right) =>
      (left.name || left.email).localeCompare(right.name || right.email)
    );
}

function applySecurityHeaders(res, realtimeConfig = { enabled: false }) {
  const connectSources = ["'self'"];
  if (realtimeConfig.enabled) {
    connectSources.push(realtimeConfig.url, realtimeConfig.websocketOrigin);
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src ${connectSources.join(" ")}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
  );
}

function routedPathname(url) {
  const forwardedPath = url.searchParams.get("path");
  if (url.pathname !== "/api" || !forwardedPath) return url.pathname;
  return `/api/${forwardedPath.replace(/^\/+/, "")}`;
}

function createRequestHandler({
  store,
  now = () => new Date(),
  root = ROOT,
  apiOnly = false,
  environment = process.env,
  authenticateRequest,
  googleContactsLoader,
  calendarSync
}) {
  if (!store) throw new Error("A booking store is required.");
  const realtimeConfig = realtimeBrowserConfig(environment);
  const verifyAccessToken =
    authenticateRequest || createAuthenticationVerifier(environment);
  const approvedDomains = allowedGoogleDomains(environment);
  const importGoogleContacts =
    googleContactsLoader ||
    ((providerToken, signedInUser) =>
      loadGoogleContactGroup(providerToken, signedInUser));
  const googleCalendar =
    calendarSync || createGoogleCalendarSync({ store, environment });

  return async function requestHandler(req, res) {
    applySecurityHeaders(res, realtimeConfig);
    const url = new URL(req.url, "http://localhost");
    const pathname = routedPathname(url);

    try {
      if (pathname === "/api/auth-config" && req.method === "GET") {
        return sendJSON(
          res,
          200,
          realtimeConfig.enabled
            ? {
                enabled: true,
                url: realtimeConfig.url,
                publishableKey: realtimeConfig.publishableKey
              }
            : { enabled: false }
        );
      }

      if (pathname === "/api/realtime-config" && req.method === "GET") {
        return sendJSON(
          res,
          200,
          realtimeConfig.enabled
            ? {
                enabled: true,
                url: realtimeConfig.url,
                publishableKey: realtimeConfig.publishableKey
              }
            : { enabled: false }
        );
      }

      // Every API route below this point requires a verified Google-backed
      // Supabase session; public configuration routes are handled above.
      const signedInUser = pathname.startsWith("/api/")
        ? await authenticatedGoogleUser(req, verifyAccessToken, approvedDomains)
        : null;

      if (pathname === "/api/calendar/status" && req.method === "GET") {
        return sendJSON(
          res,
          200,
          await googleCalendar.status(signedInUser.id)
        );
      }

      if (pathname === "/api/calendar/connect" && req.method === "POST") {
        const input = await readJSON(req);
        const calendar = await googleCalendar.connect({
          signedInUser,
          providerToken:
            typeof input.providerToken === "string" ? input.providerToken : "",
          providerRefreshToken:
            typeof input.providerRefreshToken === "string"
              ? input.providerRefreshToken
              : ""
        });
        return sendJSON(res, 200, calendar);
      }

      // Validate first so free/busy cannot probe arbitrary schedules; Google
      // receives only calendar IDs plus the requested time range.
      if (pathname === "/api/calendar/availability" && req.method === "POST") {
        const input = await readJSON(req);
        const signedInput = {
          ...input,
          name: signedInUser.name,
          email: signedInUser.email
        };
        const checked = await validateBooking(signedInput, store, now());
        if (checked.error) return sendError(res, 400, checked.error);
        return sendJSON(
          res,
          200,
          await googleCalendar.checkAvailability(checked.value, signedInUser.id)
        );
      }

      if (pathname === "/api/attendees" && req.method === "GET") {
        const contacts = await store.listAttendeeDirectory();
        return sendJSON(res, 200, { contacts });
      }

      if (
        pathname === "/api/attendees/import-google" &&
        req.method === "POST"
      ) {
        return sendError(
          res,
          410,
          "The saved attendee directory is managed from the approved team list."
        );
      }

      if (pathname === "/api/rooms" && req.method === "GET") {
        const rows = await store.listRooms();
        return sendJSON(res, 200, { rooms: rows.map(publicRoom) });
      }

      if (pathname === "/api/availability" && req.method === "GET") {
        const date = url.searchParams.get("date") || "";
        const roomId = url.searchParams.get("room") || "";
        const managementToken = url.searchParams.get("token") || "";
        if (!isRealISODate(date)) {
          return sendError(res, 400, "Select a valid booking date.");
        }
        if (isWeekendDate(date)) {
          return sendError(res, 400, WEEKEND_CLOSED_MESSAGE);
        }
        if (roomId && !(await store.getRoom(roomId, true))) {
          return sendError(res, 404, "Room or workspace not found.");
        }
        let excludedHash = "";
        if (/^[a-f0-9]{48}$/.test(managementToken)) {
          const tokenHash = hashToken(managementToken);
          if (await store.findBookingByTokenHash(tokenHash)) {
            excludedHash = tokenHash;
          }
        }
        const busy = await store.getAvailability(
          date,
          roomId,
          excludedHash
        );
        return sendJSON(res, 200, { busy });
      }

      if (pathname === "/api/bookings" && req.method === "POST") {
        const input = await readJSON(req);
        const signedInput = {
          ...input,
          name: signedInUser.name,
          email: signedInUser.email
        };
        const timestamp = now();
        const checked = await validateBooking(signedInput, store, timestamp);
        if (checked.error) return sendError(res, 400, checked.error);
        const value = checked.value;
        const token = randomBytes(24).toString("hex");
        const tokenHash = hashToken(token);
        const reference = generateReference();
        try {
          await store.createBooking({
            ...value,
            tokenHash,
            reference,
            timestamp: timestamp.toISOString()
          });
        } catch (error) {
          const known = databaseError(error, value.roomConfiguration);
          if (known) return sendError(res, known.status, known.message);
          throw error;
        }
        const row = await store.findBookingByTokenHash(tokenHash);
        if (!row) throw new Error("The created booking could not be loaded.");
        // Approved contacts and manually invited people share the same search
        // directory. A valid manual invite is remembered for future bookings.
        try {
          await store.rememberAttendeeEmails(
            value.attendeeEmails,
            timestamp.toISOString()
          );
        } catch (error) {
          console.error("Could not remember attendee suggestions.", error);
        }
        const calendar = await googleCalendar.createForBooking(
          row,
          signedInUser.id
        );
        return sendJSON(res, 201, {
          token,
          booking: publicBooking(row),
          calendar
        });
      }

      if (pathname === "/api/my-bookings" && req.method === "GET") {
        // The authenticated Google email is the authority here; no email
        // supplied by the browser can change which bookings are returned.
        const rows = await store.listBookingsForEmail(signedInUser.email);
        return sendJSON(res, 200, { bookings: rows.map(publicBooking) });
      }
      const token = tokenFromPath(pathname);
      const tokenHash = token ? hashToken(token) : "";

      if (token && req.method === "GET") {
        const row = await store.findBookingByTokenHash(tokenHash);
        if (!row) return sendError(res, 404, "Booking not found.");
        return sendJSON(res, 200, { booking: publicBooking(row) });
      }

      if (token && req.method === "PUT") {
        const existing = await store.findBookingByTokenHash(tokenHash);
        if (!existing) return sendError(res, 404, "Booking not found.");
        if (existing.status === "cancelled") {
          return sendError(
            res,
            409,
            "A cancelled booking cannot be edited."
          );
        }
        const input = await readJSON(req);
        const timestamp = now();
        if (
          bookingStartTime(existing.booking_date, existing.start_slot) <=
          timestamp
        ) {
          return sendError(
            res,
            409,
            "Past bookings can no longer be edited."
          );
        }
        const protectedInput = {
          ...input,
          name: existing.name,
          email: existing.email
        };
        const checked = await validateBooking(protectedInput, store, timestamp, {
          fallbackEmail: existing.email
        });
        if (checked.error) return sendError(res, 400, checked.error);
        const value = checked.value;
        try {
          await store.updateBooking(existing.id, {
            ...value,
            timestamp: timestamp.toISOString()
          });
        } catch (error) {
          const known = databaseError(error, value.roomConfiguration);
          if (known) return sendError(res, known.status, known.message);
          throw error;
        }
        try {
          await store.rememberAttendeeEmails(
            value.attendeeEmails,
            timestamp.toISOString()
          );
        } catch (error) {
          console.error("Could not remember attendee suggestions.", error);
        }
        const row = await store.findBookingByTokenHash(tokenHash);
        const calendar = await googleCalendar.updateForBooking(
          row,
          signedInUser.id
        );
        return sendJSON(res, 200, {
          booking: publicBooking(row),
          calendar
        });
      }

      if (token && req.method === "DELETE") {
        const existing = await store.findBookingByTokenHash(tokenHash);
        if (!existing) return sendError(res, 404, "Booking not found.");
        let calendar = { state: existing.calendar_sync_state || "not_connected" };
        if (existing.status !== "cancelled") {
          await store.cancelBooking(existing.id, now().toISOString());
          const row = await store.findBookingByTokenHash(tokenHash);
          calendar = await googleCalendar.cancelForBooking(
            row,
            signedInUser.id
          );
        }
        const row = await store.findBookingByTokenHash(tokenHash);
        return sendJSON(res, 200, {
          booking: publicBooking(row),
          calendar
        });
      }

      if (pathname.startsWith("/api/")) {
        return sendError(res, 404, "API endpoint not found.");
      }
      if (apiOnly) return sendError(res, 404, "API endpoint not found.");
      if (!["GET", "HEAD"].includes(req.method)) {
        return sendError(res, 405, "Method not allowed.");
      }

      const staticRoutes = new Set(["/", "/book", "/book/details"]);
      const relativePath =
        staticRoutes.has(pathname) ||
        /^\/booking\/[a-f0-9]{48}$/.test(pathname)
          ? "index.html"
          : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(root, relativePath);
      if (
        !filePath.startsWith(`${path.resolve(root)}${path.sep}`) &&
        filePath !== path.resolve(root, "index.html")
      ) {
        return sendError(res, 403, "Forbidden.");
      }
      if (
        !fs.existsSync(filePath) ||
        !fs.statSync(filePath).isFile()
      ) {
        return sendError(res, 404, "Page not found.");
      }
      const extension = path.extname(filePath);
      const stats = fs.statSync(filePath);
      const shouldRevalidate = [".html", ".css", ".js"].includes(extension);
      res.writeHead(200, {
        "Content-Type":
          MIME_TYPES[extension] || "application/octet-stream",
        "Cache-Control": shouldRevalidate
          ? "no-cache"
          : "public, max-age=3600",
        "Content-Length": stats.size
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      if (!res.headersSent) {
        sendError(
          res,
          error.status || 500,
          error.status
            ? error.message
            : "The server could not complete this request."
        );
      } else {
        res.destroy();
      }
      if (!error.status) console.error(error);
    }
  };
}

function createApp(options = {}) {
  const store =
    options.store || createSupabaseStoreFromEnv(options.environment);
  const handler = createRequestHandler({
    store,
    now: options.now,
    root: options.root || ROOT,
    environment: options.environment,
    authenticateRequest: options.authenticateRequest,
    googleContactsLoader: options.googleContactsLoader,
    calendarSync: options.calendarSync
  });
  return {
    server: http.createServer(handler),
    store
  };
}

function loadLocalEnvironment() {
  if (typeof process.loadEnvFile !== "function") return;
  for (const filename of [".env.local", ".env"]) {
    const filePath = path.join(ROOT, filename);
    if (fs.existsSync(filePath)) process.loadEnvFile(filePath);
  }
}

if (require.main === module) {
  loadLocalEnvironment();
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  const host = process.env.HOST || "127.0.0.1";
  const { server } = createApp();
  server.listen(port, host, () => {
    console.log(`Playbook Office Rooms is running at http://${host}:${port}`);
  });
}

module.exports = {
  createApp,
  createRequestHandler,
  validateBooking,
  hashToken,
  localISO,
  publicRoom,
  publicBooking,
  durationOptions,
  databaseError,
  realtimeBrowserConfig,
  allowedGoogleDomains,
  bearerToken,
  googleIdentity,
  authenticatedGoogleUser,
  parseAttendeeEmails,
  loadGoogleContactGroup,
  constants: {
    OPEN_HOUR,
    CLOSE_HOUR,
    SLOT_MINUTES,
    START_TIME_INTERVAL_MINUTES,
    START_SLOT_STEP,
    TOTAL_SLOTS,
    BOOKING_WINDOW_DAYS
  }
};
