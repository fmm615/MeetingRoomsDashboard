alter table public.bookings
  add column if not exists organizer_group text not null default 'PLAYBOOK',
  add column if not exists attendees text not null default 'Solo';

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'bookings_organizer_group_check'
       and conrelid = 'public.bookings'::regclass
  ) then
    alter table public.bookings
      add constraint bookings_organizer_group_check
      check (organizer_group in ('PLAYBOOK', 'O&H', 'Joint'));
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'bookings_attendees_check'
       and conrelid = 'public.bookings'::regclass
  ) then
    alter table public.bookings
      add constraint bookings_attendees_check
      check (length(btrim(attendees)) between 1 and 500);
  end if;
end;
$$;

drop function if exists public.create_booking(
  text, text, text, date, integer, integer, text, text, text, text, timestamptz
);
drop function if exists public.update_booking(
  bigint, text, date, integer, integer, text, text, text, text, timestamptz
);

create or replace function public.create_booking(
  p_token_hash text,
  p_reference text,
  p_room_id text,
  p_booking_date date,
  p_start_slot integer,
  p_end_slot integer,
  p_name text,
  p_organizer_group text,
  p_attendees text,
  p_title text,
  p_email text,
  p_notes text,
  p_timestamp timestamptz
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  booking_id bigint;
begin
  insert into public.bookings (
    token_hash, reference, room_id, booking_date, start_slot, end_slot,
    name, organizer_group, attendees, title, email, notes,
    status, created_at, updated_at
  ) values (
    p_token_hash, p_reference, p_room_id, p_booking_date, p_start_slot,
    p_end_slot, p_name, p_organizer_group, p_attendees, p_title, p_email,
    p_notes, 'confirmed', p_timestamp, p_timestamp
  )
  returning id into booking_id;
  return booking_id;
end;
$$;

create or replace function public.update_booking(
  p_booking_id bigint,
  p_room_id text,
  p_booking_date date,
  p_start_slot integer,
  p_end_slot integer,
  p_name text,
  p_organizer_group text,
  p_attendees text,
  p_title text,
  p_email text,
  p_notes text,
  p_timestamp timestamptz
)
returns bigint
language plpgsql
set search_path = ''
as $$
begin
  update public.bookings
     set room_id = p_room_id,
         booking_date = p_booking_date,
         start_slot = p_start_slot,
         end_slot = p_end_slot,
         name = p_name,
         organizer_group = p_organizer_group,
         attendees = p_attendees,
         title = p_title,
         email = p_email,
         notes = p_notes,
         updated_at = p_timestamp
   where id = p_booking_id
     and status = 'confirmed';
  if not found then
    raise exception using errcode = 'P0001', message = 'BOOKING_CANCELLED';
  end if;
  return p_booking_id;
end;
$$;

revoke execute on function public.create_booking(
  text, text, text, date, integer, integer, text, text, text, text, text, text,
  timestamptz
) from public, anon, authenticated;
revoke execute on function public.update_booking(
  bigint, text, date, integer, integer, text, text, text, text, text, text,
  timestamptz
) from public, anon, authenticated;

grant execute on function public.create_booking(
  text, text, text, date, integer, integer, text, text, text, text, text, text,
  timestamptz
) to service_role;
grant execute on function public.update_booking(
  bigint, text, date, integer, integer, text, text, text, text, text, text,
  timestamptz
) to service_role;
