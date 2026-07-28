alter table public.rooms
  add column if not exists maximum_capacity integer;

alter table public.rooms
  drop constraint if exists rooms_maximum_capacity_check;

alter table public.rooms
  add constraint rooms_maximum_capacity_check
  check (maximum_capacity is null or maximum_capacity >= 1);

update public.rooms
set
  maximum_capacity = case id
    when 'boardroom' then 7
    when 'meeting-a' then 2
    when 'meeting-b' then null
    when 'quiet-pods' then 3
  end,
  capacity_label = case id
    when 'boardroom' then '2–7 people'
    when 'meeting-a' then 'Up to 2 people'
    when 'meeting-b' then 'No fixed limit'
    when 'quiet-pods' then 'Up to 3 people'
  end
where id in ('boardroom', 'meeting-a', 'meeting-b', 'quiet-pods');

create or replace function public.enforce_booking_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  configured_capacity integer;
  attendee_count integer;
begin
  select maximum_capacity
    into configured_capacity
    from public.rooms
   where id = new.room_id;

  if configured_capacity is null then
    return new;
  end if;

  attendee_count := case
    when btrim(coalesce(new.attendees, '')) = '' then 0
    else cardinality(
      regexp_split_to_array(
        btrim(new.attendees),
        '[,;[:space:]]+'
      )
    )
  end;

  if attendee_count + 1 > configured_capacity then
    raise exception using
      errcode = 'P0001',
      message = 'BOOKING_CAPACITY';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_booking_capacity()
  from public, anon, authenticated;

drop trigger if exists bookings_enforce_capacity on public.bookings;

create trigger bookings_enforce_capacity
before insert or update of room_id, attendees on public.bookings
for each row execute function public.enforce_booking_capacity();

comment on column public.rooms.maximum_capacity is
  'Maximum total people including the organizer; null means no room-specific limit.';
