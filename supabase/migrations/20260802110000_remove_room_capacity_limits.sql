-- Room descriptions remain visible to help bookers choose a suitable space,
-- but attendee count is no longer a booking restriction.
drop trigger if exists bookings_enforce_capacity on public.bookings;
drop function if exists public.enforce_booking_capacity();

update public.rooms
set maximum_capacity = null;

comment on column public.rooms.maximum_capacity is
  'Retained for compatibility. Attendee count is not limited by the booking system.';
