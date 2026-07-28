create or replace function public.enforce_booking_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  room_config public.rooms%rowtype;
  duration_minutes integer;
begin
  if new.status <> 'confirmed' then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    public.playbook_lock_key(new.room_id, new.booking_date)
  );

  if extract(isodow from new.booking_date) in (5, 6) then
    raise exception using errcode = 'P0001', message = 'WEEKEND_CLOSED';
  end if;

  if mod(new.start_slot, 2) <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'START_TIME_INTERVAL';
  end if;

  select *
    into room_config
    from public.rooms
   where id = new.room_id
     and enabled = true;
  if not found then
    raise exception using errcode = 'P0001', message = 'ROOM_INACTIVE';
  end if;

  duration_minutes := (new.end_slot - new.start_slot) * 15;
  if duration_minutes < room_config.minimum_duration_minutes
     or duration_minutes > room_config.maximum_duration_minutes
     or duration_minutes % room_config.booking_increment_minutes <> 0
     or (
       room_config.allowed_durations_minutes is not null
       and not (
         duration_minutes = any(room_config.allowed_durations_minutes)
       )
     )
  then
    raise exception using errcode = 'P0001', message = 'BOOKING_DURATION';
  end if;

  if exists (
    select 1
      from public.room_blocks blocked
     where blocked.active = true
       and blocked.room_id = new.room_id
       and blocked.block_date = new.booking_date
       and new.start_slot < blocked.end_slot
       and new.end_slot > blocked.start_slot
  ) then
    raise exception using errcode = 'P0001', message = 'ROOM_BLOCKED';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_booking_rules()
  from public, anon, authenticated;
