"use strict";

const {
  createCipheriv,
  createDecipheriv,
  randomBytes
} = require("node:crypto");

const BAHRAIN_TIME_ZONE = "Asia/Bahrain";
const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned " +
  "https://www.googleapis.com/auth/calendar.events.freebusy";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const CALENDAR_API_ORIGIN = "https://www.googleapis.com/calendar/v3";

function calendarConfiguration(environment = process.env) {
  const clientId = String(environment.GOOGLE_CALENDAR_CLIENT_ID || "").trim();
  const clientSecret = String(
    environment.GOOGLE_CALENDAR_CLIENT_SECRET || ""
  ).trim();
  const rawKey = String(
    environment.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY || ""
  ).trim();
  const configured = [clientId, clientSecret, rawKey].filter(Boolean).length;

  if (!configured) {
    return { enabled: false, setupRequired: false };
  }
  if (configured !== 3) {
    return {
      enabled: false,
      setupRequired: true,
      message:
        "Google Calendar needs its client ID, client secret, and token encryption key."
    };
  }

  let encryptionKey;
  try {
    encryptionKey = /^[0-9a-f]{64}$/i.test(rawKey)
      ? Buffer.from(rawKey, "hex")
      : Buffer.from(rawKey, "base64");
  } catch {
    encryptionKey = Buffer.alloc(0);
  }
  if (encryptionKey.length !== 32) {
    return {
      enabled: false,
      setupRequired: true,
      message:
        "GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as Base64 or 64 hexadecimal characters."
    };
  }

  return {
    enabled: true,
    setupRequired: false,
    clientId,
    clientSecret,
    encryptionKey
  };
}

function calendarSetupError(configuration) {
  const error = new Error(
    configuration.message ||
      "Google Calendar sync is not configured on this server yet."
  );
  error.status = 503;
  return error;
}

// Refresh tokens grant long-lived Calendar access, so only their authenticated
// AES-256-GCM ciphertext is stored; the encryption key remains server-only.
function encryptRefreshToken(value, encryptionKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

function decryptRefreshToken(value, encryptionKey) {
  const [version, ivText, tagText, ciphertextText] = String(value).split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new Error("The stored Google Calendar connection is invalid.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function providerTokenError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function parseGoogleResponse(response) {
  if (response.status === 204) return {};
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function googleRequest(url, options, fetchImpl, context) {
  const response = await fetchImpl(url, options);
  const payload = await parseGoogleResponse(response);
  if (response.ok) return payload;
  const details =
    typeof payload?.error?.message === "string" ? payload.error.message : "";
  const error = new Error(details || `Google could not ${context}.`);
  error.status = response.status === 401 || response.status === 403 ? 401 : 502;
  error.code = response.status;
  throw error;
}

async function verifyGoogleProviderToken(
  providerToken,
  signedInUser,
  fetchImpl = fetch
) {
  if (
    typeof providerToken !== "string" ||
    providerToken.length < 20 ||
    providerToken.length > 4096
  ) {
    throw providerTokenError("Reconnect Google Calendar to continue.");
  }
  const profile = await googleRequest(
    USERINFO_ENDPOINT,
    {
      headers: {
        Authorization: `Bearer ${providerToken}`,
        Accept: "application/json"
      }
    },
    fetchImpl,
    "verify the Google account"
  );
  const email = typeof profile?.email === "string"
    ? profile.email.trim().toLowerCase()
    : "";
  if (!email || email !== signedInUser.email) {
    const error = new Error(
      "Google Calendar must use the same account that is signed in to Office Rooms."
    );
    error.status = 403;
    throw error;
  }
  return email;
}

function calendarEventId(bookingId) {
  return `pbrm${Number(bookingId).toString(32)}`;
}

function slotDateTime(date, slot) {
  const totalMinutes = 8 * 60 + Number(slot) * 15;
  const hour = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minute = String(totalMinutes % 60).padStart(2, "0");
  return `${date}T${hour}:${minute}:00+03:00`;
}

function attendeeEmails(value, organizerEmail) {
  const organizer = String(organizerEmail || "").trim().toLowerCase();
  return [
    ...new Set(
      String(value || "")
        .split(/[,;\n]+/)
        .map(email => email.trim().toLowerCase())
        .filter(email => email && email !== organizer)
    )
  ];
}

function calendarEventPayload(booking) {
  const location = [booking.room_name, booking.room_location]
    .filter(Boolean)
    .join(" · ");
  const description = [
    "Playbook Office Rooms",
    `Booking reference: ${booking.reference}`,
    `Booking team: ${booking.organizer_group}`,
    booking.notes ? `Notes: ${booking.notes}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: booking.calendar_event_id || calendarEventId(booking.id),
    summary: booking.title,
    description,
    location,
    start: {
      dateTime: slotDateTime(booking.booking_date, booking.start_slot),
      timeZone: BAHRAIN_TIME_ZONE
    },
    end: {
      dateTime: slotDateTime(booking.booking_date, booking.end_slot),
      timeZone: BAHRAIN_TIME_ZONE
    },
    attendees: attendeeEmails(booking.attendees, booking.email).map(email => ({
      email
    })),
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    guestsCanSeeOtherGuests: false,
    transparency: "opaque",
    visibility: "private",
    extendedProperties: {
      private: {
        playbookBookingId: String(booking.id),
        playbookBookingReference: booking.reference
      }
    }
  };
}

async function accessTokenForConnection(connection, configuration, fetchImpl) {
  const refreshToken = decryptRefreshToken(
    connection.refresh_token_ciphertext,
    configuration.encryptionKey
  );
  const body = new URLSearchParams({
    client_id: configuration.clientId,
    client_secret: configuration.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const payload = await googleRequest(
    TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    },
    fetchImpl,
    "refresh Google Calendar access"
  );
  if (typeof payload?.access_token !== "string" || !payload.access_token) {
    throw new Error("Google Calendar did not return an access token.");
  }
  return payload.access_token;
}

function createGoogleCalendarSync({
  store,
  environment = process.env,
  fetchImpl = fetch,
  logger = console
}) {
  const configuration = calendarConfiguration(environment);

  async function rememberState(booking, state, fields = {}) {
    await store.updateBookingCalendarSync(booking.id, {
      state,
      eventId: fields.eventId,
      ownerId: fields.ownerId,
      timestamp: new Date().toISOString()
    });
  }

  async function connectedStatus(userId) {
    if (!configuration.enabled) {
      return {
        enabled: false,
        connected: false,
        setupRequired: configuration.setupRequired
      };
    }
    const connection = await store.getCalendarConnection(userId);
    return {
      enabled: true,
      connected: Boolean(connection),
      email: connection?.google_email || ""
    };
  }

  async function connect({ signedInUser, providerToken, providerRefreshToken }) {
    if (!configuration.enabled) throw calendarSetupError(configuration);
    if (
      typeof providerRefreshToken !== "string" ||
      providerRefreshToken.length < 20 ||
      providerRefreshToken.length > 4096
    ) {
      throw providerTokenError(
        "Google did not return a Calendar refresh token. Choose Connect calendar and approve access again."
      );
    }
    const email = await verifyGoogleProviderToken(
      providerToken,
      signedInUser,
      fetchImpl
    );
    await store.upsertCalendarConnection({
      userId: signedInUser.id,
      email,
      refreshTokenCiphertext: encryptRefreshToken(
        providerRefreshToken,
        configuration.encryptionKey
      ),
      timestamp: new Date().toISOString()
    });
    return { enabled: true, connected: true, email };
  }

  // Free/busy is advisory: room overlap prevention remains the database's job.
  // This returns no event content, only available, busy, or unknown states.
  async function checkAvailability(booking, ownerId) {
    if (!configuration.enabled) {
      return { enabled: false, connected: false, checks: [] };
    }
    const connection = await store.getCalendarConnection(ownerId);
    if (!connection) {
      return { enabled: true, connected: false, checks: [] };
    }

    const emails = [
      ...new Set(
        [booking.email, ...attendeeEmails(booking.attendees, booking.email)]
          .map(email => String(email || "").trim().toLowerCase())
          .filter(Boolean)
      )
    ];
    if (!emails.length) {
      return { enabled: true, connected: true, checks: [] };
    }

    try {
      const accessToken = await accessTokenForConnection(
        connection,
        configuration,
        fetchImpl
      );
      const payload = await googleRequest(
        `${CALENDAR_API_ORIGIN}/freeBusy`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            timeMin: slotDateTime(booking.date, booking.start),
            timeMax: slotDateTime(booking.date, booking.end),
            timeZone: BAHRAIN_TIME_ZONE,
            items: emails.map(id => ({ id }))
          })
        },
        fetchImpl,
        "check Calendar availability"
      );
      const calendars = payload?.calendars || {};
      return {
        enabled: true,
        connected: true,
        checks: emails.map(email => {
          const calendar = calendars[email];
          if (!calendar || Array.isArray(calendar.errors) && calendar.errors.length) {
            return { email, status: "unknown" };
          }
          return {
            email,
            status: Array.isArray(calendar.busy) && calendar.busy.length
              ? "busy"
              : "available"
          };
        })
      };
    } catch (error) {
      logger.error("Google Calendar availability check failed.", error.message);
      return {
        enabled: true,
        connected: true,
        checks: emails.map(email => ({ email, status: "unknown" }))
      };
    }
  }

  async function synchronize(booking, ownerId, action) {
    if (!configuration.enabled) {
      return { state: "not_configured" };
    }
    const effectiveOwner = booking.calendar_owner_id || ownerId;
    if (!effectiveOwner) {
      await rememberState(booking, "not_connected");
      return { state: "not_connected" };
    }
    const connection = await store.getCalendarConnection(effectiveOwner);
    if (!connection) {
      await rememberState(booking, "not_connected", { ownerId: effectiveOwner });
      return { state: "not_connected" };
    }

    const eventId = booking.calendar_event_id || calendarEventId(booking.id);
    try {
      const accessToken = await accessTokenForConnection(
        connection,
        configuration,
        fetchImpl
      );
      const eventURL = `${CALENDAR_API_ORIGIN}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`;
      if (action === "cancel") {
        try {
          await googleRequest(
            eventURL,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${accessToken}` }
            },
            fetchImpl,
            "cancel the Google Calendar event"
          );
        } catch (error) {
          if (error.code !== 404 && error.code !== 410) throw error;
        }
        await rememberState(booking, "synced", {
          eventId,
          ownerId: effectiveOwner
        });
        return { state: "synced" };
      }

      const payload = calendarEventPayload({
        ...booking,
        calendar_event_id: eventId
      });
      if (!booking.calendar_event_id) {
        const createURL = `${CALENDAR_API_ORIGIN}/calendars/primary/events?sendUpdates=all`;
        try {
          await googleRequest(
            createURL,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify(payload)
            },
            fetchImpl,
            "create the Google Calendar event"
          );
        } catch (error) {
          if (error.code !== 409) throw error;
          await googleRequest(
            eventURL,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify(payload)
            },
            fetchImpl,
            "update the Google Calendar event"
          );
        }
      } else {
        await googleRequest(
          eventURL,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          },
          fetchImpl,
          "update the Google Calendar event"
        );
      }
      await rememberState(booking, "synced", {
        eventId,
        ownerId: effectiveOwner
      });
      return { state: "synced" };
    } catch (error) {
      logger.error("Google Calendar synchronization failed.", error.message);
      await rememberState(booking, "failed", {
        eventId: booking.calendar_event_id || undefined,
        ownerId: effectiveOwner
      });
      return { state: "failed" };
    }
  }

  return {
    status: connectedStatus,
    connect,
    checkAvailability,
    createForBooking: (booking, ownerId) => synchronize(booking, ownerId, "create"),
    updateForBooking: (booking, ownerId) => synchronize(booking, ownerId, "update"),
    cancelForBooking: (booking, ownerId) => synchronize(booking, ownerId, "cancel")
  };
}

module.exports = {
  BAHRAIN_TIME_ZONE,
  CALENDAR_SCOPE,
  calendarConfiguration,
  encryptRefreshToken,
  decryptRefreshToken,
  verifyGoogleProviderToken,
  calendarEventId,
  calendarEventPayload,
  createGoogleCalendarSync
};
