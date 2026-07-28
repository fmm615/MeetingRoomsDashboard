create or replace function public.broadcast_availability_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_row jsonb;
  old_row jsonb;
  affected_date text;
  affected_room text;
  prior_date text;
  prior_room text;
begin
  if tg_op <> 'DELETE' then
    new_row := pg_catalog.to_jsonb(new);
    affected_date := coalesce(
      new_row ->> 'booking_date',
      new_row ->> 'block_date'
    );
    affected_room := new_row ->> 'room_id';

    perform realtime.send(
      pg_catalog.jsonb_build_object(
        'date', affected_date,
        'room', affected_room
      ),
      'availability_changed',
      'room-availability',
      false
    );
  end if;

  if tg_op <> 'INSERT' then
    old_row := pg_catalog.to_jsonb(old);
    prior_date := coalesce(
      old_row ->> 'booking_date',
      old_row ->> 'block_date'
    );
    prior_room := old_row ->> 'room_id';

    if tg_op = 'DELETE'
       or prior_date is distinct from affected_date
       or prior_room is distinct from affected_room
    then
      perform realtime.send(
        pg_catalog.jsonb_build_object(
          'date', prior_date,
          'room', prior_room
        ),
        'availability_changed',
        'room-availability',
        false
      );
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.broadcast_availability_change()
  from public, anon, authenticated;

drop trigger if exists bookings_broadcast_availability
  on public.bookings;
create trigger bookings_broadcast_availability
after insert or delete or update of
  room_id, booking_date, start_slot, end_slot, status
on public.bookings
for each row execute function public.broadcast_availability_change();

drop trigger if exists room_blocks_broadcast_availability
  on public.room_blocks;
create trigger room_blocks_broadcast_availability
after insert or delete or update of
  room_id, block_date, start_slot, end_slot, active
on public.room_blocks
for each row execute function public.broadcast_availability_change();
