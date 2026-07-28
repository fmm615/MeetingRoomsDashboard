"use strict";

const { createClient } = require("@supabase/supabase-js");

function databaseFailure(error, context) {
  const failure = new Error(error?.message || `Supabase could not ${context}.`);
  failure.code = error?.code;
  failure.details = error?.details;
  failure.hint = error?.hint;
  failure.context = context;
  return failure;
}

function resultData(result, context) {
  if (result.error) throw databaseFailure(result.error, context);
  return result.data;
}

function normalizeBookingRow(row) {
  if (!row) return null;
  const room = Array.isArray(row.room) ? row.room[0] : row.room;
  return {
    ...row,
    room_name: room?.name || "",
    room_location: room?.location || "",
    room_slug: room?.slug || ""
  };
}

function createSupabaseClientFromEnv(environment = process.env) {
  const url = environment.SUPABASE_URL;
  const secret =
    environment.SUPABASE_SECRET_KEY ||
    environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    const error = new Error(
      "Set SUPABASE_URL and SUPABASE_SECRET_KEY before starting the booking service."
    );
    error.status = 503;
    throw error;
  }
  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function createSupabaseStore(client) {
  return {
    async listRooms() {
      const rows = resultData(
        await client
          .from("rooms")
          .select("*")
          .eq("enabled", true)
          .order("display_order", { ascending: true }),
        "load rooms"
      );
      return rows || [];
    },

    async getRoom(id, activeOnly = false) {
      let query = client.from("rooms").select("*").eq("id", id);
      if (activeOnly) query = query.eq("enabled", true);
      const row = resultData(await query.maybeSingle(), "load a room");
      return row || null;
    },

    async findBookingByTokenHash(tokenHash) {
      const row = resultData(
        await client
          .from("bookings")
          .select(
            "*, room:rooms!bookings_room_id_fkey(name, location, slug)"
          )
          .eq("token_hash", tokenHash)
          .maybeSingle(),
        "load a booking"
      );
      return normalizeBookingRow(row);
    },

    async getAvailability(date, roomId = "", excludedHash = "") {
      let bookingsQuery = client
        .from("bookings")
        .select("room_id, start_slot, end_slot")
        .eq("booking_date", date)
        .eq("status", "confirmed");
      let blocksQuery = client
        .from("room_blocks")
        .select("room_id, start_slot, end_slot")
        .eq("block_date", date)
        .eq("active", true);
      if (roomId) {
        bookingsQuery = bookingsQuery.eq("room_id", roomId);
        blocksQuery = blocksQuery.eq("room_id", roomId);
      }
      if (excludedHash) {
        bookingsQuery = bookingsQuery.neq("token_hash", excludedHash);
      }
      const [bookingResult, blockResult] = await Promise.all([
        bookingsQuery,
        blocksQuery
      ]);
      const bookings = resultData(bookingResult, "load bookings") || [];
      const blocks = resultData(blockResult, "load room blocks") || [];
      return [
        ...bookings.map(row => ({
          room: row.room_id,
          start: row.start_slot,
          end: row.end_slot,
          type: "booked"
        })),
        ...blocks.map(row => ({
          room: row.room_id,
          start: row.start_slot,
          end: row.end_slot,
          type: "blocked"
        }))
      ].sort(
        (left, right) =>
          left.room.localeCompare(right.room) || left.start - right.start
      );
    },

    async createBooking(value) {
      return resultData(
        await client.rpc("create_booking", {
          p_token_hash: value.tokenHash,
          p_reference: value.reference,
          p_room_id: value.room,
          p_booking_date: value.date,
          p_start_slot: value.start,
          p_end_slot: value.end,
          p_name: value.name,
          p_organizer_group: value.organizerGroup,
          p_attendees: value.attendees,
          p_title: value.title,
          p_email: value.email,
          p_notes: value.notes,
          p_timestamp: value.timestamp
        }),
        "create a booking"
      );
    },

    async updateBooking(id, value) {
      return resultData(
        await client.rpc("update_booking", {
          p_booking_id: id,
          p_room_id: value.room,
          p_booking_date: value.date,
          p_start_slot: value.start,
          p_end_slot: value.end,
          p_name: value.name,
          p_organizer_group: value.organizerGroup,
          p_attendees: value.attendees,
          p_title: value.title,
          p_email: value.email,
          p_notes: value.notes,
          p_timestamp: value.timestamp
        }),
        "update a booking"
      );
    },

    async cancelBooking(id, timestamp) {
      return resultData(
        await client.rpc("cancel_booking", {
          p_booking_id: id,
          p_timestamp: timestamp
        }),
        "cancel a booking"
      );
    }
  };
}

function createSupabaseStoreFromEnv(environment = process.env) {
  return createSupabaseStore(createSupabaseClientFromEnv(environment));
}

module.exports = {
  createSupabaseClientFromEnv,
  createSupabaseStore,
  createSupabaseStoreFromEnv,
  normalizeBookingRow
};
